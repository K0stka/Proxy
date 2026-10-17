import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Discovery, normalizeContainers } from '../server/komodo.js';
import { policy } from './fixtures.js';

test('UI configuration starts discovery after an empty setup and discards in-flight inventory from old settings', async () => {
  const p = policy(),
    calls = [];
  let release, started;
  const began = new Promise((resolve) => (started = resolve));
  const d = new Discovery(
    { ...p, komodo: { url: '', servers: [] } },
    {
      key: 'key',
      secret: 'secret',
      fetcher: async (url, options) => {
        const input = JSON.parse(options.body);
        calls.push(input.type);
        if (input.type === 'ListServers')
          return new Response(JSON.stringify([{ id: 'home', name: 'Home' }]));
        if (input.type === 'GetVersion') return new Response(JSON.stringify({ version: '2.3.0' }));
        started();
        await new Promise((resolve) => (release = resolve));
        return new Response(JSON.stringify([{ id: 'old', name: 'Old', ports: [] }]));
      },
    },
  );
  await d.refresh();
  assert.equal(d.running, null);
  assert.equal(calls.length, 0);
  d.configure({ ...p, komodo: { ...p.komodo, servers: [p.komodo.servers[0]] } });
  assert.deepEqual(await d.listServers(), [{ id: 'home', name: 'Home' }]);
  const polling = d.refresh();
  await began;
  d.configure({ ...p, komodo: { url: '', servers: [] } });
  release();
  await polling;
  assert.deepEqual(d.inventory, []);
  assert.equal(d.version, null);
  assert.equal(d.lastSuccess, null);
});

test('discovery distinguishes EXPOSE, unreachable loopback and published host ports', () => {
  const p = policy(),
    home = p.komodo.servers[0];
  const services = normalizeContainers(
    [
      {
        id: '1',
        name: 'test',
        state: 'running',
        ports: [
          { PrivatePort: 80, Type: 'tcp' },
          { PrivatePort: 80, PublicPort: 3000, IP: '127.0.0.1', Type: 'tcp' },
          { PrivatePort: 80, PublicPort: 3000, IP: '0.0.0.0', Type: 'tcp' },
        ],
      },
    ],
    home,
    p,
  );
  assert.deepEqual(
    services[0].ports.map((p) => p.usable),
    [false, false, true],
  );
  assert.equal(services[0].ports[2].hostPort, 3000);
  assert.equal(services[0].ports[2].containerPort, 80);
});
test('discovery selects old/new API names, authenticates to Core only, and retains inventory on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-discovery-'));
  try {
    const p = policy();
    for (const [version, method] of [
      ['2.2.0', 'ListDockerContainers'],
      ['2.3.0', 'ListContainers'],
    ]) {
      const calls = [];
      let fail = false;
      const d = new Discovery(p, {
        key: 'key',
        secret: 'secret',
        fetcher: async (url, options) => {
          assert(url.startsWith(p.komodo.url));
          assert.equal(options.headers['x-api-key'], 'key');
          assert.equal(options.headers['x-api-secret'], 'secret');
          const body = JSON.parse(options.body);
          calls.push(body);
          if (fail) throw Error('secret upstream detail');
          return new Response(
            JSON.stringify(
              body.type === 'GetVersion'
                ? { version }
                : [{ name: 'web', id: '1', state: 'running', ports: [] }],
            ),
            { status: 200 },
          );
        },
      });
      await d.refresh();
      assert.equal(d.inventory.length, 2);
      assert(calls.some((c) => c.type === method));
      const saved = d.inventory;
      fail = true;
      await d.refresh();
      assert.equal(d.inventory, saved);
      assert(d.error);
      assert(!d.error.includes('secret upstream detail'));
      assert(!calls.some((c) => /Inspect|Terminal|Secret/.test(c.type)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
