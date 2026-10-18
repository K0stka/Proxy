import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { defaultPages, parse, snapshotSchema, settingsFromPolicy } from './model.js';

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS data (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    const settings = this.get('settings');
    if (
      settings &&
      ['targets', 'ingressPorts', 'komodo', 'maxRangePorts'].some((key) => key in settings)
    )
      this.set('settings', settingsFromPolicy(settings));
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM data WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db
      .prepare('INSERT INTO data VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  snapshot() {
    return parse(snapshotSchema, this.get('snapshot', { routes: [], pages: defaultPages }));
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
