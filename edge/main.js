import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  readFile,
  writeFile,
  mkdir,
  symlink,
  rename,
  unlink,
  chmod,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, X509Certificate, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  validateSnapshot,
  safeTarget,
  defaultPages,
  Problem,
  defaultSettings,
  effectivePolicy,
  settingsFromPolicy,
  policyHash,
  parse,
  pagesSchema,
} from '../shared/model.js';
import { bodyJSON, json } from '../shared/http.js';
import { render } from './render.js';
import { inspectSite, prepareSites } from './sites.js';
import { readDeployment } from '../shared/env.js';
import { Store } from '../shared/store.js';

process.umask(0o007);
const run = promisify(execFile),
  deployment = readDeployment();
let policy = effectivePolicy(deployment, defaultSettings);
const runtime = process.env.PROXY_EDGE_STATE ?? '/runtime',
  socket = process.env.PROXY_EDGE_SOCKET ?? '/ipc/edge.sock';
await mkdir(runtime, { recursive: true });
const state = new Store(join(runtime, 'edge.db'));
let child,
  applied = null,
  snapshot = { routes: [], pages: defaultPages },
  tail = Promise.resolve(),
  certFingerprint = '',
  activeContent = null,
  failed = null,
  shuttingDown = false;
const serial = (fn) => {
  const next = tail.then(fn);
  tail = next.catch(() => {});
  return next;
};
async function certificates(currentPolicy = policy) {
  const ready = [], wildcard = [],
    prints = [];
  for (const d of currentPolicy.domains) {
    try {
      const pem = await readFile(`/tls/live/${d.name}/fullchain.pem`),
        cert = new X509Certificate(pem),
        meta = JSON.parse(await readFile(`/tls/live/${d.name}/meta.json`, 'utf8'));
      if (
        meta.staging !== currentPolicy.certificates.staging ||
        Date.parse(cert.validTo) <= Date.now() ||
        Date.parse(cert.validFrom) > Date.now() ||
        !cert.checkHost(d.name)
      )
        continue;
      ready.push(d.name);
      if (cert.checkHost(`proxy-check.${d.name}`)) wildcard.push(d.name);
      prints.push(createHash('sha256').update(pem).digest('hex'));
    } catch {}
  }
  return { ready, wildcard, fingerprint: prints.join(':') };
}
function probeRevision() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/tmp/proxy-health.sock', path: '/revision', timeout: 400 },
      (res) => {
        let text = '';
        res.on('data', (b) => (text += b));
        res.on('end', () => resolve(text));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', reject);
  });
}
async function verifyRevision(revision) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await probeRevision()) === revision) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Problem(502, 'NGINX did not activate the new configuration');
}
async function switchTo(revision) {
  const temp = join(runtime, `link-${randomUUID()}`);
  await symlink(join(runtime, revision), temp);
  await rename(temp, join(runtime, 'active'));
}
async function cleanup() {
  const keep = new Set([applied?.revision, applied?.previous]);
  for (const name of await readdir(runtime))
    if (
      /^rev-[0-9a-f-]{36}$/.test(name) &&
      !keep.has(name) &&
      Date.now() - (await stat(join(runtime, name))).mtimeMs > 3605000
    )
      await rm(join(runtime, name), { recursive: true, force: true });
}
async function apply(raw, { initial = false, refreshContent = true, persist = true } = {}) {
  if (shuttingDown) throw new Problem(503, 'Edge is shutting down');
  const { settings = settingsFromPolicy(policy), expectedHash, expectedPolicyHash, ...rawSnapshot } = raw;
  const nextPolicy = effectivePolicy(deployment, settings);
  const next = validateSnapshot(nextPolicy, rawSnapshot),
    certs = await certificates(nextPolicy),
    revision = `rev-${randomUUID()}`,
    directory = join(runtime, revision),
    previous = applied?.revision;
  if (
    nextPolicy.certificates.staging &&
    next.routes.some(
      (r) => r.published && (r.kind === 'http' || r.kind === 'static' || r.kind === 'redirect' || r.streamTLS),
    )
  )
    throw new Problem(
      409,
      'Switch ACME staging off and issue production certificates before publishing TLS routes',
    );
  const content = !refreshContent && activeContent ? activeContent : await prepareSites(next);
  const output = render(nextPolicy, next, {
    revision,
    directory,
    readyDomains: certs.ready,
    wildcardDomains: certs.wildcard,
    staticSites: content.sites,
    errorSites: content.errors,
    bindIP: process.env.PROXY_EDGE_BIND_IP,
  });
  await mkdir(directory, { mode: 0o750 });
  await writeFile(join(directory, 'nginx.conf'), output.config, { mode: 0o640 });
  for (const [name, value] of Object.entries(output.pages))
    await writeFile(join(directory, name), value, { mode: 0o640 });
  try {
    await run('nginx', ['-e', 'stderr', '-t', '-c', join(directory, 'nginx.conf')], {
      timeout: 10000,
      maxBuffer: 65536,
    });
  } catch (error) {
    console.error('NGINX preflight failed:', String(error.stderr ?? 'unavailable').slice(0, 4096));
    await rm(directory, { recursive: true, force: true });
    throw new Problem(
      502,
      'NGINX rejected the candidate configuration. Previous configuration retained.',
    );
  }
  try {
    await switchTo(revision);
    if (initial) {
      child = spawn(
        'nginx',
        ['-e', 'stderr', '-c', join(runtime, 'active/nginx.conf'), '-g', 'daemon off;'],
        { stdio: 'inherit' },
      );
      child.on('error', () => process.exit(1));
      child.on('exit', () => process.exit(shuttingDown ? 0 : 1));
    } else if (!child.kill('SIGHUP')) throw new Error('NGINX is not running');
    await verifyRevision(revision);
    const result = {
      available: true,
      revision,
      previous,
      hash: output.hash,
      policyHash: policyHash(nextPolicy),
      routes: next.routes.filter((r) => r.published).map((r) => r.id),
      readyDomains: certs.ready,
      wildcardDomains: certs.wildcard,
      appliedAt: new Date().toISOString(),
      staticFiles: Object.fromEntries(
        Object.entries(content.sites).map(([id, site]) => [id, site.count]),
      ),
    };
    if (persist)
      state.set('last-good', {
        snapshot: next,
        settings: settingsFromPolicy(nextPolicy),
        applied: result,
      });
    policy = nextPolicy;
    snapshot = next;
    activeContent = content;
    applied = result;
    certFingerprint = certs.fingerprint;
    failed = null;
    // Retain files for workers draining long-lived connections after a reload.
    setTimeout(() => cleanup().catch(() => {}), 3605000).unref();
    return result;
  } catch {
    if (previous) {
      await switchTo(previous);
      child.kill('SIGHUP');
      try {
        await verifyRevision(previous);
      } catch {
        failed = 'Rollback activation failed; operator attention required';
        throw new Problem(503, failed);
      }
    }
    throw new Problem(502, 'Edge activation failed. Previous configuration restored.');
  }
}
const saved = state.get('last-good');
let recovery = false;
if (saved) {
  try {
    policy = effectivePolicy(
      deployment,
      saved.settings ? settingsFromPolicy(saved.settings) : defaultSettings,
    );
    snapshot = validateSnapshot(policy, saved.snapshot);
  } catch {
    recovery = true;
    snapshot = { routes: [], pages: defaultPages };
    policy = effectivePolicy(deployment, defaultSettings);
  }
}
await apply(
  { ...snapshot, settings: settingsFromPolicy(policy) },
  { initial: true, persist: !recovery },
);
if (recovery)
  failed = 'Saved routes need updating. Check Domains and deployment environment, then retry.';
