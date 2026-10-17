import assert from 'node:assert/strict';
import { stat, writeFile, unlink, access } from 'node:fs/promises';
import http from 'node:http';

assert.equal(process.getuid(), 10001);
assert(!('PROXY_CLOUDFLARE_TOKEN' in process.env));
assert.equal(process.env.PROXY_KOMODO_KEY, 'smoke-test-key');
await assert.rejects(access('/config/config.json'));
await assert.rejects(access('/run/secrets/bootstrap'));
const edgeRequest = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ socketPath: '/ipc/edge.sock', path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
const edge = await edgeRequest('/status');
assert(edge.available);
assert((await edgeRequest('/network')).addresses.includes('127.0.0.1'));
assert.equal((await stat('/ipc/edge.sock')).mode & 0o777, 0o660);
await writeFile('/cert-requests/test-permission.json', '{}');
await unlink('/cert-requests/test-permission.json');
await assert.rejects(writeFile('/cert-status/cannot-write.json', '{}'));
await assert.rejects(access('/tls/live'));
const response = await new Promise((resolve, reject) => {
  http
    .get(
      {
        host: '127.0.0.1',
        port: 3001,
        path: '/api/auth/status',
        headers: { host: 'proxy.example.net' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
      },
    )
    .on('error', reject);
});
assert.equal(response.status, 200);
assert.equal(response.data.enrolled, false);
assert.equal(response.data.authenticated, false);
console.log(
  'PASS: real Compose stack, unprivileged controller, private IPC, shared-volume permissions, read-only certificate status, no TLS-key mount, locked enrollment.',
);
