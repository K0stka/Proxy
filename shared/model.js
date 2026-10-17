import { z } from 'zod';
import { isIP, BlockList } from 'node:net';
import { domainToASCII } from 'node:url';
import { createHash } from 'node:crypto';

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const hostname = z
  .string()
  .max(253)
  .transform((v) => domainToASCII(v.trim().toLowerCase()))
  .refine(
    (v) =>
      v.includes('.') &&
      v.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)),
    'Enter a valid hostname',
  );
export const ip = z.string().refine((v) => isIP(v) !== 0, 'Enter a literal IPv4 or IPv6 address');
const port = z.number().int().min(1).max(65535);
const cidr = z.string().refine((v) => {
  const [address, bits, extra] = v.split('/');
  const type = isIP(address);
  return (
    !extra &&
    type &&
    /^\d+$/.test(bits ?? '') &&
    Number(bits) >= 0 &&
    Number(bits) <= (type === 4 ? 32 : 128)
  );
}, 'Use a CIDR such as 192.0.2.0/24');
export const siteDirectory = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (v) =>
      v
        .split('/')
        .every(
          (part) =>
            /^[a-zA-Z0-9][a-zA-Z0-9_. -]*$/.test(part) &&
            !part.endsWith('.') &&
            !part.endsWith(' '),
        ),
    'Choose a folder inside /sites',
  );
const filePattern = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (v) =>
      !v.startsWith('/') &&
      !/[\\\x00-\x1f]/.test(v) &&
      !v.split('/').includes('..') &&
      (v.match(/[?*]/g) ?? []).length <= 12,
    'Use relative patterns such as assets/** or *.html',
  );
export const defaultExcludedFiles = [
  '**/node_modules/**',
  '**/*.pem',
  '**/*.key',
  '**/*.db',
  '**/*.sqlite*',
  '**/*.map',
  '**/*~',
];
export const staticSiteSchema = z
  .object({
    directory: siteDirectory,
    include: z.array(filePattern).max(30).default([]),
    exclude: z.array(filePattern).max(30).default(defaultExcludedFiles),
  })
  .strict();
export const policySchema = z
  .object({
    origin: z.string().url(),
    ingressIPs: z.array(ip).min(1).max(8),
    domains: z
      .array(
        z
          .object({
            name: hostname,
          })
          .strict(),
      )
      .max(50),
    certificates: z
      .object({
        email: z.union([z.string().email(), z.literal('')]),
        staging: z.boolean(),
        propagationSeconds: z.number().int().min(10).max(600),
      })
      .strict(),
  })
  .strict();
