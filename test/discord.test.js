import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAlerts } from '../server/discord.js';
import { Store } from '../server/store.js';
import { LogStore } from '../shared/log-store.js';
import { Security } from '../edge/security.js';
import { Monitor } from '../shared/monitor.js';

const botToken = 'test_token_'.repeat(6), recipientId = '710044411035254864', channelId = '123456789012345678';
function fixture(t, request = async () => new Response(null, { status: 204 })) {
  const store = new Store(':memory:'), archive = new LogStore(':memory:');
  let now = Date.now();
  const edgeEvents = [], calls = [];
  const discord = new DiscordAlerts({ store, archive, now: () => now, routes: () => [],
    edge: async (path) => ({ events: edgeEvents.filter((e) => e.id > Number(new URL(path, 'http://edge').searchParams.get('after'))).slice(0, 100), latest: edgeEvents.at(-1)?.id ?? 0 }),
    request: async (...args) => {
      calls.push(args);
      return args[0].endsWith('/users/@me/channels') ? Response.json({ id: channelId }) : request(...args);
    },
  });
  t.after(() => { archive.close(); store.close(); });
  return { store, archive, discord, edgeEvents, calls, advance: (ms) => { now += ms; },
    messages: () => calls.filter(([url]) => url.endsWith('/messages')).map(([, options]) => JSON.parse(options.body)),
    alert: (id, reason = 'Catch-all scanning') => ({ id, type: 'alert', service: 'catch-all', event: reason,
      time: new Date(now).toISOString(), source: '203.0.113.44', status: 404, protocol: 'http', severity: 'warning' }) };
}
const enable = (f) => f.discord.save({ enabled: true, botToken, recipientId });

test('DM settings validate credentials and recipient; legacy webhooks stay disabled', async (t) => {
  const f = fixture(t);
  f.store.set('discord', { enabled: true, webhookURL: 'https://discord.com/api/webhooks/old' });
  assert.equal(f.discord.status().enabled, false);
  assert.equal(f.discord.status().configured, false);
  await f.discord.tick();
  assert.equal(f.calls.length, 0);
  for (const settings of [{ enabled: true }, { enabled: true, botToken: 'bad token' },
    { enabled: true, botToken, recipientId: '../other' }, { enabled: true, webhookURL: 'old' }])
    await assert.rejects(f.discord.save(settings));
  await enable(f);
  assert(!JSON.stringify(f.store.get('discord')).includes('webhook'));
});

