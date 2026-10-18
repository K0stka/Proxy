import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
  await writeFile(join(directory, 'index.html'), '<meta name="style-nonce" content="__PROXY_STYLE_NONCE__">');
  let fail = false;
  const applies = [];
  const filesCalls = [];
  const app = createApp({
    policy: p,
    store,
    certificatePolicyStore,
    stateDir: directory,
    distDir: directory,
    bootstrapToken: randomToken(),
    edgeSocket: 'unused',
    certStatusDir: directory,
    certRequestDir: join(directory, 'requests'),
    development: true,
    filesRequest: async (_socket, path, options) => {
      filesCalls.push({ path, ...options });
      return path === '/repositories' ? [] : { changed: true };
    },
    edgeRequest: async (_socket, path, options) => {
      if (path === '/status') return { available: true };
      if (path === '/probe') {
        assert.equal(options.body.host, '100.101.102.103');
        assert.equal(options.body.port, 3000);
        return { reachable: true };
      }
      if (path === '/sites/inspect') {
        const exposed = ['index.html', 'app.js'].filter(fileFilter(options.body));
        return {
          directory: options.body.directory,
          exposed,
          count: exposed.length,
          files: exposed.map((path) => ({ path, allowed: true })),
        };
      }
      if (path === '/pages/validate') {
        for (const [key, documentKey] of [['notFoundSite', 'notFoundDocument'], ['internalErrorSite', 'internalErrorDocument'], ['badGatewaySite', 'badGatewayDocument']]) {
          const site = options.body[key];
          if (site && !['index.html', 'app.js'].filter(fileFilter(site)).includes(options.body[documentKey]))
            throw new Problem(400, 'Error page document must be exposed by its folder rules');
        }
        return { ok: true };
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
          const chunks = [];
          res.on('data', (chunk) => { chunks.push(chunk); response += chunk; });
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              json: async () => JSON.parse(response),
              text: async () => response,
              arrayBuffer: async () => Buffer.concat(chunks),
              headers: {
                get: (name) => res.headers[name.toLowerCase()],
                getSetCookie: () => res.headers['set-cookie'] ?? [],
              },
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
    filesCalls,
    directory,
    setFail: (value) => (fail = value),
  };
}
test('passkey names persist without changing credentials or sessions and require authorization', async (t) => {
  const f = await fixture(t);
  const credential = { id: randomToken(), publicKey: 'existing-key', counter: 7, rpID: 'localhost', created: '2026-10-17T12:00:00Z' };
  f.store.set('credentials', [credential]);
  const sessions = f.store.get('sessions');
  const rename = (body, options = {}) => f.request('/api/auth/passkeys/rename', { method: 'POST', body, ...options });
  assert.equal((await rename({ id: credential.id, name: 'Laptop' }, { authenticated: false })).status, 401);
  assert.equal((await rename({ id: credential.id, name: 'Laptop' }, { extra: { 'x-csrf-token': 'invalid' } })).status, 403);
  for (const name of ['', '  ', 'x'.repeat(81), 'Laptop\nPhone', 123])
    assert.equal((await rename({ id: credential.id, name })).status, 400);
  assert.equal((await rename({ id: 'missing', name: 'Laptop' })).status, 404);
  assert.deepEqual(f.store.get('credentials'), [credential]);
  assert.equal((await rename({ id: credential.id, name: '  Laptop  ' })).status, 200);
  assert.deepEqual(f.store.get('credentials'), [{ ...credential, name: 'Laptop' }]);
  assert.deepEqual(f.store.get('sessions'), sessions);
  const keys = await (await f.request('/api/auth/passkeys', { method: 'POST' })).json();
  assert.equal(keys[0].name, 'Laptop');
  assert.equal(keys[0].publicKey, undefined);
});

test('device links are single-use, expire after five minutes and enroll one new device', async (t) => {
  const f = await fixture(t);
  const credential = { id: randomToken(), publicKey: 'existing-key', counter: 0, rpID: 'localhost', created: '2026-10-17T12:00:00Z' };
  f.store.set('credentials', [credential]);
  const link = (options = {}) => f.request('/api/auth/devices/link', { method: 'POST', ...options });
  const options = (body) =>
    f.request('/api/auth/devices/options', { method: 'POST', authenticated: false, body });
  assert.equal((await link({ authenticated: false })).status, 401);
  assert.equal((await link({ extra: { 'x-csrf-token': 'wrong' } })).status, 403);
  const response = await link();
  assert.equal(response.status, 200);
  const { url, expires } = await response.json();
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'http://localhost:5173');
  assert.equal(parsed.pathname, '/device');
  const token = parsed.hash.slice(1);
  assert.match(token, /^[\w-]{43}$/);
  const remaining = Date.parse(expires) - Date.now();
  assert(remaining > 0 && remaining <= 300000);
  assert.deepEqual(
    f.store.get('deviceTokens').map((link) => ({ ...link, expires: Boolean(link.expires) })),
    [{ token: hash(token), origin: 'http://localhost:5173', expires: true }],
  );
  assert.equal((await options({ token: randomToken() })).status, 403);
  assert.equal((await options({ token, name: 'x'.repeat(81) })).status, 400);
  const begin = await options({ token, name: '  Phone  ' });
  assert.equal(begin.status, 200);
  const challenge = await begin.json();
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
    jwk = publicKey.export({ format: 'jwk' }),
    id = randomBytes(32),
    idString = id.toString('base64url');
  const publicCOSE = isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    ),
    length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    createHash('sha256').update('localhost').digest(),
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
      clientDataJSON: Buffer.from(
        JSON.stringify({
          type: 'webauthn.create',
          challenge: challenge.challenge,
          origin: 'http://localhost:5173',
          crossOrigin: false,
        }),
      ).toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'),
      transports: ['internal'],
    },
  };
  const challengeCookie = begin.headers.getSetCookie()[0].split(';')[0];
  const verify = (cookie, body) =>
    f.request('/api/auth/devices/verify', {
      method: 'POST',
      authenticated: false,
      extra: { cookie },
      body,
    });
  const enrolled = await verify(challengeCookie, registration);
  assert.equal(enrolled.status, 200);
  const result = await enrolled.json();
  assert.equal(result.authenticated, true);
  assert.equal(result.recoveryCode, undefined);
  assert.equal(result.csrf.length, 43);
  assert.equal(f.store.get('deviceTokens').length, 0);
  const added = f.app.auth.credentials().at(-1);
  assert.equal(added.id, idString);
  assert.equal(added.rpID, 'localhost');
  assert.equal(added.name, 'Phone');
  assert.equal((await verify(challengeCookie, registration)).status, 400);
  assert.equal((await options({ token })).status, 403);
  const session = enrolled.headers
    .getSetCookie()
    .find((value) => value.includes('proxy_session'))
    .split(';')[0];
  assert.equal((await f.request('/api/state', { authenticated: false, extra: { cookie: session } })).status, 200);
  const second = await (await link()).json();
  const secondToken = new URL(second.url).hash.slice(1);
  f.store.set('deviceTokens', [
    { token: hash(secondToken), origin: 'http://localhost:5173', expires: Date.now() - 1 },
  ]);
  assert.equal((await options({ token: secondToken })).status, 403);
  const third = await (await link()).json();
  const thirdToken = new URL(third.url).hash.slice(1);
  f.store.set('deviceTokens', [
    { token: hash(thirdToken), origin: 'https://proxy.krychlic.com', expires: Date.now() + 60000 },
  ]);
  assert.equal((await options({ token: thirdToken })).status, 403);
  assert.equal(f.app.auth.credentials().length, 2);
});
test('Git pulls require authentication, CSRF and a configured folder, then refresh proxy files', async (t) => {
  const f = await fixture(t);
  const request = (body, options = {}) => f.request('/api/sites/pull', { method: 'POST', body, ...options });
  assert.equal((await request({ directory: 'site' }, { authenticated: false })).status, 401);
  assert.equal((await request({ directory: 'site' }, { extra: { 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await request({ directory: '../private' })).status, 400);
  assert.equal((await request({ directory: 'site' })).status, 404);
  assert.equal(f.filesCalls.length, 0);
  const spec = { directory: 'site', include: [], exclude: [] };
  assert.equal((await f.request('/api/sites/config', { method: 'PUT', body: spec })).status, 200);
  const before = f.applies.length;
  assert.equal((await request({ directory: 'site' })).status, 200);
  assert.equal(f.applies.length, before + 1);
  assert.deepEqual(f.filesCalls, [{ path: '/pull', method: 'POST', body: { directory: 'site' }, timeout: 130000, service: 'Files updater' }]);
});

test('interface styles use a fresh CSP nonce without allowing inline scripts', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'index.html'), '<meta name="style-nonce" content="__PROXY_STYLE_NONCE__">');
  let previous;
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/settings/certificates');
    assert.equal(response.status, 200);
    const nonce = (await response.text()).match(/content="([^"]+)"/)[1];
    assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
    assert.notEqual(nonce, previous);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy').includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self';"));
    assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
    previous = nonce;
  }
});

