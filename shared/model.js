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
const range = z
  .object({ from: port, to: port })
  .strict()
  .refine((v) => v.to >= v.from, 'Port range must be ascending');
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
    ingressPorts: z
      .array(
        z
          .object({ protocol: z.enum(['tcp', 'udp']), from: port, to: port })
          .strict()
          .refine((v) => v.to >= v.from),
      )
      .max(100),
    targets: z
      .array(
        z
          .object({
            name: z.string().min(1).max(80),
            address: ip,
            ports: z.array(range).min(1).max(100),
          })
          .strict(),
      )
      .max(100),
    forbiddenTargetPorts: z.array(port).default([3001, 8120, 9120, 2375, 2376]),
    maxRangePorts: z.number().int().min(1).max(10000).default(1024),
    domains: z
      .array(
        z
          .object({
            name: hostname,
          })
          .strict(),
      )
      .max(50),
    komodo: z
      .object({
        url: z.union([z.string().url(), z.literal('')]),
        servers: z
          .array(
            z
              .object({
                id: z.string().min(1).max(128),
                name: z.string().min(1).max(80),
                address: ip,
                local: z.boolean(),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
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
  forbiddenTargetPorts: true,
});
export const defaultSettings = {
  ingressPorts: [],
  targets: [],
  maxRangePorts: 1024,
  domains: [],
  komodo: { url: '', servers: [] },
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
      forbiddenTargetPorts: [3001, 8120, 9120, 2375, 2376],
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
    targetHost: ip,
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
const inRange = (value, ranges) => ranges.some((r) => value >= r.from && value <= r.to);
export function allowedTarget(policy, host, start, end = start) {
  const target = policy.targets.find((t) => canonicalIP(t.address) === canonicalIP(host));
  if (!target || end < start) return false;
  for (let p = start; p <= end; p++)
    if (!inRange(p, target.ports) || policy.forbiddenTargetPorts.includes(p)) return false;
  return true;
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
  if (new Set(p.targets.map((t) => canonicalIP(t.address))).size !== p.targets.length)
    throw new Problem(400, 'Duplicate destination address');
  if (new Set(p.komodo.servers.map((s) => s.id)).size !== p.komodo.servers.length)
    throw new Problem(400, 'Duplicate Komodo server ID');
  const unsafe = new BlockList();
  unsafe.addSubnet('169.254.0.0', 16, 'ipv4');
  unsafe.addSubnet('224.0.0.0', 4, 'ipv4');
  unsafe.addSubnet('fe80::', 10, 'ipv6');
  unsafe.addSubnet('ff00::', 8, 'ipv6');
  for (const address of [...p.ingressIPs, ...p.targets.map((t) => t.address)]) {
    if (
      ['0.0.0.0', '::'].includes(canonicalIP(address)) ||
      unsafe.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
    )
      throw new Problem(
        400,
        'Unspecified, metadata/link-local and multicast addresses are forbidden',
      );
  }
  if (!p.komodo.url) {
    if (p.komodo.servers.length)
      throw new Problem(400, 'Set the Komodo Core URL before adding servers');
    return p;
  }
  const core = new URL(p.komodo.url);
  if (
    !['http:', 'https:'].includes(core.protocol) ||
    core.username ||
    core.password ||
    core.search ||
    core.hash
  )
    throw new Problem(400, 'Invalid Komodo URL');
  // HTTP is permitted only over the explicitly configured Tailscale address.
  if (
    core.protocol === 'http:' &&
    !(
      isIP(core.hostname) === 4 &&
      core.hostname.startsWith('100.') &&
      Number(core.hostname.split('.')[1]) >= 64 &&
      Number(core.hostname.split('.')[1]) <= 127
    )
  )
    throw new Problem(
      400,
      'Komodo HTTP requires a Tailscale IPv4 address; otherwise use verified HTTPS',
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
    if (r.kind !== 'static' && !allowedTarget(policy, r.targetHost, start, end))
      throw new Problem(400, 'Destination ports are not approved by the host policy');
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
      if (r.portEnd - r.portStart + 1 > policy.maxRangePorts)
        throw new Problem(400, 'Port range exceeds the configured budget');
      if (r.kind === 'udp' && (r.streamTLS || r.proxyProtocol))
        throw new Problem(400, 'UDP does not support TLS or PROXY protocol in this application');
      if (r.streamTLS && !policy.domains.some((d) => d.name === r.tlsDomain))
        throw new Problem(400, 'Choose a configured TLS certificate domain');
      if (
        !policy.ingressPorts.some(
          (p) => p.protocol === r.kind && r.portStart >= p.from && r.portEnd <= p.to,
        ) ||
        (r.kind === 'tcp' && [80, 443].some((p) => r.portStart <= p && r.portEnd >= p))
      )
        throw new Problem(
          400,
          'Listener is outside the approved ingress ranges or conflicts with HTTP/HTTPS',
        );
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
  if (sockets > policy.maxRangePorts)
    throw new Problem(400, 'Total published stream ports exceed the configured budget');
  return snapshot;
}
