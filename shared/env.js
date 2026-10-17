import { effectivePolicy, defaultSettings } from './model.js';

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
