import test from 'node:test';
import assert from 'node:assert/strict';
import { LogStore, logQuery } from '../shared/log-store.js';
import { logView, logPage, logCursor, filteredLogQuery } from '../server/logs.js';
import { logPeriod } from '../ui/log-period.js';

test('CS2 Renderer settings filter before pagination, charts and export while retaining alerts and old logs', async (t) => {
  const control = new LogStore(':memory:'), traffic = new LogStore(':memory:');
  t.after(() => { control.close(); traffic.close(); });
  const time = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 280; i++) traffic.append({ time, type: 'traffic', service: 'catch-all',
    source: '203.0.113.44', cs2Renderer: i >= 130, status: 200, event: `Request ${i}` });
  traffic.append({ time, type: 'traffic', service: 'catch-all', status: 200, event: 'Legacy request' });
  traffic.append({ time, type: 'alert', service: 'catch-all', cs2Renderer: true, event: 'Security alert' });
  control.append({ time, type: 'audit', service: 'management', cs2Renderer: true, event: 'Admin event' });
  const edge = async (path) => {
    const url = new URL(path, 'http://edge'), query = logQuery(url.searchParams);
    return url.pathname === '/logs' ? traffic.history(query) : traffic.summary(query);
  };
  const params = new URLSearchParams(logPeriod('hour'));
  const view = await logView(control, edge, params);
  assert.equal(view.summary.totals.requests, 131);
  assert.equal(view.summary.totals.count, 133);
  const exported = [];
  let cursor = {};
  do {
    const page = await logPage(control, edge, filteredLogQuery(params), cursor, { strict: true });
    exported.push(...page.events);
    cursor = page.next ? logCursor(page.next) : null;
  } while (cursor);
  assert.equal(exported.length, 133);
  assert(exported.every((e) => e.type !== 'traffic' || !e.cs2Renderer));
  const shown = await logView(control, edge, params, { hideUptimeKuma: true, hideManagement: true, hideCS2Renderer: false });
  assert.equal(shown.summary.totals.requests, 281);
  assert.equal(traffic.history().storage.count, 282);
  assert.throws(() => logQuery(new URLSearchParams('hideCS2Renderer=yes')), /Invalid log filter/);
});

test('traffic, alerts and administration stay separate through filtering, pagination and export', async (t) => {
  const control = new LogStore(':memory:'), traffic = new LogStore(':memory:');
  t.after(() => { control.close(); traffic.close(); });
  const time = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 240; i++) traffic.append({ time, type: 'traffic', service: 'catch-all',
    event: 'Exploit-path probe', url: 'https://example.net/.env', method: 'GET', status: 404 });
  traffic.append({ time, type: 'traffic', service: 'catch-all', event: 'Request / session completed', status: 200 });
  traffic.append({ time, type: 'alert', service: 'catch-all', event: 'Repeated exploit-path probes' });
  traffic.append({ time, type: 'operation', service: 'management', event: 'NGINX configuration activated' });
  control.append({ time, type: 'audit', service: 'management', event: 'Admin event' });
  control.append({ time, type: 'operation', service: 'management', event: 'Spawned new generation', generation: 'edge-1' });
  const edge = async (path) => {
    const url = new URL(path, 'http://edge'), query = logQuery(url.searchParams);
    return url.pathname === '/logs' ? traffic.history(query) : traffic.summary(query);
  };
  const params = new URLSearchParams({ ...logPeriod('hour'), kind: 'traffic', columns: JSON.stringify({
    suspicious: { op: 'equals', value: 'Suspicious' }, method: { op: 'equals', value: 'GET' }, url: { op: 'contains', value: '/.env' },
  }) });
  const view = await logView(control, edge, params);
  assert.equal(view.summary.totals.count, 240);
  assert.equal(view.events.length, 100);
  const exported = [];
  let cursor = {};
  do {
    const page = await logPage(control, edge, filteredLogQuery(params), cursor, { strict: true });
    exported.push(...page.events);
    cursor = page.next ? logCursor(page.next) : null;
  } while (cursor);
  assert.equal(exported.length, 240);
  assert(exported.every((e) => e.type === 'traffic'));
  params.delete('columns'); params.set('kind', 'alert');
  assert.equal((await logView(control, edge, params)).summary.totals.count, 1);
  params.set('kind', 'administration');
  const audit = await logView(control, edge, params);
  assert.equal(audit.summary.totals.count, 3);
  assert(audit.events.every((e) => ['audit', 'operation'].includes(e.type)));
  assert.deepEqual(audit.summary.options.event, ['Admin event', 'NGINX configuration activated', 'Spawned new generation']);
  params.set('columns', JSON.stringify({ event: { op: 'in', value: ['Admin event', 'NGINX configuration activated'] } }));
  const selected = await logView(control, edge, params);
  assert.equal(selected.summary.totals.count, 2);
  assert.deepEqual(selected.summary.options.event, audit.summary.options.event);
});

