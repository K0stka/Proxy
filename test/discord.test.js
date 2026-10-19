import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordAlerts, webhookURL } from '../server/discord.js';
import { Store } from '../server/store.js';
import { LogStore } from '../shared/log-store.js';

const url = `https://discord.com/api/webhooks/123456789012345678/${'test_token_'.repeat(6)}`;
function fixture(t, request = async () => new Response(null, { status: 204 })) {
  const store = new Store(':memory:'), archive = new LogStore(':memory:');
  let now = Date.now();
  const edgeEvents = [], calls = [];
  const discord = new DiscordAlerts({ store, archive, now: () => now, routes: () => [],
    edge: async (path) => ({ events: edgeEvents.filter((e) => e.id > Number(new URL(path, 'http://edge').searchParams.get('after'))), latest: edgeEvents.at(-1)?.id ?? 0 }),
    request: async (...args) => { calls.push(args); return request(...args); },
  });
  t.after(() => { archive.close(); store.close(); });
  return { store, archive, discord, edgeEvents, calls, advance: (ms) => { now += ms; },
    alert: (id, reason = 'Catch-all scanning') => ({ id, type: 'alert', service: 'catch-all', event: reason,
      time: new Date(now).toISOString(), source: '012345abcdef', status: 404, protocol: 'http' }) };
}

test('webhook validation rejects alternate hosts, credentials, queries, redirects and non-HTTPS URLs', () => {
  assert.equal(webhookURL(url), url);
  for (const bad of [url.replace('https:', 'http:'), url.replace('discord.com', 'discord.com.evil.test'),
    url.replace('discord.com', 'user@discord.com'), url + '?x=1', url + '#secret', url.replace('discord.com', '127.0.0.1'), url.replace('/api/', ':444/api/')])
    assert.throws(() => webhookURL(bad), /Discord webhook/);
});

test('settings redact credentials, start at current alerts, and send a safe test payload', async (t) => {
  const f = fixture(t);
  f.edgeEvents.push(f.alert(1));
  const status = await f.discord.save({ enabled: true, webhookURL: url });
  assert(!JSON.stringify(status).includes('test_token'));
  assert.equal(status.configured, true);
  await f.discord.tick();
  assert.equal(f.calls.length, 0);
  await f.discord.test();
  assert.equal(f.calls.length, 1);
  const [target, options] = f.calls[0];
  assert.equal(target, url + '?wait=true');
  assert.equal(options.redirect, 'error');
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [], users: ['710044411035254864'] });
  assert.equal(payload.content, '<@710044411035254864> Proxy alert - Test notification — Discord alerts are connected.');
  assert(!options.body.includes('test_token'));
  await f.discord.save({ enabled: false });
  assert.equal(f.discord.status().configured, true);
  f.discord.remove();
  assert.equal(f.discord.status().configured, false);
});

test('alerts are delivered without a page open, deduplicated, throttled, and resume from persisted cursors', async (t) => {
  const f = fixture(t);
  await f.discord.save({ enabled: true, webhookURL: url });
  f.edgeEvents.push(f.alert(1), f.alert(2));
  await f.discord.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.calls[0][1].body).content, '<@710044411035254864> Proxy alert - Catch-all scanning');
  await f.discord.tick();
  assert.equal(f.calls.length, 1);
  f.advance(10000);
  await f.discord.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('discord-cursors').edge, 2);
  f.archive.append({ ...f.alert(0, 'Repeated failed authentication operations'), service: 'management' });
  await f.discord.tick();
  assert.equal(f.calls.length, 2);
  f.advance(900001);
  f.edgeEvents.push(f.alert(3));
  await f.discord.tick();
  assert.equal(f.calls.length, 3);
});

test('rate limits retain cursors for retry and report sanitized failures', async (t) => {
  let fail = true;
  const f = fixture(t, async () => fail ? new Response(url, { status: 429, headers: { 'retry-after': '120' } }) : new Response(null, { status: 204 }));
  await f.discord.save({ enabled: true, webhookURL: url });
  f.edgeEvents.push(f.alert(1));
  await assert.rejects(f.discord.tick(), /HTTP 429/);
  assert.equal(f.store.get('discord-cursors').edge, 0);
  assert(!JSON.stringify(f.discord.status()).includes('test_token'));
  f.advance(60000);
  await f.discord.tick();
  assert.equal(f.calls.length, 1);
  f.advance(60001); fail = false;
  await f.discord.tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.get('discord-cursors').edge, 1);
  assert.equal(f.discord.status().error, null);
});
