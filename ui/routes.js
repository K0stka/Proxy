import { errorPageTypes } from '../shared/pages.js';
import { compareNames } from './order.js';
import { portRanges, formatPorts, samePorts } from '../shared/ports.js';
export const isWebsite = (route) => ['http', 'static', 'redirect'].includes(route.kind);
export const routeSubdomain = (name) =>
  name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
export function listener(route, compact = false) {
  if (isWebsite(route))
    return route.hostname + (['static', 'redirect'].includes(route.kind) && route.path !== '/' ? (route.path ?? '') : '');
  const ports = route.ports || formatPorts(portRanges(route));
  return `${route.ingressIP.includes(':') ? `[${route.ingressIP}]` : route.ingressIP}:${compact && ports.length > 20 ? `${ports.slice(0, 20)}…` : ports}`;
}
export const destination = (route) =>
  route.kind === 'redirect' ? route.redirectURL : route.kind === 'static'
    ? `/sites/${route.staticSite?.directory ?? ''}`
    : `${route.targetHost.includes(':') ? `[${route.targetHost}]` : route.targetHost}:${samePorts(route) ? (route.ports || formatPorts(portRanges(route))) : route.targetPort}`;
export const kindName = { http: 'Service', static: 'Static site', redirect: 'Redirect', tcp: 'TCP', udp: 'UDP' };
export const portLabel = (port) =>
  `${port.hostPort ? port.hostPort + ':' : ''}${port.containerPort} (${port.protocol.toUpperCase()})`;
export const visibleServicePorts = (service) =>
  service.ports
    .filter((port) => port.hostPort > 0 && port.usable && !port.restricted)
    .sort(
      (a, b) =>
        a.hostPort - b.hostPort ||
        a.containerPort - b.containerPort ||
        compareNames(a.protocol, b.protocol),
    );
export function serviceProxies(routes, service, port) {
  return routes.filter((route) => {
    if (['static', 'redirect'].includes(route.kind) || (route.kind === 'udp') !== (port.protocol === 'udp'))
      return false;
    if (
      samePorts(route)
        ? !portRanges(route).some(({ start, end }) => port.hostPort >= start && port.hostPort <= end)
        : route.targetPort !== port.hostPort
    )
      return false;
    if (route.source)
      return (
        route.source.server === service.server &&
        (route.source.containerId === service.containerId ||
          route.source.container === service.name) &&
        route.source.containerPort === port.containerPort
      );
    return route.targetHost === port.targetHost;
  });
}
export function destinationLabel(route, discovery) {
  if (['static', 'redirect'].includes(route.kind)) return destination(route);
  const service = discovery.services.find((service) =>
    visibleServicePorts(service).some((port) => serviceProxies([route], service, port).length),
  );
  const name = service?.name ?? route.source?.container;
  if (!name) return samePorts(route)
    ? (route.targetHost.includes(':') ? `[${route.targetHost}]` : route.targetHost)
    : destination(route);
  const server = discovery.servers.find((server) => server.id === (service?.server ?? route.source?.server));
  return `${name} (${server?.name ?? service?.serverName ?? route.source?.server ?? route.targetHost})`;
}
export function serviceEndpoints(services, kind) {
  const protocol = kind === 'udp' ? 'udp' : 'tcp';
  return services
    .flatMap((service) =>
      visibleServicePorts(service)
        .filter((port) => port.protocol === protocol)
        .map((port) => ({
          key: JSON.stringify([
            service.server,
            service.containerId,
            service.name,
            port.protocol,
            port.hostPort,
            port.containerPort,
          ]),
          service,
          port,
          reason:
            service.state !== 'running'
              ? `Container is ${service.state}`
              : !port.usable
                ? port.reason
                : '',
        })),
    )
    .sort(
      (a, b) =>
        compareNames(a.service.serverName, b.service.serverName) ||
        compareNames(a.service.name, b.service.name) ||
        a.port.hostPort - b.port.hostPort,
    );
}
export const blankSite = (directory) => ({
  directory,
  include: [],
  exclude: [
    '**/node_modules/**',
    '**/*.pem',
    '**/*.key',
    '**/*.db',
    '**/*.sqlite*',
    '**/*.map',
    '**/*~',
  ],
});
export function folderRules(state, directory) {
  return (
    state.sites.find((site) => site.directory === directory) ??
    state.routes.find((route) => route.staticSite?.directory === directory)?.staticSite ??
    errorPageTypes.map(([, key]) => state.pages[key + 'Site']).find(
      (site) => site?.directory === directory,
    ) ??
    blankSite(directory)
  );
}
export function freshRoute(state) {
  return {
    name: '',
    kind: 'http',
    path: '/',
    redirectURL: '',
    redirectStatus: 302,
    hostname: '',
    ingressIP: state.policy.ingressIPs[0],
    portStart: 51413,
    portEnd: 51413,
    ports: '',
    targetHost: '',
    targetPort: 80,
    staticSite: null,
    upstreamTLS: false,
    upstreamServerName: '',
    streamTLS: false,
    tlsDomain: '',
    proxyProtocol: false,
    sourceCIDRs: [],
    timeout: 60,
    uploadMB: 100,
    published: false,
    source: null,
  };
}