try {
  await unlink(socket);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
  try {
    if (req.url === '/status' && req.method === 'GET') {
      json(res, { ...applied, error: failed });
      return;
    }
    if (req.url === '/certificates/changed' && req.method === 'GET') {
      json(res, { changed: (await certificates()).fingerprint !== certFingerprint });
      return;
    }
    if (req.url === '/probe' && req.method === 'POST') {
      const { host, port } = await bodyJSON(req);
      if (!safeTarget(host, port))
        throw new Problem(400, 'Unsafe destination address or protected management port');
      const reachable = await new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: 3000 });
        const finish = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
        socket.once('timeout', () => finish(false));
      });
      json(res, {
        reachable,
        message: reachable
          ? 'Backend TCP connection succeeded; public ingress is not verified'
          : 'Backend TCP connection failed',
      });
      return;
    }
    if (req.url === '/network' && req.method === 'GET') {
      json(res, {
        addresses: Object.values(networkInterfaces())
          .flat()
          .filter(Boolean)
          .map((item) => item.address),
      });
      return;
    }
    if (req.url === '/pages/validate' && req.method === 'POST') {
      const pages = parse(pagesSchema, await bodyJSON(req));
      await prepareSites({ routes: [], pages });
      json(res, { ok: true });
      return;
    }
    if (req.url === '/sites/inspect' && req.method === 'POST') {
      json(res, await inspectSite(await bodyJSON(req)));
      return;
    }
    if (req.url === '/apply' && req.method === 'POST') {
      const body = await bodyJSON(req, 1_000_000);
      json(res, await serial(() => apply(body)));
      return;
    }
    throw new Problem(404, 'Not found');
  } catch (e) {
    json(
      res,
      { error: e instanceof Problem ? e.message : 'Edge operation failed' },
      e instanceof Problem ? e.status : 500,
    );
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.listen(socket, async () => {
  await chmod(socket, 0o660);
  console.log('Edge control socket ready');
});
const certTimer = setInterval(
  () =>
    serial(async () => {
      if (process.env.PROXY_EDGE_MANAGED === 'true') return;
      const certs = await certificates();
      if (certs.fingerprint !== certFingerprint) await apply(snapshot, { refreshContent: false });
    }).catch(() => {
      failed = 'Certificate reload failed; current workers retained';
    }),
  30000,
);
certTimer.unref();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    shuttingDown = true;
    clearInterval(certTimer);
    server.close();
    child.kill('SIGQUIT');
    setTimeout(() => process.exit(0), 31000).unref();
  });
