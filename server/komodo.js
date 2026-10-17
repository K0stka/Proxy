import { isIP } from 'node:net';
import { allowedTarget, Problem } from '../shared/model.js';

export function normalizeContainers(containers, server, policy) {
  if (!Array.isArray(containers)) throw new Error('Unexpected Komodo container response');
  return containers.slice(0, 2000).map((c) => ({
    server: server.id,
    serverName: server.name,
    containerId: String(c.id ?? ''),
    name: String(c.name ?? '').slice(0, 256),
    state: String(c.state ?? 'unknown'),
    ports: (Array.isArray(c.ports) ? c.ports : [])
      .slice(0, 200)
      .map((p) => {
        const hostPort = Number(p.PublicPort ?? p.public_port ?? 0),
          containerPort = Number(p.PrivatePort ?? p.private_port ?? 0);
        const bind = p.IP ?? p.ip ?? '',
          protocol = p.Type ?? p.typ ?? 'tcp';
        const loopback = bind === '127.0.0.1' || bind === '::1';
        const reachableBinding =
          Boolean(hostPort) &&
          (bind === '' ||
            bind === '0.0.0.0' ||
            bind === '::' ||
            bind === server.address ||
            (server.local && loopback));
        const targetHost = server.local && loopback ? bind : server.address;
        return {
          containerPort,
          hostPort,
          bind,
          protocol,
          targetHost,
          usable:
            reachableBinding &&
            isIP(targetHost) !== 0 &&
            allowedTarget(policy, targetHost, hostPort),
          reason: !hostPort
            ? 'Not published on host'
            : !reachableBinding
              ? 'Bind address is not reachable from VPS'
              : !allowedTarget(policy, targetHost, hostPort)
                ? 'Destination not approved in host policy'
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
  }));
}
export class Discovery {
  constructor(
    policy,
    {
      fetcher = fetch,
      key = process.env.PROXY_KOMODO_KEY ?? '',
      secret = process.env.PROXY_KOMODO_SECRET ?? '',
    } = {},
  ) {
    this.policy = policy;
    this.fetcher = fetcher;
    this.credentials = [key, secret];
    this.inventory = [];
    this.lastSuccess = null;
    this.error = null;
    this.version = null;
    this.running = null;
    this.failures = 0;
    this.generation = 0;
  }
  configure(policy) {
    this.policy = policy;
    this.generation++;
    this.inventory = [];
    this.lastSuccess = null;
    this.error = null;
    this.version = null;
    this.failures = 0;
  }
  async listServers(policy = this.policy) {
    if (!policy.komodo.url || this.credentials.some((value) => !value))
      throw new Problem(400, 'Set the Core URL and Komodo environment credentials');
    try {
      const result = await this.request('ListServers', {}, this.credentials, policy);
      if (!Array.isArray(result)) throw Error();
      return result
        .slice(0, 2000)
        .map((server) => ({
          id: String(server.id ?? ''),
          name: String(server.name ?? '').slice(0, 80),
        }))
        .filter((server) => server.id && server.id.length <= 128);
    } catch {
      throw new Problem(
        502,
        'Could not load servers. Check the Core URL, credentials and read permissions.',
      );
    }
  }
  async request(type, params, credentials, policy = this.policy) {
    const response = await this.fetcher(`${policy.komodo.url.replace(/\/$/, '')}/read`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': credentials[0],
        'x-api-secret': credentials[1],
      },
      body: JSON.stringify({ type, params }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Komodo returned HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8_000_000) throw new Error('Komodo response too large');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async refresh() {
    if (this.running) return this.running;
    const policy = this.policy,
      generation = this.generation;
    this.running = (async () => {
      await Promise.resolve();
      try {
        if (!policy.komodo.url) {
          this.error = 'Configure Komodo in Settings.';
          return;
        }
        const credentials = this.credentials;
        if (credentials.some((v) => !v)) throw new Error('Komodo credentials are empty');
        const version = await this.request('GetVersion', {}, credentials, policy);
        const v = typeof version === 'string' ? version : version.version;
        if (!/^v?\d+\.\d+\.\d+/.test(v ?? ''))
          throw new Error('Unsupported Komodo version response');
        const [major, minor] = v.replace(/^v/, '').split('.').map(Number);
        const method =
          major > 2 || (major === 2 && minor >= 3) ? 'ListContainers' : 'ListDockerContainers';
        const results = await Promise.all(
          policy.komodo.servers.map(async (server) =>
            normalizeContainers(
              await this.request(method, { server: server.id }, credentials, policy),
              server,
              policy,
            ),
          ),
        );
        if (generation !== this.generation) return;
        this.inventory = results.flat();
        this.lastSuccess = new Date().toISOString();
        this.version = v;
        this.error = null;
        this.failures = 0;
      } catch {
        if (generation !== this.generation) return;
        this.error =
          'Discovery unavailable. Check Core URL, version, read permissions and environment credentials. Last inventory retained.';
        this.failures++;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
  status() {
    return {
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
