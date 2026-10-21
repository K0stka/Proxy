import test from 'node:test';
import assert from 'node:assert/strict';
import { Security } from '../edge/security.js';
import { defaultSecurityPolicy } from '../shared/security-policy.js';
import { Monitor } from '../shared/monitor.js';
import { LogStore } from '../shared/log-store.js';

test('IP enforcement filters origins, supports IPv6 exceptions, honors overrides and reports unavailable decisions', async () => {
  let p = structuredClone(defaultSecurityPolicy), fail = false;
  const engine = new Security({ enabled: true, policy: () => ({ security: p }), request: async () => {
    if (fail) throw Error();
    return new Response(JSON.stringify([{ type: 'ban', origin: 'CAPI', scenario: 'reputation' }]));
  } });
  engine.key = async () => 'test-key';
  const input = { ip: '2001:db8::1', service: 'catch-all' };
  assert.equal((await engine.check(input)).action, 'Blocked');
  p.reputation = false;
  assert.equal((await engine.check(input)).action, 'Allowed');
  p.reputation = true; p.mode = 'monitor';
  assert.equal((await engine.check(input)).action, 'Detected');
  p.exceptions = [{ ip: '2001:db8:0:0:0:0:0:1', note: '' }];
  assert.equal((await engine.check(input)).mode, 'off');
  p.exceptions = []; p.routes = { 'catch-all': 'off' };
  assert.equal((await engine.check(input)).mode, 'off');
  p.routes = {}; fail = true; engine.cache.clear();
  assert.match((await engine.check(input)).error, /unavailable/);
  await assert.rejects(engine.release('bad-ip'), /IPv4 or IPv6/);
  await assert.rejects(engine.check({ ip: {}, service: 'catch-all' }), /Invalid/);
});

test('security counts actual inspected traffic, does not count alert duplicates and respects selected bounds', (t) => {
  const archive = new LogStore(':memory:'), monitor = new Monitor({ archive });
  t.after(() => archive.close());
  const engine = new Security({ archive, monitor });
  const time = new Date().toISOString();
  for (const [action, source] of [['Blocked', 'WAF'], ['Detected', 'WAF'], ['Allowed', ''], ['Blocked', 'Behavior'], ['Blocked', 'Availability']])
    monitor.ingest(JSON.stringify({ protocol: 'http', service: 'catch-all', address: '198.51.100.7', status: '403', bytes: '10', signal: 'none',
      url: 'https://example.net/path', method: 'POST', securityInspected: true, securityAction: action, securityEngine: source, securityReason: 'Test' }));
  const result = engine.summary({ from: new Date(Date.now() - 60000).toISOString(), to: new Date(Date.now() + 60000).toISOString() });
  assert.equal(result.counts.inspected, 5);
  assert.equal(result.counts.blocked, 3);
  assert.equal(result.counts.detected, 3);
  assert.equal(result.counts.sources.WAF, 1);
  assert.equal(result.buckets.reduce((a, b) => a + b, 0), 3);
  assert.equal(result.decisions.reduce((sum, d) => sum + d.requests, 0), 3);
  assert.equal(result.decisions[0].method, 'POST');
  assert.equal(engine.summary({ from: '2000-01-01T00:00:00.000Z', to: '2000-01-02T00:00:00.000Z' }).counts.inspected, 0);
});

test('overlapping edge generations import a CrowdSec alert once without changing normal log retention', (t) => {
  const archive = new LogStore(':memory:');
  t.after(() => archive.close());
  const event = { type: 'alert', service: 'catch-all', event: 'CrowdSec detection', time: new Date().toISOString(), crowdsecAlertId: 7 };
  archive.append(event); archive.append(event);
  archive.append({ ...event, crowdsecAlertId: 8 });
  archive.append({ ...event, type: 'traffic' });
  archive.flush();
  assert.equal(archive.history().events.length, 3);
  assert.equal(archive.history().events.filter((e) => e.type === 'alert').length, 2);
  assert.equal(new Security({ archive }).lastAlert, 8);
});
