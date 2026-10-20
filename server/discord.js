import { z } from 'zod';
import { parse, Problem } from '../shared/model.js';

const edgeAlertsUnavailable = 'Edge alerts unavailable; delivery will retry.';
const edgeAlertsTimeout = 5000;

export const discordSettings = z.object({
  enabled: z.boolean(),
  webhookURL: z.string().max(512).optional(),
}).strict();
export function webhookURL(value) {
  if (!/^https:\/\/discord\.com\/api(?:\/v10)?\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{20,200}$/.test(value))
    throw new Problem(400, 'Use an HTTPS Discord webhook URL from discord.com/api/webhooks.');
  return value;
}

export class DiscordAlerts {
  constructor({ store, archive, edge, routes, request = fetch, now = Date.now }) {
    Object.assign(this, { store, archive, edge, routes, request, now });
    this.busy = false;
  }
  config() { return this.store.get('discord', { enabled: false, webhookURL: '' }); }
  status() {
    const config = this.config();
    return { enabled: config.enabled, configured: Boolean(config.webhookURL),
      ...this.store.get('discord-status', { lastSuccess: null, error: null, nextAttempt: null }) };
  }
  async save(raw) {
    const input = parse(discordSettings, raw), old = this.config();
    const url = input.webhookURL ? webhookURL(input.webhookURL.trim()) : old.webhookURL;
    if (input.enabled && !url) throw new Problem(400, 'Enter a Discord webhook URL before enabling alerts.');
    if ((!old.enabled && input.enabled) || (input.webhookURL && url !== old.webhookURL)) {
      // Enabling starts with new alerts, rather than replaying a month of history.
      let edgeId;
      try { edgeId = (await this.edge('/alerts?after=0', { timeout: edgeAlertsTimeout })).latest; }
      catch { if (input.enabled) throw new Problem(503, 'Edge unavailable; try enabling alerts again when it recovers.'); }
      this.store.set('discord-cursors', { control: this.archive.latestId(), edge: edgeId ?? 0 });
      this.store.set('discord-dedup', []);
    }
    this.store.set('discord', { enabled: input.enabled, webhookURL: url });
    this.store.set('discord-status', { lastSuccess: this.status().lastSuccess, error: null, nextAttempt: null });
    return this.status();
  }
  remove() {
    this.store.set('discord', { enabled: false, webhookURL: '' });
    this.store.set('discord-status', { lastSuccess: null, error: null, nextAttempt: null });
    return this.status();
  }
  async send(event) {
    const config = this.config();
    if (!config.webhookURL) throw new Problem(400, 'Configure a webhook first.');
    webhookURL(config.webhookURL);
    const status = this.status();
    if (status.nextAttempt && Date.parse(status.nextAttempt) > this.now())
      throw new Problem(429, 'Discord delivery is cooling down; try again later.');
    const service = this.routes().find((r) => r.id === event.service)?.name ??
      ({ 'catch-all': 'Wildcard / unmatched traffic', management: 'Management' }[event.service] ?? 'Previous route');
    try {
      const response = await this.request(config.webhookURL + '?wait=true', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'Proxy alerts',
          content: `<@710044411035254864> Proxy alert - ${event.event.slice(0, 300)}`,
          allowed_mentions: { parse: [], users: ['710044411035254864'] }, embeds: [{
          title: 'Proxy suspicious activity', color: 15105570,
          description: event.event.slice(0, 300), timestamp: event.time,
          fields: [{ name: 'Service', value: service.slice(0, 200) },
            { name: 'Source', value: event.source ?? 'Service-wide' },
            { name: 'Protocol / status', value: `${event.protocol ?? 'management'} / ${event.status ?? '—'}` }],
        }] }),
      });
      // Never retain or report Discord response bodies, which may echo credentials.
      await response.body?.cancel();
      if (!response.ok) {
        const retry = Number(response.headers.get('retry-after'));
        const delay = response.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 60;
        this.store.set('discord-status', { lastSuccess: status.lastSuccess,
          error: `Discord returned HTTP ${response.status}. Check the webhook and channel permissions.`,
          nextAttempt: new Date(this.now() + delay * 1000).toISOString() });
        throw new Problem(502, this.status().error);
      }
      this.store.set('discord-status', { lastSuccess: new Date(this.now()).toISOString(), error: null,
        nextAttempt: new Date(this.now() + 10000).toISOString() });
    } catch (error) {
      if (error instanceof Problem) throw error;
      this.store.set('discord-status', { lastSuccess: status.lastSuccess, error: 'Discord delivery failed. Check connectivity and the webhook.',
        nextAttempt: new Date(this.now() + 60000).toISOString() });
      throw new Problem(502, this.status().error);
    }
  }
  async tick() {
    if (this.busy || !this.config().enabled || Date.parse(this.status().nextAttempt ?? '') > this.now()) return;
    this.busy = true;
    try {
      const cursors = this.store.get('discord-cursors', { control: 0, edge: 0 });
      const groups = [['control', this.archive.alertsAfter(cursors.control)]];
      try {
        groups.push(['edge', (await this.edge(`/alerts?after=${cursors.edge}`, { timeout: edgeAlertsTimeout })).events]);
        if (this.status().error === edgeAlertsUnavailable)
          this.store.set('discord-status', { ...this.statusFields(), error: null });
      }
      catch {
        this.store.set('discord-status', { ...this.statusFields(), error: edgeAlertsUnavailable });
      }
      const dedup = this.store.get('discord-dedup', []).filter(([, time]) => this.now() - time < 900000);
      for (const [component, events] of groups) for (const event of events) {
        const key = `${event.service}:${event.event}`;
        if (!dedup.some(([seen]) => seen === key)) {
          await this.send(event);
          dedup.push([key, this.now()]);
        }
        cursors[component] = event.id;
        this.store.set('discord-cursors', cursors);
        this.store.set('discord-dedup', dedup.slice(-100));
        // One new notification per poll; duplicates can advance without sending.
        if (this.status().nextAttempt && Date.parse(this.status().nextAttempt) > this.now()) return;
      }
    } finally { this.busy = false; }
  }
  statusFields() {
    const { lastSuccess, nextAttempt } = this.status();
    return { lastSuccess, nextAttempt };
  }
  async test() {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.busy = true;
    try {
      await this.send({ service: 'management', event: 'Test notification — Discord alerts are connected.', time: new Date(this.now()).toISOString() });
      return { ...this.status(), message: 'Test notification sent.' };
    } finally { this.busy = false; }
  }
}
