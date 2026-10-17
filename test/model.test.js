import test from 'node:test';
import assert from 'node:assert/strict';
import { policy, route, snapshot } from './fixtures.js';
import { validateSnapshot, validatePolicy, allowedTarget } from '../shared/model.js';

test('HTTP route accepts apex, second zone and IDNA, but rejects nested wildcard names and injection', () => {
  for (const hostname of ['krychlic.com', 'a.example.net', 'app.krychlic.com', 'těst.krychlic.com'])
    assert.equal(validateSnapshot(policy(), snapshot([route({ hostname })])).routes.length, 1);
  for (const hostname of [
    'a.b.krychlic.com',
    'bad.example.org',
    'app.krychlic.com; return 200;',
    'app.krychlic.com\ninclude /tmp/a;',
    '-bad.krychlic.com',
    'x'.repeat(64) + '.krychlic.com',
  ])
    assert.throws(() => validateSnapshot(policy(), snapshot([route({ hostname })])));
});
test('strict schema rejects arbitrary NGINX directives and unknown fields', () => {
  assert.throws(() =>
    validateSnapshot(policy(), snapshot([route({ nginx: 'include /etc/passwd;' })])),
  );
  assert.throws(() => validateSnapshot(policy(), snapshot([route({ targetHost: 'example.net' })])));
  assert.throws(() =>
    validateSnapshot(policy(), snapshot([route({ sourceCIDRs: ['any; allow all'] })])),
  );
});
test('target policy rejects management endpoints, unapproved addresses and port gaps', () => {
  const p = policy();
  assert(!allowedTarget(p, '169.254.169.254', 80));
  assert(!allowedTarget(p, '127.0.0.1', 3001));
  assert(!allowedTarget(p, '100.101.102.103', 3001));
  assert(!allowedTarget(p, '100.101.102.103', 49999, 50100));
  assert.throws(() =>
    validateSnapshot(p, snapshot([route({ targetHost: '127.0.0.1', targetPort: 3001 })])),
  );
});
test('UDP preserves range and detects overlaps independently of TCP', () => {
  const udp = route({
    kind: 'udp',
    hostname: '',
    portStart: 50000,
    portEnd: 50100,
    published: true,
  });
  assert.equal(validateSnapshot(policy(), snapshot([udp])).routes[0].portEnd, 50100);
  assert.throws(
    () =>
      validateSnapshot(
        policy(),
        snapshot([
          udp,
          route({ kind: 'udp', hostname: '', portStart: 50050, portEnd: 50070, published: true }),
        ]),
      ),
    /overlaps/,
  );
  const tcp = route({
    kind: 'tcp',
    hostname: '',
    portStart: 51413,
    portEnd: 51413,
    targetPort: 51413,
    published: true,
  });
  assert.equal(
    validateSnapshot(
      policy(),
      snapshot([tcp, route({ ...tcp, id: crypto.randomUUID(), kind: 'udp' })]),
    ).routes.length,
    2,
  );
  assert.throws(() => validateSnapshot(policy(), snapshot([route({ ...udp, portEnd: 49999 })])));
  const p = policy();
  p.maxRangePorts = 10;
  assert.throws(() => validateSnapshot(p, snapshot([udp])), /budget/);
});
test('upstream TLS requires a name; UDP cannot accept TLS or PROXY protocol', () => {
  assert.throws(() => validateSnapshot(policy(), snapshot([route({ upstreamTLS: true })])));
  for (const setting of [{ streamTLS: true }, { proxyProtocol: true }])
    assert.throws(() =>
      validateSnapshot(
        policy(),
        snapshot([route({ kind: 'udp', portStart: 50000, portEnd: 50000, ...setting })]),
      ),
    );
});
test('host policy denies insecure management origins and metadata addresses', () => {
  const p = policy();
  for (const origin of [
    'http://example.net',
    'https://example.net/path',
    'https://user:pass@example.net',
    'file:///tmp/test',
  ])
    assert.throws(() => validatePolicy({ ...p, origin }));
  assert.throws(() =>
    validatePolicy({
      ...p,
      origin: 'https://example.net',
      targets: [{ name: 'metadata', address: '169.254.169.254', ports: [{ from: 80, to: 80 }] }],
    }),
  );
  assert.throws(() =>
    validatePolicy({
      ...p,
      origin: 'https://example.net',
      komodo: { ...p.komodo, url: 'http://example.net' },
    }),
  );
});
