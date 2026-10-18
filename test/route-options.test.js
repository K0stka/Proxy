import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContainers } from '../server/komodo.js';
import { serviceEndpoints, portLabel, visibleServicePorts, serviceProxies, destinationLabel, routeSubdomain } from '../ui/routes.js';
import { byName } from '../ui/order.js';
import { route } from './fixtures.js';

test('destination picker offers normalized running services and explains unavailable matching ports', () => {
  const services = normalizeContainers(
    [
      {
        id: 'web',
        name: 'Dashy',
        state: 'Running',
        ports: [
          { PrivatePort: 8080, PublicPort: 9000, IP: '0.0.0.0', Type: 'tcp' },
          { PrivatePort: 53, PublicPort: 5353, IP: '0.0.0.0', Type: 'udp' },
        ],
      },
      { id: 'db', name: 'Database', state: 'running', ports: [{ PrivatePort: 5432, Type: 'tcp' }] },
      {
        id: 'stopped',
        name: 'Stopped',
        state: 'Exited',
        ports: [{ PrivatePort: 80, PublicPort: 8080, IP: '0.0.0.0', Type: 'tcp' }],
      },
    ],
    { id: 'home', name: 'Home', address: '100.101.102.103', local: false },
  );
  const options = serviceEndpoints(services, 'http');
  assert.equal(options.length, 2);
  assert.equal(options[0].reason, '');
  assert.equal(portLabel(options[0].port), '9000:8080 (TCP)');
  assert.ok(options.every((option) => option.port.hostPort > 0));
  assert.equal(options[1].reason, 'Container is exited');
  const udp = serviceEndpoints(services, 'udp');
  assert.equal(udp.length, 1);
  assert.equal(portLabel(udp[0].port), '5353:53 (UDP)');
  assert.equal(new Set([...options, ...udp].map((option) => option.key)).size, 3);
});

test('protected, unsafe and remote loopback endpoints are hidden from services and destinations', () => {
  const services = normalizeContainers([
    { id: 'core', name: 'Core', ports: [{ PrivatePort: 9120, PublicPort: 9120, IP: '0.0.0.0', Type: 'tcp' }] },
    { id: 'unsafe', name: 'Unsafe', ports: [{ PrivatePort: 80, PublicPort: 8080, IP: '169.254.169.254', Type: 'tcp' }] },
    { id: 'steam', name: 'Steam', state: 'running', ports: [{ PrivatePort: 3000, PublicPort: 8484, IP: '127.0.0.1', Type: 'tcp' }] },
  ], { id: 'home', name: 'Home', address: '100.89.5.109', local: false });
  assert.deepEqual(services.map((service) => visibleServicePorts(service).length), [0, 0, 0]);
  const options = serviceEndpoints(services, 'http');
  assert.equal(options.length, 0);
  assert.match(services[2].ports[0].reason, /Bound to 127\.0\.0\.1 on the remote server/);
});

test('service proxies match saved discovery references and custom endpoints without mixing servers or protocols', () => {
  const service = { server: 'home', containerId: 'new-id', name: 'Website' };
  const port = { containerPort: 3000, hostPort: 8484, targetHost: '100.89.5.109', protocol: 'tcp' };
  const source = { server: 'home', containerId: 'old-id', container: 'Website', containerPort: 3000 };
  const saved = route({ source, targetHost: '100.89.5.108', targetPort: port.hostPort, published: true });
  const custom = route({ targetHost: port.targetHost, targetPort: port.hostPort });
  const routes = [saved, custom,
    route({ source: { ...source, server: 'other' } }),
    route({ source: { ...source, containerPort: 9000 } }),
    route({ source, targetPort: 9000 }),
    route({ kind: 'udp', source }),
    route({ kind: 'static', targetHost: port.targetHost, targetPort: port.hostPort }),
  ];
  assert.deepEqual(serviceProxies(routes, service, port), [saved, custom]);
  const udp = route({ kind: 'udp', targetHost: port.targetHost, portStart: 8400, portEnd: 8500 });
  assert.deepEqual(serviceProxies([udp, custom], service, { ...port, protocol: 'udp' }), [udp]);
});

test('names sort ascending without case sensitivity and route names form valid subdomains', () => {
  assert.deepEqual([{ name: 'Zulu' }, { name: 'service 10' }, { name: 'Alpha' }, { name: 'Service 2' }].sort(byName).map((item) => item.name), ['Alpha', 'Service 2', 'service 10', 'Zulu']);
  assert.deepEqual([{ directory: 'zebra/public' }, { directory: 'alpha' }].sort(byName).map((item) => item.directory), ['alpha', 'zebra/public']);
  assert.equal(routeSubdomain('My Website / Test'), 'my-website-test');
  assert.equal(routeSubdomain(' Žlutý kůň! '), 'zluty-kun');
  assert.equal(routeSubdomain('---'), '');
  assert.equal(routeSubdomain('x'.repeat(62) + ' more').length, 62);
});


test('route destinations identify discovered services and hosts, retaining custom and stale targets', () => {
  const discovery = {
    servers: [{ id: 'home', name: 'Home server' }],
    services: [{
      server: 'home', name: 'Photos', containerId: 'photos-id',
      ports: [{ hostPort: 2283, containerPort: 2283, protocol: 'tcp', targetHost: '100.101.102.103', usable: true }],
    }],
  };
  const custom = route({ targetHost: '100.101.102.103', targetPort: 2283 });
  assert.equal(destinationLabel(custom, discovery), 'Photos (Home server)');
  assert.equal(destinationLabel(route({ targetHost: '100.101.102.103', targetPort: 9000 }), discovery), '100.101.102.103:9000');
  assert.equal(destinationLabel(route({ kind: 'static', staticSite: { directory: 'portfolio' } }), discovery), '/sites/portfolio');
  assert.equal(destinationLabel(route({ source: { server: 'home', container: 'Old photos', containerPort: 2283 } }),
    { ...discovery, services: [] }), 'Old photos (Home server)');
  assert.equal(destinationLabel(route({ source: { server: 'offline', container: 'Photos', containerPort: 2283 } }),
    { servers: [], services: [] }), 'Photos (offline)');
});
