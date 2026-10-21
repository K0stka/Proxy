import { isIP } from 'node:net';

// Metadata only, bounded even when clients deliberately vary addresses or routes.
export class Monitor {
  constructor({ now = Date.now, archive = null } = {}) {
    this.now = now;
    this.startedAt = new Date(now()).toISOString();
    this.events = [];
    this.windows = new Map();
    this.archive = archive;
    if (archive) this.events = archive.history().events.toReversed().map(({ id, ...e }) => e);
  }
  prune(force = false) {
    const now = this.now();
    if (!force && this.lastPruned !== undefined && now - this.lastPruned < 1000) return;
    this.lastPruned = now;
    this.events = this.events.filter((e) => now - Date.parse(e.time) < 86400000);
    for (const [key, value] of this.windows)
      if (now - value.started >= 60000) this.windows.delete(key);
  }
  add(event) {
    const record = { ...event, time: new Date(this.now()).toISOString() };
    this.events.push(record);
    this.archive?.append(record);
    // Preserve alerts through noisy traffic, with room left for ordinary events.
    if (event.type === 'alert' && this.events.filter((e) => e.type === 'alert').length > 100)
      this.events.splice(this.events.findIndex((e) => e.type === 'alert'), 1);
    if (this.events.length > 500)
      this.events.splice(this.events.findIndex((e) => e.type !== 'alert'), 1);
  }
  audit(record) {
    this.prune();
    this.add({ type: 'audit', service: 'management', event: record.event,
      status: record.status, source: record.source, url: record.url, method: record.method,
      severity: record.status >= 400 ? 'warning' : 'info' });
    if (record.status < 400 && ['auth.recovery', 'auth.device.completed'].includes(record.event))
      this.add({ type: 'alert', service: 'management', event: record.event, severity: 'warning' });
    if (record.event.startsWith('auth.') && record.status >= 400) {
      if (!this.authWindow || this.now() - this.authWindow.started >= 60000)
        this.authWindow = { started: this.now(), count: 0 };
      if (++this.authWindow.count === 20)
        this.add({ type: 'alert', service: 'management', event: 'Repeated failed authentication operations', severity: 'warning' });
    }
  }
  ingest(message) {
    if (message.length > 32768) return;
    let raw;
    try { raw = JSON.parse(message.slice(message.indexOf('{'))); } catch { return; }
    if (!raw || typeof raw !== 'object') return;
    raw.protocol = typeof raw.protocol === 'string' ? raw.protocol.toLowerCase() : '';
    if (!['http', 'tcp', 'udp'].includes(raw.protocol) || typeof raw.address !== 'string' || !isIP(raw.address) ||
        typeof raw.service !== 'string' || typeof raw.status !== 'string' || typeof raw.bytes !== 'string' ||
        !/^(?:catch-all|management|[0-9a-f-]{36})$/.test(raw.service) ||
        !/^\d{3}$/.test(String(raw.status)) ||
        !/^\d+$/.test(String(raw.bytes)) || !['none', 'probe'].includes(raw.signal) ||
        (raw.url !== undefined && (typeof raw.url !== 'string' || raw.url.length > 16384)) ||
        (raw.method !== undefined && typeof raw.method !== 'string') ||
        (raw.uptimeKuma !== undefined && typeof raw.uptimeKuma !== 'boolean') ||
        (raw.cs2Renderer !== undefined && typeof raw.cs2Renderer !== 'boolean')) return;
    this.prune();
    const source = raw.address;
    const security = raw.protocol === 'http' && raw.securityInspected === true &&
      ['Allowed', 'Blocked', 'Detected', 'Error'].includes(raw.securityAction) &&
      ['', 'WAF', 'Behavior', 'Reputation', 'Availability'].includes(raw.securityEngine) &&
      typeof raw.securityReason === 'string' && raw.securityReason.length <= 200;
    const matched = security && raw.securityEngine !== 'Availability' && ['Blocked', 'Detected'].includes(raw.securityAction);
    const status = Number(raw.status), bytes = Math.min(Number(raw.bytes), Number.MAX_SAFE_INTEGER);
    const event = { type: 'traffic', service: raw.service, protocol: raw.protocol,
      suspicious: raw.signal === 'probe' || matched,
      ...(security ? { securityInspected: true, securityAction: raw.securityAction, securityEngine: raw.securityEngine, securityReason: raw.securityReason } : {}),
      source, status, bytes, ...(raw.url === undefined ? {} : { url: raw.url, method: raw.method?.slice(0, 32) }),
      ...(raw.protocol === 'http' ? { uptimeKuma: raw.uptimeKuma === true, cs2Renderer: raw.cs2Renderer === true } : {}),
      event: raw.signal === 'probe' ? 'Exploit-path probe' : 'Request / session completed',
      severity: raw.signal === 'probe' || status >= 400 ? 'warning' : 'info' };
    this.add(event);
    if (security && raw.securityEngine === 'Availability' && (!this.securityFailureAt || this.now() - this.securityFailureAt > 60000)) {
      this.securityFailureAt = this.now();
      this.add({ type: 'alert', service: raw.service, severity: 'warning', event: raw.securityReason,
        securityAction: raw.securityAction, securityEngine: raw.securityEngine, securityReason: raw.securityReason });
    }
    for (const key of [raw.service, `${raw.service}:${source}`]) {
      if (this.windows.has(key) && this.now() - this.windows.get(key).started >= 60000)
        this.windows.delete(key);
      if (!this.windows.has(key)) {
        if (this.windows.size >= 4096) continue;
        this.windows.set(key, { started: this.now(), service: raw.service,
          source: key.includes(':') ? source : null, count: 0, errors: 0, denied: 0, probes: 0, missing: 0, bytes: 0, alerts: [] });
      }
      const w = this.windows.get(key);
      w.count++; w.bytes += bytes;
      if (status >= 500) w.errors++;
      if (status === 404) w.missing++;
      if ([401, 403, 429].includes(status)) w.denied++;
      if (raw.signal === 'probe') w.probes++;
      const reasons = [
        [w.count >= (w.source ? 300 : 3000), 'Traffic burst'],
        [w.errors >= 20 && w.errors / w.count >= 0.5, 'Repeated server / upstream failures'],
        [w.denied >= 20, 'Repeated denied access'],
        [w.probes >= 5, 'Repeated exploit-path probes'],
        [raw.service === 'catch-all' && w.missing >= 60, 'Catch-all scanning'],
        [raw.service !== 'catch-all' && w.missing >= 60 && w.missing / w.count >= 0.8, 'Repeated missing resources'],
      ];
      for (const [trigger, reason] of reasons) if (trigger && !w.alerts.includes(reason)) {
        w.alerts.push(reason);
        this.add({ ...event, type: 'alert', source: w.source, event: reason, severity: 'warning' });
      }
    }
  }
  snapshot() {
    this.prune(true);
    return { startedAt: this.startedAt, events: this.events.toReversed(),
      storage: this.archive?.status() ?? null,
      summary: this.archive?.summary() ?? null,
      services: [...this.windows.values()].filter((w) => !w.source),
      retention: this.archive ? 'Logs persist for up to 30 days, limited to 128 MiB of event data per component. Browse older entries in History. Activity counters cover 60 seconds and reset on restart.' : 'Up to 500 events, including up to 100 retained alerts, for at most 24 hours in memory; resets on restart. Counters cover the current 60-second window per service.' };
  }
}
