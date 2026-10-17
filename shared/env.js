import { effectivePolicy, defaultSettings, Problem } from './model.js';
import { isIP } from 'node:net';

export function readKomodoURL(env = process.env) {
  const value = env.PROXY_KOMODO_URL?.trim() ?? '';
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Problem(400, 'PROXY_KOMODO_URL must be a valid Core URL');
  }
  const tailscale =
    isIP(url.hostname) === 4 &&
    url.hostname.startsWith('100.') &&
    Number(url.hostname.split('.')[1]) >= 64 &&
    Number(url.hostname.split('.')[1]) <= 127;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && tailscale))
  )
    throw new Problem(
      400,
      'PROXY_KOMODO_URL requires verified HTTPS or a literal Tailscale IPv4 HTTP address',
    );
  return value.replace(/\/$/, '');
}

export function readDeployment(env = process.env, { development = false } = {}) {
  const deployment = {
    origin: env.PROXY_ORIGIN ?? '',
    ingressIPs: env.PROXY_INGRESS_IPS?.trim()
      ? env.PROXY_INGRESS_IPS.split(',').map((value) => value.trim())
      : [],
  };
  const policy = effectivePolicy(deployment, defaultSettings, { development });
  return { origin: policy.origin, ingressIPs: policy.ingressIPs };
}
