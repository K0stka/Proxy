import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, unlink, chmod, readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { Security } from '../edge/security.js';
import { defaultSettings, effectivePolicy } from '../shared/model.js';
import { render } from '../edge/render.js';
import { LogStore } from '../shared/log-store.js';
import { startMonitor } from '../edge/monitor.js';
import { bodyJSON, json } from '../shared/http.js';

test('real CrowdSec, NGINX and AppSec enforce policy and retain measured statistics', { skip: process.env.PROXY_CROWDSEC_TEST !== 'true' }, async (t) => {
  const directory = await mkdtemp('/tmp/proxy-crowdsec-');
  const archive = new LogStore(':memory:'), traffic = await startMonitor({ archive });
  let policy = effectivePolicy({ origin: 'https://proxy.example.net', ingressIPs: ['127.0.0.1'] }, defaultSettings);
  const security = new Security({ archive, monitor: traffic.monitor, policy: () => policy, enabled: true });
  assert.equal((await security.status()).available, true);
  assert.equal((await security.check({ ip: '198.51.100.24', service: 'catch-all' })).action, 'Blocked', 'LAPI must return the seeded ban');
  const server = http.createServer(async (req, res) => {
    try { json(res, await security.check(await bodyJSON(req))); } catch { json(res, {}, 503); }
  });
  await unlink('/tmp/proxy-security.sock').catch(() => {});
  await new Promise((r) => server.listen('/tmp/proxy-security.sock', r));
  await chmod('/tmp/proxy-security.sock', 0o600);
  let config = render(policy, { routes: [], sites: [], pages: (await import('../shared/model.js')).defaultPages }, {
    revision: 'crowdsec-test', directory, monitorPort: traffic.port, securityEnabled: true,
  }).config.replaceAll('127.0.0.1:80', '127.0.0.1:18080').replaceAll('127.0.0.1:443', '127.0.0.1:18443');
  // Trusted-proxy rewriting is restricted to this test listener; production never trusts these headers.
  config = config.replace('server_tokens off;', 'server_tokens off; set_real_ip_from 127.0.0.1; real_ip_header X-Test-IP;');
  config = config.replace('error_log stderr crit;', 'error_log stderr notice;');
  await writeFile(directory + '/nginx.conf', config);
  for (const code of [404, 500, 502]) await writeFile(`${directory}/${code}.html`, String(code));
  execFileSync('nginx', ['-t', '-e', 'stderr', '-c', directory + '/nginx.conf']);
  const nginx = spawn('nginx', ['-g', 'daemon off;', '-e', 'stderr', '-c', directory + '/nginx.conf'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; nginx.stderr.on('data', (d) => errors += d);
  t.after(async () => { nginx.kill('SIGTERM'); await new Promise((r) => server.close(r)); traffic.close(); archive.close(); });
  const request = (path = '/', ip = '198.51.100.99', options = {}) => fetch('http://127.0.0.1:18080' + path, { ...options, headers: { 'X-Test-IP': ip, ...options.headers }, redirect: 'manual' });
  for (let i = 0; i < 50; i++) { try { await request(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  assert.equal(nginx.exitCode, null, errors);
  assert.equal((await request()).status, 404, errors);
  assert.equal((await request('/', '198.51.100.24')).status, 403, 'local IP ban must stop a request');
  policy = { ...policy, security: { ...policy.security, mode: 'monitor' } };
  assert.equal((await request('/', '198.51.100.24')).status, 404, 'monitor-only does not enforce an IP ban');
  policy = { ...policy, security: { ...policy.security, mode: 'block', exceptions: [{ ip: '198.51.100.24', note: '' }] } };
  assert.equal((await request('/', '198.51.100.24')).status, 404, 'allowed address bypasses the ban');
  policy = { ...policy, security: { ...policy.security, exceptions: [], routes: { 'catch-all': 'off' } } };
  assert.equal((await request('/', '198.51.100.24')).status, 404, 'off override bypasses enforcement');
  policy = { ...policy, security: { ...policy.security, routes: {} } };
  const waf = await request('/wp-content/uploads/shell.php', '198.51.100.99');
  assert.equal(waf.status, 403, 'maintained AppSec test rule must block');
  assert.equal((await request('/search?q=1%27%20OR%201%3D1--', '198.51.100.98')).status, 403, 'CRS must inspect query strings');
  assert.equal((await request('/search', '198.51.100.97', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: "1' OR '1'='1" }) })).status, 403, 'CRS must inspect JSON bodies');
  policy = { ...policy, security: { ...policy.security, mode: 'monitor' } };
  assert.equal((await request('/wp-content/uploads/shell.php', '198.51.100.99')).status, 404, 'WAF monitor-only permits matched requests');
  policy = { ...policy, security: { ...policy.security, mode: 'block' } };
  await security.release('198.51.100.24');
  assert.equal((await request('/', '198.51.100.24')).status, 404, 'removing a ban invalidates cached decisions');
  const realRequest = security.request;
  security.request = async () => { throw Error('Test: LAPI connection unavailable'); };
  security.cache.clear();
  assert.equal((await request()).status, 404, 'allow fallback preserves availability when decisions fail');
  policy = { ...policy, security: { ...policy.security, failure: 'deny' } };
  assert.equal((await request()).status, 503, 'deny fallback stops requests when decisions fail');
  const health = await new Promise((resolve, reject) => {
    const req = http.get({ socketPath: '/tmp/proxy-health.sock', path: '/revision' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.equal(health, 200, 'private edge health remains usable during fail-closed operation');
  security.request = realRequest; security.cache.clear();
  policy = { ...policy, security: { ...policy.security, failure: 'allow' } };
  for (let i = 0; i < 65; i++) await request(`/probe-${i}`, '198.51.100.88');
  let behavioral;
  for (let i = 0; i < 30; i++) {
    security.cache.clear();
    behavioral = await security.check({ ip: '198.51.100.88', service: 'catch-all' });
    if (behavioral.action === 'Blocked') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(behavioral.action, 'Blocked', 'NGINX access logs must trigger a maintained behavioral scenario');
  assert.equal((await request('/', '198.51.100.88')).status, 403);
  await security.release('198.51.100.88');
  await security.configure({ ...policy.security, duration: '1h' });
  for (let i = 0; i < 20; i++) {
    if ((await security.status()).available) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal((await security.status()).available, true, 'policy changes must leave the engine healthy');
  await new Promise((r) => setTimeout(r, 300));
  const measured = await security.status();
  assert(measured.counts.blocked >= 2, JSON.stringify(measured));
  assert(measured.counts.detected >= 4);
  assert(measured.counts.sources.WAF >= 1);
  assert(measured.decisions.some((d) => d.engine === 'WAF'));
  assert.equal(measured.buckets.reduce((a, b) => a + b, 0), measured.counts.blocked);
  assert(measured.decisions.some((d) => d.ip === '198.51.100.24' && d.action === 'Ban removed'));
  const updateStarted = Date.now();
  await security.admin('/update', {});
  let updated;
  for (let i = 0; i < 90; i++) {
    updated = await security.status();
    if (Date.parse(updated.updated) >= updateStarted && !updated.updating) break;
    if (updated.error) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert(!updated.error, JSON.stringify(updated));
  assert(Date.parse(updated.updated) >= updateStarted, 'rule updates must complete and publish their last-success time');
  console.log('Verified IP/WAF/behavioral blocking, monitor-only, overrides, exceptions, ban release, policy reload, failure modes, and measured statistics.');
  await new Promise((resolve) => { nginx.once('exit', resolve); nginx.kill('SIGTERM'); });
  await new Promise((resolve) => server.close(resolve));
  await t.test('real controller API persists policy, reloads the real edge and changes public request enforcement', async (t) => {
    const { createApp } = await import('../server/app.js');
    const { Store } = await import('../shared/store.js');
    const { unixRequest } = await import('../shared/http.js');
    const edgeDirectory = directory + '/edge';
    const edgeSocket = directory + '/edge.sock';
    const edge = spawn('node', ['/app/edge/main.js'], { env: { ...process.env,
      PROXY_ORIGIN: 'https://proxy.example.net', PROXY_INGRESS_IPS: '127.0.0.1',
      PROXY_CROWDSEC_ENABLED: 'true', PROXY_EDGE_STATE: edgeDirectory, PROXY_EDGE_SOCKET: edgeSocket,
    }, stdio: ['ignore', 'ignore', 'pipe'] });
    let edgeErrors = ''; edge.stderr.on('data', (d) => edgeErrors += d);
    t.after(() => edge.kill('SIGTERM'));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await unixRequest(edgeSocket, '/status')).available) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(ready, edgeErrors);
    const store = new Store(directory + '/controller.db');
    const p = effectivePolicy({ origin: 'https://proxy.example.net', ingressIPs: ['127.0.0.1'] }, defaultSettings);
    const app = createApp({ policy: p, store, stateDir: directory, bootstrapToken: '', edgeSocket,
      certStatusDir: directory, certRequestDir: directory, development: true, distDir: '/app/dist', auditLog: () => {} });
    await new Promise((r) => app.server.listen(18082, '127.0.0.1', r));
    t.after(async () => { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); store.close(); });
    let cookie;
    const session = app.auth.issue({}, { getHeader: () => [], setHeader: (_k, v) => { cookie = v[0].split(';')[0]; } });
    const api = (path, body) => new Promise((resolve, reject) => {
      const content = body ? JSON.stringify(body) : null;
      const req = http.request('http://127.0.0.1:18082/api' + path, {
        method: body ? 'PUT' : 'GET', headers: { host: 'proxy.example.net', origin: p.origin,
          cookie, 'x-csrf-token': session.csrf, 'content-type': 'application/json', ...(content ? { 'content-length': Buffer.byteLength(content) } : {}) },
      }, (res) => {
        let text = ''; res.on('data', (chunk) => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode, text: async () => text, json: async () => JSON.parse(text) }));
      });
      req.on('error', reject); req.end(content);
    });
    const publicRequest = () => fetch('http://127.0.0.1/wp-content/uploads/shell.php');
    assert.equal((await publicRequest()).status, 403);
    let response = await api('/security/policy', { ...p.security, mode: 'monitor' });
    assert.equal(response.status, 200, await response.text());
    assert.equal(store.get('settings').security.mode, 'monitor');
    assert.equal((await publicRequest()).status, 404);
    response = await api('/security/policy', { ...p.security, mode: 'block' });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await publicRequest()).status, 403);
    await new Promise((r) => setTimeout(r, 200));
    response = await api('/security');
    const live = await response.json();
    assert.equal(response.status, 200);
    assert(live.available);
    assert(live.counts.blocked >= 2, JSON.stringify(live));
    assert(!JSON.stringify(live).includes('API_KEY'));
  });
});
