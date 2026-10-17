import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Auth } from './auth.js';
import { Discovery } from './komodo.js';
import {
  Problem,
  parse,
  routeSchema,
  pagesSchema,
  validateSnapshot,
  snapshotHash,
  staticSiteSchema,
  settingsSchema,
  settingsFromPolicy,
  effectivePolicy,
  policyHash,
} from '../shared/model.js';
import { bodyJSON, json, unixRequest } from '../shared/http.js';

export function createApp({
  policy,
  store,
  certificatePolicyStore,
  stateDir,
  bootstrapToken,
  edgeSocket,
  certStatusDir,
  certRequestDir,
  development = false,
  discovery = new Discovery({
    localAddresses: async () => (await edgeRequest(edgeSocket, '/network')).addresses,
  }),
  edgeRequest = unixRequest,
  distDir = resolve('dist'),
}) {
  const deployment = { origin: policy.origin, ingressIPs: policy.ingressIPs };
  if (!store.get('settings')) store.set('settings', settingsFromPolicy(policy));
  const auth = new Auth(store, { origin: policy.origin, bootstrapToken, development });
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const edge = (path, options) => edgeRequest(edgeSocket, path, options);
  async function apply(next, nextPolicy = policy) {
    next = validateSnapshot(nextPolicy, next);
    const old = store.snapshot(),
      oldPolicy = policy;
    let result;
    try {
      result = await edge('/apply', {
        method: 'POST',
        body: { ...next, settings: settingsFromPolicy(nextPolicy) },
        timeout: 35000,
      });
    } catch (error) {
      // A lost reply can follow a successful reload; reconcile by content, not a signal.
      if (error.status === 503) {
        try {
          const status = await edge('/status', { timeout: 1500 });
          if (
            status.available &&
            status.hash === snapshotHash(next) &&
            status.policyHash === policyHash(nextPolicy)
          )
            result = status;
        } catch {}
      }
      if (!result) {
        throw error;
      }
    }
    try {
      store.transaction(() => {
        store.set('snapshot', next);
        store.set('applied', result);
        store.set('settings', settingsFromPolicy(nextPolicy));
        certificatePolicyStore?.set('policy', {
          domains: nextPolicy.domains,
          certificates: nextPolicy.certificates,
        });
      });
    } catch {
      try {
        certificatePolicyStore?.set('policy', {
          domains: oldPolicy.domains,
          certificates: oldPolicy.certificates,
        });
        await edge('/apply', {
          method: 'POST',
          body: { ...old, settings: settingsFromPolicy(oldPolicy) },
          timeout: 35000,
        });
      } catch {
        throw new Problem(
          503,
          'State persistence and edge rollback failed. Check the edge before making changes.',
        );
      }
      throw new Problem(503, 'Could not persist change; previous configuration restored');
    }
    policy = nextPolicy;
    return result;
  }
  async function certStatus() {
    return Promise.all(
      policy.domains.map(async (d) => {
        let status = {};
        try {
          status = JSON.parse(await readFile(join(certStatusDir, `${d.name}.json`), 'utf8'));
        } catch {}
        return {
          name: d.name,
          staging: policy.certificates.staging,
          ready:
            Boolean(status.ready) &&
            status.staging === policy.certificates.staging &&
            Date.parse(status.expires) > Date.now(),
          expires: status.expires ?? null,
          lastCheck: status.lastCheck ?? null,
          error: status.error ?? null,
          fingerprint: status.fingerprint ?? null,
        };
      }),
    );
  }
  const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!development) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        json(res, { ok: true });
        return;
      }
      if (req.headers.host !== new URL(policy.origin).host)
        throw new Problem(403, 'Unrecognized management host');
      const url = new URL(req.url, policy.origin),
        path = url.pathname;
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
        throw new Problem(405, 'Method not allowed');
      const mutation = req.method !== 'GET';
      if (mutation && req.headers.origin !== policy.origin)
        throw new Problem(403, 'Unrecognized request origin');
      if (path.startsWith('/api/auth/')) {
        json(res, await auth.handle(path, req, res, mutation ? await bodyJSON(req) : {}));
        return;
      }
      if (path.startsWith('/api/')) {
        auth.require(req, mutation);
        if (path === '/api/state' && req.method === 'GET') {
          let edgeStatus;
          try {
            edgeStatus = await edge('/status', { timeout: 1500 });
          } catch {
            edgeStatus = { available: false };
          }
          edgeStatus.inSync =
            edgeStatus.available === true &&
            edgeStatus.hash === snapshotHash(store.snapshot()) &&
            edgeStatus.policyHash === policyHash(policy);
          json(res, {
            ...store.snapshot(),
            settings: settingsFromPolicy(policy),

            discovery: discovery.status(),
            domains: await certStatus(),
            edge: edgeStatus,
            policy: {
              origin: policy.origin,
              ingressIPs: policy.ingressIPs,
            },
            development,
          });
          return;
        }
        if (path === '/api/settings' && req.method === 'PUT') {
          const settings = parse(settingsSchema, await bodyJSON(req));
          json(
            res,
            await serial(async () => {
              const nextPolicy = effectivePolicy(deployment, settings, { development });
              await apply(store.snapshot(), nextPolicy);
              return settingsFromPolicy(policy);
            }),
          );
          return;
        }
        if (path === '/api/discovery/refresh' && req.method === 'POST') {
          await bodyJSON(req);
          await discovery.refresh();
          json(res, discovery.status());
          return;
        }
        if (path === '/api/sites' && req.method === 'GET') {
          json(res, { ...(await edge('/sites')), sites: store.snapshot().sites });
          return;
        }
        if (path === '/api/sites/config' && req.method === 'PUT') {
          const spec = parse(staticSiteSchema, await bodyJSON(req));
          const result = await serial(async () => {
            const inspection = await edge('/sites/inspect', { method: 'POST', body: spec });
            if (!inspection.exposed.includes('index.html'))
              throw new Problem(400, 'index.html must be exposed');
            const old = store.snapshot();
            const next = validateSnapshot(policy, {
              ...old,
              sites: [...old.sites.filter((site) => site.directory !== spec.directory), spec],
            });
            if (snapshotHash(next) !== snapshotHash(old)) await apply(next);
            else store.set('snapshot', next);
            return spec;
          });
          json(res, result);
          return;
        }
        if (path === '/api/sites/inspect' && req.method === 'POST') {
          const spec = parse(staticSiteSchema, await bodyJSON(req));
          json(res, await edge('/sites/inspect', { method: 'POST', body: spec }));
          return;
        }
        if (path === '/api/export' && req.method === 'GET') {
          res.setHeader('content-disposition', 'attachment; filename="proxy-configuration.json"');
          json(res, { version: 2, ...store.snapshot(), settings: settingsFromPolicy(policy) });
          return;
        }
        if (path === '/api/routes' && req.method === 'POST') {
          const input = await bodyJSON(req);
          const route = parse(routeSchema, { ...input, id: randomUUID(), published: false });
          await serial(() => {
            const next = validateSnapshot(policy, {
              ...store.snapshot(),
              routes: [...store.snapshot().routes, route],
            });
            store.transaction(() => {
              store.set('snapshot', next);
            });
          });
          json(res, route);
          return;
        }
        const match = path.match(
          /^\/api\/routes\/([0-9a-f-]{36})(?:\/(publish|disable|probe|sync))?$/,
        );
        if (match) {
          const [, id, operation] = match,
            input = mutation ? await bodyJSON(req) : {};
          const result = await serial(async () => {
            const snapshot = store.snapshot(),
              route = snapshot.routes.find((r) => r.id === id);
            if (!route) throw new Problem(404, 'Route not found');
            if (operation === 'probe' && req.method === 'POST') {
              if (route.kind === 'static')
                return edge('/sites/inspect', { method: 'POST', body: route.staticSite });
              if (route.kind === 'udp')
                return { reachable: null, message: 'UDP needs a protocol-specific external check' };
              return edge('/probe', {
                method: 'POST',
                body: { host: route.targetHost, port: route.targetPort },
                timeout: 5000,
              });
            }
            if (operation === 'sync' && req.method === 'POST') {
              if (route.kind !== 'static' || !route.published)
                throw new Problem(400, 'Publish a static site before syncing');
              return apply(snapshot);
            }
            if ((operation === 'publish' || operation === 'disable') && req.method === 'POST') {
              const next = {
                ...snapshot,
                routes: snapshot.routes.map((r) =>
                  r.id === id ? { ...r, published: operation === 'publish' } : r,
                ),
              };
              return apply(next);
            }
            if (!operation && req.method === 'PUT') {
              const replacement = parse(routeSchema, { ...input, id, published: route.published });
              const next = validateSnapshot(policy, {
                ...snapshot,
                routes: snapshot.routes.map((r) => (r.id === id ? replacement : r)),
              });
              if (route.published) {
                await apply(next);
                return replacement;
              }
              store.transaction(() => {
                store.set('snapshot', next);
              });
              return replacement;
            }
            if (!operation && req.method === 'DELETE') {
              if (route.published) throw new Problem(409, 'Disable this route before deleting it');
              store.transaction(() => {
                store.set('snapshot', {
                  ...snapshot,
                  routes: snapshot.routes.filter((r) => r.id !== id),
                });
              });
              return { ok: true };
            }
            throw new Problem(405, 'Method not allowed');
          });
          json(res, result);
          return;
        }
        if (path === '/api/pages' && req.method === 'PUT') {
          const pages = parse(pagesSchema, await bodyJSON(req));
          json(res, await serial(() => apply({ ...store.snapshot(), pages })));
          return;
        }
        if (path === '/api/reconcile' && req.method === 'POST') {
          await bodyJSON(req);
          json(res, await serial(() => apply(store.snapshot())));
          return;
        }
        if (path === '/api/certificates/retry' && req.method === 'POST') {
          const input = await bodyJSON(req),
            domain = policy.domains.find((d) => d.name === input.domain);
          if (!domain) throw new Problem(400, 'Domain is not configured');
          await mkdir(certRequestDir, { recursive: true });
          const file = join(certRequestDir, `${domain.name}.json`),
            temp = `${file}.${randomUUID()}.tmp`;
          await writeFile(temp, JSON.stringify({ requested: new Date().toISOString() }), {
            mode: 0o660,
          });
          await rename(temp, file);
          json(res, { ok: true });
          return;
        }
        throw new Problem(404, 'Not found');
      }
      if (req.method !== 'GET') throw new Problem(405, 'Method not allowed');
      const decoded = decodeURIComponent(path);
      if (decoded.includes('\0') || decoded.includes('\\')) throw new Problem(400, 'Invalid path');
      const file = resolve(distDir, `.${decoded}`);
      if (file !== distDir && !file.startsWith(`${distDir}${sep}`))
        throw new Problem(403, 'Invalid path');
      const isAsset = decoded.startsWith('/assets/'),
        destination = isAsset ? file : join(distDir, 'index.html');
      let bytes;
      try {
        bytes = await readFile(destination);
      } catch {
        throw new Problem(404, 'Build the interface with npm run build first');
      }
      res.writeHead(200, {
        'content-type':
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.html': 'text/html; charset=utf-8',
          }[extname(destination)] ?? 'application/octet-stream',
        'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      res.end(bytes);
    } catch (e) {
      if (!res.headersSent)
        json(
          res,
          {
            error:
              e instanceof Problem ? e.message : 'Request failed. Check the service configuration.',
          },
          e instanceof Problem ? e.status : 500,
        );
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  return { server, auth, discovery, apply };
}
