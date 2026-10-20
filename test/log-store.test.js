import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogStore, logQuery } from '../shared/log-store.js';
import { Monitor } from '../shared/monitor.js';

const event = (now, i = 0, type = 'traffic') => ({ time: new Date(now).toISOString(), type,
  service: 'catch-all', event: `Event ${i}`, severity: 'info' });

test('checkbox filters support multiple values and deselect all without losing available choices', (t) => {
  const archive = new LogStore(':memory:'); t.after(() => archive.close());
  const now = Date.now() - 1000;
  for (let i = 0; i < 230; i++) archive.append({ ...event(now, i), event: i < 120 ? 'First' : 'Second',
    method: i % 2 ? 'GET' : 'POST', status: i % 2 ? 200 : 503, suspicious: i % 2 === 0 });
  archive.append({ ...event(now, 1, 'audit'), event: 'Admin event', role: 'control' });
  archive.append({ ...event(now, 2), service: 'management', event: 'Hidden' });
  const query = (values) => logQuery(new URLSearchParams({ kind: 'traffic', hideManagement: 'true',
    columns: JSON.stringify({ event: { op: 'in', value: values } }) }));
  for (const [values, count] of [[['First', 'Second'], 230], [['First'], 120], [[], 0], [["' OR 1=1 --"], 0]]) {
    const summary = archive.summary(query(values));
    assert.equal(summary.totals.count, count);
    assert.equal(archive.history(query(values)).events.length, Math.min(count, 100));
    assert.deepEqual(summary.options.event, ['First', 'Second']);
    assert.deepEqual(summary.options.method, ['GET', 'POST']);
    assert.deepEqual(summary.options.status, ['200', '503']);
    assert.deepEqual(summary.options.suspicious, ['Normal', 'Suspicious']);
  }
  assert.equal(archive.history({ ...query(['First']), before: archive.history(query(['First'])).next }).events.length, 20);
  for (const value of ['GET', [3], [null], ['x'.repeat(501)]])
    assert.throws(() => query(value), /Invalid column filter/);
  const audit = archive.summary({ kind: 'administration' });
  assert.deepEqual(audit.options.role, ['control']);
  assert.deepEqual(audit.options.event, ['Admin event']);
});

test('audit field availability covers the full period and stays stable across column filtering', (t) => {
  const archive = new LogStore(':memory:'); t.after(() => archive.close());
  const now = Date.now() - 1000;
  archive.append({ ...event(now, 0, 'audit'), event: 'Admin action', method: 'POST', url: '/api/preferences', status: 200, source: '203.0.113.1' });
  for (let i = 0; i < 120; i++) archive.append({ ...event(now, i, 'operation'), event: 'Router activated', generation: 'rev-1', role: 'edge', details: '' });
  archive.append({ ...event(now - 2 * 86400000, 0, 'operation'), details: 'Outside selected period' });
  const query = { kind: 'administration', from: new Date(now - 3600000).toISOString(), to: new Date(now + 1000).toISOString() };
  assert(archive.history(query).events.every((e) => e.type === 'operation'));
  const expected = ['generation', 'role', 'severity', 'source', 'method', 'url', 'status'];
  assert.deepEqual(archive.summary(query).fields, expected);
  assert.deepEqual(archive.summary({ ...query, columns: { event: { op: 'in', value: ['Router activated'] } } }).fields, expected);
  assert.deepEqual(archive.summary({ ...query, services: [] }).fields, []);
  assert.deepEqual(archive.summary({ ...query, kind: 'operation' }).fields, ['generation', 'role', 'severity']);
});

test('every table column filters stored events and totals with bound values', (t) => {
  const archive = new LogStore(':memory:'); t.after(() => archive.close());
  const time = new Date().toISOString();
  const fields = { time, service: 'management', event: "Operator's action %_", source: '203.0.113.9',
    method: 'POST', url: '/api/routes', status: 403, severity: 'warning', generation: 'edge-2', role: 'edge', details: 'remainingConnections: 2' };
  archive.append({ ...fields, type: 'operation' });
  archive.append({ time, type: 'operation', service: 'catch-all', event: 'Other' });
  for (const [field, value] of Object.entries(fields)) {
    const query = logQuery(new URLSearchParams({ columns: JSON.stringify({ [field]: { op: 'equals', value: String(value) } }) }));
    assert.equal(archive.history(query).events.length, field === 'time' ? 2 : 1, field);
    assert.equal(archive.summary(query).totals.count, field === 'time' ? 2 : 1, field);
  }
  for (const [op, value, count] of [['contains', '%_', 1], ['excludes', fields.event, 1], ['empty', '', 0], ['present', '', 2], ['equals', "' OR 1=1 --", 0]]) {
    const query = logQuery(new URLSearchParams({ columns: JSON.stringify({ event: { op, value } }) }));
    assert.equal(archive.history(query).events.length, count);
    assert.equal(archive.summary(query).totals.count, count);
  }
  for (const columns of ['null', '[]', '{', '{"unknown":{"op":"equals","value":"x"}}', '{"event":{"op":"SQL","value":"x"}}', '{"status":{"op":"equals","value":403}}'])
    assert.throws(() => logQuery(new URLSearchParams({ columns })), /Invalid column filter/);
});

