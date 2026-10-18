import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNavigation } from '../ui/navigation.js';

function browser(entries = [{ hash: '', state: null }], index = 0) {
  const handlers = new Map();
  const location = {};
  function visit(path) {
    const url = new URL(path || '/', 'https://proxy.invalid');
    location.hash = url.hash;
    location.pathname = url.pathname;
    location.search = url.search;
  }
  visit(entries[index].hash);
  return {
    location, crypto: { randomUUID },
    addEventListener(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _, hash) {
        entries.splice(++index, entries.length, { hash, state: structuredClone(state) });
        visit(hash);
      },
      replaceState(state, _, hash) {
        entries[index] = { hash, state: structuredClone(state) };
        visit(hash);
      },
      go(delta) {
        index += delta;
        visit(entries[index].hash);
        for (const fn of handlers.get('popstate') ?? []) fn();
        for (const fn of handlers.get('hashchange') ?? []) fn();
      },
    },
    reload: () => browser(structuredClone(entries), index),
  };
}

test('browser history and refresh preserve pages, wizard steps and unsaved fields', () => {
  const tab = browser(), nav = createNavigation(tab);
  nav.setPage('Services');
  nav.setPage('Folders');
  assert.equal(tab.location.pathname, '/folders');
  assert.equal(tab.location.hash, '');
  tab.history.go(-1);
  assert.equal(nav.getSnapshot().page, 'Services');
  tab.history.go(1);
  assert.equal(nav.getSnapshot().page, 'Folders');
  nav.setPage('Settings');
  assert.equal(nav.getSnapshot().settingsSection, 'general');
  nav.setSettingsSection('certificates');
  assert.equal(tab.location.pathname, '/settings/certificates');
  assert.equal(createNavigation(tab.reload()).getSnapshot().settingsSection, 'certificates');
  nav.setPage('Folders');
  assert.equal(createNavigation(tab.reload()).getSnapshot().page, 'Folders');
  nav.setWizard({ kind: 'folder', initial: { directory: 'public' } });
  nav.setField('folder', { directory: 'assets', include: ['*.css'] });
  nav.setStep(1);
  nav.setField('folder', (value) => ({ ...value, exclude: ['private/**'] }));
  tab.history.go(-1);
  assert.equal(nav.getSnapshot().step, 0);
  assert.deepEqual(nav.getSnapshot().draft.folder.exclude, ['private/**']);
  tab.history.go(1);
  const resumed = createNavigation(tab.reload()).getSnapshot();
  assert.equal(resumed.step, 1);
  assert.equal(resumed.wizard.initial.directory, 'public');
  assert.equal(resumed.draft.folder.directory, 'assets');
  assert.deepEqual(resumed.draft.folder.exclude, ['private/**']);
  nav.setWizard(null);
  assert.equal(nav.getSnapshot().wizard, null);
  assert.equal(nav.getSnapshot().page, 'Folders');
  nav.setPage('Domains');
  nav.setWizard({ kind: 'domains' });
  assert.equal(tab.location.pathname, '/domains/new');
  nav.setWizard({ kind: 'domains', initial: { name: 'example.net', subdomains: false } });
  assert.equal(tab.location.pathname, '/domains/edit/example.net');
  assert.equal(createNavigation(tab.reload()).getSnapshot().wizard.initial.subdomains, false);
  nav.setPage('Folders');
  nav.setWizard({ kind: 'pages', code: 502 });
  assert.equal(tab.location.pathname, '/settings/pages/502');
  assert.equal(createNavigation(tab.reload()).getSnapshot().wizard.code, 502);
});

test('renamed folder links retain drafts saved under the old page name', () => {
  const tab = browser([{
    hash: '/files/folder?step=1',
    state: { proxyNavigation: {
      page: 'Files', id: 'existing-draft', wizard: { kind: 'folder', initial: { directory: 'public' } },
      draft: { folder: { directory: 'assets', include: ['*.css'], exclude: [] } },
    } },
  }]);
  const nav = createNavigation(tab);
  assert.equal(tab.location.pathname, '/folders/folder');
  assert.equal(nav.getSnapshot().wizard.initial.directory, 'public');
  assert.equal(nav.getSnapshot().draft.folder.directory, 'assets');
  assert.equal(nav.getSnapshot().step, 1);
});

test('route flows return to Routes when closed, regardless of their starting page', () => {
  for (const page of ['Routes', 'Services', 'Folders', 'Domains', 'Settings']) {
    const tab = browser(), nav = createNavigation(tab);
    nav.setPage(page);
    nav.setWizard({ kind: 'route' });
    nav.setWizard(null);
    assert.equal(nav.getSnapshot().page, 'Routes');
    assert.equal(tab.location.pathname, '/routes');
    nav.setPage(page);
    nav.setWizard({ kind: 'route' });
    nav.setStep(3);
    nav.setWizard(null);
    assert.equal(tab.location.pathname, '/routes');
  }
});


test('old Files links resolve to Folders and Settings without losing wizard state', () => {
  for (const [path, expectedPage, expectedPath] of [
    ['/files', 'Folders', '/folders'],
    ['/files/folder?step=1', 'Folders', '/folders/folder'],
    ['/files/pages/502?step=1', 'Settings', '/settings/pages/502'],
    ['/settings/pages/500?step=1', 'Settings', '/settings/pages/500'],
  ]) {
    const tab = browser([{ hash: path, state: null }]);
    const nav = createNavigation(tab);
    assert.equal(nav.getSnapshot().page, expectedPage);
    assert.equal(tab.location.pathname, expectedPath);
    if (path.includes('?')) assert.equal(nav.getSnapshot().step, 1);
    if (path.includes('/pages/')) {
      assert.equal(nav.getSnapshot().wizard.code, Number(path.split('/').at(-1).split('?')[0]));
      nav.setWizard(null);
      assert.equal(tab.location.pathname, '/settings/error-pages');
    }
  }
});
