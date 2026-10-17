import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { hash, randomToken } from '../server/auth.js';
import { policy, route } from './fixtures.js';
import {
  Problem,
  defaultPages,
  settingsFromPolicy,
  defaultSettings,
  effectivePolicy,
} from '../shared/model.js';
import http from 'node:http';
import { generateKeyPairSync, randomBytes, createHash, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { fileFilter } from '../edge/sites.js';

async function fixture(t, { empty = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-app-')),
    store = new Store(':memory:'),
    p = empty
      ? effectivePolicy(
          { origin: 'http://localhost:5173', ingressIPs: ['127.0.0.1'] },
          defaultSettings,
          { development: true },
        )
      : policy(),
    certificatePolicyStore = new Store(':memory:');
  let fail = false;
  const applies = [];
  const app = createApp({
    policy: p,
    store,
    certificatePolicyStore,
    stateDir: directory,
    bootstrapToken: randomToken(),
    edgeSocket: 'unused',
    certStatusDir: directory,
    certRequestDir: join(directory, 'requests'),
    development: true,
    edgeRequest: async (_socket, path, options) => {
      if (path === '/status') return { available: true };
      if (path === '/probe') {
        assert.equal(options.body.host, '100.101.102.103');
        assert.equal(options.body.port, 3000);
        return { reachable: true };
      }
      if (path === '/sites')
        return { folders: [{ directory: 'public', hasIndex: true }], error: null };
      if (path === '/sites/inspect') {
        const exposed = ['index.html', 'app.js'].filter(fileFilter(options.body));
        return {
          directory: options.body.directory,
          exposed,
          count: exposed.length,
          files: exposed.map((path) => ({ path, allowed: true })),
        };
      }
      if (fail) throw new Problem(502, 'Candidate rejected');
      applies.push(options.body);
      return { revision: 'test', available: true };
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { host: 'localhost:5173', origin: p.origin, 'content-type': 'application/json' };
  const cookieHeaders = {};
  const issued = app.auth.issue(
    {},
    {
      getHeader: () => [],
      setHeader: (k, v) => {
        cookieHeaders[k] = v;
      },
    },
  );
  const cookie = cookieHeaders['Set-Cookie'][0].split(';')[0];
  async function request(path, { method = 'GET', body, authenticated = true, extra = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = method === 'GET' ? undefined : JSON.stringify(body ?? {});
      const req = http.request(
        url + path,
        {
          method,
          headers: {
            ...headers,
            ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
            ...(authenticated ? { cookie, 'x-csrf-token': issued.csrf } : {}),
            ...extra,
          },
        },
        (res) => {
          let response = '';
          res.on('data', (chunk) => (response += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              json: async () => JSON.parse(response),
              headers: { getSetCookie: () => res.headers['set-cookie'] ?? [] },
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(data);
    });
  }
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
    certificatePolicyStore.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    store,
    certificatePolicyStore,
    request,
    applies,
    directory,
    setFail: (value) => (fail = value),
  };
}
test('settings are private, SQLite-backed, independently applied and reject changes invalidating saved routes', async (t) => {
  const f = await fixture(t),
    initial = settingsFromPolicy(policy());
  assert.deepEqual((await (await f.request('/api/state')).json()).settings, initial);
  assert.equal(
    (
      await f.request('/api/settings', {
        method: 'PUT',
        body: { ...initial, komodo: { url: 'https://other.example.net', servers: [] } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/komodo/servers', {
        method: 'POST',
        body: { url: 'https://other.example.net' },
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request('/api/settings', { method: 'PUT', body: initial, authenticated: false }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request('/api/settings', {
        method: 'PUT',
        body: initial,
        extra: { 'x-csrf-token': 'bad' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request('/api/settings', {
        method: 'PUT',
        body: { ...initial, origin: 'https://other.net' },
      })
    ).status,
    400,
  );
  const changed = {
    ...initial,
    certificates: { ...initial.certificates, propagationSeconds: 90 },
  };
  assert.equal((await f.request('/api/settings', { method: 'PUT', body: changed })).status, 200);
  assert.deepEqual(f.store.get('settings'), changed);
  assert.deepEqual(f.applies.at(-1).settings, changed);
  assert.deepEqual(f.certificatePolicyStore.get('policy'), {
    domains: changed.domains,
    certificates: changed.certificates,
  });
  f.setFail(true);
  assert.equal((await f.request('/api/settings', { method: 'PUT', body: initial })).status, 502);
  assert.deepEqual(f.store.get('settings'), changed);
  f.setFail(false);
  const created = await (await f.request('/api/routes', { method: 'POST', body: route() })).json();
  assert(
    (await (await f.request('/api/routes/' + created.id + '/probe', { method: 'POST' })).json())
      .reachable,
  );
  assert.equal(
    (await f.request('/api/settings', { method: 'PUT', body: { ...changed, domains: [] } })).status,
    400,
  );
  assert.deepEqual(f.store.get('settings'), changed);
  assert.deepEqual((await (await f.request('/api/export')).json()).settings, changed);
});
test('first run has no example domains, targets or services and accepts UI setup', async (t) => {
  const f = await fixture(t, { empty: true });
  const state = await (await f.request('/api/state')).json();
  assert.deepEqual(state.settings, defaultSettings);
  assert.deepEqual(state.discovery.services, []);
  const settings = settingsFromPolicy(policy());
  assert.equal((await f.request('/api/settings', { method: 'PUT', body: settings })).status, 200);
  assert.deepEqual(f.store.get('settings'), settings);
});
test('API rejects unauthenticated, cross-origin, forged-host and CSRF requests', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state', { authenticated: false })).status, 401);
  assert.equal(
    (
      await f.request('/api/routes', {
        method: 'POST',
        body: route(),
        extra: { origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request('/api/routes', {
        method: 'POST',
        body: route(),
        extra: { 'x-csrf-token': 'bad' },
      })
    ).status,
    403,
  );
  assert.equal((await f.request('/api/state', { extra: { host: 'evil.example' } })).status, 403);
  const result = await f.request('/api/state');
  assert.equal(result.status, 200);
  const state = await result.json();
  assert(!JSON.stringify(state).includes('PROXY_KOMODO_SECRET'));
  assert(!JSON.stringify(state).includes('bootstrapToken'));
  assert(!JSON.stringify(state).includes(f.app.auth.bootstrapToken));
  assert(!('activity' in state));
});
test('drafts stay private; failed publish and live edits preserve working state', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/routes', {
    method: 'POST',
    body: route({ published: true }),
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert(!created.published);
  assert.equal(f.applies.length, 0);
  f.setFail(true);
  assert.equal(
    (await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status,
    502,
  );
  assert(!f.store.snapshot().routes[0].published);
  f.setFail(false);
  assert.equal(
    (await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status,
    200,
  );
  assert(f.store.snapshot().routes[0].published);
  assert.equal(
    (await f.request(`/api/routes/${created.id}`, { method: 'PUT', body: created })).status,
    200,
  );
  f.setFail(true);
  assert.equal(
    (
      await f.request(`/api/routes/${created.id}`, {
        method: 'PUT',
        body: { ...created, name: 'Rejected change' },
      })
    ).status,
    502,
  );
  assert.equal(f.store.snapshot().routes[0].name, created.name);
  f.setFail(false);
  assert.equal((await f.request(`/api/routes/${created.id}`, { method: 'DELETE' })).status, 409);
  assert.equal(
    (await f.request(`/api/routes/${created.id}/disable`, { method: 'POST' })).status,
    200,
  );
  assert(!f.store.snapshot().routes[0].published);
  assert.equal((await f.request(`/api/routes/${created.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(f.store.snapshot().routes.length, 0);
});
test('persistent SQLite state survives reopen and old audit tables are removed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new Store(join(directory, 'state.db'));
  store.set('snapshot', { routes: [route()], pages: defaultPages });
  store.set('settings', {
    ...settingsFromPolicy(policy()),
    komodo: { url: 'http://100.101.102.103:9120', servers: [{ id: 'home' }] },
    targets: [{ address: '100.101.102.103' }],
    ingressPorts: [],
    maxRangePorts: 1024,
  });
  store.db.exec("CREATE TABLE audit (detail TEXT); INSERT INTO audit VALUES ('old entry')");
  store.close();
  store = new Store(join(directory, 'state.db'));
  assert.equal(store.snapshot().routes.length, 1);
  assert.deepEqual(store.get('settings'), settingsFromPolicy(policy()));
  assert(!JSON.stringify(store.get('settings')).includes('100.101.102.103'));
  assert.equal(
    store.db.prepare("SELECT name FROM sqlite_master WHERE name='audit'").get(),
    undefined,
  );
  store.close();
});
test('enrollment requires secret; challenges are single-use; bogus attestations never create credentials', async (t) => {
  const f = await fixture(t),
    token = randomToken();
  f.app.auth.bootstrapToken = token;
  assert.equal(
    (
      await f.request('/api/auth/register/options', {
        method: 'POST',
        authenticated: false,
        body: { token: 'wrong' },
      })
    ).status,
    403,
  );
  const response = await f.request('/api/auth/register/options', {
    method: 'POST',
    authenticated: false,
    body: { token },
  });
  assert.equal(response.status, 200);
  const options = await response.json();
  assert(options.challenge);
  const challengeCookie = response.headers.getSetCookie()[0].split(';')[0];
  const forged = {
    id: 'bogus',
    rawId: 'bogus',
    type: 'public-key',
    response: { clientDataJSON: 'e30', attestationObject: 'e30' },
  };
  assert.equal(
    (
      await f.request('/api/auth/register/verify', {
        method: 'POST',
        authenticated: false,
        extra: { cookie: challengeCookie },
        body: forged,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/auth/register/verify', {
        method: 'POST',
        authenticated: false,
        extra: { cookie: challengeCookie },
        body: forged,
      })
    ).status,
    400,
  );
  assert.equal(f.app.auth.credentials().length, 0);
});
test('recovery is single-use, rotates code, and revokes all existing sessions', async (t) => {
  const f = await fixture(t),
    code = randomToken();
  f.store.set('recovery', hash(code));
  assert.equal(
    (
      await f.request('/api/auth/recover', {
        method: 'POST',
        authenticated: false,
        body: { code: 'bad' },
      })
    ).status,
    403,
  );
  const response = await f.request('/api/auth/recover', {
    method: 'POST',
    authenticated: false,
    body: { code },
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert(result.recoveryCode);
  assert.notEqual(result.recoveryCode, code);
  assert.equal(
    (await f.request('/api/auth/recover', { method: 'POST', authenticated: false, body: { code } }))
      .status,
    403,
  );
  assert.equal((await f.request('/api/state')).status, 401);
});
test('certificate requests cannot select paths or unauthorized zones', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request('/api/certificates/retry', {
        method: 'POST',
        body: { domain: '../../etc/passwd' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/certificates/retry', {
        method: 'POST',
        body: { domain: 'krychlic.com' },
      })
    ).status,
    200,
  );
});

test('static folder endpoints require authentication and validated paths; sync requires a published static route', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/sites', { authenticated: false })).status, 401);
  assert.equal((await f.request('/api/sites')).status, 200);
  assert.equal(
    (await f.request('/api/sites/inspect', { method: 'POST', body: { directory: '../etc' } }))
      .status,
    400,
  );
  const inspected = await f.request('/api/sites/inspect', {
    method: 'POST',
    body: { directory: 'public' },
  });
  assert.equal(inspected.status, 200);
  assert.equal((await inspected.json()).count, 2);
  const created = await (
    await f.request('/api/routes', {
      method: 'POST',
      body: route({ kind: 'static', staticSite: { directory: 'public' } }),
    })
  ).json();
  assert.equal((await f.request(`/api/routes/${created.id}/sync`, { method: 'POST' })).status, 400);
  assert.equal(
    (await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status,
    200,
  );
  assert.equal((await f.request(`/api/routes/${created.id}/sync`, { method: 'POST' })).status, 200);
  assert.equal(f.applies.length, 2);
});

test('real WebAuthn registration and signatures work; wrong origin, RP, UV, replay and forged signatures fail', async (t) => {
  const f = await fixture(t),
    token = randomToken();
  f.app.auth.bootstrapToken = token;
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(32),
    idString = id.toString('base64url');
  const digest = (data) => createHash('sha256').update(data).digest(),
    client = (type, challenge, origin = 'http://localhost:5173') =>
      Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const publicCOSE = isoCBOR.encode(
    new Map([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
  const begin = await f.request('/api/auth/register/options', {
      method: 'POST',
      authenticated: false,
      body: { token },
    }),
    options = await begin.json(),
    length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    digest('localhost'),
    Buffer.from([0x45]),
    Buffer.alloc(4),
    Buffer.alloc(16),
    length,
    id,
    Buffer.from(publicCOSE),
  ]);
  const attestation = isoCBOR.encode(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const registration = {
    id: idString,
    rawId: idString,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: client('webauthn.create', options.challenge).toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'),
      transports: ['internal'],
    },
  };
  const enrolled = await f.request('/api/auth/register/verify', {
    method: 'POST',
    authenticated: false,
    extra: { cookie: begin.headers.getSetCookie()[0].split(';')[0] },
    body: registration,
  });
  assert.equal(enrolled.status, 200);
  assert((await enrolled.json()).recoveryCode);
  assert.equal(f.app.auth.credentials().length, 1);
  async function attempt({
    origin,
    flags = 0x05,
    rp = 'localhost',
    counter = 1,
    forge = false,
  } = {}) {
    const response = await f.request('/api/auth/login/options', {
        method: 'POST',
        authenticated: false,
      }),
      options = await response.json();
    const clientJSON = client('webauthn.get', options.challenge, origin),
      count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([digest(rp), Buffer.from([flags]), count]),
      signature = sign(
        'sha256',
        Buffer.concat([authenticatorData, digest(clientJSON)]),
        privateKey,
      );
    if (forge) signature[signature.length - 1] ^= 1;
    const body = {
      id: idString,
      rawId: idString,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: Buffer.from('proxy-owner').toString('base64url'),
      },
    };
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    return {
      response: await f.request('/api/auth/login/verify', {
        method: 'POST',
        authenticated: false,
        extra: { cookie },
        body,
      }),
      cookie,
      body,
    };
  }
  const good = await attempt();
  assert.equal(good.response.status, 200);
  assert.equal(f.app.auth.credentials()[0].counter, 1);
  assert.equal(
    (
      await f.request('/api/auth/login/verify', {
        method: 'POST',
        authenticated: false,
        extra: { cookie: good.cookie },
        body: good.body,
      })
    ).status,
    400,
  );
  for (const invalid of [
    { origin: 'https://evil.example' },
    { rp: 'evil.example' },
    { flags: 0x01 },
    { counter: 1 },
    { forge: true, counter: 2 },
  ])
    assert.equal((await attempt(invalid)).response.status, 400);
  assert.equal((await attempt({ counter: 2 })).response.status, 200);
});

test('Files rules persist per folder, update every use atomically and survive failed applies', async (t) => {
  const f = await fixture(t);
  for (const hostname of ['one.krychlic.com', 'two.krychlic.com']) {
    const created = await (
      await f.request('/api/routes', {
        method: 'POST',
        body: route({
          kind: 'static',
          hostname,
          staticSite: { directory: 'public', include: [], exclude: [] },
        }),
      })
    ).json();
    assert.equal(
      (await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status,
      200,
    );
  }
  assert.equal(
    (
      await f.request('/api/pages', {
        method: 'PUT',
        body: { ...defaultPages, badGatewaySite: { directory: 'public' } },
      })
    ).status,
    200,
  );
  const spec = { directory: 'public', include: [], exclude: ['app.js'] };
  assert.equal(
    (await f.request('/api/sites/config', { method: 'PUT', body: spec, authenticated: false }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...spec, directory: '../outside' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...spec, exclude: ['index.html'] },
      })
    ).status,
    400,
  );
  assert.equal((await f.request('/api/sites/config', { method: 'PUT', body: spec })).status, 200);
  for (const route of f.store.snapshot().routes) assert.deepEqual(route.staticSite, spec);
  assert.deepEqual(f.store.snapshot().pages.badGatewaySite, spec);
  const prior = f.store.snapshot();
  f.setFail(true);
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...spec, exclude: ['private/**'] },
      })
    ).status,
    502,
  );
  assert.deepEqual(f.store.snapshot(), prior);
  const count = f.applies.length;
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...spec, directory: 'unused' },
      })
    ).status,
    200,
  );
  assert.equal(f.applies.length, count);
  assert(
    (await (await f.request('/api/sites')).json()).sites.some(
      (site) => site.directory === 'unused',
    ),
  );
});
