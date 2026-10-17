import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNavigation } from '../ui/navigation.js';

function browser(entries = [{ hash: '', state: null }], index = 0) {
  const handlers = new Map();
  const location = { hash: entries[index].hash };
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
        location.hash = hash;
      },
      replaceState(state, _, hash) {
        entries[index] = { hash, state: structuredClone(state) };
        location.hash = hash;
      },
      go(delta) {
        index += delta;
        location.hash = entries[index].hash;
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
  nav.setPage('Files');
  tab.history.go(-1);
  assert.equal(nav.getSnapshot().page, 'Services');
  tab.history.go(1);
  assert.equal(nav.getSnapshot().page, 'Files');
  assert.equal(createNavigation(tab.reload()).getSnapshot().page, 'Files');
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
  assert.equal(nav.getSnapshot().page, 'Files');
});
