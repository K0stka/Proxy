import test from 'node:test';
import assert from 'node:assert/strict';
import { filterDecisions } from '../shared/security-filters.js';

test('recent decision filters match the values displayed in each table column', () => {
  const decisions = [
    { ip: '192.0.2.1', reason: 'Web attack', host: 'panel.example', engine: 'WAF', action: 'Blocked', requests: 12, banned: true, expires: '3h' },
    { ip: '192.0.2.2', reason: 'Scanning', host: 'Unmatched hosts', engine: 'Behavior', action: 'Detected', requests: 0, banned: false },
  ];

  assert.deepEqual(filterDecisions(decisions, { source: { op: 'equals', value: '192.0.2.2' } }, false), [decisions[1]]);
  assert.deepEqual(filterDecisions(decisions, { threat: { op: 'contains', value: 'panel' } }, false), [decisions[0]]);
  assert.deepEqual(filterDecisions(decisions, { engine: { op: 'in', value: ['Behavior'] } }, false), [decisions[1]]);
  assert.deepEqual(filterDecisions(decisions, { action: { op: 'in', value: ['IP ban active'] } }, false), [decisions[0]]);
  assert.deepEqual(filterDecisions(decisions, { requests: { op: 'contains', value: '12' } }, false), [decisions[0]]);
  assert.deepEqual(filterDecisions(decisions, { expires: { op: 'empty', value: '' } }, false), [decisions[1]]);
});
