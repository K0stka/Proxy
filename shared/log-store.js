import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Problem } from './model.js';
import { isIP } from 'node:net';

export const LOG_DAYS = 30, LOG_BYTES = 128 * 1024 * 1024;
export function logBounds(params) {
  const from = params.get('from'), to = params.get('to');
  if (from === null && to === null) return {};
  if (![from, to].every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))) ||
      Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 32 * 86400000)
    throw new Problem(400, 'Invalid log period');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
export function logQuery(params) {
  const before = params.get('before'), service = params.get('service') ?? 'all', kind = params.get('kind') ?? 'all';
  const source = params.get('source') ?? '';
  const beforeTime = params.get('beforeTime');
  const services = params.has('services') ? (params.get('services') ? params.get('services').split(',') : []) : null;
  if ((before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) ||
      !/^(all|catch-all|management|[0-9a-f-]{36})$/.test(service) ||
      !['all', 'traffic', 'alert', 'audit', 'operation'].includes(kind) || (source && !isIP(source)) ||
      (services && (services.length > 512 || services.some((id) => !/^(catch-all|management|[0-9a-f-]{36})$/.test(id)))) ||
      (beforeTime !== null && (before === null || !Number.isFinite(Date.parse(beforeTime)))))
    throw new Problem(400, 'Invalid log filter');
  return { before: before === null ? null : Number(before), beforeTime: beforeTime === null ? null : new Date(beforeTime).toISOString(), service, services, kind, source, ...logBounds(params) };
}