test('settings redact credentials, skip history and send a mention-free test DM with bot authentication', async (t) => {
  const f = fixture(t);
  f.edgeEvents.push(f.alert(1));
  f.archive.append(f.alert(0));
  const status = await enable(f);
  assert(!JSON.stringify(status).includes(botToken));
  assert.equal(status.configured, true);
  await f.discord.tick();
  assert.equal(f.calls.length, 0);
  await f.discord.test();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0][0], 'https://discord.com/api/v10/users/@me/channels');
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { recipient_id: recipientId });
  assert.equal(f.calls[1][0], `https://discord.com/api/v10/channels/${channelId}/messages`);
  for (const [, options] of f.calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bot ${botToken}`);
    assert(!options.body.includes(botToken));
  }
  assert.deepEqual(f.messages()[0].allowed_mentions, { parse: [] });
  assert(!JSON.stringify(f.messages()).includes('<@'));
  await f.discord.save({ enabled: false });
  assert.equal(f.discord.status().configured, true);
  f.discord.remove();
  assert.equal(f.discord.status().configured, false);
});

test('bursts are counted together and pending summaries survive recreation during the five-minute cooldown', async (t) => {
  const f = fixture(t);
  await enable(f);
  f.edgeEvents.push(f.alert(1), f.alert(2));
  await f.discord.tick();
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].content, 'Proxy · 2 alerts');
  assert.match(f.messages()[0].embeds[0].fields[0].name, /2×/);
  f.advance(10000);
  f.edgeEvents.push(f.alert(3), { ...f.alert(4), source: '203.0.113.45' });
  f.archive.append({ ...f.alert(0, 'Repeated failed authentication operations'), service: 'management', protocol: undefined, status: undefined, source: null });
  await f.discord.tick();
  assert.equal(f.messages().length, 1);
  assert.equal(f.store.get('discord-queue').cursors.edge, 4);
  const restarted = new DiscordAlerts(f.discord);
  f.advance(290000);
  await restarted.tick();
  assert.equal(f.messages().length, 2);
  const payload = f.messages()[1];
  assert.equal(payload.content, 'Proxy · 3 alerts');
  assert.equal(payload.embeds[0].fields.length, 2);
  const fields = payload.embeds[0].fields;
  assert(fields.some((field) => field.value.includes('203.0.113.45')));
  assert(fields.some((field) => field.value.includes('Scope: service-wide') && !field.value.includes('protocol')));
  await restarted.tick();
  assert.equal(f.messages().length, 2);
});

test('summaries and pending state stay bounded under many distinct alerts', async (t) => {
  const f = fixture(t);
  await enable(f);
  await f.discord.test();
  for (let i = 1; i <= 100; i++) f.edgeEvents.push(f.alert(i, `Reason ${i} ${'*'.repeat(500)}`));
  await f.discord.tick();
  const queue = f.store.get('discord-queue');
  assert.equal(queue.groups.length, 20);
  assert.equal(queue.overflow, 80);
  f.advance(300000);
  await f.discord.tick();
  const payload = f.messages()[1], embed = payload.embeds[0];
  assert.equal(payload.content, 'Proxy · 100 alerts');
  assert.equal(embed.fields.length, 6);
  assert.match(embed.description, /94 additional alerts/);
  const size = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
  assert(size < 6000);
  assert(embed.fields.every((field) => field.name.length <= 256 && field.value.length <= 1024));
  assert.equal(f.store.get('discord-queue').groups.length, 0);
});

test('rate limits retain queued counts, report sanitized failures and honor retry-after', async (t) => {
  let fail = true;
  const f = fixture(t, async () => fail ? new Response(botToken, { status: 429, headers: { 'retry-after': '120' } }) : new Response(null, { status: 204 }));
  await enable(f);
  f.edgeEvents.push(f.alert(1));
  await assert.rejects(f.discord.tick(), /HTTP 429/);
  assert.equal(f.store.get('discord-queue').groups[0].count, 1);
  assert(!JSON.stringify(f.discord.status()).includes(botToken));
  f.advance(60000);
  f.edgeEvents.push(f.alert(2));
  await f.discord.tick();
  assert.equal(f.messages().length, 1);
  assert.equal(f.store.get('discord-queue').groups[0].count, 2);
  f.advance(60001); fail = false;
  await f.discord.tick();
  assert.equal(f.messages().length, 2);
  assert.equal(f.messages()[1].content, 'Proxy · 2 alerts');
  assert.equal(f.discord.status().error, null);
});

test('DM creation failures do not leak response bodies and retry pending alerts', async (t) => {
  const f = fixture(t);
  await enable(f);
  const request = f.discord.request;
  f.discord.request = async () => new Response(botToken, { status: 403 });
  f.edgeEvents.push(f.alert(1));
  await assert.rejects(f.discord.tick(), /HTTP 403/);
  assert(!JSON.stringify(f.discord.status()).includes(botToken));
  assert.equal(f.discord.channel, null);
  f.discord.request = request;
  f.advance(60000);
  await f.discord.tick();
  assert.equal(f.messages().length, 1);
});

test('network errors and malformed DM channels are sanitized', async (t) => {
  const f = fixture(t);
  await enable(f);
  f.discord.request = async () => { throw new Error(botToken); };
  await assert.rejects(f.discord.test(), /DM delivery failed/);
  assert(!JSON.stringify(f.discord.status()).includes(botToken));
  f.advance(60000);
  f.discord.request = async () => Response.json({ id: '../bad-channel' });
  await assert.rejects(f.discord.test(), /DM delivery failed/);
  assert.equal(f.discord.channel, null);
});

test('settings edits cannot bypass cooldowns and destination changes discard old pending alerts', async (t) => {
  const f = fixture(t);
  await enable(f);
  await f.discord.test();
  f.edgeEvents.push(f.alert(1));
  await f.discord.tick();
  const cooldown = f.discord.status().nextAttempt;
  await f.discord.save({ enabled: true, recipientId: '123456789012345678' });
  assert.equal(f.discord.status().nextAttempt, cooldown);
  assert.deepEqual(f.store.get('discord-queue').groups, []);
  await assert.rejects(f.discord.test(), /cooling down/);
  f.advance(300000);
  await f.discord.test();
  assert.equal(JSON.parse(f.calls.at(-2)[1].body).recipient_id, '123456789012345678');
});

test('edge outages preserve cursors, clear stale warnings on recovery, and still deliver control alerts', async (t) => {
  const f = fixture(t);
  await enable(f);
  const edge = f.discord.edge;
  f.edgeEvents.push(f.alert(1));
  f.discord.edge = async () => { throw new Error('Edge unavailable'); };
  await f.discord.tick();
  assert.equal(f.discord.status().error, 'Edge alerts unavailable; delivery will retry.');
  assert.deepEqual(f.store.get('discord-queue').cursors, { control: 0, edge: 0 });
  f.archive.append({ ...f.alert(0, 'Management warning'), service: 'management' });
  await f.discord.tick();
  assert.equal(f.messages().length, 1);
  assert.equal(f.discord.status().error, 'Edge alerts unavailable; delivery will retry.');
  f.discord.edge = edge;
  f.advance(300000);
  await f.discord.tick();
  assert.equal(f.store.get('discord-queue').cursors.edge, 1);
  assert.equal(f.messages().length, 2);
  assert.equal(f.discord.status().error, null);
  const status = { lastSuccess: null, error: 'Discord returned HTTP 403.', nextAttempt: null };
  f.store.set('discord-status', status);
  await f.discord.tick();
  assert.equal(f.discord.status().error, status.error);
});

test('recovered health gets an informational summary without fabricated protocol or status', async (t) => {
  const f = fixture(t);
  await enable(f);
  f.edgeEvents.push({ ...f.alert(1, 'CrowdSec recovered'), severity: 'info', service: 'management', protocol: undefined, status: undefined, source: null });
  await f.discord.tick();
  const embed = f.messages()[0].embeds[0];
  assert.equal(embed.color, 3066993);
  assert.match(embed.fields[0].value, /CrowdSec recovered/);
  assert(!embed.fields[0].value.includes('protocol'));
});

test('current CrowdSec events retain distinct ban, request-block and detection-only outcomes with rule links', async (t) => {
  const f = fixture(t);
  await enable(f);
  const security = new Security({ archive: f.archive, monitor: new Monitor({ archive: f.archive }),
    policy: () => ({ security: { exceptions: [] } }), enabled: true });
  security.admin = async () => ({ available: true, decisions: [], alerts: [
    { id: 1, scenario: 'crowdsecurity/http-probing', remediation: true, source: { ip: '203.0.113.1' } },
    { id: 2, scenario: 'crowdsecurity/http-probing', remediation: false, source: { ip: '203.0.113.2' } },
    { id: 3, scenario: 'anomaly score block: rce: 10, anomaly: 10,', kind: 'waf', source: { ip: '203.0.113.3' } },
  ] });
  await security.status();
  await f.discord.tick();
  const payload = f.messages()[0], fields = payload.embeds[0].fields;
  assert.equal(payload.content, 'Proxy · 3 alerts');
  assert.equal(fields.length, 3);
  for (const action of ['IP ban issued', 'Request blocked', 'Detection only'])
    assert(fields.some((field) => field.value.includes(`Recorded action: ${action}`)));
  assert(fields.some((field) => field.value.includes('https://app.crowdsec.net/hub/author/crowdsecurity/scenarios/http-probing')));
  const crs = fields.find((field) => field.value.includes('OWASP CRS'));
  assert.match(crs.value, /RCE score 10/);
  assert.match(crs.value, /not successful code execution/);
  assert.match(crs.value, /https:\/\/docs.crowdsec.net/);
  assert(!JSON.stringify(payload).includes('Latest protocol'));
});

test('security availability alerts preserve the observed fallback and take priority over scanning floods', async (t) => {
  const f = fixture(t);
  await enable(f);
  await f.discord.test();
  for (let i = 1; i <= 20; i++) f.edgeEvents.push(f.alert(i, `Scan ${i}`));
  await f.discord.tick();
  const monitor = new Monitor({ archive: f.archive });
  for (const securityAction of ['Blocked', 'Error']) {
    monitor.securityFailureAt = null;
    monitor.ingest(JSON.stringify({ protocol: 'http', service: 'catch-all', address: '203.0.113.7', status: '503',
      bytes: '0', signal: 'none', securityInspected: true, securityAction,
      securityEngine: 'Availability', securityReason: 'CrowdSec inspection unavailable' }));
  }
  await f.discord.tick();
  const queue = f.store.get('discord-queue');
  assert.equal(queue.groups.length, 20);
  assert.equal(queue.overflow, 2);
  f.advance(300000);
  await f.discord.tick();
  const payload = f.messages()[1], fields = payload.embeds[0].fields;
  assert.equal(payload.content, 'Proxy · 22 alerts');
  assert(fields.slice(0, 2).every((field) => field.value.includes('Protection unavailable')));
  assert(fields.some((field) => field.value.includes('sample request denied by fallback')));
  assert(fields.some((field) => field.value.includes('sample request allowed without full inspection')));
});

test('DM summaries escape event formatting, reject untrusted rule links and fit Discord limits', async (t) => {
  const f = fixture(t);
  await enable(f);
  f.discord.routes = () => [{ id: 'catch-all', name: '*'.repeat(200) }];
  for (let i = 1; i <= 6; i++) f.edgeEvents.push({ ...f.alert(i, `${i} <@123456789012345678>\n${'*'.repeat(300)}`),
    action: '*'.repeat(200), ruleUrl: 'https://evil.test/secret', securityAction: 'Blocked', securityEngine: 'WAF',
    securityReason: '*'.repeat(200) });
  await f.discord.tick();
  const payload = f.messages()[0], embed = payload.embeds[0];
  assert(!JSON.stringify(payload).includes('evil.test'));
  assert(embed.fields.every((field) => field.value.length <= 750 && field.name.length <= 256));
  assert(embed.fields[0].value.includes('\\<@'));
  const size = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n, field) => n + field.name.length + field.value.length, 0);
  assert(size < 6000);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test('settings save holds the delivery lock while querying the edge', async (t) => {
  const f = fixture(t);
  await enable(f);
  let release;
  f.discord.edge = () => new Promise((resolve) => { release = resolve; });
  const saving = f.discord.save({ enabled: true, recipientId: '123456789012345678' });
  await f.discord.tick();
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.discord.test(), /already in progress/);
  assert.throws(() => f.discord.remove(), /already in progress/);
  release({ latest: 0 });
  await saving;
  assert.equal(f.discord.busy, false);
});
