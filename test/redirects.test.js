import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot } from '../shared/model.js';
import { render } from '../edge/render.js';
import { listener, destination, destinationLabel, serviceProxies } from '../ui/routes.js';
import { policy, route, snapshot } from './fixtures.js';

const redirect = (changes = {}) => route({
  kind: 'redirect', hostname: 'krychlic.com', path: '/something',
  targetHost: '', redirectURL: 'https://example.net/landing?from=proxy#section', redirectStatus: 302,
  published: true, ...changes,
});
const options = { revision: 'redirect-test', directory: '/runtime/test', readyDomains: ['krychlic.com'] };

test('redirects coexist with a root website, reserve their own normalized path, and need domain coverage', () => {
  const root = route({ hostname: 'krychlic.com', published: true });
  const child = redirect({ path: '/something/' });
  const value = validateSnapshot(policy(), snapshot([child, root]));
  assert.equal(value.routes[0].path, '/something');
  assert.equal(value.routes[0].targetHost, '');
  assert.throws(() => validateSnapshot(policy(), snapshot([child, redirect()])), /already have a route/);
  assert.throws(() => validateSnapshot(policy(), snapshot([root, redirect({ path: '/' })])), /already have a route/);
  assert.throws(() => validateSnapshot(policy(), snapshot([redirect({ hostname: 'outside.invalid' })])), /coverage/);
  assert.throws(() => validateSnapshot({ ...policy(), adminHostname: 'krychlic.com' }, snapshot([redirect()])), /reserved/);
});

test('redirect paths, targets, status codes and upstream fields reject ambiguous or injectable values', () => {
  for (const path of ['relative', '//something', '/a/../b', '/a/./b', '/a%2fb', '/a?x=1', '/a#b', '/a; return 200;', '/$uri', '/_proxy/errors'])
    assert.throws(() => validateSnapshot(policy(), snapshot([redirect({ path })])), path);
  for (const redirectURL of ['', 'javascript:alert(1)', '/relative', 'ftp://example.net/', 'https://user:pass@example.net/', 'https://example.net/$host', 'https://example.net/\nreturn 200;', 'https:\\example.net'])
    assert.throws(() => validateSnapshot(policy(), snapshot([redirect({ redirectURL })])), redirectURL);
  for (const redirectStatus of [200, 307, 308])
    assert.throws(() => validateSnapshot(policy(), snapshot([redirect({ redirectStatus })])));
  assert.throws(() => validateSnapshot(policy(), snapshot([redirect({ redirectURL: 'https://krychlic.com/something/else' })])), /itself/);
  assert.throws(() => validateSnapshot(policy(), snapshot([route({ path: '/something' })])), /Only redirects/);
});

test('standalone directory redirects generate one host and keep unmatched HTTPS paths at 404', () => {
  const output = render(policy(), snapshot([redirect()]), options);
  assert.equal(output.config.match(/server_name krychlic.com;/g).length, 2);
  assert.match(output.config, /location = "\/something" \{ return 302 "https:\/\/example.net\/landing\?from=proxy#section";/);
  assert.match(output.config, /location \^~ "\/something\/"/);
  assert(!output.config.includes('location /somethingelse'));
  assert.match(output.config, /location \/ \{ return 404; \}/);
  assert(!output.config.includes('proxy_pass http://:80'));
  assert.throws(() => render(policy(), snapshot([redirect()]), { ...options, readyDomains: [] }), /Certificate/);
});

test('redirects merge with a proxy root in either order and preserve independent CIDR restrictions', () => {
  const root = route({ hostname: 'krychlic.com', published: true });
  const child = redirect({ redirectStatus: 301, sourceCIDRs: ['192.0.2.0/24'] });
  for (const routes of [[root, child], [child, root]]) {
    const output = render(policy(), snapshot(routes), options);
    assert.equal(output.config.match(/server_name krychlic.com;/g).length, 2);
    assert.match(output.config, /proxy_pass http:\/\/100.101.102.103:3000/);
    assert.match(output.config, /return 301 "https:\/\/example.net/);
    assert.match(output.config, /geo \$redirect_allowed_0 \{ default 0; 192.0.2.0\/24 1;/);
    assert.match(output.config, /if \(\$redirect_allowed_0 = 0\) \{ return 403;/);
  }
});

test('directory redirects take precedence over static exact file and directory locations', () => {
  const root = route({ hostname: 'krychlic.com', kind: 'static', staticSite: { directory: 'public' }, published: true });
  const output = render(policy(), snapshot([root, redirect()]), {
    ...options, staticSites: { [root.id]: { directory: 'public', exposed: ['index.html', 'something/index.html', 'something/file.html', 'somethingelse/index.html'] } },
  });
  assert(!output.config.includes('location = "/something/file.html"'));
  assert(!output.config.includes('location = "/something/index.html"'));
  assert(output.config.includes('location = "/somethingelse/index.html"'));
  assert(output.config.includes('location = "/"'));
  assert(output.config.includes('location ^~ "/something/"'));
});

test('root and nested redirect rules retain their URLs in UI labels without matching services', () => {
  const child = redirect();
  assert.equal(listener(child), 'krychlic.com/something');
  assert.equal(destination(child), child.redirectURL);
  assert.equal(destinationLabel(child, { services: [], servers: [] }), child.redirectURL);
  assert.deepEqual(serviceProxies([child], { ports: [] }, { protocol: 'tcp' }), []);
  const root = redirect({ path: '/', redirectURL: 'https://example.net/', redirectStatus: 301 });
  const output = render(policy(), snapshot([root, child]), options);
  assert.match(output.config, /location \/ \{ return 301 "https:\/\/example.net\/"; \}/);
  assert.match(output.config, /location = "\/something"/);
});
