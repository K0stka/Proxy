import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { json, unixRequest } from '../shared/http.js';

test('internal HTTP preserves actionable client errors and identifies the failed service', async (t) => {
  const id = randomUUID();
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\proxy-test-${id}`
      : join(tmpdir(), `proxy-${id}.sock`);
  const server = http.createServer((req, res) =>
    json(res, { error: 'Repository has local changes' }, Number(req.url.slice(1))),
  );
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [remoteStatus, expected] of [
    [400, 400],
    [409, 409],
    [500, 502],
  ])
    await assert.rejects(
      unixRequest(socket, `/${remoteStatus}`, { service: 'Files updater' }),
      (error) => error.status === expected && error.message === 'Repository has local changes',
    );
  await assert.rejects(
    unixRequest(`${socket}-missing`, '/pull', { service: 'Files updater' }),
    (error) =>
      error.status === 503 && /Files updater/.test(error.message) && !/Edge/.test(error.message),
  );
});
