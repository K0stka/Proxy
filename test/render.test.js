import test from 'node:test';
import assert from 'node:assert/strict';
import { render, errorPage, activeHash } from '../edge/render.js';
import { policy, route, snapshot } from './fixtures.js';
const options = {
  revision: 'rev-test',
  directory: '/runtime/rev-test',
  readyDomains: ['krychlic.com', 'example.net'],
};

test('apex and wildcard readiness differ; admin proxy has a fixed destination and requires production TLS', () => {
  const p = policy();
  p.certificates.staging = false;
  p.adminHostname = 'proxy.krychlic.com';
  const apex = route({ hostname: 'krychlic.com', published: true });
  const pending = render(p, snapshot([apex]), { ...options, wildcardDomains: [] }).config;
  assert(!pending.includes('proxy_pass http://127.0.0.1:3001'));
  assert.throws(() => render(p, snapshot([route({ published: true })]), { ...options, wildcardDomains: [] }), /not ready/);
  const ready = render(p, snapshot([apex]), options).config;
  assert(ready.includes('proxy_pass http://127.0.0.1:3001'));
  assert(ready.includes('proxy_set_header Host proxy.krychlic.com'));
  assert.match(ready, /location \/api\/ \{[^}]*proxy_intercept_errors off;[^}]*error_page 502 = @admin_api_unavailable;/);
  assert.match(ready, /location @admin_api_unavailable \{\s*default_type application\/json;\s*return 502/);
  p.domains[0].subdomains = false;
  p.adminHostname = 'krychlic.com';
  assert.throws(() => render(p, snapshot([route({ published: true })]), options), /Hostname/);
});
test('UDP uses accepted destination port, with no DNS resolver or single-response assumption', () => {
  const output = render(
    policy(),
    snapshot([route({ kind: 'udp', portStart: 50000, portEnd: 50100, published: true })]),
    options,
  ).config;
  assert.match(output, /listen 203\.0\.113\.10:50000-50100 udp reuseport/);
  assert.match(output, /proxy_pass 100\.101\.102\.103:\$server_port/);
  assert(!output.includes('proxy_responses'));
  assert(!output.includes('listen 0.0.0.0'));
});
test('HTTPS sanitizes headers, verifies TLS and always uses shared gateway errors', () => {
  const output = render(
    policy(),
    snapshot([
      route({ published: true, upstreamTLS: true, upstreamServerName: 'backend.example.net' }),
    ]),
    options,
  ).config;
  for (const directive of [
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_ssl_verify on;',
    'proxy_set_header Upgrade $http_upgrade;',
    'proxy_buffering off;',
    'proxy_intercept_errors on;',
    'error_page 502 /_proxy/error-documents/502;',
    'error_page 504 /_proxy/error-documents/504;',
  ])
    assert(output.includes(directive));
  assert(!output.includes('$proxy_add_x_forwarded_for'));
});
test('unknown TLS rejects; covered catchall is a regex so apex routes retain exact-match precedence', () => {
  const output = render(
    policy(),
    snapshot([route({ hostname: 'krychlic.com', published: true })]),
    options,
  ).config;
  assert.match(output, /ssl_reject_handshake on/);
  assert.match(output, /server_name ~\^\(\?:/);
  assert.match(output, /server_name krychlic\.com;/);
  assert.throws(
    () =>
      render(policy(), snapshot([route({ published: true })]), { ...options, readyDomains: [] }),
    /not ready/,
  );
});

test('shared error documents have an explicit HTML content type despite extensionless internal URLs', () => {
  const output = render(policy(), snapshot([]), options).config;
  for (const code of [404, 500, 502, 504]) {
    assert.ok(output.includes(`location = "/_proxy/error-documents/${code}" { internal; types {} default_type text/html; charset utf-8;`));
  }
});
test('embedded error pages have status-specific copy and a local favicon', () => {
  for (const [code, title] of [[404, 'Oops! Page not found'], [500, 'Internal server error'], [502, 'Oops! Bad Gateway'], [504, 'Request timed out']]) {
    const page = errorPage(code);
    assert(page.includes(title));
    assert(page.includes('/_proxy/error-icon.svg'));
    assert(!page.includes('umami') && !page.includes('fonts.googleapis.com'));
  }
  const output = render(policy(), snapshot([]), options);
  assert.match(output.config, /location = "\/_proxy\/error-icon\.svg"/);
  assert.ok(output.pages['error-icon.svg'].includes('<svg'));
  const s = snapshot([]);
  assert.equal(activeHash(s), activeHash({ ...s, routes: [route()] }));
  assert.notEqual(activeHash(s), activeHash(snapshot([route({ published: true })])));
});
test('one website route listens on every approved IPv4/IPv6 ingress address', () => {
  const p = policy();
  p.ingressIPs.push('2001:db8::1');
  const config = render(p, snapshot([route({ published: true })]), options).config;
  assert(
    config.includes(
      'listen 203.0.113.10:443 ssl; listen [2001:db8::1]:443 ssl; server_name app.krychlic.com;',
    ),
  );
});
