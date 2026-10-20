#!/usr/bin/env python3
"""Root-owned setup and bounded import of legacy history into the external log volume."""
import argparse
from contextlib import closing
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sqlite3
import subprocess
import sys

CONFIG = Path('/var/lib/proxy-handoff/log-storage.json')
SCHEMA = '''
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS log_stats(id INTEGER PRIMARY KEY,written INTEGER,bytes INTEGER,count INTEGER);
INSERT OR IGNORE INTO log_stats VALUES(1,0,0,0);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT NOT NULL,
 service TEXT NOT NULL,kind TEXT NOT NULL,position INTEGER NOT NULL,bytes INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS log_time ON logs(time);
CREATE INDEX IF NOT EXISTS log_position ON logs(position);
CREATE INDEX IF NOT EXISTS log_kind ON logs(kind,id);
CREATE TRIGGER IF NOT EXISTS log_added AFTER INSERT ON logs BEGIN
 UPDATE log_stats SET bytes=bytes+NEW.bytes,count=count+1 WHERE id=1; END;
CREATE TRIGGER IF NOT EXISTS log_removed AFTER DELETE ON logs BEGIN
 UPDATE log_stats SET bytes=bytes-OLD.bytes,count=count-1 WHERE id=1; END;
CREATE TABLE IF NOT EXISTS log_imports(source TEXT PRIMARY KEY,last_id INTEGER NOT NULL);
'''


def import_rows(database, source, rows):
    """Runs as the owning application UID, including creation of SQLite WAL files."""
    with closing(sqlite3.connect(database, timeout=5)) as db, db:
        db.executescript(SCHEMA)
        db.execute('BEGIN IMMEDIATE')
        last = db.execute('SELECT last_id FROM log_imports WHERE source=?', (source,)).fetchone()
        last = last[0] if last else 0
        written = db.execute('SELECT written FROM log_stats WHERE id=1').fetchone()[0]
        for identifier, timestamp, service, kind, data in rows:
            if identifier <= last:
                continue
            size = len(data.encode())
            db.execute('INSERT INTO logs(time,service,kind,position,bytes,data) VALUES(?,?,?,?,?,?)',
                       (timestamp, service, kind, written, size, data))
            written += size
            last = identifier
        db.execute('UPDATE log_stats SET written=? WHERE id=1', (written,))
        db.execute('INSERT INTO log_imports VALUES(?,?) ON CONFLICT(source) DO UPDATE SET last_id=excluded.last_id', (source, last))
        db.execute('DELETE FROM logs WHERE position<?', (written - 128 * 1024 * 1024,))
        cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        db.execute('DELETE FROM logs WHERE time<?', (cutoff,))
    return last


def save(config):
    temporary = CONFIG.with_suffix('.new')
    temporary.write_text(json.dumps(config))
    temporary.chmod(0o600)
    temporary.replace(CONFIG)


