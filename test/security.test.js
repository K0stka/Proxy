import test from 'node:test';
import assert from 'node:assert/strict';
import { Auth, hash, randomToken } from '../server/auth.js';
import { Store } from '../shared/store.js';
import { auditEvent } from '../server/audit.js';
import { render } from '../edge/render.js';
import { safeTarget } from '../shared/model.js';
import { policy, snapshot } from './fixtures.js';

const response = () => {
  const headers = new Map();
  return { getHeader: (key) => headers.get(key), setHeader: (key, value) => headers.set(key, value) };
};

test('private handoff addresses cannot be configured as proxy backends', () => {
  for (const host of ['10.254.240.2', '10.254.240.250', '::ffff:10.254.240.2'])
    assert.equal(safeTarget(host, 443), false);
});

test('pending sign-ins survive a controller handoff, stay origin-bound and consume once', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const origin = 'https://proxy.example.net';
  const old = new Auth(store, { origin });
  let cookie;
  const res = response();
  old.challenge({}, { ...res, setHeader: (_key, value) => { cookie = value[0].split(';')[0]; } },
    { type: 'login', challenge: 'handoff-test' });
  const other = new Auth(store, { origin: 'https://private.example.net' });
  assert.throws(() => other.consume({ headers: { cookie } }, response(), 'login'), /Sign-in expired/);
  const next = new Auth(store, { origin });
  assert.equal(next.consume({ headers: { cookie } }, response(), 'login').challenge, 'handoff-test');
  assert.throws(() => old.consume({ headers: { cookie } }, response(), 'login'), /Sign-in expired/);
});

test('recovery revokes links and pending challenges across management origins', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const origin = 'https://proxy.example.net';
  const auth = new Auth(store, { origin });
  const other = new Auth(store, { origin: 'https://private.example.net' });
  const code = randomToken(), token = randomToken();
  store.set('recovery', hash(code));
  store.set('deviceTokens', [{ token: hash(token), origin, expires: Date.now() + 300000 }]);
  let cookie;
  const res = response();
  other.challenge({}, { ...res, setHeader: (_key, value) => { cookie = value[0].split(';')[0]; } },
    { type: 'login', challenge: 'pending' });
  await auth.handle('/api/auth/recover', { method: 'POST', headers: {} }, response(), { code });
  assert.deepEqual(store.get('deviceTokens'), []);
  assert.throws(() => auth.deviceLink(token), /invalid or has expired/);
  assert.throws(() => other.consume({ headers: { cookie } }, response(), 'login'), /Authorization changed/);
});

test('removing a passkey revokes sessions and device authorizations atomically', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store, { origin: 'https://proxy.example.net' });
  const res = response(); let cookie;
  const issued = auth.issue({}, { ...res, setHeader: (_key, value) => { cookie = value[0].split(';')[0]; } });
  store.set('credentials', [{ id: 'keep' }, { id: 'remove' }]);
  store.set('deviceTokens', [{ token: 'outstanding' }]);
  await auth.handle('/api/auth/passkeys/remove', {
    method: 'POST', headers: { cookie, 'x-csrf-token': issued.csrf },
  }, response(), { id: 'remove' });
  assert.deepEqual(store.get('credentials'), [{ id: 'keep' }]);
  assert.deepEqual(store.get('sessions'), []);
  assert.deepEqual(store.get('deviceTokens'), []);
  assert.equal(store.get('authEpoch'), 1);
});

test('application ceiling is global and does not impose the old shared 20-request limit', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store, { origin: 'https://proxy.example.net' });
  for (let i = 0; i < 1000; i++) auth.rate({ socket: { remoteAddress: `192.0.2.${i % 255}` } });
  assert.throws(() => auth.rate({}), (error) => error.status === 429);
});

test('admin virtual host contains no site aliases and has per-client authentication throttling', () => {
  const p = { ...policy(), adminHostname: 'proxy.krychlic.com' };
  p.certificates.staging = false;
  const output = render(p, snapshot([]), { revision: 'test', directory: '/runtime/test',
    readyDomains: ['krychlic.com'], errorSites: {
      404: { directory: 'untrusted', exposed: ['index.html', 'evil.js'], html: '<script>evil()</script>' },
    } });
  const admin = output.config.slice(output.config.indexOf('server_name proxy.krychlic.com; ssl_certificate'));
  assert(!admin.includes('/sites/'));
  assert(!admin.includes('evil'));
  assert.match(admin, /location \^~ \/_proxy\/ \{ return 404; \}/);
  assert.match(admin, /limit_req zone=proxy_auth burst=20 nodelay/);
  assert.match(admin, /frame-ancestors 'none'/);
  assert.match(output.config, /limit_req_zone \$proxy_auth_key zone=proxy_auth:1m rate=20r\/m/);
});

test('audit labels never contain URL queries, credential IDs, or enrollment tokens', () => {
  assert.equal(auditEvent('/api/auth/recover', 'POST'), 'auth.recovery');
  assert.equal(auditEvent('/api/routes/00000000-0000-0000-0000-000000000000/publish', 'POST'), 'admin.routes.changed');
  assert.equal(auditEvent('/api/domains/private.example.net', 'DELETE'), 'admin.configuration.changed');
  assert.equal(auditEvent('/api/auth/token-secret', 'POST'), null);
  assert.equal(auditEvent('/api/state', 'GET'), null);
});
