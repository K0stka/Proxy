import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { unixRequest } from '../shared/http.js';
import { Problem, parse } from '../shared/model.js';
import { securityPolicySchema } from '../shared/security-policy.js';

const crowdsecAppsecGuide = 'https://docs.crowdsec.net/docs/appsec/crs/intro/';
function alertDetails(alert, decisions) {
  const scenario = String(alert.scenario ?? 'CrowdSec detection').slice(0, 200);
  const source = isIP(alert.source?.ip) ? alert.source.ip : null;
  const banned = alert.remediation === true || decisions.some((d) => d.type === 'ban' && d.value === source);
  const requestBlocked = alert.kind === 'waf' || /^anomaly score block:/i.test(scenario);
  const action = banned ? 'IP ban issued' : requestBlocked ? 'Request blocked' : 'Detection only';
  const score = scenario.match(/^anomaly score block:\s*(?:(rce|sqli|xss|lfi):\s*(\d+),\s*)?anomaly:\s*(\d+)/i);
  const name = score
    ? `OWASP CRS${score[1] ? ` · ${score[1].toUpperCase()} score ${score[2]}` : ''} · total anomaly score ${score[3]}`
    : scenario.match(/^[a-z0-9_-]+\/([a-z0-9_-]+)$/i)?.[1].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) ?? scenario;
  const item = scenario.match(/^([a-z0-9_-]+)\/([a-z0-9_-]+)$/i);
  const ruleUrl = item
    ? `https://app.crowdsec.net/hub/author/${encodeURIComponent(item[1])}/${alert.kind === 'waf' ? 'appsec-rules' : 'scenarios'}/${encodeURIComponent(item[2])}`
    : requestBlocked ? crowdsecAppsecGuide : null;
  return { source, action, event: name, ruleUrl };
}

