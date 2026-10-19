import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { Monitor } from '../shared/monitor.js';
import { startMonitor } from '../edge/monitor.js';
import { render } from '../edge/render.js';
import { policy, route, snapshot } from './fixtures.js';

const record = (changes = {}) => JSON.stringify({ protocol: 'http', service: 'catch-all',
  address: '203.0.113.77', status: '404', bytes: '100', signal: 'none', ...changes });

test('HTTP logs retain only the Kuma classification and validate its type', () => {
  const m = new Monitor();
  m.ingest(record({ uptimeKuma: true, userAgent: 'not-retained' }));
  m.ingest(record({ uptimeKuma: false }));
  m.ingest(record({ uptimeKuma: 'true' }));
  const events = m.snapshot().events;
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.uptimeKuma).sort(), [false, true]);
  assert(!JSON.stringify(events).includes('not-retained'));
});

test('catch-all scanning retains client IPs and full request URLs but ignores unrelated request fields', () => {
  let now = Date.now();
  const m = new Monitor({ now: () => now });
  for (let i = 0; i < 60; i++) m.ingest(record({ signal: 'probe', url: 'https://unknown.example.net/.env?scan=1', method: 'GET', body: 'not-recorded', cookie: 'not-recorded' }));
  const state = m.snapshot();
  assert.equal(state.services[0].count, 60);
  assert.equal(state.events.filter((e) => e.type === 'alert' && e.event === 'Catch-all scanning').length, 2);
  assert.equal(state.events.filter((e) => e.type === 'alert' && e.event === 'Repeated exploit-path probes').length, 2);
  assert(JSON.stringify(state).includes('203.0.113.77'));
  assert(JSON.stringify(state).includes('https://unknown.example.net/.env?scan=1'));
  assert(!JSON.stringify(state).includes('not-recorded'));
  assert.equal(state.events.find((e) => e.type === 'traffic').source, '203.0.113.77');
  now += 60000;
  assert.equal(m.snapshot().services.length, 0);
  now += 86400000;
  assert.equal(m.snapshot().events.length, 0);
});

test('detects denied access, errors, traffic bursts and management authentication failures', () => {
  const m = new Monitor();
  const id = route().id;
  for (let i = 0; i < 20; i++) m.ingest(record({ service: id, status: '503' }));
  for (let i = 0; i < 20; i++) m.ingest(record({ service: id, status: '403' }));
  for (let i = 0; i < 260; i++) m.ingest(record({ service: id, protocol: 'TCP', status: '200' }));
  for (let i = 0; i < 20; i++) m.audit({ event: 'auth.login.completed', status: 403 });
  const events = m.snapshot().events;
  for (const reason of ['Repeated denied access', 'Repeated server / upstream failures', 'Traffic burst', 'Repeated failed authentication operations'])
    assert(events.some((e) => e.type === 'alert' && e.event === reason), reason);
  const udp = new Monitor();
  udp.ingest(record({ protocol: 'UDP', service: id, status: '200' }));
  assert.equal(udp.snapshot().events[0].protocol, 'udp');
  const missing = new Monitor();
  for (let i = 0; i < 60; i++) missing.ingest(record({ service: id }));
  assert(missing.snapshot().events.some((e) => e.type === 'alert' && e.event === 'Repeated missing resources'));
});

test('malformed input is ignored and attacker-controlled cardinality is bounded', () => {
  const m = new Monitor();
  for (const input of ['null', '[]', '1', '{}', '{', 'x'.repeat(2049), record({ address: 1 }), record({ service: 'injected\nservice' }), record({ status: 'NaN' }), record({ status: { toString: 0 } }), record({ service: { toString: 0 } }), record({ bytes: { toString: 0 } })])
    assert.doesNotThrow(() => m.ingest(input));
  assert.equal(m.snapshot().events.length, 0);
  for (let i = 0; i < 4500; i++) m.ingest(record({ address: `10.0.${Math.floor(i / 256)}.${i % 256}` }));
  assert.equal(m.snapshot().events.length, 500);
  assert(m.windows.size <= 4096);
  assert(m.snapshot().events.some((e) => e.type === 'alert'));
});

test('loopback syslog receiver ingests sanitized NGINX records', async (t) => {
  const traffic = await startMonitor(), sender = dgram.createSocket('udp4');
  t.after(() => { sender.close(); traffic.close(); });
  await new Promise((resolve, reject) => sender.send(`<190>Oct 19 proxy proxy_http: ${record()}`, traffic.port, '127.0.0.1', (e) => e ? reject(e) : resolve()));
  for (let i = 0; i < 50 && !traffic.monitor.snapshot().events.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(traffic.monitor.snapshot().events[0].service, 'catch-all');
});

test('NGINX monitoring covers routes and records URLs and IPs without request bodies or headers', () => {
  const root = route({ published: true }), child = route({ kind: 'redirect', path: '/go', redirectURL: 'https://example.net/', hostname: root.hostname, published: true });
  const tcp = route({ kind: 'tcp', ports: '50000-50001', published: true });
  const udp = route({ kind: 'udp', ports: '50000-50001', published: true });
  const config = render(policy(), snapshot([root, child, tcp, udp]), {
    revision: 'test', directory: '/runtime/test', readyDomains: ['krychlic.com'], monitorPort: 12345,
  }).config;
  assert(config.includes('default catch-all;'));
  assert(config.indexOf(` ${child.id};`) < config.indexOf(` ${root.id};`));
  for (const r of [tcp, udp]) for (const port of [50000, 50001])
    assert(config.includes(`"203.0.113.10:${r.kind.toUpperCase()}:${port}" ${r.id};`));
  const formats = config.split('\n').filter((line) => line.startsWith('log_format'));
  assert.equal(formats.length, 2);
  for (const line of formats) {
    assert(!/\$(?:request_body|http_cookie|http_authorization)/.test(line));
    assert(line.includes('escape=json'));
  }
  assert(formats.some((line) => line.includes('$host$request_uri')));
  assert(config.includes('map $http_user_agent $monitor_uptime_kuma'));
  assert(config.includes('~*^Uptime-Kuma/ true;'));
  assert(formats.some((line) => line.includes('"uptimeKuma":$monitor_uptime_kuma')));
  assert(config.includes('listen unix:/tmp/proxy-health.sock; access_log off;'));
});
