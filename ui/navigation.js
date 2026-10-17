import { useSyncExternalStore } from 'react';

const pages = ['Routes', 'Services', 'Files', 'Domains', 'Settings'];
const kinds = ['route', 'folder', 'pages', 'domains'];

export function createNavigation(browser) {
  const listeners = new Set();
  const drafts = new Map();
  function read() {
    const url = new URL(browser.location.hash.slice(1) || '/routes', 'https://proxy.invalid');
    const [, section, kind] = url.pathname.split('/');
    const page = pages.find((name) => name.toLowerCase() === section) ?? 'Routes';
    const saved = browser.history.state?.proxyNavigation;
    const matches = saved?.page === page && saved.wizard?.kind === kind;
    const wizard = kinds.includes(kind) ? (matches ? saved.wizard : { kind }) : null;
    const id = wizard ? (matches ? saved.id : null) ?? browser.crypto.randomUUID() : null;
    const maxStep = wizard?.kind === 'route'
      ? (wizard.publishOnly ? 0 : 3)
      : wizard?.kind === 'pages' ? 2 : 1;
    const requestedStep = Math.floor(Number(url.searchParams.get('step'))) || 0;
    return {
      page, wizard, id,
      step: wizard ? Math.min(maxStep, Math.max(0, requestedStep)) : 0,
      draft: drafts.get(id) ?? (wizard && saved?.id === id ? saved.draft : null) ?? {},
    };
  }
  let current = read();
  function write(next, method = 'replaceState') {
    current = next;
    if (next.id) drafts.set(next.id, next.draft);
    const hash = `#/${next.page.toLowerCase()}${next.wizard ? `/${next.wizard.kind}?step=${next.step}` : ''}`;
    browser.history[method]({ ...browser.history.state, proxyNavigation: next }, '', hash);
    for (const listener of listeners) listener();
  }
  const onPop = () => write(read());
  browser.addEventListener('popstate', onPop);
  browser.addEventListener('hashchange', onPop);
  write(current);
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setPage(page) {
      if (current.page === page && !current.wizard) return;
      write({ page, wizard: null, step: 0, draft: {}, id: null }, 'pushState');
    },
    setWizard(wizard) {
      write({
        ...current, wizard, step: 0, draft: {},
        id: wizard ? browser.crypto.randomUUID() : null,
      }, wizard ? 'pushState' : 'replaceState');
    },
    setStep(step) {
      if (step !== current.step) write({ ...current, step }, 'pushState');
    },
    setField(key, value, fallback) {
      const previous = current.draft[key] ?? fallback;
      write({
        ...current,
        draft: {
          ...current.draft,
          [key]: typeof value === 'function' ? value(previous) : value,
        },
      });
    },
  };
}

let navigation;
function store() {
  return navigation ??= createNavigation(window);
}
export function useNavigation() {
  const source = store();
  return {
    ...useSyncExternalStore(source.subscribe, source.getSnapshot),
    setPage: source.setPage, setWizard: source.setWizard, setStep: source.setStep,
  };
}
export function useWizardField(key, initial) {
  const { draft } = useNavigation();
  return [
    Object.hasOwn(draft, key) ? draft[key] : initial,
    (value) => store().setField(key, value, initial),
  ];
}
