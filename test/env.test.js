import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { readDeployment, readKomodoURL } from '../shared/env.js';
import { policy, policyEnv } from './fixtures.js';
import { mkdtemp, copyFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

test('Core URL is configured only through env and rejects credentials, redirects and insecure non-tailnet HTTP', () => {
  assert.equal(
    readKomodoURL({ PROXY_KOMODO_URL: 'http://100.101.102.103:9120/' }),
    'http://100.101.102.103:9120',
  );
  assert.equal(
    readKomodoURL({ PROXY_KOMODO_URL: 'https://core.example.net' }),
    'https://core.example.net',
  );
  for (const url of [
    'invalid',
    'http://example.net',
    'https://user:secret@example.net',
    'https://example.net?secret=hidden',
    'file:///etc/passwd',
  ])
    assert.throws(
      () => readKomodoURL({ PROXY_KOMODO_URL: url }),
      (error) => !error.message.includes('secret'),
    );
});

test('installation policy loads from environment without copying credentials', () => {
  const expected = policy(),
    env = {
      ...policyEnv(expected),
      PROXY_KOMODO_KEY: 'private-key',
      PROXY_KOMODO_SECRET: 'private-secret',
      PROXY_CLOUDFLARE_TOKEN: 'private-dns',
      PROXY_BOOTSTRAP_TOKEN: 'private-bootstrap',
    };
  assert.deepEqual(readDeployment(env, { development: true }), {
    origin: expected.origin,
    ingressIPs: expected.ingressIPs,
  });
  const serialized = JSON.stringify(readDeployment(env, { development: true }));
  assert(!serialized.includes('private-'));
  const example = parseEnv(readFileSync('.env.example', 'utf8'));
  assert.equal(example.PROXY_ORIGIN, '');
  assert.equal(example.PROXY_KOMODO_URL, '');
  for (const name of ['PROXY_TARGETS', 'PROXY_DOMAINS', 'PROXY_KOMODO_SERVERS', 'PROXY_ACME_EMAIL'])
    assert(!(name in example));
});

test('invalid environment fails closed with names, never raw input', () => {
  const env = policyEnv(policy());
  for (const change of [
    { PROXY_INGRESS_IPS: '0.0.0.0' },
    { PROXY_ORIGIN: 'http://evil.example' },
  ]) {
    assert.throws(
      () => readDeployment({ ...env, ...change }, { development: true }),
      (error) => !error.message.includes('private-sentinel'),
    );
  }
});

test('development setup creates an env token privately, never prints it or overwrites settings', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'proxy-env-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await copyFile('.env.example', join(folder, '.env.example'));
  const setup = resolve('scripts/setup.js');
  const output = execFileSync(process.execPath, [setup], { cwd: folder, encoding: 'utf8' });
  const saved = await readFile(join(folder, '.env'), 'utf8'),
    env = parseEnv(saved);
  assert.equal(env.PROXY_BOOTSTRAP_TOKEN.length, 43);
  assert(!output.includes(env.PROXY_BOOTSTRAP_TOKEN));
  assert.equal(readDeployment(env, { development: true }).origin, 'http://localhost:5173');
  execFileSync(process.execPath, [setup], { cwd: folder, encoding: 'utf8' });
  assert.equal(await readFile(join(folder, '.env'), 'utf8'), saved);
});
