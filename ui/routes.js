export const isWebsite = (route) => route.kind === 'http' || route.kind === 'static';
export const listener = (route) =>
  isWebsite(route)
    ? route.hostname
    : `${route.ingressIP}:${route.portStart}${route.portEnd !== route.portStart ? `–${route.portEnd}` : ''}`;
export const destination = (route) =>
  route.kind === 'static'
    ? `/sites/${route.staticSite?.directory ?? ''}`
    : `${route.targetHost.includes(':') ? `[${route.targetHost}]` : route.targetHost}:${route.kind === 'udp' ? (route.portStart === route.portEnd ? route.portStart : `${route.portStart}–${route.portEnd}`) : route.targetPort}`;
export const kindName = { http: 'Website', static: 'Static site', tcp: 'TCP', udp: 'UDP' };
export const portLabel = (port) =>
  `${port.hostPort || 'Container only'} (${port.containerPort}) / ${port.protocol.toUpperCase()}`;
export function serviceEndpoints(services, kind) {
  const protocol = kind === 'udp' ? 'udp' : 'tcp';
  return services.flatMap((service) =>
    service.ports
      .filter((port) => port.hostPort > 0 && port.protocol === protocol)
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
    [state.pages.notFoundSite, state.pages.badGatewaySite].find(
      (site) => site?.directory === directory,
    ) ??
    blankSite(directory)
  );
}
export function freshRoute(state) {
  return {
    name: '',
    kind: 'http',
    hostname: '',
    ingressIP: state.policy.ingressIPs[0],
    portStart: 51413,
    portEnd: 51413,
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
