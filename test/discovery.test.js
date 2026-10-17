import test from 'node:test';
import assert from 'node:assert/strict';
import { Discovery, normalizeContainers } from '../server/komodo.js';

test('discovery requires Core environment credentials and releases the poll lock on failure', async () => {
  const d = new Discovery({
    url: '',
    key: '',
    secret: '',
    fetcher: () => assert.fail('No request expected'),
  });
  await d.refresh();
  assert.equal(d.running, null);
  assert(d.error.includes('PROXY_KOMODO_URL'));
  await d.refresh();
  assert.equal(d.running, null);
});

test('published ports need no allowlist; remote loopback, metadata and management endpoints stay unavailable', () => {
  const containers = [
    {
      id: 'web',
      name: 'web',
      state: 'Running',
      ports: [
        { PrivatePort: 80, Type: 'tcp' },
        { PrivatePort: 80, PublicPort: 3002, IP: '127.0.0.1', Type: 'tcp' },
        { private_port: 80, public_port: 3000, ip: '0.0.0.0', typ: 'tcp' },
        { PrivatePort: 80, PublicPort: 3001, IP: '0.0.0.0', Type: 'tcp' },
        { PrivatePort: 80, PublicPort: 8080, IP: '169.254.169.254', Type: 'tcp' },
      ],
    },
  ];
  const server = { id: 'home', name: 'Home', address: '100.101.102.103', local: false };
  const ports = normalizeContainers(containers, server)[0].ports;
  assert.equal(normalizeContainers(containers, server)[0].state, 'running');
  assert.deepEqual(
    ports.map((port) => port.usable),
    [false, false, true, false, false],
  );
  assert.equal(ports[2].targetHost, server.address);
  assert.equal(ports[2].hostPort, 3000);
  assert(normalizeContainers(containers, { ...server, local: true })[0].ports[1].usable);
  const mapped = normalizeContainers(
    [
      {
        name: 'mapped',
        ports: [{ PrivatePort: 80, PublicPort: 8080, IP: '::ffff:127.0.0.1', Type: 'tcp' }],
      },
    ],
    server,
  );
  assert(!mapped[0].ports[0].usable);
});

test('dual-stack mappings collapse to one outside/inside port while TCP and UDP stay separate', () => {
  const [service] = normalizeContainers(
    [
      {
        name: 'Dashy',
        state: 'Running',
        ports: [
          { PrivatePort: 8080, PublicPort: 9000, IP: '::', Type: 'TCP' },
          { PrivatePort: 8080, PublicPort: 9000, IP: '0.0.0.0', Type: 'tcp' },
          { PrivatePort: 8080, PublicPort: 9000, IP: '127.0.0.1', Type: 'tcp' },
          { PrivatePort: 8080, PublicPort: 9000, IP: '0.0.0.0', Type: 'udp' },
          { PrivatePort: 5432, Type: 'tcp' },
        ],
      },
    ],
    { id: 'home', name: 'Home', address: '100.101.102.103', local: false },
  );
  assert.equal(service.state, 'running');
  assert.equal(service.ports.length, 3);
  assert(service.ports[0].usable);
  assert.equal(service.ports[0].targetHost, '100.101.102.103');
  assert.deepEqual(
    service.ports.map((port) => port.protocol),
    ['tcp', 'udp', 'tcp'],
  );
  assert(!service.ports[2].usable);
});

