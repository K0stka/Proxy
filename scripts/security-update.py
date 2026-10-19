#!/usr/bin/env python3
"""Root-owned daily rebuild/test/deploy job. Never changes host firewall or SSH."""
import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

SERVICES = ('control', 'edge', 'files', 'certificates')
TEMPLATE_PATH = Path('/var/lib/proxy-handoff/templates.json')


def run(args, *, cwd=None, capture=False, **kwargs):
    # Git checkout files become non-root container inputs; private state keeps 0077.
    if args[0] == 'git':
        kwargs.setdefault('umask', 0o022)
    return subprocess.check_output(args, cwd=cwd, text=True, **kwargs) if capture else subprocess.check_call(args, cwd=cwd, **kwargs)


def compose(directory):
    args = ['docker', 'compose', '-p', 'proxy', '--env-file', str(directory / '.env')]
    for name in ('compose.yaml', 'compose.paths.yaml', 'compose.ssh.yaml'):
        if (directory / name).exists() and (name != 'compose.ssh.yaml' or os.environ.get('PROXY_UPDATE_SSH', 'true') == 'true'):
            args += ['-f', str(directory / name)]
    return args


def containers():
    state_file = Path('/var/lib/proxy-handoff/state.json')
    generations = json.loads(state_file.read_text()) if state_file.exists() else {}
    return [json.loads(run(['docker', 'inspect', generations[service]['container']
                           if service in generations else 'proxy-' + service + '-1'], capture=True))[0]
            for service in SERVICES]


def handoff(images):
    import socket
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(self.timeout)
            config = json.loads(Path('/var/lib/proxy-handoff/templates.json').read_text())
            self.sock.connect(str(Path(config['ipc']) / 'edge.sock'))
    connection = Connection('localhost', timeout=90)
    try:
        connection.request('POST', '/deploy', json.dumps(images), {'Content-Type': 'application/json'})
        response = connection.getresponse()
        response.read()
        if response.status != 200:
            raise RuntimeError('Connection-preserving deployment failed')
    finally:
        connection.close()


def rollback_images(previous):
    for service, container in zip(SERVICES, previous):
        run(['docker', 'tag', container['Image'], 'proxy-' + service])


def rollback_configuration(config):
    changes = ['LABEL org.krychlic.proxy.managed=true']
    for name in ('Entrypoint', 'Cmd'):
        if config.get(name):
            changes.append(name.upper() + ' ' + json.dumps(config[name]))
    for name, directive in [('User', 'USER'), ('WorkingDir', 'WORKDIR')]:
        if config.get(name):
            changes.append(directive + ' ' + config[name])
    for value in config.get('Env', []):
        key, data = value.split('=', 1)
        if not any(secret in key.upper() for secret in ('TOKEN', 'SECRET', 'KEY', 'PASSWORD')):
            changes.append('ENV ' + key + '=' + json.dumps(data))
    return changes