test('logs survive reopening, paginate without gaps, and expire after 30 days even when idle', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-logs-'));
  let now = Date.now();
  let archive = new LogStore(join(dir, 'logs.db'), { now: () => now });
  for (let i = 0; i < 240; i++) archive.append(event(now, i));
  archive.close();
  archive = new LogStore(join(dir, 'logs.db'), { now: () => now });
  t.after(async () => { archive.close(); await rm(dir, { recursive: true, force: true }); });
  const first = archive.history(), second = archive.history({ before: first.next }), third = archive.history({ before: second.next });
  assert.deepEqual([first.events.length, second.events.length, third.events.length], [100, 100, 40]);
  assert.equal(new Set([...first.events, ...second.events, ...third.events].map((e) => e.id)).size, 240);
  assert.equal(third.next, null);
  assert.equal(archive.status().days, 30);
  assert(archive.status().diskBytes > 0);
  const monitor = new Monitor({ archive });
  assert(monitor.snapshot().events.length > 0);
  now += 31 * 86400000;
  archive.flush();
  assert.equal(archive.history().events.length, 0);
});

test('byte cap removes oldest events; filters, alert cursor and multiple writers stay consistent', () => {
  const archive = new LogStore(':memory:', { maxBytes: 1500 });
  try {
    for (let i = 0; i < 100; i++) archive.append(event(Date.now(), i, i % 2 ? 'alert' : 'traffic'));
    archive.flush();
    assert(archive.status().bytes <= 1500);
    assert(archive.status().count < 100);
    assert.equal(archive.history().events[0].event, 'Event 99');
    assert(archive.history({ kind: 'alert' }).events.every((e) => e.type === 'alert'));
    assert(archive.alertsAfter(archive.latestId()).length === 0);
    assert(archive.alertsAfter(0).every((e) => e.type === 'alert'));
    assert.equal(archive.history({ service: 'management' }).events.length, 0);
  } finally { archive.close(); }
});

test('persistence errors are reported without throwing from traffic logging; log queries reject injection', () => {
  const archive = new LogStore(':memory:');
  try {
    const exec = archive.db.exec.bind(archive.db);
    archive.db.exec = (sql) => { if (sql === 'BEGIN IMMEDIATE') throw new Error('disk full'); return exec(sql); };
    archive.append(event(Date.now()));
    assert.doesNotThrow(() => archive.flush());
    assert.match(archive.status().error, /persistence failed/);
    archive.db.exec = exec;
    for (const query of ['before=-1', 'before=9007199254740992', 'service=x%27', 'kind=secret'])
      assert.throws(() => logQuery(new URLSearchParams(query)), /Invalid log filter/);
  } finally { archive.close(); }
});

test('two generation writers share the retention budget and monotonic cursor', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-log-writers-'));
  const a = new LogStore(join(dir, 'logs.db'), { maxBytes: 1500 });
  const b = new LogStore(join(dir, 'logs.db'), { maxBytes: 1500 });
  t.after(async () => { a.close(); b.close(); await rm(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 20; i++) {
    const writer = i % 2 ? a : b;
    writer.append(event(Date.now(), i)); writer.flush();
  }
  assert(a.status().bytes <= 1500);
  assert.equal(a.status().count, b.status().count);
  assert.equal(a.latestId(), 20);
});

test('shared history survives generation retirement and reopening', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'proxy-shared-logs-'));
  const file = join(dir, 'logs.db');
  const old = new LogStore(file), active = new LogStore(file);
  for (let i = 0; i < 120; i++) old.append(event(Date.now(), i));
  old.flush();
  for (let i = 120; i < 160; i++) active.append(event(Date.now(), i));
  active.flush();
  old.append(event(Date.now(), 160));
  old.close();
  assert.equal(active.status().count, 161);
  assert.equal(active.summary().totals.requests, 161);
  active.close();
  const reopened = new LogStore(file);
  t.after(async () => { reopened.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(reopened.status().count, 161);
  assert.equal(reopened.latestId(), 161);
  const first = reopened.history();
  assert.equal(first.events.length, 100);
  assert.equal(reopened.history({ before: first.next }).events.length, 61);
});

test('chart summaries count retained traffic and response outcomes in 60 real minute buckets', () => {
  let now = Date.parse('2026-10-19T14:30:25Z');
  const archive = new LogStore(':memory:', { now: () => now });
  try {
    for (const [minutes, status] of [[0, 200], [0, 302], [1, 403], [1, 502], [70, 200]])
      archive.append({ ...event(now - minutes * 60000), status });
    archive.append(event(now, 1, 'alert'));
    archive.append(event(now, 2, 'operation'));
    const summary = archive.summary();
    assert.equal(summary.buckets.length, 60);
    assert.deepEqual(summary.totals, { count: 6, requests: 4, alerts: 1, success: 2, clientErrors: 1, serverErrors: 1 });
    assert.equal(summary.buckets.at(-1).requests, 2);
    assert.equal(summary.buckets.at(-2).requests, 2);
    assert.equal(summary.buckets[0].requests, 0);
    now += 61 * 60000;
    assert.equal(archive.summary().totals.requests, 0);
  } finally { archive.close(); }
});