test('PWA manifest and icons are served as app files without relaxing authentication or CSP', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, 'icons'));
  for (const [path, mime] of [
    ['manifest.webmanifest', 'application/manifest+json'],
    ['favicon.svg', 'image/svg+xml'],
    ['icons/proxy-180.png', 'image/png'],
    ['icons/proxy-192.png', 'image/png'],
    ['icons/proxy-512.png', 'image/png'],
    ['icons/proxy-maskable-512.png', 'image/png'],
  ]) {
    const expected = await readFile(new URL(`../public/${path}`, import.meta.url));
    await writeFile(join(f.directory, path), expected);
    const response = await f.request(`/${path}`, { authenticated: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mime);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
  }
  assert.equal((await f.request('/api/state', { authenticated: false })).status, 401);
});

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
  assert.equal(state.settings.certificates.staging, false);
  assert.deepEqual(state.discovery.services, []);
  const settings = settingsFromPolicy(policy());
  assert.equal((await f.request('/api/settings', { method: 'PUT', body: settings })).status, 200);
  assert.deepEqual(f.store.get('settings'), settings);
});

test('wizard validation checks the current step without writes and error pages save independently', async (t) => {
  const f = await fixture(t), before = f.store.snapshot();
  const validate = (body) => f.request('/api/validate', { method: 'POST', body });
  assert.equal((await validate({ kind: 'route', step: 0, value: { name: ' ', kind: 'http' } })).status, 400);
  assert.equal((await validate({ kind: 'route', step: 0, value: { name: 'Website', kind: 'http' } })).status, 200);
  assert.equal((await validate({ kind: 'route', step: 1, value: route({ targetHost: '169.254.169.254' }) })).status, 400);
  assert.equal((await validate({ kind: 'route', step: 2, value: route({ hostname: 'too.deep.krychlic.com' }) })).status, 400);
  assert.equal((await validate({ kind: 'domain', value: { name: 'https://invalid.example.net' } })).status, 400);
  assert.equal((await validate({ kind: 'folder', value: { directory: '/leading/', include: [], exclude: [] } })).status, 400);
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(f.applies.length, 0);
  const gateway = { site: { directory: 'errors/gateway', include: [], exclude: [] }, document: 'index.html' };
  assert.equal((await f.request('/api/pages/502', { method: 'PUT', body: gateway })).status, 200);
  const notFound = { site: { directory: 'errors/not-found', include: [], exclude: [] }, document: 'missing.html' };
  assert.equal((await validate({ kind: 'page', code: 404, value: notFound })).status, 400);
  assert.deepEqual(f.store.snapshot().pages.badGatewaySite, gateway.site);
  notFound.document = 'index.html';
  assert.equal((await validate({ kind: 'page', code: 404, value: notFound })).status, 200);
  assert.equal((await f.request('/api/pages/404', { method: 'PUT', body: notFound })).status, 200);
  assert.deepEqual(f.store.snapshot().pages.badGatewaySite, gateway.site);
  assert.deepEqual(f.store.snapshot().pages.notFoundSite, notFound.site);
});

