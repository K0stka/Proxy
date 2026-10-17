import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { render } from '../edge/render.js';
import { policy, snapshot } from './fixtures.js';

test(
  'admin API keeps upstream and NGINX-generated errors as JSON while pages use shared HTML',
  { skip: process.env.PROXY_ADMIN_API_TEST !== 'true', timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp('/tmp/admin-api-');
    const domain = 'krychlic.com';
    const certDir = `/tls/live/${domain}`;
    await mkdir(certDir, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        `${certDir}/privkey.pem`,
        '-out',
        `${certDir}/fullchain.pem`,
        '-subj',
        `/CN=${domain}`,
      ],
      { stdio: 'ignore' },
    );
    const p = { ...policy(), ingressIPs: ['127.0.0.1'], adminHostname: `proxy.${domain}` };
    p.certificates.staging = false;
    const output = render(p, snapshot([]), {
      directory,
      revision: 'test',
      readyDomains: [domain],
      wildcardDomains: [domain],
    });
    await writeFile(`${directory}/nginx.conf`, output.config);
    for (const [name, text] of Object.entries(output.pages))
      await writeFile(`${directory}/${name}`, text);
    execFileSync('nginx', ['-e', 'stderr', '-t', '-c', `${directory}/nginx.conf`], {
      stdio: 'pipe',
    });
    const backend = http.createServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"SSH host verification failed"}');
    });
    await new Promise((resolve) => backend.listen(3001, '127.0.0.1', resolve));
    const nginx = spawn(
      'nginx',
      ['-e', 'stderr', '-c', `${directory}/nginx.conf`, '-g', 'daemon off;'],
      { stdio: 'ignore' },
    );
    t.after(async () => {
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
      if (nginx.exitCode === null)
        await new Promise((resolve) => {
          nginx.once('exit', resolve);
          nginx.kill('SIGTERM');
        });
    });
    const request = (path) =>
      new Promise((resolve, reject) => {
        https
          .get(
            {
              hostname: '127.0.0.1',
              port: 443,
              path,
              servername: p.adminHostname,
              headers: { host: p.adminHostname },
              rejectUnauthorized: false,
              agent: false,
            },
            (res) => {
              let body = '';
              res.on('data', (chunk) => (body += chunk));
              res.on('error', reject);
              res.on('end', () =>
                resolve({ status: res.statusCode, type: res.headers['content-type'], body }),
              );
            },
          )
          .on('error', reject);
      });
    let response;
    for (let i = 0; i < 30; i++) {
      try {
        response = await request('/api/sites/pull');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(response.status, 502);
    assert.match(response.type, /application\/json/);
    assert.equal(JSON.parse(response.body).error, 'SSH host verification failed');
    const page = await request('/routes');
    assert.equal(page.status, 502);
    assert.match(page.type, /text\/html/);
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
    const unavailable = await request('/api/sites/pull');
    assert.equal(unavailable.status, 502);
    assert.match(unavailable.type, /application\/json/);
    assert.match(JSON.parse(unavailable.body).error, /Management service unavailable/);
  },
);
