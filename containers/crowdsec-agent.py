"""Private CrowdSec administration socket. No Docker socket or host filesystem access."""
import http.server
import ipaddress
import json
import os
from pathlib import Path
import secrets
import signal
import socketserver
import subprocess
import threading
import time
import socket

os.umask(0o027)
ROOT = Path('/etc/crowdsec')
IPC = Path('/security-ipc')
IPC.mkdir(exist_ok=True)
os.chown(IPC, 0, 10000)
os.chmod(IPC, 0o2770)
lock = threading.Lock()
state_file = ROOT / 'proxy-state.json'
try:
    state = json.loads(state_file.read_text())
except FileNotFoundError:
    state = {'updates': True, 'duration': '4h', 'appsecExceptions': {'umamiDelete': True, 'socketIo': True}, 'updated': None, 'error': None}
state.setdefault('appsecExceptions', {'umamiDelete': True, 'socketIo': True})
key_file = ROOT / 'proxy-bouncer.key'
if not key_file.exists():
    key_file.write_text(secrets.token_hex(32))
    key_file.chmod(0o600)
key = key_file.read_text().strip()
# The key is readable only by the edge's group, never returned through the UI.
conf = IPC / 'bouncer.conf'
conf.write_text('API_URL=http://127.0.0.1:8088\nAPI_KEY=' + key + '\nAPPSEC_URL=http://127.0.0.1:7422\nAPPSEC_PROCESS_TIMEOUT=2000\nMODE=live\nENABLED=true\nAPPSEC_DROP_UNREADABLE_BODY=true\n')
os.chown(conf, 0, 10000)
conf.chmod(0o640)
(ROOT / 'config.yaml.local').write_text('api:\n  server:\n    listen_uri: 127.0.0.1:8088\ncommon:\n  log_media: stdout\n')
(ROOT / 'appsec-configs').mkdir(exist_ok=True)
# Successful recorder traffic is legitimate automation, despite the hub's UA regex.
(ROOT / 'parsers' / 's02-enrich').mkdir(parents=True, exist_ok=True)
(ROOT / 'parsers' / 's02-enrich' / 'proxy-recorder.yaml').write_text('''name: proxy/recorder
description: Allow successful recorder requests
whitelist:
  reason: Successful AutoTournament recorder request
  expression:
   - evt.Meta.log_type == "http_access-log" && evt.Meta.http_user_agent == "AutoTournament-Recorder/1.0" && evt.Meta.http_status matches "^2[0-9]{2}$"
''')
def appsec_config():
    rules = []
    if state['appsecExceptions'].get('socketIo', True):
        rules.append('''   - filter: 'req.Method == "POST" && req.URL.Path == "/socket.io/" && req.Header.Get("Content-Type") matches "(?i)^text/plain(;|$)"'
     apply:
      - RemoveInBandRuleByID(920420)''')
    if state['appsecExceptions'].get('umamiDelete', True):
        rules.append('''   - filter: 'req.Host == "logs.krychlic.com" && req.Method == "DELETE" && req.URL.Path matches "^/api/websites/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"'
     apply:
      - RemoveInBandRuleByID(911100)''')
    block = '\n'.join(rules)
    (ROOT / 'appsec-configs' / 'proxy-crs.yaml').write_text('''name: proxy/crs
default_remediation: ban
inband_rules:
 - crowdsecurity/crs
''' + ('inband:\n  pre_eval:\n' + block + '\n' if block else ''))

appsec_config()
(ROOT / 'acquis.yaml').write_text('source: syslog\nlisten_addr: 127.0.0.1\nlisten_port: 7423\nlabels:\n  type: nginx\n---\nsource: appsec\nlisten_addr: 127.0.0.1:7422\nappsec_configs:\n - crowdsecurity/appsec-default\n - proxy/crs\nlabels:\n  type: appsec\n')

def save():
    temporary = state_file.with_suffix('.tmp')
    temporary.write_text(json.dumps(state))
    temporary.replace(state_file)

def profiles():
    (ROOT / 'profiles.yaml').write_text('name: proxy_default\nfilters:\n - Alert.Remediation == true && Alert.GetScope() == "Ip"\ndecisions:\n - type: ban\n   duration: ' + state['duration'] + '\non_success: break\n')

profiles()
os.environ['BOUNCER_KEY_proxy'] = key
os.environ['COLLECTIONS'] = 'crowdsecurity/nginx crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/appsec-crs'
child = subprocess.Popen(['/docker_start.sh'])

