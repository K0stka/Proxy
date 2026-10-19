// Synthetic routing only; Discord sends through a real user-configured webhook.
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { LogStore, logQuery } from '../shared/log-store.js';
import { Monitor } from '../shared/monitor.js';
import { defaultPages, effectivePolicy, defaultSettings, routeSchema, snapshotHash, policyHash, settingsFromPolicy } from '../shared/model.js';

if (process.env.PROXY_CONTROL_GENERATION || process.env.PROXY_EDGE_MANAGED)
  throw new Error('The mock preview cannot run in a managed deployment.');
const port = Number(process.env.PROXY_PREVIEW_PORT ?? 4180);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const origin = `http://127.0.0.1:${port}`, directory = resolve('.local/preview');
await mkdir(directory, { recursive: true });
const dist = join(directory, 'ui');
await cp(resolve('dist'), dist, { recursive: true });
const html = await readFile(join(dist, 'index.html'), 'utf8');
await writeFile(join(dist, 'index.html'), html.replace('<head>', '<head><meta name="proxy-preview" content="true">'));
let policy = effectivePolicy({ origin, ingressIPs: ['203.0.113.10'] }, {
  ...defaultSettings, domains: [{ name: 'example.net', subdomains: true }],
  certificates: { ...defaultSettings.certificates, email: 'preview@example.net' },
}, { development: true });
const store = new Store(join(directory, 'control.db'));
const routes = [
  { name: 'Home dashboard', kind: 'http', hostname: 'home.example.net', targetPort: 8080 },
  { name: 'Media server', kind: 'http', hostname: 'media.example.net', targetPort: 8096 },
  { name: 'Game server', kind: 'udp', ports: '25565', targetPort: 25565 },
].map((r, i) => routeSchema.parse({ id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`, targetHost: '100.101.102.103', ingressIP: '203.0.113.10', published: true, ...r }));
store.set('settings', settingsFromPolicy(policy));
store.set('snapshot', { routes, pages: defaultPages, sites: [] });
const archive = new LogStore(join(directory, 'edge-trace-logs.db'));
if (archive.status().count < 100) for (let i = 0; i < 380; i++) {
  const suspicious = i % 31 === 0;
  archive.append({ type: suspicious ? 'alert' : 'traffic', time: new Date(Date.now() - (380 - i) * 6500000).toISOString(),
    service: suspicious ? 'catch-all' : routes[i % routes.length].id,
    protocol: 'http', status: suspicious ? 404 : 200, source: `203.0.113.${40 + i % 9}`,
    url: `https://${suspicious ? 'unknown' : 'home'}.example.net${suspicious ? '/.env?scan=1' : '/dashboard?view=traffic'}`, method: 'GET',
    severity: suspicious ? 'warning' : 'info', event: suspicious ? 'Catch-all scanning' : 'Request / session completed', bytes: 1200 });
}
if (archive.status().count < 1000) for (let minute = 59; minute >= 1; minute--) {
  const count = 8 + Math.round(14 * (1 + Math.sin(minute / 6))) + (minute >= 18 && minute <= 24 ? 28 : 0);
  for (let i = 0; i < count; i++) {
    const status = minute >= 18 && minute <= 24 && i % 3 === 0 ? 403 : i % 19 === 0 ? 502 : 200;
    archive.append({ type: 'traffic', time: new Date((Math.floor(Date.now() / 60000) - minute) * 60000 + i * 700).toISOString(),
      service: status === 403 ? 'catch-all' : routes[i % routes.length].id, protocol: 'http', status,
      source: `203.0.113.${40 + i % 9}`, url: `https://${status === 403 ? 'unknown' : 'home'}.example.net${status === 403 ? '/.git/config' : '/dashboard'}`, method: 'GET', severity: status >= 400 ? 'warning' : 'info',
      event: status === 403 ? 'Exploit-path probe' : 'Request / session completed', bytes: 1200 });
  }
}
archive.flush();
if (store.get('discord')?.webhookURL?.includes('demo_token_')) store.set('discord', { enabled: false, webhookURL: '' });
if (!store.get('discord-cursors')) store.set('discord-cursors', { control: 0, edge: archive.latestId() });
const monitor = new Monitor({ archive });
const applied = () => ({ available: true, hash: snapshotHash(store.snapshot()), policyHash: policyHash(policy),
  readyDomains: ['example.net'], wildcardDomains: ['example.net'], routes: store.snapshot().routes.filter((r) => r.published).map((r) => r.id) });
