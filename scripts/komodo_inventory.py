#!/usr/bin/env python3
"""Root-only Compose inventory of the actual active/draining proxy containers."""
import hashlib
import hmac
import fcntl
import json
from pathlib import Path
import urllib.request


def service(container, name, env_path):
    config, host = container['Config'], container['HostConfig']
    environment = config.get('Env', [])
    if any('\n' in value or '\r' in value for value in environment):
        raise ValueError('Multiline container environment cannot be exported safely')
    env_path.write_text('\n'.join(environment) + '\n')
    env_path.chmod(0o600)
    result = {
        'container_name': name, 'image': container['Image'],
        'entrypoint': config.get('Entrypoint') or [], 'command': config.get('Cmd') or [],
        'user': config.get('User', ''), 'working_dir': config.get('WorkingDir', ''),
        'env_file': [{'path': str(env_path), 'format': 'raw'}],
        'restart': host['RestartPolicy']['Name'] or 'no',
        'read_only': host['ReadonlyRootfs'], 'privileged': False,
        'cap_drop': host.get('CapDrop') or [], 'cap_add': host.get('CapAdd') or [],
        'security_opt': host.get('SecurityOpt') or [],
        'init': bool(host.get('Init')), 'pids_limit': host.get('PidsLimit', 0),
        'stop_grace_period': str(config.get('StopTimeout', 10)) + 's',
        'mem_limit': host.get('Memory', 0), 'cpus': host.get('NanoCpus', 0) / 1e9,
        'tmpfs': [path + ':' + options for path, options in (host.get('Tmpfs') or {}).items()],
        'logging': {'driver': host['LogConfig']['Type'], 'options': host['LogConfig'].get('Config') or {}},
        'volumes': [{'type': 'bind' if mount['Type'] == 'bind' else 'volume',
                     'source': mount['Source'] if mount['Type'] == 'bind' else mount['Name'],
                     'target': mount['Destination'], 'read_only': not mount['RW']}
                    for mount in container['Mounts'] if mount['Type'] in ['bind', 'volume']],
    }
    if host.get('CgroupParent'):
        result['cgroup_parent'] = host['CgroupParent']
    if host.get('Ulimits'):
        result['ulimits'] = {item['Name']: {'soft': item['Soft'], 'hard': item['Hard']} for item in host['Ulimits']}
    if host['NetworkMode'] == 'host':
        result['network_mode'] = 'host'
    else:
        result['networks'] = list(container['NetworkSettings']['Networks'])
    return result


def write_inventory(root, state, inspect, atomic):
    services, networks, volumes = {}, {}, {}
    entries = [state['edge'], state['control'], *state['draining']]
    targets = [(entry['container'], None) for entry in entries]
    targets += [('proxy-files-1', 'files'), ('proxy-certificates-1', 'certificates')]
    for identifier, fixed in targets:
        container = inspect(identifier)
        name = container['Name'].lstrip('/')
        key = fixed or name
        services[key] = service(container, name, root / (key + '.env'))
        for network in services[key].get('networks', []):
            networks[network] = {'external': True, 'name': network}
        for mount in services[key]['volumes']:
            if mount['type'] == 'volume':
                volumes[mount['source']] = {'external': True, 'name': mount['source']}
    manifest = {'name': 'proxy', 'services': services, 'networks': networks, 'volumes': volumes}
    atomic(root / 'compose.json', manifest)


def update_running():
    try:
        lock = open('/var/lib/proxy-security-updates/update.lock', 'r')
    except FileNotFoundError:
        return False
    with lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
    return False


def notify(root):
    """A signed webhook can refresh only this fixed Komodo Action, not administer Core."""
    settings = root / 'komodo.json'
    if not settings.exists() or update_running():
        return False
    config = json.loads(settings.read_text())
    body = b'{"ref":"refs/heads/main"}'
    signature = hmac.new(config['secret'].encode(), body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(config['url'], data=body, headers={
        'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + signature,
        'X-GitHub-Event': 'push',
    })
    with urllib.request.urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise RuntimeError('Komodo inventory refresh was not accepted')
    return True
