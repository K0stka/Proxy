import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogStore, logQuery } from '../shared/log-store.js';
import { Monitor } from '../shared/monitor.js';

const event = (now, i = 0, type = 'traffic') => ({ time: new Date(now).toISOString(), type,
  service: 'catch-all', event: `Event ${i}`, severity: 'info' });

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
