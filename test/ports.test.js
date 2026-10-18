import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePorts, portRanges, formatPorts } from '../shared/ports.js';
import { validateSnapshot } from '../shared/model.js';
import { render } from '../edge/render.js';
import { listener, destination, destinationLabel, serviceProxies } from '../ui/routes.js';
import { policy, route, snapshot } from './fixtures.js';

test('port lists normalize singles and ranges and reject malformed or overlapping values', () => {
  assert.equal(formatPorts(parsePorts('56 - 78, 034, 12')), '12, 34, 56-78');
  for (const value of ['', '12,', '12,,34', '0', '65536', '78-56', '12,12', '12-34, 20', '-1', '1.5', '12; return 200'])
    assert.throws(() => parsePorts(value), value);
});

test('TCP and UDP lists check actual ranges, protected ports, overlaps and total socket budget', () => {
  for (const kind of ['tcp', 'udp']) {
    const input = route({ kind, ports: '12, 34, 56-78', published: true });
    const parsed = validateSnapshot(policy(), snapshot([input])).routes[0];
    assert.equal(parsed.ports, input.ports);
    assert.equal(portRanges(parsed).length, 3);
    const gap = route({ kind, ports: '35-55', published: true });
    assert.equal(validateSnapshot(policy(), snapshot([input, gap])).routes.length, 2);
    assert.throws(() => validateSnapshot(policy(), snapshot([input, route({ kind, ports: '70', published: true })])), /overlaps/);
    assert.throws(() => validateSnapshot(policy(), snapshot([route({ kind, ports: '3000-3002' })])), /unsafe|management/);
    assert.throws(() => validateSnapshot(policy(), snapshot([route({ kind, ports: '20000-21023, 22000' })])), /budget/);
  }
  assert.throws(() => validateSnapshot(policy(), snapshot([route({ kind: 'tcp', ports: '79-81' })])), /conflicts/);
});

test('stream lists create separate listeners with preserved destinations; single TCP keeps remapping', () => {
  for (const kind of ['tcp', 'udp']) {
    const input = route({ kind, ports: '12, 34, 56-78', published: true });
    const output = render(policy(), snapshot([input]), { revision: 'ports', directory: '/runtime/test' });
    for (const ports of ['12', '34', '56-78']) assert(output.config.includes(`listen 203.0.113.10:${ports}`));
    assert(output.config.includes('proxy_pass 100.101.102.103:$server_port;'));
    assert.equal(listener(input), '203.0.113.10:12, 34, 56-78');
    assert.equal(destination(input), '100.101.102.103:12, 34, 56-78');
    assert.equal(serviceProxies([input], {}, { protocol: kind === 'udp' ? 'udp' : 'tcp', hostPort: 60, targetHost: input.targetHost }).length, 1);
    assert.equal(serviceProxies([input], {}, { protocol: kind === 'udp' ? 'udp' : 'tcp', hostPort: 50, targetHost: input.targetHost }).length, 0);
  }
  const output = render(policy(), snapshot([route({ kind: 'tcp', ports: '12345', targetPort: 8080, published: true })]), { revision: 'ports', directory: '/runtime/test' });
  assert(output.config.includes('proxy_pass 100.101.102.103:8080;'));
});

test('route rows truncate only long source ports and omit repeated destination ports', () => {
  const discovery = { services: [], servers: [] };
  const ports = '27015, 27020, 27025, 27030';
  for (const kind of ['tcp', 'udp']) {
    const input = route({ kind, ports });
    assert.equal(listener(input, true), `203.0.113.10:${ports.slice(0, 20)}…`);
    assert.equal(listener(input), `203.0.113.10:${ports}`);
    assert.equal(destinationLabel(input, discovery), input.targetHost);
    assert.equal(destinationLabel({ ...input, targetHost: '2001:db8::1' }, discovery), '[2001:db8::1]');
  }
  for (const ports of ['27015', '27015, 27020, 30-300']) {
    const input = route({ kind: 'udp', ports });
    assert.equal(listener(input, true), listener(input));
  }
  assert.equal(destinationLabel(route({ kind: 'tcp', ports: '27015', targetPort: 8080 }), discovery), '100.101.102.103:8080');
  const website = route({ kind: 'http', hostname: 'example.com' });
  assert.equal(listener(website, true), 'example.com');
});
