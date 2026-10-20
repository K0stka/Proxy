import { isIP, BlockList } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { safeAddress, safeTarget, canonicalIP, protectedPorts } from '../shared/model.js';
import { readKomodoURL } from '../shared/env.js';

const loopbacks = new BlockList();
loopbacks.addSubnet('127.0.0.0', 8, 'ipv4');
loopbacks.addAddress('::1', 'ipv6');
const loopback = (address) =>
  isIP(address) !== 0 && loopbacks.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
function uniquePorts(ports) {
  const mappings = new Map();
  for (const port of ports) {
    const key = JSON.stringify([port.protocol, port.hostPort, port.containerPort]),
      previous = mappings.get(key);
    if (
      !previous ||
      (!previous.usable && port.usable) ||
      (previous.usable === port.usable &&
        isIP(port.targetHost) === 4 &&
        isIP(previous.targetHost) === 6)
    )
      mappings.set(key, port);
  }
  return [...mappings.values()];
}
export function normalizeContainers(containers, server) {
  if (!Array.isArray(containers)) throw Error('Unexpected Komodo container response');
  return containers.slice(0, 2000).map((c) => ({
    server: server.id,
    serverName: server.name,
    containerId: String(c.id ?? ''),
    name: String(c.name ?? '').slice(0, 256),
    state: String(c.state ?? 'unknown')
      .trim()
      .toLowerCase(),
    ports: uniquePorts(
      (Array.isArray(c.ports) ? c.ports : [])
        .slice(0, 200)
        .map((p) => {
          const hostPort = Number(p.PublicPort ?? p.public_port ?? 0),
            containerPort = Number(p.PrivatePort ?? p.private_port ?? 0),
            bind = String(p.IP ?? p.ip ?? ''),
            protocol = String(p.Type ?? p.typ ?? 'tcp').toLowerCase();
          let targetHost = server.address;
          if (bind && !isIP(bind)) targetHost = '';
          if (isIP(bind) && !['0.0.0.0', '::'].includes(bind))
            targetHost = loopback(canonicalIP(bind))
              ? server.local
                ? canonicalIP(bind)
                : ''
              : canonicalIP(bind);
          const usable = Boolean(hostPort) && safeTarget(targetHost, hostPort);
          return {
            containerPort,
            hostPort,
            bind,
            protocol,
            targetHost,
            usable,
            restricted: protectedPorts.includes(hostPort) || (Boolean(hostPort && targetHost) && !safeTarget(targetHost, hostPort)),
            reason: !hostPort
              ? 'No Docker host-port mapping'
              : !targetHost
                ? loopback(canonicalIP(bind)) && !server.local
                  ? `Bound to ${bind} on the remote server; publish this port on its Tailscale IP`
                  : bind && !isIP(bind)
                    ? 'Docker reported an invalid host binding'
                    : 'No reachable address; set the server External Address in Komodo'
                : !safeTarget(targetHost, hostPort)
                  ? 'Unsafe address or protected management port'
                  : 'Binding available; connection not yet checked',
          };
        })
        .filter(
          (p) =>
            Number.isInteger(p.containerPort) &&
            p.containerPort > 0 &&
            p.containerPort <= 65535 &&
            Number.isInteger(p.hostPort) &&
            p.hostPort >= 0 &&
            p.hostPort <= 65535 &&
            ['tcp', 'udp'].includes(p.protocol),
        ),
    ),
  }));
}
export class Discovery {
  constructor({
    url = readKomodoURL(),
    fetcher = fetch,
    lookup = dnsLookup,
    localAddresses = async () => [],
    key = process.env.PROXY_KOMODO_KEY ?? '',
    secret = process.env.PROXY_KOMODO_SECRET ?? '',
    onUpdate = () => {},
  } = {}) {
    this.url = url;
    this.fetcher = fetcher;
    this.lookup = lookup;
    this.localAddresses = localAddresses;
    this.credentials = [key, secret];
    this.onUpdate = onUpdate;
    this.inventory = [];
    this.servers = [];
    this.lastSuccess = null;
    this.error = null;
    this.version = null;
    this.running = null;
    this.failures = 0;
  }
  async request(type, params = {}) {
    const response = await this.fetcher(this.url + '/read', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.credentials[0],
        'x-api-secret': this.credentials[1],
      },
      body: JSON.stringify({ type, params }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw Error('Komodo request failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8000000) throw Error('Komodo response too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async addresses(value) {
    if (typeof value !== 'string' || !value) return [];
    try {
      const host = isIP(value)
        ? value
        : new URL(value.includes('://') ? value : 'http://' + value).hostname.replace(
            /^\[|\]$/g,
            '',
          );
      const resolved = isIP(host) ? [{ address: host }] : await this.lookup(host, { all: true });
      return [...new Set(resolved.map((item) => canonicalIP(item.address)).filter(safeAddress))];
    } catch {
      return [];
    }
  }
  async refresh() {
    if (this.running) return this.running;
    this.running = this.poll().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async poll() {
    const before = JSON.stringify([this.servers, this.inventory, this.version, this.error, Boolean(this.lastSuccess)]);
    try {
      if (!this.url || this.credentials.some((value) => !value))
        throw Error('Missing Core environment');
      const version = await this.request('GetVersion'),
        v = typeof version === 'string' ? version : version.version;
      if (!/^v?\d+\.\d+\.\d+/.test(v ?? '')) throw Error('Unsupported Core version');
      const [major, minor] = v.replace(/^v/, '').split('.').map(Number),
        method =
          major > 2 || (major === 2 && minor >= 3) ? 'ListContainers' : 'ListDockerContainers';
      const listed = await this.request('ListServers', { limit: 0 });
      if (!Array.isArray(listed) || listed.length > 2000) throw Error('Unexpected server list');
      const local = new Set(
        (await this.localAddresses().catch(() => [])).filter(safeAddress).map(canonicalIP),
      );
      const servers = [],
        inventory = [];
      for (let offset = 0; offset < listed.length; offset += 8) {
        const batch = await Promise.all(
          listed
            .slice(offset, offset + 8)
            .filter((item) => !item.template)
            .map(async (item) => {
              const server = {
                id: String(item.id ?? ''),
                name: String(item.name ?? '').slice(0, 80),
                address: '',
                local: false,
                error: null,
              };
              if (!server.id || server.id.length > 128) throw Error('Invalid server ID');
              const candidates = await this.addresses(item.info?.address);
              const external = await this.addresses(item.info?.external_address);
              const addresses = [...candidates, ...external].filter(
                (address) => !loopback(address),
              );
              server.address =
                addresses.find(
                  (address) =>
                    address.startsWith('100.') &&
                    Number(address.split('.')[1]) >= 64 &&
                    Number(address.split('.')[1]) <= 127,
                ) ||
                addresses[0] ||
                '';
              server.local = local.has(server.address);
              try {
                return {
                  server,
                  services: normalizeContainers(
                    await this.request(method, { server: server.id }),
                    server,
                  ),
                };
              } catch {
                server.error =
                  'Could not read containers. Check server connectivity and Read permission.';
                return {
                  server,
                  services: this.inventory.filter((service) => service.server === server.id),
                };
              }
            }),
        );
        for (const item of batch) {
          servers.push(item.server);
          inventory.push(...item.services);
        }
      }
      this.servers = servers;
      this.inventory = inventory;
      this.version = v;
      this.lastSuccess = new Date().toISOString();
      this.error = null;
      this.failures = 0;
    } catch {
      this.error =
        !this.url || this.credentials.some((value) => !value)
          ? 'Set PROXY_KOMODO_URL, PROXY_KOMODO_KEY and PROXY_KOMODO_SECRET in Komodo stack environment.'
          : 'Discovery unavailable. Check Core connectivity and Read permissions. Last inventory retained.';
      this.failures++;
    }
    if (before !== JSON.stringify([this.servers, this.inventory, this.version, this.error, Boolean(this.lastSuccess)])) this.onUpdate();
  }
  status() {
    return {
      configured: Boolean(this.url) && this.credentials.every(Boolean),
      servers: this.servers,
      services: this.inventory,
      lastSuccess: this.lastSuccess,
      error: this.error,
      version: this.version,
      stale: !this.lastSuccess || Date.now() - Date.parse(this.lastSuccess) > 90000,
    };
  }
  start() {
    let stopped = false,
      timer;
    const tick = async () => {
      await this.refresh();
      if (!stopped) {
        timer = setTimeout(tick, Math.min(300000, 30000 * 2 ** Math.min(this.failures, 3)));
        timer.unref();
      }
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}
