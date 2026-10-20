import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Problem } from './model.js';
import { isIP } from 'node:net';

export const LOG_DAYS = 30, LOG_BYTES = 128 * 1024 * 1024;
const filterColumns = {
  time: 'time', service: 'service', event: "json_extract(data,'$.event')",
  action: "json_extract(data,'$.action')",
  source: "json_extract(data,'$.source')", url: "json_extract(data,'$.url')",
  method: "json_extract(data,'$.method')", status: "json_extract(data,'$.status')",
  severity: "json_extract(data,'$.severity')", generation: "json_extract(data,'$.generation')",
  role: "json_extract(data,'$.role')", details: "json_extract(data,'$.details')",
  suspicious: "CASE WHEN kind='traffic' AND (json_extract(data,'$.suspicious')=1 OR json_extract(data,'$.event')='Exploit-path probe') THEN 'Suspicious' ELSE 'Normal' END",
};
export function columnFilters(value = '{}') {
  try {
    if (value.length > 8192) throw Error();
    const filters = JSON.parse(value);
    if (!filters || typeof filters !== 'object' || Array.isArray(filters) ||
        Object.entries(filters).some(([key, f]) => !Object.hasOwn(filterColumns, key) || !f ||
          !['contains', 'equals', 'excludes', 'empty', 'present', 'in'].includes(f.op) ||
          (f.op === 'in' ? !Array.isArray(f.value) || f.value.length > 512 || f.value.some((v) => typeof v !== 'string' || v.length > 500)
            : typeof f.value !== 'string' || f.value.length > 500))) throw Error();
    return filters;
  } catch { throw new Problem(400, 'Invalid column filter'); }
}
function columnWhere(filters) {
  const clauses = [], values = [];
  for (const [key, { op, value }] of Object.entries(columnFilters(JSON.stringify(filters)))) {
    const expression = `COALESCE(CAST(${filterColumns[key]} AS TEXT),'')`;
    if (op === 'in') {
      clauses.push(`${expression} IN (SELECT value FROM json_each(?))`);
      values.push(JSON.stringify(value));
    } else if (op === 'empty' || op === 'present') clauses.push(`${expression}${op === 'empty' ? '=' : '!='}''`);
    else {
      clauses.push(op === 'contains' ? `instr(lower(${expression}),lower(?))>0` : `${expression}${op === 'equals' ? '=' : '!='}? COLLATE NOCASE`);
      values.push(value);
    }
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values };
}
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
  const hideUptimeKuma = params.get('hideUptimeKuma') ?? 'false';
  const hideCS2Renderer = params.get('hideCS2Renderer') ?? 'false';
  const hideManagement = params.get('hideManagement') ?? 'false';
  const beforeTime = params.get('beforeTime');
  const services = params.has('services') ? (params.get('services') ? params.get('services').split(',') : []) : null;
  if ((before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))) ||
      !/^(all|catch-all|management|[0-9a-f-]{36})$/.test(service) ||
      !['all', 'traffic', 'alert', 'audit', 'operation', 'administration'].includes(kind) || (source && !isIP(source)) ||
      !['true', 'false'].includes(hideUptimeKuma) || !['true', 'false'].includes(hideCS2Renderer) || !['true', 'false'].includes(hideManagement) ||
      (services && (services.length > 512 || services.some((id) => !/^(catch-all|management|[0-9a-f-]{36})$/.test(id)))) ||
      (beforeTime !== null && (before === null || !Number.isFinite(Date.parse(beforeTime)))))
    throw new Problem(400, 'Invalid log filter');
  return { before: before === null ? null : Number(before), beforeTime: beforeTime === null ? null : new Date(beforeTime).toISOString(), service, services, kind, source, columns: columnFilters(params.get('columns') ?? '{}'), hideUptimeKuma: hideUptimeKuma === 'true', hideCS2Renderer: hideCS2Renderer === 'true', hideManagement: hideManagement === 'true', ...logBounds(params) };
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
      const insertDetection = this.db.prepare(`INSERT INTO logs(time,service,kind,position,bytes,data)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM logs WHERE kind='alert' AND json_extract(data,'$.crowdsecAlertId')=?)`);
      for (const e of batch) {
        const data = JSON.stringify(e), bytes = Buffer.byteLength(data);
        const detection = e.type === 'alert' && Number.isSafeInteger(e.crowdsecAlertId) && e.crowdsecAlertId > 0;
        const result = detection ? insertDetection.run(e.time, e.service, e.type, written, bytes, data, e.crowdsecAlertId)
          : insert.run(e.time, e.service, e.type, written, bytes, data);
        if (result.changes) written += bytes;
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
  history({ before = null, beforeTime = null, service = 'all', services = null, kind = 'all', source = '', columns = {}, from = null, to = null, hideUptimeKuma = false, hideCS2Renderer = false, hideManagement = false } = {}) {
    this.flush();
    const selection = services === null ? service === 'all' ? null : JSON.stringify([service]) : JSON.stringify(services);
    const filter = columnWhere(columns);
    const rows = this.db.prepare(`SELECT id,data FROM logs WHERE
      ((? IS NULL AND (? IS NULL OR id<?)) OR (? IS NOT NULL AND (time<? OR (time=? AND id<?))))
      AND (? IS NULL OR service IN (SELECT value FROM json_each(?))) AND (?='all' OR kind=? OR (?='administration' AND kind IN ('audit','operation')))
      AND (?='' OR json_extract(data,'$.source')=?)
      AND (kind!='traffic' OR ((?=0 OR service!='management') AND (?=0 OR COALESCE(json_extract(data,'$.uptimeKuma'),0)=0) AND (?=0 OR COALESCE(json_extract(data,'$.cs2Renderer'),0)=0)))
      AND (? IS NULL OR time>=?) AND (? IS NULL OR time<?)${filter.sql} ORDER BY time DESC,id DESC LIMIT 101`)
      .all(beforeTime, before, before, beforeTime, beforeTime, beforeTime, before, selection, selection, kind, kind, kind, source, source, Number(hideManagement), Number(hideUptimeKuma), Number(hideCS2Renderer), from, from, to, to, ...filter.values);
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
    to = new Date(this.now() + 1).toISOString(), service = 'all', services = null, kind = 'all', source = '', columns = {}, hideUptimeKuma = false, hideCS2Renderer = false, hideManagement = false } = {}) {
    const selection = services === null ? service === 'all' ? null : JSON.stringify([service]) : JSON.stringify(services);
    const filter = columnWhere(columns);
    const key = JSON.stringify([from, to, selection, kind, source, columns, hideUptimeKuma, hideCS2Renderer, hideManagement]);
    if (this.summaryCache?.key === key && this.now() - this.summaryCache.at < 10000) return this.summaryCache.value;
    this.flush();
    const start = Date.parse(from), end = Date.parse(to), step = Math.max(60000, Math.ceil((end - start) / 60 / 60000) * 60000);
    const where = `FROM logs WHERE time>=? AND time<? AND (? IS NULL OR service IN (SELECT value FROM json_each(?))) AND (?='all' OR kind=? OR (?='administration' AND kind IN ('audit','operation')))
      AND (?='' OR json_extract(data,'$.source')=?)
      AND (kind!='traffic' OR ((?=0 OR service!='management') AND (?=0 OR COALESCE(json_extract(data,'$.uptimeKuma'),0)=0) AND (?=0 OR COALESCE(json_extract(data,'$.cs2Renderer'),0)=0)))`;
    const parameters = [from, to, selection, selection, kind, kind, kind, source, source, Number(hideManagement), Number(hideUptimeKuma), Number(hideCS2Renderer)];
    const rows = this.db.prepare(`SELECT CAST((CAST(strftime('%s',time) AS INTEGER)*1000-?)/? AS INTEGER) AS bucket,
      COUNT(*) AS count, COUNT(DISTINCT json_extract(data,'$.source')) AS sources,
      SUM(kind='traffic') AS requests, SUM(kind='alert') AS alerts,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER)<400) AS success,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER) BETWEEN 400 AND 499) AS clientErrors,
      SUM(kind='traffic' AND CAST(json_extract(data,'$.status') AS INTEGER)>=500) AS serverErrors
      ${where}${filter.sql} GROUP BY bucket ORDER BY bucket`)
      .all(start, step, ...parameters, ...filter.values);
    const grouped = new Map(rows.map((r) => [r.bucket, r]));
    const buckets = Array.from({ length: Math.ceil((end - start) / step) }, (_, i) => ({ minute: (start + i * step) / 60000, requests: 0,
      count: 0, alerts: 0, success: 0, clientErrors: 0, serverErrors: 0, ...grouped.get(i) }));
    const totals = buckets.reduce((sum, bucket) => {
      for (const key of ['count', 'requests', 'alerts', 'success', 'clientErrors', 'serverErrors']) sum[key] += bucket[key] ?? 0;
      return sum;
    }, { count: 0, requests: 0, alerts: 0, success: 0, clientErrors: 0, serverErrors: 0 });
    const choiceFields = ['event', 'action', 'suspicious', 'method', 'status', 'severity', 'role'];
    const optionalFields = ['generation', 'role', 'details', 'severity', 'source', 'method', 'url', 'status', 'action'];
    const choices = this.db.prepare(`SELECT ${choiceFields.map((field) =>
      `json_group_array(DISTINCT COALESCE(CAST(${filterColumns[field]} AS TEXT),'')) AS ${field}`).concat(optionalFields.map((field) =>
      `MAX(COALESCE(CAST(${filterColumns[field]} AS TEXT),'')!='') AS has_${field}`)).join(',')} ${where}`).get(...parameters);
    const options = Object.fromEntries(choiceFields.map((field) => [field, JSON.parse(choices[field]).sort()]));
    const fields = optionalFields.filter((field) => choices[`has_${field}`]);
    const value = { buckets, totals, from, to, step, options, fields };
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
