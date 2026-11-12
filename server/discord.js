import { z } from 'zod';
import { parse, Problem } from '../shared/model.js';

const edgeAlertsUnavailable = 'Edge alerts unavailable; delivery will retry.';
const edgeAlertsTimeout = 5000, digestInterval = 300000;
const defaultRecipient = '710044411035254864';
const snowflake = /^\d{17,20}$/;
const text = (value, limit) => String(value).replace(/[\r\n\t]/g, ' ').replace(/([\\`*_~|<>\[\]])/g, '\\$1').slice(0, limit);
const actionable = (event) => ['auth.recovery', 'auth.device.completed',
  'Repeated failed authentication operations', 'CrowdSec is unavailable',
  'Edge is unavailable', 'Edge connection recovered'].includes(event.event);
const alertNames = { 'auth.recovery': 'Recovery code used', 'auth.device.completed': 'New device added',
  'CrowdSec is unavailable': 'CrowdSec health check failed' };
const priority = (group) => group.severity === 'error' ? 4 : group.securityEngine === 'Availability' ||
  /unavailable|update failed|recovered/i.test(group.event) ? 3 : group.service === 'management' ? 2 : group.action === 'Detection only' ? 1 : 0;

export const discordSettings = z.object({
  enabled: z.boolean(),
  botToken: z.string().trim().min(20).max(512).regex(/^[A-Za-z0-9._-]+$/).optional(),
  recipientId: z.string().regex(snowflake).optional(),
}).strict();

export class DiscordAlerts {
  constructor({ store, archive, edge, routes, origin, request = fetch, now = Date.now }) {
    Object.assign(this, { store, archive, edge, routes, origin, request, now });
    this.busy = false;
    this.channel = null;
  }
  config() {
    const saved = this.store.get('discord', {});
    // Legacy webhooks cannot deliver DMs; require bot setup before enabling again.
    return { enabled: Boolean(saved.enabled && saved.botToken && saved.recipientId),
      botToken: saved.botToken ?? '', recipientId: saved.recipientId ?? defaultRecipient };
  }
  status() {
    const config = this.config();
    return { enabled: config.enabled, configured: Boolean(config.botToken && config.recipientId),
      botToken: '•'.repeat(config.botToken.length), recipientId: config.recipientId,
      ...this.store.get('discord-status', { lastSuccess: null, error: null, nextAttempt: null }) };
  }
  async save(raw) {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.busy = true;
    try {
      const old = this.config();
      const input = parse(discordSettings, {
        ...raw, ...(raw.botToken && raw.botToken === '•'.repeat(old.botToken.length) ? { botToken: undefined } : {}),
      });
      const botToken = input.botToken ?? old.botToken, recipientId = input.recipientId ?? old.recipientId;
      if (input.enabled && !botToken) throw new Problem(400, 'Enter a Discord bot token before enabling DMs.');
      if ((!old.enabled && input.enabled) || botToken !== old.botToken || recipientId !== old.recipientId) {
        let edgeId;
        try { edgeId = (await this.edge('/alerts?after=0', { timeout: edgeAlertsTimeout })).latest; }
        catch { if (input.enabled) throw new Problem(503, 'Edge unavailable; try enabling alerts again when it recovers.'); }
        this.store.set('discord-queue', { cursors: { control: this.archive.latestId(), edge: edgeId ?? 0 }, groups: [], overflow: 0 });
      }
      this.channel = null;
      this.store.set('discord', { enabled: input.enabled, botToken, recipientId });
      // Editing settings must not bypass a delivery or Discord rate-limit cooldown.
      this.store.set('discord-status', { ...this.statusFields(), error: null });
      return this.status();
    } finally { this.busy = false; }
  }
  remove() {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.channel = null;
    this.store.set('discord', { enabled: false, botToken: '', recipientId: defaultRecipient });
    this.store.set('discord-queue', { cursors: { control: 0, edge: 0 }, groups: [], overflow: 0 });
    this.store.set('discord-status', { lastSuccess: null, error: null, nextAttempt: null });
    return this.status();
  }
  async post(path, payload, read = false) {
    const response = await this.request(`https://discord.com/api/v10${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', authorization: `Bot ${this.config().botToken}` },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      const delay = response.status === 429 && Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 60;
      this.store.set('discord-status', { lastSuccess: this.status().lastSuccess,
        error: `Discord returned HTTP ${response.status}. Check the bot token, recipient and DM privacy settings.`,
        nextAttempt: new Date(this.now() + delay * 1000).toISOString() });
      if (response.status === 403 || response.status === 404) this.channel = null;
      throw new Problem(502, this.status().error);
    }
    if (read) return response.json();
    // Never retain or report Discord response bodies, which may echo credentials.
    await response.body?.cancel();
  }
  async send(payload) {
    if (!this.status().configured) throw new Problem(400, 'Configure a Discord bot and recipient first.');
    if (Date.parse(this.status().nextAttempt ?? '') > this.now())
      throw new Problem(429, 'Discord delivery is cooling down; try again later.');
    try {
      if (!this.channel) {
        const dm = await this.post('/users/@me/channels', { recipient_id: this.config().recipientId }, true);
        if (typeof dm.id !== 'string' || !snowflake.test(dm.id)) throw new Error('Invalid DM channel');
        this.channel = dm.id;
      }
      await this.post(`/channels/${this.channel}/messages`, { ...payload, allowed_mentions: { parse: [] } });
      this.store.set('discord-status', { lastSuccess: new Date(this.now()).toISOString(), error: null,
        nextAttempt: new Date(this.now() + digestInterval).toISOString() });
    } catch (error) {
      if (error instanceof Problem) throw error;
      this.store.set('discord-status', { lastSuccess: this.status().lastSuccess,
        error: 'Discord DM delivery failed. Check connectivity, bot token and DM privacy settings.',
        nextAttempt: new Date(this.now() + 60000).toISOString() });
      throw new Problem(502, this.status().error);
    }
  }
  digest({ groups, overflow }) {
    const total = groups.reduce((sum, group) => sum + group.count, overflow);
    const ordered = [...groups].sort((a, b) => priority(b) - priority(a));
    const shown = ordered.slice(0, 6), hidden = ordered.slice(6).reduce((sum, group) => sum + group.count, overflow);
    const describe = (group) => {
      const service = this.routes().find((r) => r.id === group.service)?.name ??
        ({ 'catch-all': 'Unmatched traffic', management: '' }[group.service] ?? 'Previous route');
      return [text(alertNames[group.event] ?? group.event, 80) + (group.count > 1 ? ` ×${group.count}` : ''),
        service ? text(service, 40) : null,
        group.sources.length ? group.sources.map((source) => text(source, 40)).join(', ') : null].filter(Boolean).join(' · ');
    };
    const single = shown.length === 1 && !hidden;
    const outage = single && shown[0].event === 'CrowdSec is unavailable';
    const lines = [single ? `Proxy: ${describe(shown[0])}` : `Proxy: ${total} alerts`,
      ...(single ? [] : shown.map((group) => `• ${describe(group)}`)),
      hidden ? `+${hidden} more in Logs` : null,
      this.origin ? `${outage ? 'Security' : 'Logs'}: ${new URL(outage ? '/security' : '/logs', this.origin).href}` : null];
    return { content: lines.filter(Boolean).join('\n').slice(0, 2000) };
  }
  async tick() {
    if (this.busy || !this.config().enabled) return;
    this.busy = true;
    try {
      const queue = this.store.get('discord-queue', { cursors: { control: 0, edge: 0 }, groups: [], overflow: 0 });
      const batches = [['control', this.archive.alertsAfter(queue.cursors.control)]];
      let edgeUnavailable = false;
      try {
        batches.push(['edge', (await this.edge(`/alerts?after=${queue.cursors.edge}`, { timeout: edgeAlertsTimeout })).events]);
        if (this.status().error === edgeAlertsUnavailable)
          this.store.set('discord-status', { ...this.statusFields(), error: null });
      } catch { edgeUnavailable = true; }
      for (const [component, events] of batches) for (const event of events) {
        if (!actionable(event)) { queue.cursors[component] = event.id; continue; }
        const severity = event.severity ?? 'warning';
        const outcome = { action: event.action, securityAction: event.securityAction, securityEngine: event.securityEngine, securityReason: event.securityReason };
        let group = queue.groups.find((g) => g.service === event.service && g.event === event.event && g.severity === severity &&
          Object.entries(outcome).every(([key, value]) => g[key] === value));
        if (!group && queue.groups.length === 20) {
          const least = [...queue.groups].sort((a, b) => priority(a) - priority(b))[0];
          if (priority({ ...event, severity }) > priority(least)) {
            queue.overflow += least.count;
            queue.groups.splice(queue.groups.indexOf(least), 1);
          }
        }
        if (!group && queue.groups.length < 20) {
          group = { service: event.service, event: event.event, severity, ...outcome, ruleUrl: event.ruleUrl,
            count: 0, first: event.time, last: event.time, sources: [] };
          queue.groups.push(group);
        }
        if (group) {
          group.count++;
          if (event.time < group.first) group.first = event.time;
          if (event.time > group.last) group.last = event.time;
          if (event.source && group.sources.length < 3 && !group.sources.includes(event.source)) group.sources.push(event.source);
          group.protocol = event.protocol; group.status = event.status;
        } else queue.overflow++;
        queue.cursors[component] = event.id;
      }
      // Persist aggregation and cursors together, including while delivery is cooling down.
      this.store.set('discord-queue', queue);
      if ((queue.groups.length || queue.overflow) && !(Date.parse(this.status().nextAttempt ?? '') > this.now())) {
        await this.send(this.digest(queue));
        this.store.set('discord-queue', { ...queue, groups: [], overflow: 0 });
      }
      if (edgeUnavailable && !this.status().error)
        this.store.set('discord-status', { ...this.statusFields(), error: edgeAlertsUnavailable });
    } finally { this.busy = false; }
  }
  async checkEdge() {
    let available = false;
    try { available = (await this.edge('/status', { timeout: edgeAlertsTimeout })).available === true; } catch {}
    const previous = this.store.get('edge-availability', { failedSince: null, unavailable: false });
    const state = available ? { failedSince: null, unavailable: false } : {
      failedSince: previous.failedSince ?? this.now(),
      unavailable: previous.unavailable || this.now() - (previous.failedSince ?? this.now()) >= 30000,
    };
    if (state.unavailable !== previous.unavailable)
      this.archive.append({ type: 'alert', service: 'management',
        event: state.unavailable ? 'Edge is unavailable' : 'Edge connection recovered',
        severity: state.unavailable ? 'error' : 'info', time: new Date(this.now()).toISOString() });
    if (JSON.stringify(state) !== JSON.stringify(previous)) this.store.set('edge-availability', state);
  }
  statusFields() {
    const { lastSuccess, nextAttempt } = this.status();
    return { lastSuccess, nextAttempt };
  }
  async test() {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.busy = true;
    try {
      await this.send({ content: 'Proxy: Discord DMs connected. New alerts will arrive here.' });
      return { ...this.status(), message: 'Test DM sent.' };
    } finally { this.busy = false; }
  }
}