test('500 page validation, saving and shared-folder updates stay independent of other error pages', async (t) => {
  const f = await fixture(t), before = f.store.snapshot().pages;
  const spec = { directory: 'errors/internal', include: [], exclude: [] };
  const invalid = { site: spec, document: 'missing.html' };
  assert.equal((await f.request('/api/validate', { method: 'POST', body: { kind: 'page', code: 500, value: invalid } })).status, 400);
  assert.equal((await f.request('/api/pages/500', { method: 'PUT', body: invalid })).status, 400);
  assert.deepEqual(f.store.snapshot().pages, before);
  const selection = { site: spec, document: 'index.html' };
  assert.equal((await f.request('/api/pages/500', { method: 'PUT', body: selection, authenticated: false })).status, 401);
  assert.equal((await f.request('/api/pages/500', { method: 'PUT', body: selection })).status, 200);
  assert.deepEqual(f.store.snapshot().pages, { ...before, internalErrorSite: spec });
  assert.equal((await f.request('/api/sites/config', { method: 'PUT', body: spec })).status, 200);
  assert.equal((await f.request('/api/sites/config', { method: 'DELETE', body: { directory: spec.directory } })).status, 409);
  const moved = { ...spec, directory: 'errors/server' };
  assert.equal((await f.request('/api/sites/config', { method: 'PUT', body: { ...moved, previousDirectory: spec.directory } })).status, 200);
  assert.deepEqual(f.store.snapshot().pages.internalErrorSite, moved);
  assert.equal((await f.request('/api/pages/500', { method: 'PUT', body: { site: null, document: 'index.html' } })).status, 200);
  assert.equal(f.store.snapshot().pages.internalErrorSite, null);
});

