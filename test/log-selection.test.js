import test from 'node:test';
import assert from 'node:assert/strict';
import { logSelection, logSelectionIndices } from '../ui/log-period.js';

test('chart selections include complete buckets, normalize reverse drags and clamp partial endpoints', () => {
  const start = Date.parse('2026-10-20T10:00:25.123Z');
  const summary = { from: new Date(start).toISOString(), to: new Date(start + 150000).toISOString(),
    step: 60000, buckets: [0, 1, 2].map((i) => ({ minute: (start + i * 60000) / 60000 })) };
  assert.deepEqual(logSelection(summary, 1, 0), { from: summary.from, to: new Date(start + 120000).toISOString() });
  assert.deepEqual(logSelection(summary, -5, 10), { from: summary.from, to: summary.to });
  assert.deepEqual(logSelection(summary, 2, 2), { from: new Date(start + 120000).toISOString(), to: summary.to });
  for (const [first, last] of [[0, 0], [0, 1], [1, 2], [0, 2], [2, 2]])
    assert.deepEqual(logSelectionIndices(summary, logSelection(summary, first, last)), [first, last]);
  assert.equal(logSelectionIndices(summary, null), null);
  assert.equal(logSelection({ ...summary, buckets: [] }, 0, 1), null);
});
