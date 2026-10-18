import { errorPageTypes } from '../shared/pages.js';
import { samePorts } from '../shared/ports.js';
import http from 'node:http';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
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
  siteDirectory,
  settingsSchema,
  settingsFromPolicy,
  effectivePolicy,
  policyHash,
  domainSchema,
  routeFields,
  redirectURL,
  safeTarget,
  safeAddress,
  defaultPages,
  errorPageSchema,
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
  filesRequest = unixRequest,
  filesSocket = '/files-ipc/files.sock',
  distDir = resolve('dist'),
}) {
  const deployment = { origin: policy.origin, ingressIPs: policy.ingressIPs };
  if (!store.get('settings')) store.set('settings', settingsFromPolicy(policy));
  const auth = new Auth(store, { origin: policy.origin, bootstrapToken, development });
  const publicAuth = new Map();
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const edge = (path, options) => edgeRequest(edgeSocket, path, options);
  function configuredFolders() {
    const snapshot = store.snapshot();
    const folders = new Map(snapshot.sites.map((site) => [site.directory, site]));
    for (const site of [...snapshot.routes.map((route) => route.staticSite), ...errorPageTypes.map(([, key]) => snapshot.pages[key + 'Site'])])
      if (site && !folders.has(site.directory)) folders.set(site.directory, site);
    return [...folders.values()];
  }
  function domainPolicy(input, previous) {
    if (previous && !policy.domains.some((d) => d.name === previous))
      throw new Problem(404, 'Domain not found');
    const domains = [...policy.domains.filter((d) => d.name !== previous), ...(input ? [input] : [])];
    const nextPolicy = effectivePolicy(deployment, { ...settingsFromPolicy(policy), domains }, { development });
    validateSnapshot(nextPolicy, store.snapshot());
    return nextPolicy;
  }
  function folderSnapshot(spec, previous) {
    const old = store.snapshot();
    if (previous !== spec.directory && old.sites.some((site) => site.directory === spec.directory))
      throw new Problem(409, 'That folder is already configured');
    const update = (site) => site?.directory === previous ? spec : site;
    return validateSnapshot(policy, {
      ...old,
      routes: old.routes.map((route) => ({ ...route, staticSite: update(route.staticSite) })),
      pages: { ...old.pages, ...Object.fromEntries(errorPageTypes.map(([, key]) => [key + 'Site', update(old.pages[key + 'Site'])])) },
      sites: [...old.sites.filter((site) => site.directory !== previous), spec],
    });
  }
  function pageSnapshot(code, value) {
    const spec = parse(errorPageSchema, value), old = store.snapshot();
    const [, key] = errorPageTypes.find(([value]) => value === code);
    const siteKey = key + 'Site', documentKey = key + 'Document';
    const next = validateSnapshot(policy, { ...old, pages: {
      ...old.pages, [siteKey]: spec.site, [documentKey]: spec.document,
    } });
    return { next, selection: { ...defaultPages,
      [siteKey]: next.pages[siteKey], [documentKey]: next.pages[documentKey],
    } };
  }
  const checkPages = (pages) => edge('/pages/validate', { method: 'POST', body: pages });
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
          subdomains: d.subdomains,
          staging: policy.certificates.staging,
          ready:
            Boolean(status.ready) &&
            status.staging === policy.certificates.staging &&
            (status.subdomains ?? true) === d.subdomains &&
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
    const styleNonce = randomBytes(18).toString('base64');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader(
      'content-security-policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (!development) res.setHeader('strict-transport-security', 'max-age=31536000');
    try {
      if (req.url === '/healthz' && req.method === 'GET') {
        json(res, { ok: true });
        return;
      }
      const origin = req.headers.host === new URL(policy.origin).host ? policy.origin
        : policy.adminHostname && req.headers.host === policy.adminHostname ? `https://${policy.adminHostname}` : null;
      if (!origin)
        throw new Problem(403, 'Unrecognized management host');
      let requestAuth = auth;
      if (origin !== policy.origin) {
        if (!publicAuth.has(origin)) publicAuth.set(origin, new Auth(store, {
          origin, bootstrapToken, development, legacyRPID: new URL(policy.origin).hostname,
        }));
        requestAuth = publicAuth.get(origin);
      }
      const url = new URL(req.url, origin),
        path = url.pathname;
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
        throw new Problem(405, 'Method not allowed');
      const mutation = req.method !== 'GET';
      if (mutation && req.headers.origin !== origin)
        throw new Problem(403, 'Unrecognized request origin');
      if (path.startsWith('/api/auth/')) {
        json(res, await requestAuth.handle(path, req, res, mutation ? await bodyJSON(req) : {}));
        return;
      }
      if (path.startsWith('/api/')) {
        requestAuth.require(req, mutation);
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
        if (path === '/api/preferences' && req.method === 'PUT') {
          const raw = await bodyJSON(req);
          const parsed = parse(settingsSchema.omit({ domains: true }).partial(), raw);
          // Partial Zod objects still apply defaults; update only explicitly submitted fields.
          const input = Object.fromEntries(Object.keys(raw).map((key) => [key, parsed[key]]));
          json(res, await serial(async () => {
            await apply(store.snapshot(), effectivePolicy(deployment, {
              ...settingsFromPolicy(policy), ...input,
            }, { development }));
            return settingsFromPolicy(policy);
          }));
          return;
        }
        if (path === '/api/validate' && req.method === 'POST') {
          const input = await bodyJSON(req), value = input?.value;
          if (input?.kind === 'domain') domainPolicy(parse(domainSchema, value), input.previous);
          else if (input?.kind === 'folder') {
            const spec = parse(staticSiteSchema, value);
            const previous = input.previousDirectory === undefined ? spec.directory : parse(siteDirectory, input.previousDirectory);
            const next = folderSnapshot(spec, previous);
            await edge('/sites/inspect', { method: 'POST', body: spec });
            const affected = { ...defaultPages };
            for (const [key, documentKey] of errorPageTypes.map(([, key]) => [key + 'Site', key + 'Document']))
              if (next.pages[key]?.directory === spec.directory) {
                affected[key] = next.pages[key]; affected[documentKey] = next.pages[documentKey];
              }
            if (errorPageTypes.some(([, key]) => affected[key + 'Site'])) await checkPages(affected);
          } else if (input?.kind === 'page' && errorPageTypes.some(([code]) => code === input.code)) {
            await checkPages(pageSnapshot(input.code, value).selection);
          } else if (input?.kind === 'route' && [0, 1, 2].includes(input.step)) {
            const base = parse(routeFields.pick({ name: true, kind: true }).strip(), value);
            if (input.step === 1) {
              if (base.kind === 'static') {
                const spec = parse(staticSiteSchema, value.staticSite);
                await edge('/sites/inspect', { method: 'POST', body: spec });
              } else if (base.kind === 'redirect') {
                parse(redirectURL, value.redirectURL);
              } else {
                const endpoint = parse(routeFields.pick({ targetHost: true, targetPort: true, upstreamTLS: true, upstreamServerName: true, source: true }).strip(), value);
                if (samePorts(value) ? !safeAddress(endpoint.targetHost) : !safeTarget(endpoint.targetHost, endpoint.targetPort))
                  throw new Problem(400, 'Choose a safe destination IP and host port');
                if (endpoint.upstreamTLS && !endpoint.upstreamServerName)
                  throw new Problem(400, 'HTTPS backend requires its certificate hostname');
              }
            } else if (input.step === 2) {
              const route = parse(routeSchema, { ...value, id: value.id ?? randomUUID(), published: true });
              const old = store.snapshot();
              validateSnapshot(policy, { ...old, routes: [...old.routes.filter((r) => r.id !== route.id), route] });
            }
          } else throw new Problem(400, 'Unknown validation step');
          json(res, { ok: true });
          return;
        }
        const singlePage = path.match(/^\/api\/pages\/(404|500|502)$/);
        if (singlePage && req.method === 'PUT') {
          const input = await bodyJSON(req);
          json(res, await serial(async () => {
            const { next, selection } = pageSnapshot(Number(singlePage[1]), input);
            await checkPages(selection);
            return apply(next);
          }));
          return;
        }
        const domainMatch = path.match(/^\/api\/domains(?:\/([^/]+))?$/);
        if (domainMatch && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
          const previous = domainMatch[1] ? decodeURIComponent(domainMatch[1]) : null;
          const input = req.method === 'DELETE' ? null : parse(domainSchema, await bodyJSON(req));
          if (req.method === 'DELETE') await bodyJSON(req);
          if ((req.method === 'POST') !== !previous) throw new Problem(405, 'Method not allowed');
          json(res, await serial(async () => {
            await apply(store.snapshot(), domainPolicy(input, previous));
            return input ?? { ok: true };
          }));
          return;
        }
        if (path === '/api/discovery/refresh' && req.method === 'POST') {
          await bodyJSON(req);
          await discovery.refresh();
          json(res, discovery.status());
          return;
        }
        if (path === '/api/sites' && req.method === 'GET') {
          const folders = configuredFolders();
          let repositories = [], gitAvailable = false;
          try {
            repositories = await filesRequest(filesSocket, '/repositories', { method: 'POST', body: { directories: folders.map((folder) => folder.directory) }, timeout: 3000, service: 'Files updater' });
            gitAvailable = true;
          } catch {}
          json(res, { folders, repositories, gitAvailable });
          return;
        }
        if (path === '/api/sites/pull' && req.method === 'POST') {
          const directory = parse(siteDirectory, (await bodyJSON(req)).directory);
          const result = await serial(async () => {
            if (!configuredFolders().some((folder) => folder.directory === directory))
              throw new Problem(404, 'Folder not configured');
            const result = await filesRequest(filesSocket, '/pull', { method: 'POST', body: { directory }, timeout: 130000, service: 'Files updater' });
            try { await apply(store.snapshot()); }
            catch { throw new Problem(502, 'Git pull completed, but proxy file synchronization failed. Reapply the configuration before retrying.'); }
            return result;
          });
          json(res, result);
          return;
        }
        if (path === '/api/sites/config' && req.method === 'PUT') {
          const { previousDirectory, ...raw } = (await bodyJSON(req)) ?? {},
            spec = parse(staticSiteSchema, raw);
          const previous =
            previousDirectory === undefined
              ? spec.directory
              : parse(siteDirectory, previousDirectory);
          const result = await serial(async () => {
            await edge('/sites/inspect', { method: 'POST', body: spec });
            const old = store.snapshot();
            const next = folderSnapshot(spec, previous);
            if (snapshotHash(next) !== snapshotHash(old)) await apply(next);
            else store.set('snapshot', next);
            return spec;
          });
          json(res, result);
          return;
        }
        if (path === '/api/sites/config' && req.method === 'DELETE') {
          const directory = parse(siteDirectory, (await bodyJSON(req))?.directory);
          await serial(() => {
            const old = store.snapshot();
            if (
              old.routes.some((route) => route.staticSite?.directory === directory) ||
              errorPageTypes.map(([, key]) => old.pages[key + 'Site']).some(
                (site) => site?.directory === directory,
              )
            )
              throw new Problem(409, 'Folder is still used by a route or error page');
            if (!old.sites.some((site) => site.directory === directory))
              throw new Problem(404, 'Folder not found');
            store.set('snapshot', {
              ...old,
              sites: old.sites.filter((site) => site.directory !== directory),
            });
          });
          json(res, { ok: true });
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
              if (route.kind === 'redirect')
                return { reachable: null, message: 'Redirects do not use an upstream connection' };
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
              const next = {
                ...snapshot,
                routes: snapshot.routes.filter((r) => r.id !== id),
              };
              if (route.published) await apply(next);
              else store.transaction(() => {
                store.set('snapshot', next);
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
        isAppFile = ['/favicon.svg', '/manifest.webmanifest', '/icons/proxy-180.png',
          '/icons/proxy-192.png', '/icons/proxy-512.png', '/icons/proxy-maskable-512.png'].includes(decoded),
        isDocument = !isAsset && !isAppFile,
        destination = isDocument ? join(distDir, 'index.html') : file;
      let bytes;
      try {
        bytes = await readFile(destination);
        if (isDocument) bytes = Buffer.from(bytes.toString('utf8').replaceAll('__PROXY_STYLE_NONCE__', styleNonce));
      } catch {
        throw new Problem(404, 'Build the interface with npm run build first');
      }
      res.writeHead(200, {
        'content-type':
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.webmanifest': 'application/manifest+json',
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
