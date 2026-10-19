#!/usr/bin/env python3
"""Root host broker: fixed container templates, IPVS handoff, bounded draining.

Application peers can submit snapshots, never Docker options, paths or image IDs.
Only a root Unix peer may request a version deployment. No TCP control listener.
"""
import argparse
import copy
from contextlib import closing
import datetime
import http.client
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import socketserver
import sqlite3
import struct
import ssl
import subprocess
import threading
import time
import uuid

STATE = Path('/var/lib/proxy-handoff')
REGISTRY = Path('/run/proxy-handoff')
AUDIT = Path('/var/log/proxy-deployments.jsonl')
NETWORK = ipaddress.ip_network('10.254.240.0/24')
MAX_GENERATIONS = 16
DRAIN_SECONDS = 3600


class ControlError(RuntimeError):
    def __init__(self, status):
        super().__init__('Control operation failed: HTTP ' + str(status))
        self.status = status


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout=35):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def request(path, method, url, body=None, timeout=35):
    with UnixHTTP(path, timeout=timeout) as connection:
        connection.request(method, url, None if body is None else json.dumps(body),
                           {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise RuntimeError('Oversized control response')
        value = json.loads(raw) if raw else None
        if response.status >= 400:
            raise ControlError(response.status)
        return value


def verify_admin(ip, hostname):
    class Connection(http.client.HTTPSConnection):
        def connect(self):
            self.sock = ssl.create_default_context().wrap_socket(
                socket.create_connection((ip, 443), timeout=3), server_hostname=hostname)
    for path, expected in [('/api/auth/status', 200), ('/api/state', 401),
                           ('/_proxy/errors/404/index.html', 404)]:
        connection = Connection(hostname, timeout=3)
        try:
            connection.request('GET', path, headers={'Host': hostname})
            response = connection.getresponse()
            response.read()
            if response.status != expected:
                raise RuntimeError('Candidate management isolation check failed')
        finally:
            connection.close()


def docker(method, path, body=None):
    return request('/var/run/docker.sock', method, '/v1.52' + path, body)


def inspect(name):
    return docker('GET', '/containers/' + name + '/json')


def atomic(path, value, mode=0o600):
    temp = path.with_suffix('.new')
    with open(temp, 'w') as output:
        os.chmod(temp, mode)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)


def audit(event, **fields):
    # Fixed operational fields only; never log HTTP bodies, environments or templates.
    record = {'type': 'audit', 'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'event': 'deployment.' + event, **fields}
    line = json.dumps(record)
    fd = os.open(AUDIT, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as output:
        output.write(line + '\n')
    print(line, flush=True)


def ports(snapshot, vip):
    result = {('tcp', 80), ('tcp', 443)}
    for route in snapshot.get('routes', []):
        if not route.get('published') or route.get('kind') not in ('tcp', 'udp'):
            continue
        if route.get('ingressIP') != vip:
            raise ValueError('Unexpected ingress address')
        ranges = route.get('ports') or str(route['portStart']) + '-' + str(route['portEnd'])
        for item in ranges.split(','):
            match = re.fullmatch(r'\s*(\d+)(?:\s*-\s*(\d+))?\s*', item)
            if not match:
                raise ValueError('Invalid port list')
            first, last = int(match[1]), int(match[2] or match[1])
            if not 1 <= first <= last <= 65535 or last - first >= 1024:
                raise ValueError('Invalid port range')
            result.update((route['kind'], port) for port in range(first, last + 1))
            if any(port in [22, 3001, 8120, 9120, 2375, 2376, 41641] for _, port in result):
                raise ValueError('Host management listener is protected')
            if len(result) > 1026:
                raise ValueError('Listener budget exceeded')
    return [list(item) for item in sorted(result)]


def service_args(vip, proto, port):
    return ['-t' if proto == 'tcp' else '-u', f'{vip}:{port}']


def configure_service(vip, proto, port, backends):
    key = service_args(vip, proto, port)
    current = run(['ipvsadm', '-Sn'])
    header = '-A ' + ' '.join(key) + ' '
    if not any(line.startswith(header) for line in current.splitlines()):
        run(['ipvsadm', '-A', *key, '-s', 'rr'])
    # Add/enable the healthy replacement before quiescing old destinations.
    for ip, weight in sorted(backends.items(), key=lambda item: -item[1]):
        target = f'{ip}:{port}'
        exists = any(line.startswith('-a ' + ' '.join(key) + ' ') and
                     (' -r ' + target + ' ') in line for line in current.splitlines())
        run(['ipvsadm', '-e' if exists else '-a', *key, '-r', target, '-m', '-w', str(weight)])


def generation_count(entry):
    if entry.get('legacy'):
        return None  # Pre-IPVS TCP connections cannot be counted by IPVS.
    count = 0
    target = entry['ip'] + ':'
    for line in run(['ipvsadm', '-Ln']).splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[0] == '->' and fields[1].startswith(target):
            count += int(fields[-1]) + int(fields[-2])
    return count


class Broker:
    def __init__(self):
        self.lock = threading.RLock()
        self.config = json.loads((STATE / 'templates.json').read_text())
        self.state = json.loads((STATE / 'state.json').read_text())
        self.agent_stopped_since = {}
        self.vip = self.config['vip']
        if ipaddress.ip_address(self.vip).version != 4:
            raise RuntimeError('This deployment requires one IPv4 ingress address')

    def persist(self):
        atomic(STATE / 'state.json', self.state)
        control = self.state['control']
        atomic(REGISTRY / 'active.json', {'id': control['id'], 'ip': control['ip']}, 0o644)

    def network(self):
        # Input filtering happens BEFORE IPVS's LOCAL_IN dispatch. Direct traffic
        # to generation addresses must never bypass the public UFW rules.
        rules = '''table inet proxy_handoff_guard {
 chain input {
  type filter hook input priority -10; policy accept;
  iifname != "lo" ip daddr 10.254.240.0/24 drop
 }
}
'''
        listed = subprocess.run(['nft', 'list', 'table', 'inet', 'proxy_handoff_guard'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        if not listed:
            rules = 'delete table inet proxy_handoff_guard\n' + rules
        run(['nft', '-f', '-'], input=rules)
        for entry in [self.state['edge'], self.state['control'], *self.state['draining']]:
            if not entry.get('legacy'):
                self.address(entry['ip'])
        self.routes()
        self.persist()

    def address(self, ip):
        if ipaddress.ip_address(ip) not in NETWORK or ip == str(NETWORK.network_address):
            raise RuntimeError('Invalid private generation address')
        run(['ip', 'address', 'replace', ip + '/32', 'dev', 'lo'])

    def routes(self):
        edge = self.state['edge']
        all_entries = [edge, *[e for e in self.state['draining'] if e['role'] == 'edge']]
        listeners = {tuple(p) for entry in all_entries for p in entry['ports']}
        for proto, port in sorted(listeners):
            backends = {entry['ip']: int(entry['id'] == edge['id'] and 'edge' not in self.state.get('paused', []))
                        for entry in all_entries if [proto, port] in entry['ports']}
            configure_service(self.vip, proto, port, backends)
        control = self.state['control']
        backends = {entry['ip']: int(entry['id'] == control['id'] and 'control' not in self.state.get('paused', [])) for entry in
                    [control, *[e for e in self.state['draining'] if e['role'] == 'control']]}
        configure_service('127.0.0.1', 'tcp', 3001, backends)

    def new(self, role, image, snapshot=None, reserved=()):
        memory = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
        if int(memory['MemAvailable'].split()[0]) < 512 * 1024:
            raise RuntimeError('Insufficient free memory for a safe overlapping deployment')
        if shutil.disk_usage(STATE).free < 2 * 1024 ** 3:
            raise RuntimeError('Insufficient free disk space for a safe overlapping deployment')
        used = {entry['ip'] for entry in [self.state['edge'], self.state['control'], *self.state['draining']]}
        used.update(entry['ip'] for entry in self.state.get('pending', []))
        # A removed IPVS destination can still have kernel flow records. Never
        # give that address to another generation while those records survive.
        for line in run(['ipvsadm', '-Lnc']).splitlines():
            fields = line.split()
            match = re.fullmatch(r'(10\.254\.240\.\d+):\d+', fields[-1]) if fields else None
            if match:
                used.add(match[1])
        used.update(reserved)
        ip = next((f'10.254.240.{i}' for i in range(2, 251) if f'10.254.240.{i}' not in used), None)
        if not ip or len(self.state['draining']) + len(self.state.get('pending', [])) >= MAX_GENERATIONS:
            raise RuntimeError('Drain capacity reached; retry after old sessions retire')
        identifier = uuid.uuid4().hex
        entry = {'id': identifier, 'ip': ip, 'role': role, 'image': image, 'created': time.time()}
        template = self.config[role]
        config = copy.deepcopy(template['config'])
        config['Image'] = image
        config['Labels'] = {'org.krychlic.proxy.generation': identifier, 'org.krychlic.proxy.role': role}
        env = {key: value for key, value in (item.split('=', 1) for item in config['Env'])
               if key.startswith('PROXY_') or key in ['PORT', 'NODE_ENV', 'TZ']}
        env.pop('PROXY_HANDOFF_AGENT', None)
        host = copy.deepcopy(template['host'])
        host['NetworkMode'] = 'host'
        host['CgroupParent'] = 'proxy-generations.slice'
        host.pop('PortBindings', None)
        host['Binds'] = [f"{m['Source']}:{m['Destination']}:{'rw' if m['RW'] else 'ro'}"
                         for m in template['mounts'] if role != 'edge' or m['Destination'] not in ['/runtime', '/ipc']]
        if role == 'edge':
            host['Tmpfs']['/ipc'] = 'rw,noexec,nosuid,size=1m,mode=2770,uid=10002,gid=10000'
            directory = STATE / identifier
            directory.mkdir(mode=0o700)
            with sqlite3.connect(directory / 'edge.db') as db:
                db.execute('CREATE TABLE data (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
                body = copy.deepcopy(snapshot)
                settings = body.pop('settings')
                body.pop('expectedHash', None)
                body.pop('expectedPolicyHash', None)
                db.execute('INSERT INTO data VALUES (?, ?)', ('last-good', json.dumps({'snapshot': body, 'settings': settings})))
            os.chown(directory / 'edge.db', 10002, 10000)
            os.chown(directory, 10002, 10000)
            host['Binds'].append(f'{directory}:/runtime:rw')
            env.update(PROXY_EDGE_BIND_IP=ip, PROXY_EDGE_SOCKET='/runtime/edge.sock', PROXY_EDGE_MANAGED='true')
            entry['socket'] = str(directory / 'edge.sock')
            entry['ports'] = ports(snapshot, self.vip)
        else:
            env.update(PROXY_LISTEN_HOST=ip, PROXY_CONTROL_GENERATION=identifier)
            env['PROXY_AUDIT_PATH'] = '/audit/events.jsonl'
            host['Binds'].append(f'{REGISTRY}:/handoff:ro')
            host['Binds'].append('/var/log/proxy-management-audit:/audit:rw')
        config['Env'] = [key + '=' + value for key, value in env.items()]
        config['HostConfig'] = host
        self.address(ip)
        self.state.setdefault('pending', []).append(entry)
        self.persist()
        try:
            result = docker('POST', '/containers/create?name=proxy-generation-' + identifier, config)
            entry['container'] = result['Id']
            docker('POST', '/containers/' + entry['container'] + '/start')
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    if role == 'edge':
                        status = request(entry['socket'], 'GET', '/status', timeout=1)
                        if not status.get('available') or status.get('error'):
                            raise RuntimeError('Candidate configuration is unavailable')
                        entry['status'] = status
                        hostname = snapshot['settings'].get('adminHostname')
                        if hostname and any(hostname == domain or (
                                hostname.endswith('.' + domain) and domain in status.get('wildcardDomains', []))
                                for domain in status.get('readyDomains', [])):
                            verify_admin(ip, hostname)
                    else:
                        with closing(http.client.HTTPConnection(ip, 3001, timeout=1)) as connection:
                            connection.request('GET', '/healthz')
                            if connection.getresponse().status != 200:
                                raise RuntimeError('Candidate management is unavailable')
                    return entry
                except (OSError, RuntimeError, ValueError, http.client.HTTPException):
                    time.sleep(.1)
            raise RuntimeError('Candidate failed readiness verification')
        except BaseException:
            audit('candidate_failed', role=role, generation=identifier)
            self.remove(entry)
            self.state['pending'] = [e for e in self.state['pending'] if e['id'] != identifier]
            self.persist()
            raise

    def remove(self, entry):
        if entry.get('container'):
            try:
                docker('DELETE', '/containers/' + entry['container'] + '?force=true')
            except ControlError as error:
                if error.status != 404:
                    raise
        if not entry.get('legacy'):
            current = json.loads(run(['ip', '-j', 'address', 'show', 'dev', 'lo']))
            if any(info['local'] == entry['ip'] for interface in current for info in interface['addr_info']):
                run(['ip', 'address', 'del', entry['ip'] + '/32', 'dev', 'lo'])
            if entry['role'] == 'edge':
                if not re.fullmatch(r'[0-9a-f]{32}', entry['id']) or not shutil.rmtree.avoids_symlink_attacks:
                    raise RuntimeError('Safe generation cleanup is unavailable')
                # Root's parent is immutable to applications; fd-based rmtree
                # refuses symlink traversal inside the app-owned child tree.
                parent = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    shutil.rmtree(entry['id'], dir_fd=parent)
                except FileNotFoundError:
                    pass
                finally:
                    os.close(parent)
        if any(item['id'] == entry['id'] for item in self.state.get('pending', [])):
            self.state['pending'] = [item for item in self.state['pending'] if item['id'] != entry['id']]
            self.persist()

    def activate(self, edge, control=None, reason='configuration'):
        before = copy.deepcopy(self.state)
        old = self.state['edge']
        retiring = [old]
        if control:
            retiring.append(self.state['control'])
            self.state['control'] = control
        self.state['edge'] = edge
        self.state['pending'] = [e for e in self.state.get('pending', [])
                                 if e['id'] not in [edge['id'], (control or {}).get('id')]]
        for entry in retiring:
            entry['deadline'] = time.time() + DRAIN_SECONDS
        self.state['draining'].extend(retiring)
        try:
            self.routes()
            self.persist()
            # Verify the ACTIVE path, not just that the candidate process started.
            with closing(http.client.HTTPConnection('127.0.0.1', 3001, timeout=3)) as connection:
                connection.request('GET', '/healthz')
                if connection.getresponse().status != 200:
                    raise RuntimeError('Management handoff verification failed')
        except BaseException:
            self.state = before
            self.routes()
            self.persist()
            # Explicitly quiesce failed destinations; retained flows can be reset on rollback.
            for entry in [edge, *([control] if control else [])]:
                self.drop_destinations(entry)
                self.remove(entry)
            self.state['pending'] = []
            self.persist()
            audit('rollback', generation=edge['id'])
            raise
        audit('switched', generation=edge['id'], reason=reason,
              drainSeconds=DRAIN_SECONDS, retiring=[e['id'] for e in retiring])
        return edge['status']

    def drop_destinations(self, entry):
        vip = self.vip if entry['role'] == 'edge' else '127.0.0.1'
        for proto, port in entry.get('ports', [['tcp', 3001]]):
            key = service_args(vip, proto, port)
            target = f"{entry['ip']}:{port}"
            if any(line.startswith('-a ' + ' '.join(key) + ' ') and (' -r ' + target + ' ') in line
                   for line in run(['ipvsadm', '-Sn']).splitlines()):
                run(['ipvsadm', '-d', *key, '-r', target])

    def recover(self):
        active = {entry['id'] for entry in [self.state['edge'], self.state['control'], *self.state['draining']]}
        for entry in self.state.get('pending', []):
            if entry['id'] in active:
                continue
            names = run(['docker', 'ps', '-aq', '--filter', 'name=^proxy-generation-' + entry['id'] + '$'])
            if names:
                entry['container'] = names
            self.drop_destinations(entry)
            self.remove(entry)
            audit('abandoned_candidate', generation=entry['id'])
        self.state['pending'] = []

    def refresh_certificates(self):
        with self.lock:
            if self.state['edge'].get('legacy') or self.state.get('paused'):
                return
            if request(self.state['edge']['socket'], 'GET', '/certificates/changed').get('changed'):
                edge = self.new('edge', self.state['edge']['image'], self.state['snapshot'])
                self.activate(edge, reason='certificate')

    def watch_agents(self):
        with self.lock:
            states = {}
            for role in ['edge', 'control', 'files', 'certificates']:
                try:
                    states[role] = inspect('proxy-' + role + '-1')['State']['Status']
                except ControlError as error:
                    if error.status != 404:
                        raise
                    states[role] = 'missing'
            down = all(value == 'missing' for value in states.values())
            for role in ['edge', 'control']:
                paused = self.state.setdefault('paused', [])
                if states[role] == 'exited' or down:
                    since = self.agent_stopped_since.setdefault(role, time.time())
                    if role not in paused and time.time() - since >= 5:
                        paused.append(role)
                        self.routes()
                        for entry in [self.state[role], *[e for e in self.state['draining'] if e['role'] == role]]:
                            docker('POST', '/containers/' + entry['container'] + '/stop?t=1')
                        self.persist()
                        audit('operator_stopped', role=role)
                else:
                    self.agent_stopped_since.pop(role, None)
                    if states[role] == 'running' and role in paused:
                        docker('POST', '/containers/' + self.state[role]['container'] + '/start')
                        paused.remove(role)
                        self.routes()
                        self.persist()
                        audit('operator_started', role=role)

    def ensure_agents(self):
        with self.lock:
            for role in ['control', 'edge']:
                if role in self.state.get('paused', []) or any(
                        entry.get('legacy') and entry['role'] == role for entry in self.state['draining']):
                    continue
                try:
                    inspect('proxy-' + role + '-1')
                    continue
                except ControlError as error:
                    if error.status != 404:
                        raise
                template = self.config[role]
                config = copy.deepcopy(template['config'])
                config['Image'] = self.state[role]['image']
                config['Env'] = [value for value in config['Env'] if not value.startswith('PROXY_HANDOFF_AGENT=')]
                config['Env'].append('PROXY_HANDOFF_AGENT=true')
                config['Labels'] = template['agentLabels']
                host = copy.deepcopy(template['host'])
                host['NetworkMode'] = 'host' if role == 'edge' else template['network']
                host['Binds'] = [f"{m['Source']}:{m['Destination']}:{'rw' if m['RW'] else 'ro'}" for m in template['mounts']]
                if role == 'control':
                    host['PortBindings'] = {'3001/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '0'}]}
                    config['ExposedPorts'] = {'3001/tcp': {}}
                    probe = ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
                else:
                    probe = ['CMD', 'proxy-as-edge', 'node', '-e', "require('http').get({socketPath:'/ipc/edge.sock',path:'/status'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
                config['Healthcheck'] = {'Test': probe, 'Interval': 30_000_000_000,
                                         'Timeout': 5_000_000_000, 'Retries': 3}
                config['HostConfig'] = host
                result = docker('POST', '/containers/create?name=proxy-' + role + '-1', config)
                docker('POST', '/containers/' + result['Id'] + '/start')
                audit('status_agent_started', role=role)

    def check_agent_updates(self):
        with self.lock:
            if self.state.get('paused') or any(entry.get('legacy') for entry in self.state['draining']):
                return
            images = {}
            for role in ['control', 'edge']:
                agent = inspect('proxy-' + role + '-1')
                if 'PROXY_HANDOFF_AGENT=true' not in agent['Config']['Env']:
                    return
                images[role] = agent['Image']
            if all(images[role] == self.state[role]['image'] for role in images):
                return
            if self.state.get('lastRequestedImages') == images and time.time() - self.state.get('lastUpdateRequest', 0) < 3600:
                return
            if subprocess.run(['systemctl', 'is-active', '--quiet', 'proxy-security-update.service']).returncode == 0:
                return
            # A Komodo rebuild requests the fixed, tested updater. Agent contents
            # never select privileged commands, paths, revisions or arbitrary images.
            subprocess.run(['systemctl', 'start', '--no-block', 'proxy-security-update.service'], check=True)
            self.state['lastRequestedImages'] = images
            self.state['lastUpdateRequest'] = time.time()
            self.persist()
            audit('update_requested', source='komodo')

    def reap(self):
        with self.lock:
            for entry in list(self.state['draining']):
                count = generation_count(entry)
                forced = time.time() >= entry['deadline']
                if count != 0 and not forced:
                    continue
                self.drop_destinations(entry)
                self.remove(entry)
                self.state['draining'].remove(entry)
                self.persist()
                audit('forced_retirement' if forced and count != 0 else 'retired',
                      generation=entry['id'], role=entry['role'], remainingConnections=count)

    def apply(self, body):
        status = request(self.state['edge']['socket'], 'GET', '/status')
        if not self.state['edge'].get('legacy') and (
                body.get('expectedHash') != status['hash'] or body.get('expectedPolicyHash') != status['policyHash']):
            raise RuntimeError('Configuration changed concurrently; refresh before retrying')
        candidate = self.new('edge', self.state['edge']['image'], body)
        previous = self.state['snapshot']
        self.state['snapshot'] = {key: value for key, value in body.items()
                                  if key not in ['expectedHash', 'expectedPolicyHash']}
        try:
            return self.activate(candidate)
        except BaseException:
            self.state['snapshot'] = previous
            self.persist()
            raise

    def deploy(self, images):
        if self.state.get('paused'):
            raise RuntimeError('Proxy was stopped by the operator')
        if set(images) != {'edge', 'control'} or any(not re.fullmatch(r'sha256:[0-9a-f]{64}', value) for value in images.values()):
            raise ValueError('Expected immutable edge/control image IDs')
        control = self.new('control', images['control'])
        try:
            edge = self.new('edge', images['edge'], self.state['snapshot'], reserved=[control['ip']])
        except BaseException:
            self.remove(control)
            raise
        return self.activate(edge, control, 'version')


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    request_queue_size = 16
    permits = threading.BoundedSemaphore(8)

    def process_request(self, request, address):
        if not self.permits.acquire(blocking=False):
            request.close()
            return
        super().process_request(request, address)

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.permits.release()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        self.connection.settimeout(40)
        uid = struct.unpack('3i', self.connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
        status, result = 200, None
        try:
            if uid not in [0, 10001, 10002] or (uid == 10002 and (self.command, self.path) != ('GET', '/status')):
                raise PermissionError('Unauthorized control peer')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 1_000_000 or self.headers.get('Transfer-Encoding'):
                raise ValueError('Invalid control body length')
            body = json.loads(self.rfile.read(size)) if size else None
            broker = self.server.broker
            with broker.lock:
                if self.path == '/deploy' and self.command == 'POST' and uid == 0:
                    result = broker.deploy(body)
                elif self.path == '/apply' and self.command == 'POST' and uid in [0, 10001]:
                    result = broker.apply(body)
                elif (self.command, self.path) in [('GET', '/status'), ('GET', '/network'),
                       ('POST', '/probe'), ('POST', '/pages/validate'), ('POST', '/sites/inspect')]:
                    result = request(broker.state['edge']['socket'], self.command, self.path, body)
                    if self.path == '/status':
                        if not result.get('available') or result.get('error'):
                            raise RuntimeError('Active edge is unavailable')
                        with closing(http.client.HTTPConnection(broker.state['control']['ip'], 3001, timeout=2)) as connection:
                            connection.request('GET', '/healthz')
                            if connection.getresponse().status != 200:
                                raise RuntimeError('Active controller is unavailable')
                else:
                    raise PermissionError('Unsupported control operation')
        except PermissionError:
            status, result = 403, {'error': 'Unsupported control operation'}
        except (ValueError, TypeError, KeyError):
            status, result = 400, {'error': 'Invalid deployment request'}
        except Exception as error:
            status, result = 503, {'error': 'Handoff failed; previous deployment retained. Check deployment audit.'}
            audit('failed', operation='version' if self.path == '/deploy' else 'configuration', error=type(error).__name__)
        raw = json.dumps(result).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def initialize():
    STATE.mkdir(mode=0o700, exist_ok=True)
    if (STATE / 'state.json').exists():
        raise RuntimeError('Handoff is already initialized')
    os.chmod(STATE, 0o700)
    originals = {role: inspect('proxy-' + role + '-1') for role in ['edge', 'control']}
    env = dict(value.split('=', 1) for value in originals['edge']['Config']['Env'])
    vip = env['PROXY_INGRESS_IPS']
    if ',' in vip or ipaddress.ip_address(vip).version != 4:
        raise RuntimeError('Expected the current single IPv4 ingress deployment')
    templates = {'vip': vip}
    for role, container in originals.items():
        templates[role] = {
            'config': {key: container['Config'][key] for key in
                       ['Image', 'Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Env']},
            'host': {key: container['HostConfig'][key] for key in
                     ['ReadonlyRootfs', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Memory', 'NanoCpus',
                      'PidsLimit', 'Tmpfs', 'Ulimits', 'Init', 'RestartPolicy', 'LogConfig']},
            'mounts': container['Mounts'],
            'network': container['HostConfig']['NetworkMode'],
            'agentLabels': container['Config']['Labels'],
        }
    edge_mount = next(m['Source'] for m in originals['edge']['Mounts'] if m['Destination'] == '/runtime')
    ipc = next(m['Source'] for m in originals['edge']['Mounts'] if m['Destination'] == '/ipc')
    with sqlite3.connect(Path(edge_mount).as_uri() + '/edge.db?mode=ro', uri=True) as db:
        saved = json.loads(db.execute("SELECT value FROM data WHERE key='last-good'").fetchone()[0])
    snapshot = {**saved['snapshot'], 'settings': saved['settings']}
    state = {'snapshot': snapshot, 'draining': []}
    for role, container in originals.items():
        state[role] = {'id': 'legacy-' + role, 'role': role, 'container': container['Id'],
                       'image': container['Image'], 'ip': vip if role == 'edge' else '127.0.0.1',
                       'legacy': True}
    state['edge'].update(socket=str(Path(ipc) / 'legacy-edge.sock'), ports=ports(snapshot, vip))
    templates['ipc'] = ipc
    atomic(STATE / 'templates.json', templates)
    atomic(STATE / 'state.json', state)
    os.rename(Path(ipc) / 'edge.sock', Path(ipc) / 'legacy-edge.sock')
    audit('initialized', drainSeconds=DRAIN_SECONDS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    audit_dir = Path('/var/log/proxy-management-audit')
    audit_dir.mkdir(mode=0o750, exist_ok=True)
    os.chown(audit_dir, 0, 10000)
    os.chmod(audit_dir, 0o750)
    audit_file = audit_dir / 'events.jsonl'
    fd = os.open(audit_file, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.fchown(fd, 10001, 10000)
    os.fchmod(fd, 0o600)
    os.close(fd)
    if args.initialize:
        initialize()
    REGISTRY.mkdir(mode=0o755, exist_ok=True)
    os.chmod(REGISTRY, 0o755)
    broker = Broker()
    broker.recover()
    broker.network()
    socket_path = Path(broker.config['ipc']) / 'edge.sock'
    socket_path.unlink(missing_ok=True)
    with Server(str(socket_path), Handler) as server:
        server.broker = broker
        os.chown(socket_path, 0, 10000)
        os.chmod(socket_path, 0o660)
        def cleanup():
            ticks = 0
            while True:
                time.sleep(5)
                try:
                    broker.reap()
                    broker.watch_agents()
                    broker.ensure_agents()
                    ticks += 1
                    if ticks % 6 == 0:
                        broker.refresh_certificates()
                        broker.check_agent_updates()
                except Exception:
                    audit('cleanup_failed')
        threading.Thread(target=cleanup, daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    main()
