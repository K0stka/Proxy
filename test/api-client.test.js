import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../ui/api.js';

test('API client reports proxy HTML failures without leaking response content or retrying writes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('<!DOCTYPE html><h1>private error page</h1>', { status: 502 });
  };
  await assert.rejects(
    api('/sites/pull', { method: 'POST', body: { directory: 'codenames/dist' } }),
    (error) =>
      error.status === 502 &&
      /result is unknown/.test(error.message) &&
      !/DOCTYPE|private|Unexpected token/.test(error.message),
  );
  assert.equal(calls, 1);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'SSH host verification failed' }), { status: 502 });
  await assert.rejects(
    api('/sites/pull', { method: 'POST' }),
    (error) => error.status === 502 && error.message === 'SSH host verification failed',
  );
});
