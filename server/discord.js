import { z } from 'zod';
import { parse, Problem } from '../shared/model.js';

const edgeAlertsUnavailable = 'Edge alerts unavailable; delivery will retry.';
const edgeAlertsTimeout = 5000, digestInterval = 300000;
const defaultRecipient = '710044411035254864';
const snowflake = /^\d{17,20}$/;
const text = (value, limit) => String(value).replace(/[\r\n\t]/g, ' ').replace(/([\\`*_~|<>\[\]])/g, '\\$1').slice(0, limit);
const actionable = (event) => event.severity === 'error' || event.securityEngine === 'Availability' ||
  ['auth.recovery', 'auth.device.completed', 'Repeated failed authentication operations',
    'Repeated server / upstream failures'].includes(event.event);
const alertNames = { 'auth.recovery': 'Recovery code used', 'auth.device.completed': 'New device added' };
const priority = (group) => group.severity === 'error' ? 4 : group.securityEngine === 'Availability' ||
  /unavailable|update failed|recovered/i.test(group.event) ? 3 : group.service === 'management' ? 2 : group.action === 'Detection only' ? 1 : 0;
const explanations = {
  'Traffic burst': 'High traffic can also be legitimate; this threshold alert does not itself block traffic.',
  'Repeated server / upstream failures': 'Repeated server errors suggest a service or upstream health issue.',
  'Repeated denied access': 'Repeated denied requests may include existing policy blocks.',
  'Repeated exploit-path probes': 'Repeated requests to common discovery paths suggest scanning, not confirmed access.',
  'Catch-all scanning': 'Repeated not-found responses on unmatched hosts suggest automated discovery.',
  'Repeated missing resources': 'Repeated not-found responses can indicate discovery scans or broken links.',
};
function ruleLink(value) {
  // Only link to the documentation destinations produced by the security adapter.
  return typeof value === 'string' && value.length <= 300 && /^(?:https:\/\/app\.crowdsec\.net\/hub\/author\/[a-z0-9_-]+\/(?:appsec-rules|scenarios)\/[a-z0-9_-]+|https:\/\/docs\.crowdsec\.net\/docs\/appsec\/crs\/intro\/)$/.test(value)
    ? `[Rule details](${value})` : null;
}

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
    return { enabled: config.enabled, configured: Boolean(config.botToken && config.recipientId), recipientId: config.recipientId,
      ...this.store.get('discord-status', { lastSuccess: null, error: null, nextAttempt: null }) };
  }
  async save(raw) {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.busy = true;
    try {
      const input = parse(discordSettings, raw), old = this.config();
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
    const proxyUrl = this.origin ? new URL('/logs', this.origin).href : null;
    return { content: `Proxy · ${total} alert${total === 1 ? '' : 's'}`,
      embeds: [{ title: 'Proxy alert summary', color: groups.some((g) => g.severity !== 'info') || overflow ? 15105570 : 3066993,
        ...(proxyUrl ? { url: proxyUrl } : {}),
        description: [proxyUrl ? `[Open Proxy](${new URL('/', this.origin).href}) · [View Logs](${proxyUrl})` : null,
          hidden ? `${hidden} additional alerts omitted from this summary.` : null].filter(Boolean).join('\n'),
        fields: shown.map((group) => {
          const service = this.routes().find((r) => r.id === group.service)?.name ??
            ({ 'catch-all': 'Wildcard / unmatched traffic', management: 'Management' }[group.service] ?? 'Previous route');
          const stamp = (value) => `<t:${Math.floor(Date.parse(value) / 1000)}:t>`;
          const link = ruleLink(group.ruleUrl);
          return { name: `${text(service, 130)} · ${text(group.severity, 15)} · ${group.count}×`,
            value: [text(alertNames[group.event] ?? group.event, 200),
              group.action ? `Recorded action: ${text(group.action, 40)}` : null,
              group.securityEngine === 'Availability'
                ? `Protection unavailable · ${group.securityAction === 'Blocked' ? 'sample request denied by fallback' : 'sample request allowed without full inspection'}`
                : group.securityAction ? `Latest request: ${text(group.securityAction, 15)}${group.securityEngine ? ` · ${text(group.securityEngine, 15)}` : ''}`
                  : !group.action && group.event !== 'CrowdSec recovered' ? 'Blocking action: not recorded' : null,
              group.securityReason && group.securityReason !== group.event ? `Rule / reason: ${text(group.securityReason, 130)}` : null,
              /^OWASP CRS/.test(group.event) ? 'Scores indicate matched attack patterns, not successful code execution.' : explanations[group.event],
              `Seen: ${stamp(group.first)} – ${stamp(group.last)}`,
              group.sources.length ? `Source samples: ${group.sources.map((s) => text(s, 50)).join(', ')}` : 'Scope: service-wide',
              group.protocol ? `Latest protocol / status: ${text(group.protocol, 20)} / ${text(group.status ?? '—', 10)}` : null,
            ].filter(Boolean).join('\n').slice(0, 750 - (link ? link.length + 1 : 0)) + (link ? `\n${link}` : '') };
        }), timestamp: new Date(this.now()).toISOString(),
      }] };
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
  statusFields() {
    const { lastSuccess, nextAttempt } = this.status();
    return { lastSuccess, nextAttempt };
  }
  async test() {
    if (this.busy) throw new Problem(409, 'A delivery is already in progress.');
    this.busy = true;
    try {
      await this.send({ content: 'Proxy · Discord DMs are connected.', embeds: [{ title: 'Test notification', color: 3066993,
        description: 'New alerts will arrive here as grouped summaries, at most once every 5 minutes. No mentions.',
        timestamp: new Date(this.now()).toISOString() }] });
      return { ...this.status(), message: 'Test DM sent.' };
    } finally { this.busy = false; }
  }
}
