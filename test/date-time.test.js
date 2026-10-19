import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateTime } from '../ui/date-time.js';

test('date formatting uses relative local calendar days and a padded 24-hour clock', () => {
  const now = new Date(2026, 9, 19, 12);
  assert.equal(formatDateTime(new Date(2026, 9, 19, 0, 5, 9), now), 'Today, 00:05:09');
  assert.equal(formatDateTime(new Date(2026, 9, 18, 23, 59, 58), now), 'Yesterday, 23:59:58');
  assert.equal(formatDateTime(new Date(2026, 9, 20, 17, 6, 4), now), 'Tomorrow, 17:06:04');
  assert.equal(formatDateTime(new Date(2026, 9, 17, 13, 2, 3), now), '17. 10. 13:02:03');
  assert.equal(formatDateTime(new Date(2026, 11, 31, 22, 3, 1), new Date(2027, 0, 1, 2)), 'Yesterday, 22:03:01');
  assert.equal(formatDateTime(null, now), '—');
  assert.equal(formatDateTime('invalid', now), '—');
});

test('relative days stay correct across the Prague daylight-saving change', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Prague';
  try {
    assert.equal(formatDateTime('2026-10-24T23:30:00Z', new Date('2026-10-26T22:00:00Z')), 'Yesterday, 01:30:00');
    assert.equal(formatDateTime('2026-10-25T22:30:00Z', new Date('2026-10-25T00:30:00Z')), 'Today, 23:30:00');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
