import test from 'node:test';
import assert from 'node:assert/strict';
import {
  staticSiteSchema,
  siteDirectory,
  validateSnapshot,
  snapshotSchema,
} from '../shared/model.js';
import { fileFilter } from '../edge/sites.js';
import { render } from '../edge/render.js';
import { route, snapshot, policy } from './fixtures.js';

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

test('renderer exposes checked site files and embeds the shared error pages', () => {
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
  });
  assert.match(output.config, /location = "\/app.js"/);
  assert.match(output.config, /disable_symlinks on/);
  assert.match(output.config, /location \/ \{ return 404;/);
  assert.match(output.config, /error_page 404 \/_proxy\/error-documents\/404;/);
  assert.match(output.config, /location = "\/_proxy\/error-icon\.svg"/);
  assert.match(output.pages['error-404.html'], /Oops! Page not found/);
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
    pages: { notFoundSite: old.staticSite },
  });
  assert.deepEqual(configured.routes[0].staticSite, rules);
  assert(!('pages' in configured));
  assert(!snapshotSchema.safeParse({ ...migrated, sites: [rules, rules] }).success);
});

test('legacy page settings are discarded when snapshots are read', () => {
  const migrated = snapshotSchema.parse({ routes: [], pages: { notFoundTitle: 'Old page', notFoundSite: { directory: 'errors' } } });
  assert.deepEqual(migrated, { routes: [], sites: [] });
});