def deployment_rows(source, cursor=0):
    labels = {'spawned': 'Spawned new generation', 'switched': 'Activated new edge generation',
              'retired': 'Outdated generation stopped after draining',
              'forced_retirement': 'Force terminated generation', 'rollback': 'Deployment rolled back',
              'candidate_failed': 'New generation failed', 'abandoned_candidate': 'Abandoned generation removed',
              'operator_stopped': 'Generation stopped by operator'}
    rows = []
    with source.open('rb') as stream:
        stream.seek(cursor)
        for _ in range(1000):
            line = stream.readline(32769)
            if not line or not line.endswith(b'\n') or len(line) > 32768:
                break
            cursor = stream.tell()
            try:
                raw = json.loads(line)
                event = raw['event'].removeprefix('deployment.')
                timestamp = datetime.datetime.fromisoformat(raw['time']).astimezone(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
                record = {'time': timestamp, 'type': 'operation', 'service': 'management',
                          'event': labels.get(event, raw['event']),
                          'severity': 'warning' if event in ['forced_retirement', 'rollback', 'candidate_failed'] else 'info',
                          'generation': raw.get('generation'), 'role': raw.get('role'),
                          'details': ', '.join(f'{key}: {raw[key]}' for key in
                                              ['name', 'reason', 'remainingConnections', 'retiring', 'retirementDeadline'] if key in raw)}
                rows.append((cursor, timestamp, 'management', 'operation', json.dumps(record)))
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
    return rows, cursor


def sync(config=None, *, complete=False):
    if config is None:
        if not CONFIG.exists():
            return
        config = json.loads(CONFIG.read_text())
    root = Path(config['root'])
    # Import host events as the controller UID so its SQLite files stay writable.
    source = root / 'host/deployments.jsonl'
    if source.exists():
        identity = f'{source.stat().st_dev}:{source.stat().st_ino}'
        cursor = config.setdefault('deploymentCursors', {}).get(identity, 0)
        if cursor > source.stat().st_size:
            cursor = 0
        while True:
            rows, next_cursor = deployment_rows(source, cursor)
            if rows:
                subprocess.run([sys.executable, __file__, 'import', str(root / 'control/logs.db'), 'deployments:' + identity],
                               input=json.dumps(rows), capture_output=True, text=True, check=True,
                               user=10001, group=10000, extra_groups=[])
            config['deploymentCursors'][identity] = next_cursor
            if not complete or next_cursor == cursor:
                break
            cursor = next_cursor
    state = json.loads((CONFIG.parent / 'state.json').read_text())
    known = {item['path'] for item in config['sources']}
    for entry in [state['edge'], *state['draining']]:
        if entry['role'] == 'edge':
            path = str(Path(entry['socket']).parent / 'logs.db')
            if path not in known and Path(path).exists():
                config['sources'].append({'role': 'edge', 'path': path, 'key': hashlib.sha256(path.encode()).hexdigest()})
    for item in config['sources']:
        source = Path(item['path'])
        if source.exists():
            identity = str(source.stat().st_dev) + ':' + str(source.stat().st_ino)
            if item.get('identity', identity) != identity:
                item['key'] = hashlib.sha256((item['path'] + identity).encode()).hexdigest()
                item['last'] = 0
            item['identity'] = identity
        if not source.exists() and item.get('backup'):
            source = Path(item['backup'])
        if not source.exists():
            continue
        if source.is_symlink() or not stat.S_ISREG(source.stat().st_mode):
            raise RuntimeError('Legacy log source must be a regular database')
        while True:
            uri = source.as_uri() + ('?mode=ro' if Path(str(source) + '-shm').exists() else '?mode=ro&immutable=1')
            with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
                db.execute('PRAGMA trusted_schema=OFF')
                db.execute('PRAGMA query_only=ON')
                rows = db.execute('SELECT id,time,service,kind,data FROM logs WHERE id>? ORDER BY id LIMIT 1000', (item.get('last', 0),)).fetchall()
            if not rows:
                break
            role = item['role']
            result = subprocess.run([sys.executable, __file__, 'import', str(root / role / 'logs.db'), item['key']],
                                    input=json.dumps(rows), capture_output=True, text=True, check=True,
                                    user=10002 if role == 'edge' else 10001, group=10000, extra_groups=[])
            item['last'] = int(result.stdout)
            if not complete:
                break
    # Legacy controllers can continue appending during their one-hour drain.
    source = Path('/var/log/proxy-management-audit/events.jsonl')
    if source.exists():
        with source.open('rb') as old, (root / 'audit/events.jsonl').open('ab') as target:
            identity = str(source.stat().st_ino)
            cursor = config.setdefault('auditCursors', {}).get(identity, 0)
            old.seek(cursor)
            for line in old:
                if not line.endswith(b'\n'):
                    break
                target.write(line)
                cursor += len(line)
            config['auditCursors'][identity] = cursor
    save(config)


def enable(config):
    templates = CONFIG.parent / 'templates.json'
    settings = json.loads(templates.read_text())
    settings['logVolume'] = config['volume']
    temporary = templates.with_suffix('.logs-new')
    temporary.write_text(json.dumps(settings))
    temporary.chmod(0o600)
    temporary.replace(templates)


def prepare():
    if CONFIG.exists():
        config = json.loads(CONFIG.read_text())
        sync(config, complete=True)
        enable(config)
        return
    volume = 'proxy_logs'
    subprocess.run(['docker', 'volume', 'create', '--label', 'org.krychlic.proxy.persistent=logs', volume], check=True, stdout=subprocess.DEVNULL)
    info = json.loads(subprocess.check_output(['docker', 'volume', 'inspect', volume]))[0]
    if info['Driver'] != 'local':
        raise RuntimeError('Log migration requires a local Docker volume')
    root = Path('/var/lib/proxylogs')
    if subprocess.run(['mountpoint', '-q', str(root)]).returncode != 0 or not os.path.samefile(root, info['Mountpoint']):
        raise RuntimeError('Start var-lib-proxylogs.mount before preparing log storage')
    root.chmod(0o755)
    for name, uid, mode in [('edge', 10002, 0o700), ('control', 10001, 0o700), ('audit', 0, 0o750), ('host', 0, 0o700)]:
        path = root / name
        path.mkdir(mode=mode, exist_ok=True)
        os.chown(path, uid, 10000)
        path.chmod(mode)
    audit = root / 'audit/events.jsonl'
    audit.touch(mode=0o600, exist_ok=True)
    os.chown(audit, 10001, 10000)
    audit.chmod(0o600)
    templates = json.loads((CONFIG.parent / 'templates.json').read_text())
    paths = {role: {Path(m['Source']) / 'logs.db' for m in templates[role]['mounts']
                    if m['Destination'] == ('/state' if role == 'control' else '/runtime')}
             for role in ['control', 'edge']}
    state = json.loads((CONFIG.parent / 'state.json').read_text())
    for entry in [state['edge'], *state['draining']]:
        if entry['role'] == 'edge':
            paths['edge'].add(Path(entry['socket']).parent / 'logs.db')
    sources = []
    manifest = root / 'host/migration-backups/sources.json'
    backups = json.loads(manifest.read_text()) if manifest.exists() else []
    for role, candidates in paths.items():
        for source in sorted(candidates):
            if source.exists():
                sources.append({'role': role, 'path': str(source), 'key': hashlib.sha256(str(source).encode()).hexdigest()})
    for backup in backups:
        item = next((item for item in sources if item['path'] == backup['path']), None)
        if item:
            item['backup'] = backup['backup']
        else:
            sources.append({**backup, 'key': hashlib.sha256(backup['path'].encode()).hexdigest()})
    config = {'volume': volume, 'root': str(root), 'sources': sources}
    for source, target in [('/var/log/proxy-deployments.jsonl', root / 'host/deployments.jsonl')]:
        for old in Path(source).parent.glob(Path(source).name + '*'):
            shutil.copy2(old, target.parent / (target.name + old.name[len(Path(source).name):]))
    old_updates = Path('/var/log/proxy-updates')
    if old_updates.exists():
        shutil.copytree(old_updates, root / 'host/updates', dirs_exist_ok=True)
    for old in Path('/var/log/proxy-management-audit').glob('events.jsonl.*'):
        shutil.copy2(old, root / 'audit' / old.name)
    save(config)
    sync(config, complete=True)
    enable(config)
    print('Persistent log volume ready: ' + volume)


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'sync', 'import'])
    parser.add_argument('database', nargs='?')
    parser.add_argument('source', nargs='?')
    args = parser.parse_args()
    if args.operation == 'import':
        print(import_rows(args.database, args.source, json.load(sys.stdin)))
    elif os.getuid() != 0:
        raise PermissionError('Host administrator required')
    elif args.operation == 'prepare':
        prepare()
    else:
        sync(complete=True)
