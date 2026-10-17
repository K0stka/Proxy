import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContainers } from '../server/komodo.js';
import { serviceEndpoints, portLabel } from '../ui/routes.js';

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
  assert.equal(options.length, 3);
  assert.equal(options[0].reason, '');
  assert.equal(portLabel(options[0].port), '9000 (8080) / TCP');
  assert.equal(options[1].reason, 'No Docker host-port mapping');
  assert.equal(portLabel(options[1].port), 'Container only (5432) / TCP');
  assert.equal(options[2].reason, 'Container is exited');
  const udp = serviceEndpoints(services, 'udp');
  assert.equal(udp.length, 1);
  assert.equal(portLabel(udp[0].port), '5353 (53) / UDP');
  assert.equal(new Set([...options, ...udp].map((option) => option.key)).size, 4);
});