export class Security {
  constructor({ archive, monitor, policy, storage = null, request = fetch, socket = '/security-ipc/crowdsec.sock', enabled = false }) {
    Object.assign(this, { archive, monitor, policy, storage, request, socket, enabled });
    this.cache = new Map(); this.lastAlert = Math.max(storage?.get('crowdsec-alert-cursor') ?? 0,
      archive?.db.prepare("SELECT MAX(json_extract(data,'$.crowdsecAlertId')) AS id FROM logs WHERE kind='alert'").get().id ?? 0); this.lastHealth = null;
  }
  admin(path, body) { return unixRequest(this.socket, path, body ? { method: 'POST', body, timeout: path === '/policy' ? 30000 : 10000 } : {}); }
  async key() {
    const config = await readFile('/security-ipc/bouncer.conf', 'utf8');
    return config.match(/^API_KEY=(.+)$/m)?.[1];
  }
  async check(input) {
    if (typeof input.ip !== 'string' || !isIP(input.ip) || !/^(catch-all|management|[0-9a-f-]{36})$/.test(input.service)) throw new Problem(400, 'Invalid inspection input');
    const p = this.policy().security;
    const mode = p.routes[input.service] && p.routes[input.service] !== 'inherit' ? p.routes[input.service] : p.mode;
    const result = { mode, waf: p.waf, failure: p.failure, action: 'Allowed', engine: '', reason: '' };
    if (!this.enabled || mode === 'off' || p.exceptions.some((item) => sameIP(item.ip, input.ip))) return { ...result, mode: 'off' };
    if (!p.behavior && !p.reputation) return result;
    try {
      let cached = this.cache.get(input.ip);
      if (!cached || Date.now() - cached.at >= 1000) {
        const response = await this.request(`http://127.0.0.1:8088/v1/decisions?ip=${encodeURIComponent(input.ip)}`, {
          headers: { 'x-api-key': await this.key(), 'user-agent': 'proxy-crowdsec/1.0.0' }, signal: AbortSignal.timeout(1500), redirect: 'error',
        });
        if (!response.ok) throw Error();
        const decisions = await response.json();
        if (decisions !== null && !Array.isArray(decisions)) throw Error();
        cached = { at: Date.now(), decisions: decisions ?? [] };
        if (this.cache.size >= 4096) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(input.ip, cached);
      }
      const decision = cached.decisions.find((d) => d.type === 'ban' && (['CAPI', 'lists'].includes(d.origin) ? p.reputation : p.behavior));
      if (decision) return { ...result, action: mode === 'block' ? 'Blocked' : 'Detected', engine: ['CAPI', 'lists'].includes(decision.origin) ? 'Reputation' : 'Behavior', reason: String(decision.scenario ?? 'IP ban').slice(0, 200) };
    } catch {
      return { ...result, error: 'IP decision lookup unavailable' };
    }
    return result;
  }
  async configure(value) {
    const policy = parse(securityPolicySchema, value);
    if (!this.enabled) throw new Problem(503, 'CrowdSec is not configured on this edge');
    await this.admin('/policy', { duration: policy.duration, updates: policy.updates, appsecExceptions: policy.appsecExceptions });
    this.cache.clear();
    this.engineCache = null;
    return policy;
  }
  async release(ip) {
    if (typeof ip !== 'string' || !isIP(ip)) throw new Problem(400, 'Enter an IPv4 or IPv6 address');
    await this.admin('/release', { ip });
    this.cache.clear();
    this.engineCache = null;
    this.monitor.add({ type: 'audit', service: 'management', event: 'security.ban.removed', source: ip, severity: 'info' });
  }
  async status(bounds = {}) {
    let engine;
    try {
      if (!this.engineCache || Date.now() - this.engineCache.at > 4000) {
        this.enginePromise ??= this.admin('/status').then((value) => { this.engineCache = { at: Date.now(), value }; return value; }).finally(() => { this.enginePromise = null; });
        engine = await this.enginePromise;
      } else engine = this.engineCache.value;
    }
    catch { engine = { available: false, error: this.enabled ? 'CrowdSec is unavailable' : 'CrowdSec is not configured', decisions: [], alerts: [] }; }
    const healthy = engine.available && !engine.error;
    if (this.lastHealth !== healthy) {
      if (!healthy || this.lastHealth !== null) this.monitor.add({ type: 'alert', service: 'management', severity: healthy ? 'info' : 'warning', event: healthy ? 'CrowdSec recovered' : engine.error });
      this.lastHealth = healthy;
    }
    for (const a of [...(engine.alerts ?? [])].sort((a, b) => Number(a.id) - Number(b.id))) {
      if (Number(a.id) <= this.lastAlert) continue;
      this.lastAlert = Number(a.id);
      this.storage?.set('crowdsec-alert-cursor', this.lastAlert);
      this.monitor.add({ type: 'alert', service: 'catch-all', ...alertDetails(a, engine.decisions ?? []),
        severity: 'warning', crowdsecAlertId: this.lastAlert });
    }
    const summary = this.summary(bounds);
    const bans = (engine.decisions ?? []).filter((d) => d.type === 'ban');
    const releases = new Map(this.archive.db.prepare(`SELECT json_extract(data,'$.source') AS ip, MAX(time) AS time
      FROM logs WHERE kind='audit' AND json_extract(data,'$.event')='security.ban.removed' GROUP BY ip`).all().map((r) => [r.ip, r.time]));
    return { ...summary, policy: this.policy().security, available: Boolean(engine.available), error: engine.error,
      updated: engine.updated ? new Date(engine.updated * 1000).toISOString() : null, updating: !!engine.updating,
      activeBans: engine.active_bans ?? bans.length,
      decisions: summary.decisions.map((d) => {
        const ban = bans.find((ban) => ban.value === d.ip);
        const alert = d.engine === 'WAF' ? (engine.alerts ?? []).find((a) => a.source?.ip === d.ip) : null;
        const allowed = this.policy().security.exceptions.some((item) => sameIP(item.ip, d.ip));
        return { ...d, rule: alert?.scenario || d.rule, banned: !!ban,
          action: allowed ? 'Allowed' : !ban && releases.get(d.ip) >= d.time ? 'Ban removed' : d.action,
          expires: ban?.duration ?? null };
      }) };
  }
  summary({ from = new Date(Date.now() - 86400000).toISOString(), to = new Date().toISOString() } = {}) {
    this.archive.flush();
    const where = `FROM logs WHERE kind='traffic' AND time>=? AND time<? AND json_extract(data,'$.securityInspected')=1`;
    const rows = this.archive.db.prepare(`SELECT json_extract(data,'$.securityAction') AS action,
      json_extract(data,'$.securityEngine') AS engine, COUNT(*) AS count ${where} GROUP BY action,engine`).all(from, to);
    const counts = { blocked: 0, detected: 0, inspected: 0, sources: { WAF: 0, Behavior: 0, Reputation: 0, Availability: 0 } };
    for (const row of rows) {
      counts.inspected += row.count;
      if (row.engine !== 'Availability' && ['Blocked', 'Detected'].includes(row.action)) counts.detected += row.count;
      if (row.action === 'Blocked') { counts.blocked += row.count; counts.sources[row.engine] = row.count + (counts.sources[row.engine] ?? 0); }
    }
    const buckets = Array.from({ length: 36 }, () => 0);
    for (const row of this.archive.db.prepare(`SELECT CAST((julianday(time)-julianday(?))/(julianday(?)-julianday(?))*36 AS INTEGER) AS bucket,
      COUNT(*) AS count ${where} AND json_extract(data,'$.securityAction')='Blocked' GROUP BY bucket`).all(from, to, from, from, to))
      buckets[Math.max(0, Math.min(35, row.bucket))] += row.count;
    const decisions = this.archive.db.prepare(`SELECT data, MAX(time) AS time,
      SUM(json_extract(data,'$.securityAction')='Blocked') AS requests ${where}
      AND json_extract(data,'$.securityAction') IN ('Blocked','Detected') GROUP BY json_extract(data,'$.source'), json_extract(data,'$.securityEngine'), json_extract(data,'$.securityReason') ORDER BY time DESC LIMIT 100`)
      .all(from, to).map((row) => {
        const d = JSON.parse(row.data); let host = d.service;
        try { host = new URL(d.url).hostname; } catch {}
        return { id: `${d.source}:${d.securityEngine}:${d.securityReason}`, ip: d.source, action: d.securityAction, engine: d.securityEngine,
          method: d.method,
          reason: d.securityReason || 'CrowdSec match', rule: d.securityReason || 'CrowdSec match',
          host, path: d.url ?? '', requests: row.requests, time: row.time };
      });
    return { counts, buckets, decisions };
  }
}
function sameIP(a, b) {
  // URL canonicalization normalizes equivalent IPv6 spellings without trusting forwarded headers.
  if (isIP(a) !== isIP(b)) return false;
  return isIP(a) === 6 ? new URL(`http://[${a}]`).hostname === new URL(`http://[${b}]`).hostname : a === b;
}
