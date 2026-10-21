import { randomUUID } from 'node:crypto';
import { validatePolicy } from '../shared/model.js';

export function policy() {
  return validatePolicy(
    {
      origin: 'http://localhost:5173',
      ingressIPs: ['203.0.113.10'],
      domains: [{ name: 'krychlic.com' }, { name: 'example.net' }],
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
export const snapshot = (routes) => ({ routes });

export function policyEnv(p) {
  return { PROXY_ORIGIN: p.origin, PROXY_INGRESS_IPS: p.ingressIPs.join(',') };
}