def preserve_images(previous, work):
    for service, container in zip(SERVICES, previous):
        present = subprocess.run(['docker', 'image', 'inspect', container['Image']],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if not present:
            # A running container can outlive pruned image metadata. Export excludes
            # mounted state/keys; import explicitly excludes runtime secret variables.
            print('Reconstructing missing rollback image for ' + service, flush=True)
            archive = work / (service + '-rootfs.tar')
            try:
                run(['docker', 'export', '--output', str(archive), container['Id']])
                changes = rollback_configuration(container['Config'])
                command = ['docker', 'import']
                for change in changes:
                    command += ['--change', change]
                container['Image'] = run(command + [str(archive)], capture=True).strip()
            finally:
                archive.unlink(missing_ok=True)
        run(['docker', 'tag', container['Image'], 'proxy-rollback-' + service + ':latest'])


def health(previous, admin_host, isolation=True):
    for container in containers():
        if not container['State']['Running'] or container['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
            return False
    origin = dict(value.split('=', 1) for value in previous[0]['Config']['Env'])['PROXY_ORIGIN']
    connection = http.client.HTTPConnection('127.0.0.1', 3001, timeout=5)
    try:
        connection.request('GET', '/api/auth/status', headers={'Host': urlparse(origin).netloc})
        response = connection.getresponse()
        if response.status != 200 or not json.loads(response.read()).get('enrolled'):
            return False
    finally:
        connection.close()
    if admin_host:
        probes = [('/api/auth/status', 200), ('/api/state', 401)]
        if isolation:
            probes.append(('/_proxy/errors/404/index.html', 404))
        for path, expected in probes:
            try:
                with urllib.request.urlopen('https://' + admin_host + path, timeout=5) as response:
                    status = response.status
            except urllib.error.HTTPError as error:
                status = error.code
            if status != expected:
                return False
    return True


def deploy(directory, previous, admin_host, rollback_file, check=health,
           rollback_check=lambda previous, host: health(previous, host, isolation=False),
           wait=time.sleep, attempts=36, managed=None, rollback_templates=None):
    if managed is None:
        managed = Path('/var/lib/proxy-handoff/state.json').exists()
    switched = False
    inventory_managed = managed and Path('/var/lib/proxy-handoff/templates.json').exists() and json.loads(
        Path('/var/lib/proxy-handoff/templates.json').read_text()).get('komodoManaged', False)
    selected_services = ['files', 'certificates'] if inventory_managed else []
    try:
        if managed:
            images = {service: run(['docker', 'image', 'inspect', 'proxy-' + service,
                                   '--format', '{{.Id}}'], capture=True).strip() for service in ['control', 'edge']}
            handoff(images)
            switched = True
        run(compose(directory) + ['up', '-d', '--no-build', '--pull', 'never', *selected_services])
        for _ in range(attempts):
            try:
                if check(previous, admin_host):
                    return
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
            wait(5)
        raise RuntimeError('Candidate health verification failed')
    except BaseException:
        if rollback_templates is not None:
            temporary = TEMPLATE_PATH.with_suffix('.restore')
            shutil.copyfile(rollback_templates, temporary)
            temporary.chmod(0o600)
            temporary.replace(TEMPLATE_PATH)
        if switched:
            handoff({service: previous[SERVICES.index(service)]['Image'] for service in ['control', 'edge']})
        rollback_images(previous)
        run(compose(directory) + ['-f', str(rollback_file), 'up', '-d', '--no-build', '--pull', 'never', *selected_services])
        for _ in range(attempts):
            try:
                if rollback_check(previous, admin_host):
                    break
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
            wait(5)
        else:
            raise RuntimeError('Candidate and rollback health verification failed; operator attention required')
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path('/etc/komodo/stacks/proxy'))
    parser.add_argument('--state', type=Path, default=Path('/var/lib/proxy-security-updates'))
    args = parser.parse_args()
    os.umask(0o077)
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = open(args.state / 'update.lock', 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Another proxy security update is running', flush=True)
        return
    repo = args.repo.resolve(strict=True)
    if run(['git', 'status', '--porcelain'], cwd=repo, capture=True).strip():
        raise RuntimeError('Deployment checkout has local changes; refusing to overwrite them')
    if shutil.disk_usage(args.state).free < 5 * 1024 ** 3:
        raise RuntimeError('At least 5 GiB of free disk space is required')
    previous = containers()
    configuration = json.loads(run(compose(repo) + ['config', '--format', 'json'], capture=True))
    # This updater supports this deployment's explicit host-storage overrides only.
    state_mount = next(m for m in configuration['services']['control']['volumes'] if m['target'] == '/state')
    if state_mount['type'] != 'bind':
        raise RuntimeError('Set compose.paths.yaml host storage before enabling this updater')
    db_path = Path(state_mount['source']) / 'proxy.db'
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as database:
        settings = json.loads(database.execute("SELECT value FROM data WHERE key='settings'").fetchone()[0])
    run(['git', 'fetch', 'origin', 'main'], cwd=repo)
    run(['git', 'merge-base', '--is-ancestor', 'HEAD', 'origin/main'], cwd=repo)
    revision = run(['git', 'rev-parse', 'origin/main'], cwd=repo, capture=True).strip()
    environment_hash = hashlib.sha256((repo / '.env').read_bytes()).digest()
    work = Path(tempfile.mkdtemp(prefix='run-', dir=args.state))
    template_backup = work / 'rollback.templates.json' if TEMPLATE_PATH.exists() else None
    if template_backup is not None:
        shutil.copyfile(TEMPLATE_PATH, template_backup)
    preserve_images(previous, work)
    rollback_file = work / 'rollback.compose.json'
    rollback_file.write_text(json.dumps({'services': {service: {'image': container['Image']} for service, container in zip(SERVICES, previous)}}))
    with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(work / 'control-backup.db') as destination:
            source.backup(destination)
    candidate = work / 'source'
    candidate.mkdir()
    with tempfile.TemporaryFile() as archive:
        subprocess.check_call(['git', 'archive', revision], cwd=repo, stdout=archive)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as source:
            source.extractall(candidate, filter='data')
    shutil.copyfile(repo / '.env', candidate / '.env')
    try:
        # No build/pull operation may change a running container before these tests pass.
        run(['docker', 'build', '--pull', '-f', 'containers/check.Dockerfile', '-t', 'proxy-security-check', '.'], cwd=candidate)
        for service in SERVICES:
            run(compose(candidate) + ['build', '--pull', '--no-cache', service], cwd=candidate)
        run(['docker', 'run', '--rm', '--memory', '768m', '--cpus', '1',
             '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
             '--env', 'PROXY_SKIP_BUILD=true', '--env', 'PROXY_TEST_SOURCE=' + str(candidate),
             'proxy-security-check'])
        if [c['Id'] for c in containers()] != [c['Id'] for c in previous] or environment_hash != hashlib.sha256((repo / '.env').read_bytes()).digest():
            raise RuntimeError('Deployment changed during validation; refusing concurrent deployment')
        if run(['git', 'status', '--porcelain'], cwd=repo, capture=True).strip():
            raise RuntimeError('Checkout changed during validation')
        run(['git', 'merge', '--ff-only', revision], cwd=repo)
        if Path('/var/lib/proxy-handoff/state.json').exists():
            template_path = Path('/var/lib/proxy-handoff/templates.json')
            templates = json.loads(template_path.read_text())
            if templates.get('komodoManaged'):
                fresh = json.loads(run(compose(repo) + ['config', '--format', 'json'], capture=True))
                for service in ['control', 'edge']:
                    templates[service]['config']['Env'] = [key + '=' + str(value) for key, value in
                        fresh['services'][service].get('environment', {}).items() if value is not None]
                temporary = template_path.with_suffix('.new')
                temporary.write_text(json.dumps(templates)); temporary.chmod(0o600); temporary.replace(template_path)
            mapping_path = Path('/var/lib/proxy-handoff/image-revisions.json')
            mapping = json.loads(mapping_path.read_text()) if mapping_path.exists() else {}
            for service in ['control', 'edge']:
                image = run(['docker', 'image', 'inspect', 'proxy-' + service, '--format', '{{.Id}}'], capture=True).strip()
                mapping[image] = revision
            temporary = mapping_path.with_suffix('.new')
            temporary.write_text(json.dumps(mapping))
            temporary.chmod(0o600)
            temporary.replace(mapping_path)
        deploy(repo, previous, settings.get('adminHostname'), rollback_file, rollback_templates=template_backup)
    except BaseException:
        # Do not overwrite tags from a concurrent Komodo deployment. deploy() handles
        # its own rollback after it starts replacing running containers.
        if template_backup is not None:
            temporary = TEMPLATE_PATH.with_suffix('.restore')
            shutil.copyfile(template_backup, temporary)
            temporary.chmod(0o600)
            temporary.replace(TEMPLATE_PATH)
        if [c['Id'] for c in containers()] == [c['Id'] for c in previous]:
            rollback_images(previous)
        raise
    finally:
        # Candidate .env is never kept with the retained rollback metadata.
        if candidate.exists():
            shutil.rmtree(candidate)
    (args.state / 'last-success.json').write_text(json.dumps({
        'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'revision': revision,
        'backup': str(work / 'control-backup.db'),
    }))
    # Keep the current rollback images and seven private SQLite recovery snapshots.
    for old in sorted(args.state.glob('run-*'), key=lambda p: p.stat().st_mtime, reverse=True)[7:]:
        if old.is_dir() and not old.is_symlink() and old.parent.resolve() == args.state.resolve():
            shutil.rmtree(old)
    run(['docker', 'image', 'prune', '-f', '--filter', 'label=org.krychlic.proxy.managed=true'])
    print('Proxy security update passed tests and health verification', flush=True)
    print('PROXY_DEPLOYED_REVISION=' + revision, flush=True)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        main()
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print('Proxy security update failed: ' + detail, file=sys.stderr, flush=True)
        sys.exit(1)
