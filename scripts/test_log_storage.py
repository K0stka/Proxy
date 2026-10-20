import datetime
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('log_storage', Path(__file__).with_name('proxy_log_storage.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class LogStorageTests(unittest.TestCase):
    def test_deployment_events_import_once_with_generation_details_and_partial_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'deployments.jsonl'
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            events = [{'time': now, 'event': 'deployment.' + name, 'generation': 'edge-123', 'role': 'edge',
                       'remainingConnections': 2, 'secret': 'never copy arbitrary fields'}
                      for name in ['spawned', 'forced_retirement', 'retired']]
            source.write_bytes(('\n'.join(json.dumps(e) for e in events) + '\n{"incomplete":').encode())
            rows, cursor = storage.deployment_rows(source)
            self.assertEqual(len(rows), 3)
            self.assertEqual(storage.deployment_rows(source, cursor), ([], cursor))
            records = [json.loads(row[4]) for row in rows]
            self.assertEqual([r['event'] for r in records], ['Spawned new generation', 'Force terminated generation', 'Outdated generation stopped after draining'])
            self.assertEqual(records[1]['severity'], 'warning')
            self.assertTrue(all(r['generation'] == 'edge-123' and r['role'] == 'edge' for r in records))
            self.assertNotIn('never copy', json.dumps(records))
            target = Path(directory) / 'logs.db'
            storage.import_rows(target, 'host', rows)
            storage.import_rows(target, 'host', rows)
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM logs').fetchone()[0], 3)

    def test_import_is_incremental_idempotent_and_combines_generations(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'logs.db'
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            def row(identifier, name):
                data = json.dumps({'time': now, 'service': 'catch-all', 'type': 'traffic', 'event': name})
                return (identifier, now, 'catch-all', 'traffic', data)
            self.assertEqual(storage.import_rows(target, 'old-edge', [row(1, 'first'), row(2, 'second')]), 2)
            self.assertEqual(storage.import_rows(target, 'old-edge', [row(1, 'first'), row(2, 'second'), row(3, 'third')]), 3)
            storage.import_rows(target, 'other-edge', [row(1, 'other')])
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM logs').fetchone()[0], 4)
                self.assertEqual(db.execute('SELECT count FROM log_stats').fetchone()[0], 4)
                self.assertEqual(db.execute('SELECT bytes FROM log_stats').fetchone()[0],
                                 db.execute('SELECT sum(bytes) FROM logs').fetchone()[0])
                self.assertEqual(db.execute('SELECT max(id) FROM logs').fetchone()[0], 4)

    def test_failed_import_rolls_back_rows_and_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'logs.db'
            with self.assertRaises(sqlite3.IntegrityError):
                storage.import_rows(target, 'source', [(1, 'now', 'catch-all', 'traffic', '{}'), (2, None, 'catch-all', 'traffic', '{}')])
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM logs').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT count(*) FROM log_imports').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