export class LogStore {
  constructor(file, { now = Date.now, maxBytes = LOG_BYTES } = {}) {
    this.file = file; this.now = now; this.maxBytes = maxBytes; this.pending = []; this.error = null;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=1000; PRAGMA max_page_count=131072; PRAGMA wal_autocheckpoint=256;
      PRAGMA journal_size_limit=4194304;
      CREATE TABLE IF NOT EXISTS log_stats (id INTEGER PRIMARY KEY, written INTEGER, bytes INTEGER, count INTEGER);
      INSERT OR IGNORE INTO log_stats VALUES (1,0,0,0);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL,
        service TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS log_time ON logs(time);
      CREATE INDEX IF NOT EXISTS log_position ON logs(position);
      CREATE INDEX IF NOT EXISTS log_kind ON logs(kind,id);
      CREATE TRIGGER IF NOT EXISTS log_added AFTER INSERT ON logs BEGIN
        UPDATE log_stats SET bytes=bytes+NEW.bytes, count=count+1 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS log_removed AFTER DELETE ON logs BEGIN
        UPDATE log_stats SET bytes=bytes-OLD.bytes, count=count-1 WHERE id=1; END;`);
    this.flush();
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }
  append(event) {
    const data = JSON.stringify(event);
    if (Buffer.byteLength(data) > 32768) return;
    this.pending.push(event);
    if (this.pending.length >= 256) this.flush();
  }
  flush() {
    if (!this.pending.length && this.lastCleanup !== undefined && this.now() - this.lastCleanup < 60000) return;
    const batch = this.pending.splice(0);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      let { written } = this.db.prepare('SELECT written FROM log_stats WHERE id=1').get();
      const insert = this.db.prepare('INSERT INTO logs(time,service,kind,position,bytes,data) VALUES (?,?,?,?,?,?)');
      for (const e of batch) {
        const data = JSON.stringify(e), bytes = Buffer.byteLength(data);
        insert.run(e.time, e.service, e.type, written, bytes, data);
        written += bytes;
      }
      this.db.prepare('UPDATE log_stats SET written=? WHERE id=1').run(written);
      this.db.prepare('DELETE FROM logs WHERE position<?').run(written - this.maxBytes);
      this.db.prepare('DELETE FROM logs WHERE time<?').run(new Date(this.now() - LOG_DAYS * 86400000).toISOString());
      this.db.exec('COMMIT');
      if (batch.length || !this.error) this.error = null;
      this.lastCleanup = this.now();
    } catch {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.error = 'Log persistence failed; recent events may be missing. Check disk space and permissions.';
    }
  }
  history({ before = null, beforeTime = null, service = 'all', services = null, kind = 'all', source = '', from = null, to = null } = {}) {
    this.flush();
    const selection = services === null ? service === 'all' ? null : JSON.stringify([service]) : JSON.stringify(services);
    const rows = this.db.prepare(`SELECT id,data FROM logs WHERE
      ((? IS NULL AND (? IS NULL OR id<?)) OR (? IS NOT NULL AND (time<? OR (time=? AND id<?))))
      AND (? IS NULL OR service IN (SELECT value FROM json_each(?))) AND (?='all' OR kind=?)
      AND (?='' OR json_extract(data,'$.source')=?)
      AND (? IS NULL OR time>=?) AND (? IS NULL OR time<?) ORDER BY time DESC,id DESC LIMIT 101`)
      .all(beforeTime, before, before, beforeTime, beforeTime, beforeTime, before, selection, selection, kind, kind, source, source, from, from, to, to);
    const page = rows.slice(0, 100);
    return { events: page.map((r) => ({ ...JSON.parse(r.data), id: r.id })),
      next: rows.length > 100 ? page.at(-1).id : null, storage: this.status() };
  }
  alertsAfter(id) {
    this.flush();
    return this.db.prepare("SELECT id,data FROM logs WHERE kind='alert' AND id>? ORDER BY id LIMIT 100")
      .all(id).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
  }
  latestId() {
    this.flush();
    return this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM logs').get().id;
  }
  summary({ from = new Date((Math.floor(this.now() / 60000) - 59) * 60000).toISOString(),
    to = new Date(this.now() + 1).toISOString(), service = 'all', services = null, kind = 'all', source = '' } = {}) {
    const selection = services === null ? service === 'all' ? null : JSON.stringify([service]) : JSON.stringify(services);
    const key = JSON.stringify([from, to, selection, kind, source]);
    if (this.summaryCache?.key === key && this.now() - this.summaryCache.at < 10000) return this.summaryCache.value;
    this.flush();
    const start = Date.parse(from), end = Date.parse(to), step = Math.max(60000, Math.ceil((end - start) / 60 / 60000) * 60000);
    const rows = this.db.prepare(`SELECT CAST((CAST(strftime('%s',time) AS INTEGER)*1000-?)/? AS INTEGER) AS bucket,
      COUNT(*) AS count, COUNT(DISTINCT json_extract(data,'$.source')) AS sources,
      SUM(kind='traffic') AS requests, SUM(kind='alert') AS alerts,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER)<400) AS success,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER) BETWEEN 400 AND 499) AS clientErrors,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER)>=500) AS serverErrors
      FROM logs WHERE time>=? AND time<? AND (? IS NULL OR service IN (SELECT value FROM json_each(?))) AND (?='all' OR kind=?)
      AND (?='' OR json_extract(data,'$.source')=?) GROUP BY bucket ORDER BY bucket`)
      .all(start, step, from, to, selection, selection, kind, kind, source, source);
    const grouped = new Map(rows.map((r) => [r.bucket, r]));
    const buckets = Array.from({ length: Math.ceil((end - start) / step) }, (_, i) => ({ minute: (start + i * step) / 60000, requests: 0,
      count: 0, alerts: 0, success: 0, clientErrors: 0, serverErrors: 0, ...grouped.get(i) }));
    const totals = buckets.reduce((sum, bucket) => {
      for (const key of ['count', 'requests', 'alerts', 'success', 'clientErrors', 'serverErrors']) sum[key] += bucket[key] ?? 0;
      return sum;
    }, { count: 0, requests: 0, alerts: 0, success: 0, clientErrors: 0, serverErrors: 0 });
    const value = { buckets, totals, from, to, step };
    this.summaryCache = { at: this.now(), key, value };
    return value;
  }
  status() {
    const totals = this.db.prepare('SELECT bytes,count FROM log_stats WHERE id=1').get();
    const oldest = this.db.prepare('SELECT time FROM logs ORDER BY id LIMIT 1').get()?.time ?? null;
    let diskBytes = 0;
    if (this.file !== ':memory:') for (const suffix of ['', '-wal', '-shm'])
      try { diskBytes += statSync(this.file + suffix).size; } catch {}
    return { ...totals, diskBytes, oldest, maxBytes: this.maxBytes, days: LOG_DAYS, error: this.error };
  }
  close() { clearInterval(this.timer); this.flush(); this.db.close(); }
}
