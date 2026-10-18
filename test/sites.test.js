import test from 'node:test';
import assert from 'node:assert/strict';
import {
  staticSiteSchema,
  siteDirectory,
  validateSnapshot,
  pagesSchema,
  defaultPages,
  snapshotSchema,
  siteDocument,
} from '../shared/model.js';
import { fileFilter, errorDocument } from '../edge/sites.js';
import { render } from '../edge/render.js';
import { route, snapshot, policy } from './fixtures.js';

test('error documents are explicit paths and retain the selected document directory for assets', () => {
  assert(siteDocument.safeParse('nested/notice.htm').success);
  for (const path of ['/etc/passwd', '../notice.html', '**/*.html', 'file\\name'])
    assert(!siteDocument.safeParse(path).success);
  assert.match(
    errorDocument('<head></head>', 502, 'nested/notice.htm'),
    /href="\/_proxy\/errors\/502\/nested\/"/,
  );
});

test('static folder validation and filters cannot opt in dotfiles or escape the mount', () => {
  for (const directory of [
    '/etc',
    '../secret',
    'public/../secret',
    '.git',
    'public/.git',
    'public\\secret',
    'a/',
    'a.',
  ])
    assert(!siteDirectory.safeParse(directory).success, directory);
  assert(siteDirectory.safeParse('portfolio/assets-v2').success);
  assert(!staticSiteSchema.safeParse({ directory: 'public', include: ['../*'] }).success);
  const allows = fileFilter({
    directory: 'public',
    include: ['**/*.html', 'assets/**'],
    exclude: ['assets/private/**'],
  });
  for (const name of ['index.html', 'docs/index.html', 'assets/app.js']) assert(allows(name), name);
  for (const name of [
    '.env',
    '.git/config',
    'assets/.env',
    'assets/private/key',
    'assets/$uri',
    'app.js',
    '_proxy/errors/404/index.html',
  ])
    assert(!allows(name), name);
  assert(!fileFilter({ directory: 'public' })('private.key'));
});

test('static routes require a folder and reuse website hostname conflict checks', () => {
  const p = policy(),
    site = route({ kind: 'static', staticSite: { directory: 'public', include: [], exclude: [] } });
  validateSnapshot(p, snapshot([site]));
  assert.throws(() => validateSnapshot(p, snapshot([{ ...site, staticSite: null }])));
  assert.throws(() => validateSnapshot(p, snapshot([site, route()])));
});

test('renderer exposes only checked exact files and error assets use separate paths', () => {
  const site = route({
    kind: 'static',
    published: true,
    staticSite: { directory: 'public', include: [], exclude: [] },
  });
  const output = render(policy(), snapshot([site]), {
    revision: 'test',
    directory: '/runtime/test',
    readyDomains: ['krychlic.com', 'example.net'],
    staticSites: {
      [site.id]: { directory: 'public', exposed: ['index.html', 'docs/index.html', 'app.js'] },
    },
    errorSites: {
      404: {
        directory: 'errors',
        exposed: ['index.html', 'style.css'],
        html: errorDocument('<html><head></head><body>Error</body></html>', 404),
      },
    },
  });
  assert.match(output.config, /location = "\/app.js"/);
  assert.match(output.config, /disable_symlinks on/);
  assert.match(output.config, /location \/ \{ return 404;/);
  assert.match(output.config, /\/_proxy\/errors\/404\/style.css/);
  assert.match(output.pages['404.html'], /<head><base href="\/_proxy\/errors\/404\/">/);
  assert.throws(
    () =>
      render(policy(), snapshot([site]), {
        revision: 'test',
        directory: '/runtime/test',
        readyDomains: ['krychlic.com'],
      }),
    /checked/i,
  );
});

test('old separate timeout settings migrate away; all gateway errors share the 502 bundle', () => {
  const pages = pagesSchema.parse({
    ...defaultPages,
    gatewayTimeoutSite: { directory: 'old-504' },
  });
  assert(!('gatewayTimeoutSite' in pages));
  const output = render(
    policy(),
    { routes: [], pages },
    {
      revision: 'test',
      directory: '/runtime/test',
      errorSites: {
        502: {
          directory: 'errors/502',
          exposed: ['index.html', 'app.js'],
          html: 'Shared gateway page',
        },
      },
    },
  );
  assert.match(output.config, /error_page 502 504 \/_proxy\/error-documents\/502/);
  assert.equal(output.pages['502.html'], 'Shared gateway page');
  assert(!('504.html' in output.pages));
  assert(!output.config.includes('/errors/504/'));
});

test('legacy folder filters stay intact until shared profiles are explicitly saved', () => {
  const old = route({
    kind: 'static',
    staticSite: { directory: 'public', include: [], exclude: ['secret/**'] },
    interceptErrors: false,
  });
  const migrated = snapshotSchema.parse(snapshot([old]));
  assert.deepEqual(migrated.sites, []);
  assert.deepEqual(migrated.routes[0].staticSite, old.staticSite);
  assert(!('interceptErrors' in migrated.routes[0]));
  const rules = { directory: 'public', include: ['**/*.html'], exclude: [] };
  const configured = snapshotSchema.parse({
    ...migrated,
    sites: [rules],
    pages: { ...defaultPages, badGatewaySite: old.staticSite },
  });
  assert.deepEqual(configured.routes[0].staticSite, rules);
  assert.deepEqual(configured.pages.badGatewaySite, rules);
  assert(!snapshotSchema.safeParse({ ...migrated, sites: [rules, rules] }).success);
});


test('older snapshots gain a default 500 page and custom 500 bundles render separately', () => {
  const legacy = { ...defaultPages };
  for (const key of ['internalErrorTitle', 'internalErrorText', 'internalErrorSite', 'internalErrorDocument']) delete legacy[key];
  const migrated = pagesSchema.parse(legacy);
  assert.equal(migrated.internalErrorSite, null);
  assert.equal(migrated.internalErrorDocument, 'index.html');
  const output = render(policy(), { routes: [route({ published: true })], pages: migrated }, {
    revision: 'test', directory: '/runtime/test', readyDomains: ['krychlic.com'],
    errorSites: { 500: { directory: 'errors/server', exposed: ['notice.html', 'style.css'], html: 'Custom internal error' } },
  });
  assert.equal(output.pages['500.html'], 'Custom internal error');
  assert.match(output.config, /error_page 500 \/_proxy\/error-documents\/500;/);
  assert.match(output.config, /\/_proxy\/errors\/500\/style.css/);
  const shared = { directory: 'errors/server', include: ['*.html'], exclude: [] };
  const updated = snapshotSchema.parse({ routes: [], sites: [shared], pages: { ...migrated, internalErrorSite: { directory: shared.directory } } });
  assert.deepEqual(updated.pages.internalErrorSite, shared);
});