export const settingsSchema = policySchema.omit({
  origin: true,
  ingressIPs: true,
});
export const defaultSettings = {
  domains: [],
  certificates: { email: '', staging: true, propagationSeconds: 60 },
};
export function settingsFromPolicy(policy) {
  return parse(
    settingsSchema,
    Object.fromEntries(Object.keys(defaultSettings).map((key) => [key, policy[key]])),
  );
}
export function effectivePolicy(deployment, settings, { development = false } = {}) {
  return validatePolicy(
    {
      ...parse(settingsSchema, settings),
      ...deployment,
    },
    { development },
  );
}
export const policyHash = (policy) =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export const routeSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['http', 'static', 'tcp', 'udp']),
    staticSite: staticSiteSchema.nullable().default(null),
    hostname: z.union([hostname, z.literal('')]).default(''),
    ingressIP: ip,
    portStart: port.default(51413),
    portEnd: port.default(51413),
    targetHost: z.union([ip, z.literal('')]),
    targetPort: port,
    upstreamTLS: z.boolean().default(false),
    upstreamServerName: z.union([hostname, z.literal('')]).default(''),
    streamTLS: z.boolean().default(false),
    tlsDomain: z.union([hostname, z.literal('')]).default(''),
    proxyProtocol: z.boolean().default(false),
    sourceCIDRs: z.array(cidr).max(50).default([]),
    timeout: z.number().int().min(5).max(86400).default(60),
    uploadMB: z.number().int().min(1).max(1024).default(100),
    interceptErrors: z.unknown().optional(),
    published: z.boolean().default(false),
    source: z
      .object({
        server: z.string().max(128),
        container: z.string().max(256),
        containerId: z.string().max(128),
        containerPort: port,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .transform(({ interceptErrors, ...route }) => route);
export const pagesSchema = z
  .object({
    notFoundTitle: z.string().trim().min(1).max(100),
    notFoundText: z.string().max(240),
    badGatewayTitle: z.string().trim().min(1).max(100),
    badGatewayText: z.string().max(240),
    notFoundSite: staticSiteSchema.nullable().default(null),
    badGatewaySite: staticSiteSchema.nullable().default(null),
    // Accept older saved configurations, but discard the removed page setting.
    gatewayTimeoutSite: z.unknown().optional(),
  })
  .strict()
  .transform(({ gatewayTimeoutSite, ...pages }) => pages);
export const defaultPages = {
  notFoundTitle: 'Nothing here.',
  notFoundText: 'This address has no website connected to it.',
  badGatewayTitle: 'Back soon.',
  badGatewayText: 'This service is temporarily unavailable. Please try again shortly.',
  notFoundSite: null,
  badGatewaySite: null,
};
export const snapshotSchema = z
  .object({
    routes: z.array(routeSchema).max(500),
    pages: pagesSchema,
    sites: z.array(staticSiteSchema).max(500).default([]),
  })
  .strict()
  .transform((snapshot, ctx) => {
    const profiles = new Map(snapshot.sites.map((site) => [site.directory, site]));
    if (profiles.size !== snapshot.sites.length) {
      ctx.addIssue({ code: 'custom', message: 'Folder rules must be unique' });
      return z.NEVER;
    }
    // Preserve legacy per-use filters until the administrator saves shared folder rules.
    const resolveSite = (site) => (site ? (profiles.get(site.directory) ?? site) : null);
    const routes = snapshot.routes.map((route) => ({
      ...route,
      staticSite: resolveSite(route.staticSite),
    }));
    const pages = {
      ...snapshot.pages,
      notFoundSite: resolveSite(snapshot.pages.notFoundSite),
      badGatewaySite: resolveSite(snapshot.pages.badGatewaySite),
    };
    return { routes, pages, sites: [...profiles.values()] };
  });
export const snapshotHash = (snapshot) =>
  createHash('sha256')
    .update(
      JSON.stringify({ routes: snapshot.routes.filter((r) => r.published), pages: snapshot.pages }),
    )
    .digest('hex');
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new Problem(
      400,
      result.error.issues
        .map((i) => `${i.path.join('.') || 'Request'}: ${i.message}`)
        .slice(0, 4)
        .join('; '),
    );
  return result.data;
}
export function canonicalIP(value) {
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}
export function coveredDomain(host, domains) {
  return domains.find(
    (d) =>
      host === d.name ||
      (host.endsWith(`.${d.name}`) && host.split('.').length === d.name.split('.').length + 1),
  );
}
export const MAX_STREAM_PORTS = 1024;
const protectedPorts = [3001, 8120, 9120, 2375, 2376];
const unsafeAddresses = new BlockList();
for (const [address, bits, type] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
])
  unsafeAddresses.addSubnet(address, bits, type);