test('domain CRUD, global preferences and admin origins preserve private access and certificate boundaries', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/domains', { method: 'POST', body: { name: 'apex.example.org', subdomains: false } })).status, 200);
  assert.equal((await f.request('/api/domains', { method: 'POST', body: { name: 'apex.example.org', subdomains: false } })).status, 400);
  assert.equal((await f.request('/api/routes', { method: 'POST', body: route({ hostname: 'sub.apex.example.org' }) })).status, 400);
  assert.equal((await f.request('/api/domains/apex.example.org', { method: 'PUT', body: { name: 'apex.example.org', subdomains: true } })).status, 200);
  assert.equal((await f.request('/api/preferences', { method: 'PUT', body: { adminHostname: 'proxy.krychlic.com' } })).status, 200);
  assert.equal((await f.request('/api/preferences', { method: 'PUT', body: { certificates: {
    email: 'shared@example.net', staging: false, propagationSeconds: 60,
  } } })).status, 200);
  assert.equal(f.store.get('settings').adminHostname, 'proxy.krychlic.com');
  assert.equal((await f.request('/api/routes', { method: 'POST', body: route({ hostname: 'proxy.krychlic.com' }) })).status, 400);
  assert.equal((await f.request('/api/domains/apex.example.org', { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/api/domains/krychlic.com', { method: 'DELETE' })).status, 400);
  const publicHeaders = { host: 'proxy.krychlic.com', origin: 'https://proxy.krychlic.com' };
  assert.equal((await f.request('/api/state', { extra: publicHeaders })).status, 401);
  assert.equal((await f.request('/api/state')).status, 200);
  f.store.set('credentials', [{ id: randomToken(), rpID: 'localhost', transports: [] }]);
  const publicStatus = await (await f.request('/api/auth/status', { extra: publicHeaders, authenticated: false })).json();
  assert.equal(publicStatus.enrolled, true);
  assert.equal(publicStatus.originEnrolled, false);
  assert.equal((await (await f.request('/api/auth/status', { authenticated: false })).json()).originEnrolled, true);
  const code = randomToken();
  f.store.set('recovery', hash(code));
  const recovered = await f.request('/api/auth/recover', { method: 'POST', authenticated: false, extra: publicHeaders, body: { code } });
  assert.equal(recovered.status, 200);
  const session = await recovered.json(), cookie = recovered.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await f.request('/api/state', { authenticated: false, extra: { ...publicHeaders, cookie } })).status, 200);
  assert.equal((await f.request('/api/state', { authenticated: false, extra: { cookie } })).status, 401);
  assert.equal((await f.request('/api/preferences', { method: 'PUT', authenticated: false,
    extra: { ...publicHeaders, cookie, origin: policy().origin, 'x-csrf-token': session.csrf }, body: { adminHostname: '' } })).status, 403);
  assert.equal((await f.request('/settings/certificates')).status, 200);
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
test('redirect drafts validate URLs without probes and publish beside a root route', async (t) => {
  const f = await fixture(t);
  const input = route({ kind: 'redirect', hostname: 'krychlic.com', path: '/something', targetHost: '', redirectURL: 'https://example.net/target', redirectStatus: 302 });
  const validate = (value) => f.request('/api/validate', { method: 'POST', body: { kind: 'route', step: 1, value } });
  assert.equal((await validate(input)).status, 200);
  assert.equal((await validate({ ...input, redirectURL: 'javascript:alert(1)' })).status, 400);
  const created = await (await f.request('/api/routes', { method: 'POST', body: input })).json();
  assert.equal(created.kind, 'redirect');
  assert.equal(created.published, false);
  assert.equal((await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/routes', { method: 'POST', body: route({ hostname: 'krychlic.com' }) })).status, 200);
  assert.equal((await f.request('/api/routes', { method: 'POST', body: input })).status, 400);
  const probe = await (await f.request(`/api/routes/${created.id}/probe`, { method: 'POST' })).json();
  assert.equal(probe.reachable, null);
  f.setFail(true);
  assert.equal((await f.request(`/api/routes/${created.id}`, { method: 'PUT', body: { ...created, redirectStatus: 301 } })).status, 502);
  assert.equal(f.store.snapshot().routes.find((route) => route.id === created.id).redirectStatus, 302);
  const exported = await (await f.request('/api/export')).json();
  assert.equal(exported.routes.find((route) => route.id === created.id).redirectURL, input.redirectURL);
});

test('static directory paths and port lists validate, persist and publish through the API', async (t) => {
  const f = await fixture(t);
  const site = route({ kind: 'static', hostname: 'krychlic.com', path: '/something/', staticSite: { directory: 'something' } });
  const created = await (await f.request('/api/routes', { method: 'POST', body: site })).json();
  assert.equal(created.path, '/something');
  assert.equal((await f.request(`/api/routes/${created.id}/publish`, { method: 'POST' })).status, 200);
  assert.equal((await f.request('/api/routes', { method: 'POST', body: route({ hostname: 'krychlic.com' }) })).status, 200);
  for (const kind of ['tcp', 'udp']) {
    const input = route({ kind, ports: '56-78, 12, 34' });
    assert.equal((await f.request('/api/validate', { method: 'POST', body: { kind: 'route', step: 2, value: input } })).status, 200);
    const stream = await (await f.request('/api/routes', { method: 'POST', body: input })).json();
    assert.equal(stream.ports, '12, 34, 56-78');
    assert.equal((await f.request(`/api/routes/${stream.id}/publish`, { method: 'POST' })).status, 200);
    assert.equal((await f.request('/api/routes', { method: 'POST', body: { ...input, ports: '12,,34' } })).status, 400);
  }
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
  assert.equal((await f.request(`/api/routes/${created.id}`, { method: 'DELETE' })).status, 502);
  assert(f.store.snapshot().routes[0].published);
  f.setFail(false);
  assert.equal((await f.request(`/api/routes/${created.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(f.store.snapshot().routes.length, 0);
  assert.equal(f.applies.at(-1).routes.length, 0);
  const draft = await (await f.request('/api/routes', { method: 'POST', body: route() })).json();
  const appliesBeforeDelete = f.applies.length;
  assert.equal((await f.request(`/api/routes/${draft.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(f.applies.length, appliesBeforeDelete);
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
    200,
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
    (await (await f.request('/api/sites')).json()).folders.some(
      (site) => site.directory === 'unused',
    ),
  );
});

test('folder definitions are explicit, permit no index or exposed files, and move references atomically', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await (await f.request('/api/sites')).json()).folders, []);
  const spec = { directory: 'assets', include: ['*.svg'], exclude: ['private/**'] };
  assert.equal((await f.request('/api/sites/config', { method: 'PUT', body: spec })).status, 200);
  assert.deepEqual((await (await f.request('/api/sites')).json()).folders, [spec]);
  const created = await (
    await f.request('/api/routes', {
      method: 'POST',
      body: route({ kind: 'static', staticSite: spec }),
    })
  ).json();
  assert.equal(
    (
      await f.request('/api/pages', {
        method: 'PUT',
        body: { ...defaultPages, notFoundSite: spec, notFoundDocument: 'notice.html' },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request('/api/sites/config', { method: 'DELETE', body: { directory: 'assets' } }))
      .status,
    409,
  );
  const moved = { ...spec, directory: 'moved' };
  f.setFail(true);
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...moved, previousDirectory: 'assets' },
      })
    ).status,
    502,
  );
  assert.equal(
    f.store.snapshot().routes.find((route) => route.id === created.id).staticSite.directory,
    'assets',
  );
  f.setFail(false);
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { ...moved, previousDirectory: 'assets' },
      })
    ).status,
    200,
  );
  assert.deepEqual(
    f.store.snapshot().routes.find((route) => route.id === created.id).staticSite,
    moved,
  );
  assert.deepEqual(f.store.snapshot().pages.notFoundSite, moved);
  assert.equal(f.store.snapshot().pages.notFoundDocument, 'notice.html');
  assert.deepEqual(f.store.snapshot().sites, [moved]);
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'PUT',
        body: { directory: 'unused', include: [], exclude: [] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request('/api/sites/config', {
        method: 'DELETE',
        body: { directory: 'unused' },
        authenticated: false,
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.request('/api/sites/config', { method: 'DELETE', body: { directory: 'unused' } }))
      .status,
    200,
  );
});