def stop(_signal, _frame):
    if child.poll() is None:
        child.terminate()

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def cli(*args):
    result = subprocess.run(['cscli', *args], capture_output=True, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError('CrowdSec command failed')
    return result.stdout

def reload_engine():
    # docker_start.sh execs CrowdSec after initialization.
    child.send_signal(signal.SIGHUP)
    time.sleep(0.2)
    for _ in range(40):
        if child.poll() is not None:
            raise RuntimeError('CrowdSec stopped while reloading')
        try:
            with socket.create_connection(('127.0.0.1', 7422), timeout=0.2):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError('CrowdSec reload timed out')

def validate_engine():
    result = subprocess.run(['crowdsec', '-t', '-c', str(ROOT / 'config.yaml')], capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError('CrowdSec configuration validation failed')

def update():
    if not lock.acquire(blocking=False):
        return
    try:
        cli('hub', 'update')
        cli('hub', 'upgrade')
        validate_engine()
        reload_engine()
        state.update(updated=time.time(), error=None)
    except Exception:
        state['error'] = 'Rule update failed; existing rules retained'
    finally:
        save()
        lock.release()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path != '/status':
                return self.respond({'error': 'Not found'}, 404)
            records = json.loads(cli('decisions', 'list', '--all', '--limit', '0', '--no-simu', '-o', 'json')) or []
            decisions = [decision for record in records for decision in (record.get('decisions') or [])]
            alerts = json.loads(cli('alerts', 'list', '-l', '100', '-o', 'json')) or []
            with socket.create_connection(('127.0.0.1', 7422), timeout=1):
                pass
            # Return operational metadata only, not request headers, bodies, or engine credentials.
            self.respond({'available': child.poll() is None, 'updated': state.get('updated'),
                          'error': state.get('error'), 'updating': lock.locked(),
                          'active_bans': sum(d.get('type') == 'ban' and d.get('origin') not in ('CAPI', 'lists') for d in decisions),
                          'decisions': [{k: d.get(k) for k in ('id', 'value', 'scope', 'origin', 'scenario', 'duration', 'type')} for d in decisions[:5000]],
                          'alerts': [{k: a.get(k) for k in ('id', 'scenario', 'created_at', 'source', 'kind', 'remediation')} for a in alerts[:100]]})
        except Exception:
            self.respond({'error': 'CrowdSec is unavailable'}, 503)

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 4096:
                return self.respond({'error': 'Invalid request size'}, 400)
            body = json.loads(self.rfile.read(size))
            if self.path == '/update':
                threading.Thread(target=update, daemon=True).start()
            elif self.path == '/release':
                ip = str(ipaddress.ip_address(body['ip']))
                cli('decisions', 'delete', '--ip', ip)
            elif self.path == '/policy':
                exceptions = body.get('appsecExceptions')
                if (body.get('duration') not in ('1h', '4h', '24h') or not isinstance(body.get('updates'), bool)
                    or not isinstance(exceptions, dict) or set(exceptions) != {'umamiDelete', 'socketIo'}
                    or not all(isinstance(value, bool) for value in exceptions.values())):
                    return self.respond({'error': 'Invalid policy'}, 400)
                if not lock.acquire(blocking=False):
                    return self.respond({'error': 'A rule update is in progress; retry shortly'}, 409)
                try:
                    old = dict(state)
                    try:
                        state.update(duration=body['duration'], updates=body['updates'], appsecExceptions=exceptions)
                        if old['duration'] != state['duration'] or old.get('appsecExceptions') != state['appsecExceptions']:
                            appsec_config()
                            profiles()
                            validate_engine()
                            reload_engine()
                        save()
                    except Exception:
                        state.update(old)
                        appsec_config()
                        profiles()
                        raise
                finally:
                    lock.release()
            else:
                return self.respond({'error': 'Not found'}, 404)
            self.respond({'ok': True})
        except (ValueError, KeyError, TypeError):
            self.respond({'error': 'Invalid request'}, 400)
        except Exception:
            self.respond({'error': 'CrowdSec operation failed'}, 503)

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

sock = IPC / 'crowdsec.sock'
sock.unlink(missing_ok=True)
server = Server(str(sock), Handler)
os.chown(sock, 0, 10000)
sock.chmod(0o660)
threading.Thread(target=server.serve_forever, daemon=True).start()
last_check = time.time()
while child.poll() is None:
    if state['updates'] and time.time() - last_check >= 86400:
        threading.Thread(target=update, daemon=True).start()
        last_check = time.time()
    time.sleep(1)
server.shutdown()
raise SystemExit(child.returncode)