export function safeAddress(host) {
  const type = isIP(host);
  if (!type) return false;
  const address = canonicalIP(host),
    normalized = isIP(address);
  return address !== '::' && !unsafeAddresses.check(address, normalized === 4 ? 'ipv4' : 'ipv6');
}
export function safeTarget(host, start, end = start) {
  return (
    safeAddress(host) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end <= 65535 &&
    end >= start &&
    !protectedPorts.some((port) => port >= start && port <= end)
  );
}
export function validatePolicy(raw, { development = false } = {}) {
  const p = parse(policySchema, raw);
  const origin = new URL(p.origin);
  if (
    origin.origin !== p.origin ||
    origin.username ||
    origin.password ||
    (origin.protocol !== 'https:' &&
      !(
        development &&
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(origin.hostname)
      ))
  )
    throw new Problem(
      400,
      'Management origin must be an exact HTTPS origin (HTTP loopback only in development)',
    );
  if (origin.protocol === 'https:' && !hostname.safeParse(origin.hostname).success)
    throw new Problem(400, 'Use an HTTPS DNS hostname for passkey management');
  if (new Set(p.domains.map((d) => d.name)).size !== p.domains.length)
    throw new Problem(400, 'Duplicate domains in policy');
  if (p.domains.length && !p.certificates.email)
    throw new Problem(400, 'Set an ACME email before adding domains');
  if (p.ingressIPs.some((address) => !safeAddress(address)))
    throw new Problem(
      400,
      'Unspecified, metadata/link-local and multicast addresses are forbidden',
    );
  return p;
}
export function validateSnapshot(policy, raw) {
  const snapshot = parse(snapshotSchema, raw);
  const ids = new Set(),
    hosts = new Set(),
    listeners = [];
  let sockets = 0;
  for (const r of snapshot.routes) {
    if (ids.has(r.id)) throw new Problem(400, 'Duplicate route ID');
    ids.add(r.id);
    if (!policy.ingressIPs.some((a) => canonicalIP(a) === canonicalIP(r.ingressIP)))
      throw new Problem(400, 'Ingress address is not approved');
    const end = r.kind === 'udp' ? r.portEnd : r.targetPort;
    const start = r.kind === 'udp' ? r.portStart : r.targetPort;
    if (r.kind !== 'static' && !safeTarget(r.targetHost, start, end))
      throw new Problem(400, 'Destination uses an unsafe address or a protected management port');
    if (r.kind === 'static' && !r.staticSite) throw new Problem(400, 'Choose a static-site folder');
    if (r.kind !== 'static' && r.staticSite)
      throw new Problem(400, 'Only static routes can select a folder');
    if (r.kind === 'http' || r.kind === 'static') {
      if (!coveredDomain(r.hostname, policy.domains))
        throw new Problem(
          400,
          'Hostname must be an apex or one-level subdomain of a configured domain',
        );
      if (hosts.has(r.hostname)) throw new Problem(400, 'Hostname already has a route');
      hosts.add(r.hostname);
      if (r.upstreamTLS && !r.upstreamServerName)
        throw new Problem(400, 'HTTPS upstream requires its certificate hostname');
      if (r.streamTLS || r.proxyProtocol)
        throw new Problem(400, 'Stream options cannot be used on a website');
    } else {
      if (r.portEnd < r.portStart || (r.kind === 'tcp' && r.portStart !== r.portEnd))
        throw new Problem(400, 'TCP needs one port; UDP ranges must be ascending');
      if (r.portEnd - r.portStart + 1 > MAX_STREAM_PORTS)
        throw new Problem(400, 'Port range exceeds the configured budget');
      if (r.kind === 'udp' && (r.streamTLS || r.proxyProtocol))
        throw new Problem(400, 'UDP does not support TLS or PROXY protocol in this application');
      if (r.streamTLS && !policy.domains.some((d) => d.name === r.tlsDomain))
        throw new Problem(400, 'Choose a configured TLS certificate domain');
      if (
        r.kind === 'tcp' &&
        [80, 443, ...protectedPorts].some((port) => r.portStart <= port && r.portEnd >= port)
      )
        throw new Problem(400, 'Listener conflicts with HTTP/HTTPS or a protected management port');
      if (r.published) {
        if (
          listeners.some(
            (o) =>
              o.kind === r.kind &&
              canonicalIP(o.ingressIP) === canonicalIP(r.ingressIP) &&
              r.portStart <= o.portEnd &&
              r.portEnd >= o.portStart,
          )
        )
          throw new Problem(400, 'Listener overlaps another published route');
        listeners.push(r);
        sockets += r.portEnd - r.portStart + 1;
      }
    }
  }
  if (sockets > MAX_STREAM_PORTS)
    throw new Problem(400, 'Total published stream ports exceed the configured budget');
  return snapshot;
}
