import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultPages, settingsFromPolicy } from '../shared/model.js';
import { unixRequest } from '../shared/http.js';
import { route, policyEnv } from './fixtures.js';
import { inspectSite, readSiteIndex } from '../edge/sites.js';

test(
  'Linux NGINX: real HTTPS, unknown hosts, error pages, WebSocket, TCP, UDP range, failed reload and restart',
  { skip: process.env.PROXY_LINUX_TEST !== 'true', timeout: 90000 },
  async (t) => {
    assert.equal(process.getuid(), 10002);
    assert.match(await readFile('/proc/self/status', 'utf8'), /CapBnd:\s+0000000000000400/);
    assert.match(await readFile('/proc/self/status', 'utf8'), /CapEff:\s+0000000000000400/);
    assert.match(await readFile('/proc/self/status', 'utf8'), /NoNewPrivs:\s+1/);
    const directory = await mkdtemp('/tmp/proxy-linux-'),
      socket = join(directory, 'edge.sock'),
      certificates = [];
    for (const domain of ['krychlic.com', 'example.net']) {
      const dir = `/tls/live/${domain}`;
      await mkdir(dir, { recursive: true });
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-keyout',
          `${dir}/privkey.pem`,
          '-out',
          `${dir}/fullchain.pem`,
          '-subj',
          `/CN=${domain}`,
          '-addext',
          `subjectAltName=DNS:${domain},DNS:*.${domain}`,
        ],
        { stdio: 'ignore' },
      );
      await writeFile(`${dir}/meta.json`, JSON.stringify({ staging: false }));
      certificates.push(await readFile(`${dir}/fullchain.pem`));
    }
    const policy = {
      origin: 'https://proxy.example.net',
      ingressIPs: ['127.0.0.1'],
      ingressPorts: [
        { protocol: 'tcp', from: 51413, to: 51420 },
        { protocol: 'udp', from: 52000, to: 52002 },
      ],
      targets: [
        {
          name: 'Home',
          address: '127.0.0.2',
          ports: [
            { from: 18080, to: 18082 },
            { from: 52000, to: 52002 },
          ],
        },
      ],
      forbiddenTargetPorts: [3001, 8120, 9120, 2375, 2376],
      maxRangePorts: 1024,
      domains: ['krychlic.com', 'example.net'].map((name) => ({
        name,
      })),
      komodo: {
        url: 'http://100.101.102.103:9120',

        servers: [{ id: 'home', name: 'Home', address: '127.0.0.2', local: false }],
      },
      certificates: { email: 'admin@example.net', staging: false, propagationSeconds: 60 },
    };
    const edgeRequest = (path, options = {}) =>
      unixRequest(
        socket,
        path,
        path === '/apply'
          ? { ...options, body: { ...options.body, settings: settingsFromPolicy(policy) } }
          : options,
      );
    const backend = http.createServer((req, res) => {
      if (req.url === '/not-found') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"missing resource"}');
        return;
      }
      if (req.url === '/api-error') {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end('{"error":"application response"}');
        return;
      }
      if (req.url === '/slow') {
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from home');
    });
    backend.on('upgrade', (req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.on('data', (data) => socket.write(data));
    });
    const connections = new Set();
    backend.on('connection', (s) => {
      connections.add(s);
      s.on('close', () => connections.delete(s));
    });
    const tcp = net.createServer((s) => {
      s.on('data', (data) => s.write(Buffer.concat([Buffer.from('tcp:'), data])));
    });
    const udp = [];
    for (let port = 52000; port <= 52002; port++) {
      const s = dgram.createSocket('udp4');
      s.on('message', (data, remote) =>
        s.send(Buffer.concat([Buffer.from(`${port}:`), data]), remote.port, remote.address),
      );
      await new Promise((r) => s.bind(port, '127.0.0.2', r));
      udp.push(s);
    }
    await new Promise((r) => backend.listen(18080, '127.0.0.2', r));
    await new Promise((r) => tcp.listen(18081, '127.0.0.2', r));
    let edge,
      logs = '';
    const start = () => {
      const child = spawn(process.execPath, ['edge/main.js'], {
        cwd: '/app',
        env: { ...process.env, ...policyEnv(policy), PROXY_EDGE_SOCKET: socket },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (b) => (logs += b));
      child.stderr.on('data', (b) => (logs += b));
      return child;
    };
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        if (edge.exitCode !== null) throw Error(logs);
        try {
          if ((await edgeRequest('/status', { timeout: 500 })).available) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(logs);
    };
    const stop = async () => {
      if (edge && edge.exitCode === null) {
        edge.kill('SIGTERM');
        await Promise.race([
          new Promise((r) => edge.once('exit', r)),
          new Promise((r) =>
            setTimeout(() => {
              edge.kill('SIGKILL');
              r();
            }, 3000),
          ),
        ]);
      }
    };
    function request(host, path = '/', secure = true, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = (secure ? https : http).get(
          {
            host: '127.0.0.1',
            port: secure ? 443 : 80,
            servername: host,
            ca: certificates,
            headers: { host, ...headers },
            path,
            timeout: 8000,
          },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(Error('timeout')));
      });
    }
    t.after(async () => {
      for (const s of connections) s.destroy();
      await stop();
      backend.close();
      tcp.close();
      for (const s of udp) s.close();
    });
    edge = start();
    await ready();
    assert.equal(
      (await readFile('/runtime/edge.db')).subarray(0, 15).toString(),
      'SQLite format 3',
    );
    const routes = [
      route({
        published: true,
        ingressIP: '127.0.0.1',
        targetHost: '127.0.0.2',
        targetPort: 18080,
      }),
      route({
        name: 'Second domain',
        hostname: 'example.net',
        published: true,
        ingressIP: '127.0.0.1',
        targetHost: '127.0.0.2',
        targetPort: 18080,
      }),
      route({
        name: 'TCP',
        kind: 'tcp',
        hostname: '',
        published: true,
        ingressIP: '127.0.0.1',
        portStart: 51413,
        portEnd: 51413,
        targetHost: '127.0.0.2',
        targetPort: 18081,
      }),
      route({
        name: 'UDP',
        kind: 'udp',
        hostname: '',
        published: true,
        ingressIP: '127.0.0.1',
        portStart: 52000,
        portEnd: 52002,
        targetHost: '127.0.0.2',
        targetPort: 18080,
      }),
      route({
        name: 'TCP TLS',
        kind: 'tcp',
        hostname: '',
        published: true,
        ingressIP: '127.0.0.1',
        portStart: 51414,
        portEnd: 51414,
        targetHost: '127.0.0.2',
        targetPort: 18081,
        streamTLS: true,
        tlsDomain: 'krychlic.com',
      }),
    ];
    const snapshot = { routes, pages: defaultPages };
    await mkdir('/sites/public/docs', { recursive: true });
    await mkdir('/sites/public/.git', { recursive: true });
    await mkdir('/sites/errors', { recursive: true });
    for (const [name, body] of Object.entries({
      'index.html': '<h1>Static home</h1>',
      'app.js': 'console.log(1)',
      'style.css': 'body{}',
      'private.txt': 'secret',
      '.env': 'secret',
      '.git/config': 'secret',
      'docs/index.html': 'Docs',
      'swap.txt': 'safe',
      'Upper.txt': 'upper',
      'upper.txt': 'lower',
    }))
      await writeFile(`/sites/public/${name}`, body);
    await symlink('/etc/passwd', '/sites/public/link.txt');
    await writeFile(
      '/sites/errors/index.html',
      '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>Custom bundle<script src="app.js"></script></body></html>',
    );
    await writeFile('/sites/errors/style.css', 'body{color:red}');
    await writeFile('/sites/errors/app.js', 'console.log("error bundle")');
    await t.test('folder reads reject symlinked parents and index files', async () => {
      await symlink('/sites/public', '/sites/linked');
      await assert.rejects(inspectSite({ directory: 'linked' }), /symlink/);
      await mkdir('/sites/linked-index');
      await symlink('/etc/passwd', '/sites/linked-index/index.html');
      await assert.rejects(readSiteIndex({ directory: 'linked-index' }), /unreadable/);
      await assert.rejects(
        inspectSite({ directory: 'linked-index' }, { requireIndex: true }),
        /index.html/,
      );
    });
    await t.test(
      'static sites expose selected files; secrets, symlinks and new files stay private',
      async () => {
        const site = route({
          kind: 'static',
          hostname: 'files.krychlic.com',
          published: true,
          ingressIP: '127.0.0.1',
          staticSite: { directory: 'public', include: [], exclude: [] },
        });
        const next = {
          routes: [...routes, site],
          sites: [{ directory: 'public', include: [], exclude: ['private.txt'] }],
          pages: {
            ...defaultPages,
            notFoundSite: { directory: 'errors', include: [], exclude: [] },
            badGatewaySite: { directory: 'errors', include: [], exclude: [] },
          },
        };
        next.routes[0] = { ...next.routes[0], timeout: 5 };
        await edgeRequest('/apply', { method: 'POST', body: next, timeout: 20000 });
        assert.equal((await request(site.hostname)).body, '<h1>Static home</h1>');
        assert.match(
          (await request(site.hostname, '/app.js')).headers['content-type'],
          /javascript/,
        );
        assert.match((await request(site.hostname, '/style.css')).headers['content-type'], /css/);
        assert.equal((await request(site.hostname, '/docs/')).body, 'Docs');
        assert.equal((await request(site.hostname, '/docs')).status, 308);
        assert.equal((await request(site.hostname, '/Upper.txt')).body, 'upper');
        assert.equal((await request(site.hostname, '/upper.txt')).body, 'lower');
        await writeFile('/sites/public/new.txt', 'new');
        const beforeRenewal = (await edgeRequest('/status')).revision;
        const certificatePath = '/tls/live/krychlic.com/fullchain.pem';
        await writeFile(certificatePath, (await readFile(certificatePath, 'utf8')) + '\n');
        for (let i = 0; i < 180; i++) {
          if ((await edgeRequest('/status')).revision !== beforeRenewal) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        assert.notEqual(
          (await edgeRequest('/status')).revision,
          beforeRenewal,
          'certificate reload completed',
        );
        assert.equal(
          (await request(site.hostname, '/new.txt')).status,
          404,
          'certificate reload preserves approved files',
        );
        await unlink('/sites/public/swap.txt');
        await symlink('/etc/passwd', '/sites/public/swap.txt');
        for (const path of [
          '/private.txt',
          '/.env',
          '/.git/config',
          '/%2egit/config',
          '/link.txt',
          '/swap.txt',
          '/new.txt',
          '/../etc/passwd',
          '/_proxy/errors/404/index.html',
        ])
          assert.notEqual((await request(site.hostname, path)).status, 200, path);
        const missing = await request(site.hostname, '/missing');
        assert.equal(missing.status, 404);
        assert.match(missing.body, /<base href="\/_proxy\/errors\/404\/">/);
        assert.match(missing.body, /Custom bundle/);
        assert.equal(
          (await request(site.hostname, '/_proxy/errors/404/style.css')).body,
          'body{color:red}',
        );
        const timeout = await request('app.krychlic.com', '/slow');
        assert.equal(timeout.status, 504);
        assert.match(timeout.body, /Custom bundle/);
        assert.match(timeout.body, /<base href="\/_proxy\/errors\/502\/">/);
        const bad = {
          ...next,
          routes: next.routes.map((r, i) => (i === 0 ? { ...r, targetPort: 18082 } : r)),
        };
        await edgeRequest('/apply', { method: 'POST', body: bad, timeout: 20000 });
        assert.equal((await request(site.hostname, '/new.txt')).body, 'new');
        const response = await request('app.krychlic.com');
        assert.equal(response.status, 502);
        assert.match(response.body, /Custom bundle/);
        assert.equal((await request('app.krychlic.com', '/_proxy/errors/502/app.js')).status, 200);
        const restricted = {
          ...next,
          routes: next.routes.map((r) =>
            r.id === site.id ? { ...r, sourceCIDRs: ['192.0.2.0/24'] } : r,
          ),
        };
        await edgeRequest('/apply', { method: 'POST', body: restricted, timeout: 20000 });
        assert.equal((await request(site.hostname, '/app.js')).status, 403);
        await assert.rejects(
          edgeRequest('/apply', {
            method: 'POST',
            body: {
              ...next,
              routes: [
                ...routes,
                { ...site, staticSite: { directory: 'missing', include: [], exclude: [] } },
              ],
            },
            timeout: 20000,
          }),
          /Folder/,
        );
        assert.equal((await request('example.net')).status, 200);
      },
    );
    await edgeRequest('/apply', { method: 'POST', body: snapshot, timeout: 20000 });
    await t.test('HTTP redirect and HTTPS backend on both domains', async () => {
      const redirect = await request('app.krychlic.com', '/', false);
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.location, 'https://app.krychlic.com/');
      assert.equal((await request('app.krychlic.com')).body, 'hello from home');
      assert.equal((await request('example.net')).status, 200);
    });
    await t.test('covered unknown hostname gets 404; uncovered TLS fails', async () => {
      assert.equal((await request('missing.krychlic.com')).status, 404);
      assert.equal((await request('whatever.invalid', '/', false)).status, 404);
      await assert.rejects(request('unrelated.invalid'));
      await assert.rejects(request('deep.app.krychlic.com'));
    });
    await t.test(
      'source restrictions reject spoofed forwarding headers and mismatched SNI/Host',
      async () => {
        assert.equal(
          (await request('example.net', '/', true, { host: 'app.krychlic.com' })).status,
          421,
        );
        const restricted = {
          ...snapshot,
          routes: routes.map((r, i) => (i === 0 ? { ...r, sourceCIDRs: ['192.0.2.0/24'] } : r)),
        };
        await edgeRequest('/apply', { method: 'POST', body: restricted, timeout: 20000 });
        assert.equal(
          (await request('app.krychlic.com', '/', true, { 'X-Forwarded-For': '192.0.2.1' })).status,
          403,
        );
        await edgeRequest('/apply', { method: 'POST', body: snapshot, timeout: 20000 });
      },
    );
    await t.test(
      'application gateway errors always use the shared page; application 404 bodies are preserved',
      async () => {
        const response = await request('app.krychlic.com', '/api-error');
        assert.equal(response.status, 502);
        assert(response.body.includes('Back soon.'));
        const missing = await request('app.krychlic.com', '/not-found');
        assert.equal(missing.status, 404);
        assert.equal(missing.body, '{"error":"missing resource"}');
      },
    );
    await t.test(
      'WebSocket upgrade and bidirectional bytes pass through',
      async () =>
        new Promise((resolve, reject) => {
          const req = https.request(
            {
              host: '127.0.0.1',
              port: 443,
              servername: 'app.krychlic.com',
              ca: certificates,
              path: '/',
              headers: { host: 'app.krychlic.com', connection: 'Upgrade', upgrade: 'websocket' },
            },
            () => reject(Error('not upgraded')),
          );
          req.on('upgrade', (_res, socket) => {
            socket.write('ping');
            socket.once('data', (data) => {
              assert.equal(data.toString(), 'ping');
              socket.destroy();
              resolve();
            });
          });
          req.on('error', reject);
          req.end();
        }),
    );
    await t.test(
      'raw TCP forwards in both directions',
      async () =>
        new Promise((resolve, reject) => {
          const s = net.connect(51413, '127.0.0.1', () => s.write('ping'));
          s.once('data', (data) => {
            assert.equal(data.toString(), 'tcp:ping');
            s.destroy();
            resolve();
          });
          s.once('error', reject);
        }),
    );
    await t.test('UDP range preserves both boundary destination ports', async () => {
      for (const port of [52000, 52002])
        await new Promise((resolve, reject) => {
          const s = dgram.createSocket('udp4'),
            timer = setTimeout(() => {
              s.close();
              reject(Error('UDP timeout'));
            }, 3000);
          s.once('message', (data) => {
            clearTimeout(timer);
            assert.equal(data.toString(), `${port}:ping`);
            s.close();
            resolve();
          });
          s.send(Buffer.from('ping'), port, '127.0.0.1');
        });
    });
    await t.test(
      'TCP TLS termination presents the configured certificate and forwards bytes',
      async () =>
        new Promise((resolve, reject) => {
          const s = tls.connect(
            { host: '127.0.0.1', port: 51414, servername: 'tcp.krychlic.com', ca: certificates },
            () => s.write('secure'),
          );
          s.once('data', (data) => {
            assert.equal(data.toString(), 'tcp:secure');
            s.destroy();
            resolve();
          });
          s.once('error', reject);
        }),
    );
    await t.test(
      'occupied listener makes apply fail and old websites remain available',
      async () => {
        const busy = net.createServer();
        await new Promise((r) => busy.listen(51415, '127.0.0.1', r));
        try {
          const conflict = route({
            ...routes[2],
            id: crypto.randomUUID(),
            portStart: 51415,
            portEnd: 51415,
          });
          await assert.rejects(
            edgeRequest('/apply', {
              method: 'POST',
              body: { ...snapshot, routes: [...routes, conflict] },
              timeout: 20000,
            }),
            /activation failed/,
          );
          assert.equal((await request('app.krychlic.com')).status, 200);
          assert.equal((await edgeRequest('/status')).routes.length, routes.length);
        } finally {
          busy.close();
        }
      },
    );
    await t.test('upstream timeout preserves 504 status and uses the shared 502 page', async () => {
      const next = {
        ...snapshot,
        routes: routes.map((r, i) => (i === 0 ? { ...r, timeout: 5 } : r)),
      };
      await edgeRequest('/apply', { method: 'POST', body: next, timeout: 20000 });
      const response = await request('app.krychlic.com', '/slow');
      assert.equal(response.status, 504);
      assert(response.body.includes('Back soon.'));
    });
    await t.test('NGINX-generated failure keeps 502 status and custom static body', async () => {
      const next = {
        ...snapshot,
        routes: routes.map((r, i) => (i === 0 ? { ...r, targetPort: 18082 } : r)),
      };
      await edgeRequest('/apply', { method: 'POST', body: next, timeout: 20000 });
      const response = await request('app.krychlic.com');
      assert.equal(response.status, 502);
      assert(response.body.includes('Back soon.'));
      assert(!response.body.includes('127.0.0.2'));
    });
    await t.test('saved routing resumes after edge process restart', async () => {
      for (const s of connections) s.destroy();
      await stop();
      edge = start();
      await ready();
      assert.equal((await request('example.net')).body, 'hello from home');
      assert.equal((await edgeRequest('/status')).routes.length, routes.length);
    });
  },
);
