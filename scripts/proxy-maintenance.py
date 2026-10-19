#!/usr/bin/env python3
"""Fixed root commands invoked by Komodo; accepts no shell commands or Docker options."""
import argparse
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess


def broker(path):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(120)
            config = json.loads(Path('/var/lib/proxy-handoff/templates.json').read_text())
            self.sock.connect(str(Path(config['ipc']) / 'edge.sock'))
    with closing(Connection('localhost', timeout=120)) as connection:
        connection.request('POST', path, '{}', {'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError('Broker operation failed: HTTP ' + str(response.status))
        return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['update', 'status', 'inventory', 'retire-draining'])
    args = parser.parse_args()
    if os.getuid() != 0:
        raise PermissionError('Host administrator required')
    if args.operation == 'update':
        # Komodo owns the environment; the build checkout stays independent so
        # inventory refreshes cannot change source/environment during validation.
        environment = Path('/etc/komodo/repos/proxy/.env')
        target = Path('/etc/komodo/stacks/proxy/.env')
        temporary = target.with_suffix('.komodo-new')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write(environment.read_bytes())
        temporary.chmod(0o600)
        temporary.replace(target)
        subprocess.run(['/usr/local/lib/proxy-security-update.py'], check=True)
        broker('/inventory')
    elif args.operation in ['inventory', 'retire-draining']:
        print(json.dumps(broker('/' + args.operation)), flush=True)
    result = json.loads(Path('/var/lib/proxy-security-updates/last-success.json').read_text())
    print('PROXY_DEPLOYED_REVISION=' + result['revision'], flush=True)
    state = json.loads(Path('/var/lib/proxy-handoff/state.json').read_text())
    print('PROXY_PAUSED=' + ('1' if state.get('paused') else '0'), flush=True)


if __name__ == '__main__':
    main()