test('all readable servers are discovered, DNS is pinned to IPs, local host is detected and failures are isolated', async () => {
  for (const [version, method] of [
    ['2.2.0', 'ListDockerContainers'],
    ['2.3.2', 'ListContainers'],
  ]) {
    const calls = [];
    let offline = false,
      broken = false,
      listed = Array.from({ length: 35 }, (_, i) => ({
        id: String(i),
        name: 'Server ' + i,
        info: {
          address:
            i === 0 ? 'https://home.tailnet.ts.net:8120' : 'http://100.64.0.' + (i + 1) + ':8120',
        },
      }));
    const d = new Discovery({
      url: 'https://core.tailnet.ts.net',
      key: 'private-key',
      secret: 'private-secret',
      localAddresses: async () => ['127.0.0.1', '100.64.0.2'],
      lookup: async (host) => [
        { address: host.startsWith('home.') ? '100.101.102.103' : '100.101.102.104' },
      ],
      fetcher: async (url, options) => {
        assert.equal(url, 'https://core.tailnet.ts.net/read');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['x-api-key'], 'private-key');
        assert.equal(options.headers['x-api-secret'], 'private-secret');
        const body = JSON.parse(options.body);
        calls.push(body);
        if (offline) throw Error('sensitive upstream error');
        if (body.type === 'GetVersion') return Response.json({ version });
        if (body.type === 'ListServers') {
          assert.equal(body.params.limit, 0);
          return Response.json(listed);
        }
        assert.equal(body.type, method);
        if (broken && body.params.server === '0') throw Error('sensitive server error');
        return Response.json([
          {
            id: 'web-' + body.params.server,
            name: 'Web',
            state: 'running',
            ports: [
              {
                PrivatePort: 80,
                PublicPort: 8080,
                IP: body.params.server === '1' ? '127.0.0.1' : '0.0.0.0',
                Type: 'tcp',
              },
            ],
          },
        ]);
      },
    });
    await d.refresh();
    assert.equal(d.servers.length, 35);
    assert.equal(d.inventory.length, 35);
    assert.equal(d.error, null);
    assert.equal(d.servers[0].address, '100.101.102.103');
    assert(d.servers[1].local);
    assert.equal(d.inventory[1].ports[0].targetHost, '127.0.0.1');
    assert(d.inventory.every((item) => item.ports[0].usable));
    assert(!JSON.stringify(d.status()).includes('private-'));
    assert(!calls.some((call) => /Inspect|Terminal|GetServer/.test(call.type)));
    broken = true;
    await d.refresh();
    assert(d.servers[0].error);
    assert.equal(d.inventory.length, 35);
    assert(!JSON.stringify(d.status()).includes('sensitive'));
    const prior = d.inventory;
    offline = true;
    await d.refresh();
    assert.equal(d.inventory, prior);
    assert(d.error);
    assert(!d.error.includes('sensitive'));
    offline = false;
    broken = false;
    listed = [];
    await d.refresh();
    assert.deepEqual(d.servers, []);
    assert.deepEqual(d.inventory, []);
  }
});

test('missing, unsafe and Core-relative loopback addresses never become remote localhost routes', async () => {
  const d = new Discovery({
    url: 'https://core.example.net',
    key: 'key',
    secret: 'secret',
    localAddresses: async () => ['127.0.0.1'],
    lookup: async () => {
      throw Error('unknown DNS');
    },
    fetcher: async (_url, options) => {
      const { type } = JSON.parse(options.body);
      if (type === 'GetVersion') return Response.json('2.3.2');
      if (type === 'ListServers')
        return Response.json([
          {
            id: 'home',
            name: 'Home',
            info: { address: 'http://127.0.0.1:8120', external_address: 'https://100.101.102.103' },
          },
        ]);
      return Response.json([
        {
          name: 'Web',
          ports: [
            { PrivatePort: 80, PublicPort: 8080, IP: '127.0.0.1', Type: 'tcp' },
            { PrivatePort: 80, PublicPort: 8081, IP: '0.0.0.0', Type: 'tcp' },
          ],
        },
      ]);
    },
  });
  await d.refresh();
  assert.equal(d.servers[0].address, '100.101.102.103');
  assert(!d.servers[0].local);
  assert(!d.inventory[0].ports[0].usable);
  assert(d.inventory[0].ports[1].usable);
});

test('Core being hosted or reverse-proxied locally does not make a loopback Periphery address local', async () => {
  const d = new Discovery({
    url: 'https://100.64.0.1',
    key: 'key',
    secret: 'secret',
    localAddresses: async () => ['100.64.0.1', '127.0.0.1'],
    fetcher: async (_url, options) => {
      const { type } = JSON.parse(options.body);
      if (type === 'GetVersion') return Response.json('2.3.2');
      if (type === 'ListServers')
        return Response.json([
          { id: 'remote', name: 'Remote', info: { address: 'http://127.0.0.1:8120' } },
        ]);
      return Response.json([
        { name: 'Web', ports: [{ PrivatePort: 80, PublicPort: 8080, IP: '0.0.0.0', Type: 'tcp' }] },
      ]);
    },
  });
  await d.refresh();
  assert(!d.servers[0].local);
  assert.equal(d.servers[0].address, '');
  assert(!d.inventory[0].ports[0].usable);
});