await writeFile(join(directory, 'example.net.json'), JSON.stringify({ ready: true, staging: false, subdomains: true,
  expires: new Date(Date.now() + 70 * 86400000).toISOString(), lastCheck: new Date().toISOString() }));
const app = createApp({ policy, store, stateDir: directory, distDir: dist, development: true,
  bootstrapToken: '', edgeSocket: 'mock-only', certStatusDir: directory, certRequestDir: join(directory, 'requests'),
  discovery: { status: () => ({ configured: true, servers: [{ id: 'demo', name: 'Demo home server', address: '100.101.102.103' }],
    services: routes.map((r) => ({ name: r.name, server: 'demo', serverName: 'Demo home server', containerId: r.id,
      state: 'running', ports: [{ protocol: r.kind === 'udp' ? 'udp' : 'tcp', hostPort: r.targetPort, containerPort: r.targetPort, targetHost: r.targetHost, usable: true }] })),
    stale: false, error: null, lastSuccess: new Date().toISOString() }), refresh: async () => {} },
  auditLog: () => {},
  filesRequest: async () => [],
  edgeRequest: async (_socket, path, options) => {
    const url = new URL(path, origin);
    if (url.pathname === '/status') return applied();
    if (url.pathname === '/monitoring') return monitor.snapshot();
    if (url.pathname === '/logs') return archive.history(logQuery(url.searchParams));
    if (url.pathname === '/log-summary') return archive.summary(logQuery(url.searchParams));
    if (url.pathname === '/alerts') return { events: archive.alertsAfter(Number(url.searchParams.get('after') ?? 0)), latest: archive.latestId() };
    if (url.pathname === '/apply') { policy = effectivePolicy({ origin, ingressIPs: policy.ingressIPs }, options.body.settings, { development: true }); return { ...applied(), hash: snapshotHash(options.body), policyHash: policyHash(policy) }; }
    if (url.pathname === '/probe') return { reachable: true, message: 'Simulated backend connection succeeded' };
    if (url.pathname === '/sites/inspect') return { files: [], exposed: [], count: 0 };
    return { ok: true };
  },
});
let cookie;
const issue = () => app.auth.issue({}, { getHeader: () => [], setHeader: (_key, value) => { cookie = value[0].split(';')[0]; } });
issue();
app.server.prependListener('request', (req) => {
  if (!app.auth.session({ headers: { cookie } })) issue();
  req.headers.cookie = cookie;
});
const feed = () => {
  for (let i = 0; i < 8; i++) {
    const route = i % 4 ? routes[(i - 1) % routes.length] : null;
    monitor.ingest(JSON.stringify({ protocol: route?.kind === 'udp' ? 'udp' : 'http', service: route?.id ?? 'catch-all',
      address: '203.0.113.44', status: route ? '200' : '404', bytes: '1200', signal: route ? 'none' : 'probe',
      ...(route?.kind === 'udp' ? {} : { url: `https://${route?.hostname ?? 'unknown.example.net'}${route ? '/dashboard?view=traffic' : '/.env?scan=1'}`, method: 'GET' }) }));
  }
};
feed();
const timer = setInterval(feed, 5000);
app.server.listen(port, '127.0.0.1', () => console.log(`LOCAL PREVIEW: ${origin}/logs — synthetic traffic; configure a real Discord webhook in Settings.`));
app.server.on('close', () => { clearInterval(timer); archive.close(); store.close(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.server.closeAllConnections(); app.server.close(); });
