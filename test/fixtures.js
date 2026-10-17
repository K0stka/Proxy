import { randomUUID } from 'node:crypto';
import { validatePolicy, defaultPages } from '../shared/model.js';

export function policy() {
  return validatePolicy(
    {
      origin: 'http://localhost:5173',
      ingressIPs: ['203.0.113.10'],
      ingressPorts: [
        { protocol: 'udp', from: 50000, to: 50100 },
        { protocol: 'tcp', from: 51413, to: 51420 },
        { protocol: 'udp', from: 51413, to: 51413 },
      ],
      targets: [
        {
          name: 'Home',
          address: '100.101.102.103',
          ports: [
            { from: 3000, to: 3000 },
            { from: 8080, to: 8080 },
            { from: 50000, to: 50100 },
            { from: 51413, to: 51420 },
          ],
        },
        { name: 'VPS', address: '127.0.0.1', ports: [{ from: 8081, to: 8081 }] },
      ],
      forbiddenTargetPorts: [3001, 8120, 9120, 2375, 2376],
      maxRangePorts: 1024,
      domains: [{ name: 'krychlic.com' }, { name: 'example.net' }],
      komodo: {
        url: 'http://100.101.102.103:9120',

        servers: [
          { id: 'home', name: 'Home', address: '100.101.102.103', local: false },
          { id: 'vps', name: 'VPS', address: '127.0.0.1', local: true },
        ],
      },
      certificates: { email: 'admin@krychlic.com', staging: true, propagationSeconds: 60 },
    },
    { development: true },
  );
}
export function route(changes = {}) {
  return {
    id: randomUUID(),
    name: 'Website',
    kind: 'http',
    hostname: 'app.krychlic.com',
    ingressIP: '203.0.113.10',
    portStart: 51413,
    portEnd: 51413,
    targetHost: '100.101.102.103',
    targetPort: 3000,
    upstreamTLS: false,
    upstreamServerName: '',
    streamTLS: false,
    tlsDomain: '',
    proxyProtocol: false,
    sourceCIDRs: [],
    timeout: 60,
    uploadMB: 100,
    interceptErrors: false,
    published: false,
    source: null,
    ...changes,
  };
}
export const snapshot = (routes) => ({ routes, pages: { ...defaultPages } });

export function policyEnv(p) {
  return { PROXY_ORIGIN: p.origin, PROXY_INGRESS_IPS: p.ingressIPs.join(',') };
}