test('default exclusions filter requests before pagination, totals and export, retaining audit and alerts', async (t) => {
  const control = new LogStore(':memory:'), traffic = new LogStore(':memory:');
  t.after(() => { control.close(); traffic.close(); });
  const time = new Date().toISOString();
  for (let i = 0; i < 240; i++) traffic.append({ time, type: 'traffic', service: 'catch-all', source: '203.0.113.9', event: `Visible ${i}`, status: 200 });
  for (let i = 0; i < 240; i++) traffic.append({ time, type: 'traffic', service: i % 2 ? 'management' : 'catch-all', source: '203.0.113.9', uptimeKuma: i % 2 === 0, event: 'Hidden', status: 200 });
  traffic.append({ time, type: 'alert', service: 'management', source: '203.0.113.9', uptimeKuma: true, event: 'Security alert' });
  control.append({ time, type: 'audit', service: 'management', source: '100.89.5.109', event: 'Admin event' });
  const edge = async (path) => {
    const url = new URL(path, 'http://edge'), query = logQuery(url.searchParams);
    return url.pathname === '/logs' ? traffic.history(query) : traffic.summary(query);
  };
  const params = new URLSearchParams(logPeriod('hour'));
  const view = await logView(control, edge, params);
  assert.equal(view.summary.totals.requests, 240);
  assert.equal(view.summary.totals.count, 242);
  assert(view.events.every((e) => e.event !== 'Hidden'));
  const events = [];
  let cursor = {};
  do {
    const page = await logPage(control, edge, filteredLogQuery(params), cursor, { strict: true });
    events.push(...page.events);
    cursor = page.next ? logCursor(page.next) : null;
  } while (cursor);
  assert.equal(events.length, 242);
  assert(events.some((e) => e.type === 'audit'));
  assert(events.some((e) => e.type === 'alert'));
  const all = await logView(control, edge, params, { hideUptimeKuma: false, hideManagement: false });
  assert.equal(all.summary.totals.requests, 480);
  const managementOnly = await logView(control, edge, params, { hideUptimeKuma: false, hideManagement: true });
  assert.equal(managementOnly.summary.totals.requests, 360);
  const kumaOnly = await logView(control, edge, params, { hideUptimeKuma: true, hideManagement: false });
  assert.equal(kumaOnly.summary.totals.requests, 360);
  for (const value of ['hideUptimeKuma=yes', 'hideManagement=yes']) assert.throws(() => logQuery(new URLSearchParams(value)));
});

test('period presets use rolling ranges and Today starts at local midnight across DST', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Prague';
  try {
    const now = new Date('2026-10-25T12:00:00Z');
    assert.equal(logPeriod('today', now).from, '2026-10-24T22:00:00.000Z');
    for (const [period, hours] of [['hour', 1], ['day', 24], ['week', 168], ['month', 720]]) {
      const bounds = logPeriod(period, now);
      assert.equal(Date.parse(bounds.to) - Date.parse(bounds.from), hours * 3600000);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('one period and service selection controls totals, events, client IP filtering and all export pages', async (t) => {
  const control = new LogStore(':memory:'), traffic = new LogStore(':memory:');
  t.after(() => { control.close(); traffic.close(); });
  const now = Date.now(), from = new Date(now - 86400000).toISOString(), to = new Date(now + 1).toISOString();
  const id = '11111111-1111-4111-8111-111111111111';
  // Deliberately insert out of time order, including identical timestamps across components.
  for (let i = 0; i < 370; i++) {
    const item = { time: new Date(now - (i % 100) * 1000).toISOString(), type: 'traffic',
      service: i % 3 ? id : 'catch-all', event: `Request ${i}`, status: i % 4 ? 200 : 502,
      source: i % 2 ? '203.0.113.9' : '2001:db8::1', url: `https://example.net/path/${i}?q=1` };
    (i % 2 ? control : traffic).append(item);
  }
  traffic.append({ time: new Date(now - 2 * 86400000).toISOString(), type: 'traffic', service: id, event: 'Outside period', status: 200 });
  const edge = async (path) => {
    const url = new URL(path, 'http://edge'), query = logQuery(url.searchParams);
    return url.pathname === '/logs' ? traffic.history(query) : traffic.summary(query);
  };
  const params = new URLSearchParams({ from, to, services: id });
  const view = await logView(control, edge, params);
  assert.equal(view.summary.totals.count, 246);
  assert.equal(view.summary.totals.requests, 246);
  assert(view.events.every((e) => e.service === id && Date.parse(e.time) >= Date.parse(from)));
  const all = [];
  let page = await logPage(control, edge, logQuery(params));
  for (let i = 0; i < 10; i++) {
    all.push(...page.events);
    if (!page.next) break;
    page = await logPage(control, edge, logQuery(params), logCursor(page.next));
  }
  assert.equal(all.length, 246);
  assert.equal(new Set(all.map((e) => `${e.component}:${e.id}`)).size, 246);
  assert(all.every((e, i) => !i || e.time <= all[i - 1].time));
  params.set('services', '');
  const none = await logView(control, edge, params);
  assert.equal(none.events.length, 0); assert.equal(none.summary.totals.count, 0);
  params.set('services', `${id},catch-all`); params.set('source', '203.0.113.9');
  const ip = await logView(control, edge, params);
  assert.equal(ip.summary.totals.requests, 185);
  assert(ip.events.every((e) => e.source === '203.0.113.9'));
});

test('invalid periods, cursors and service selections fail closed; incomplete edge export fails', async (t) => {
  const archive = new LogStore(':memory:'); t.after(() => archive.close());
  for (const query of ['from=invalid&to=nope', 'from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z',
    'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z', 'services=management,bad-id', 'source=not-an-ip'])
    assert.throws(() => logQuery(new URLSearchParams(query)));
  for (const value of ['bad!', Buffer.from('{"edge":-1}').toString('base64url'), Buffer.from('{"edge":{"id":1,"time":"bad"}}').toString('base64url')])
    assert.throws(() => logCursor(value));
  const edge = async () => { throw new Error('Edge offline'); };
  const result = await logView(archive, edge, new URLSearchParams(logPeriod('day')));
  assert.equal(result.edgeAvailable, false);
  await assert.rejects(logPage(archive, edge, {}, {}, { strict: true }), /offline/);
});
