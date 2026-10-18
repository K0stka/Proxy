import { useSyncExternalStore } from 'react';

const pages = ['Routes', 'Services', 'Folders', 'Domains', 'Settings'];
const kinds = ['route', 'folder', 'pages', 'domains'];

export function createNavigation(browser) {
  const listeners = new Set();
  const drafts = new Map();
  function read() {
    const legacy = browser.location.hash?.startsWith('#/') ? browser.location.hash.slice(1) : '';
    const url = new URL(legacy || `${browser.location.pathname}${browser.location.search}`, 'https://proxy.invalid');
    const [, section, action, name] = url.pathname.split('/');
    const kind = section === 'domains' && ['new', 'edit'].includes(action) ? 'domains' : action;
    const domainName = section === 'domains' && action === 'edit' ? name : null;
    const code = ['files', 'settings'].includes(section) && kind === 'pages' ? ([404, 500, 502].includes(Number(name)) ? Number(name) : 404) : null;
    const page = code !== null ? 'Settings' : section === 'files' ? 'Folders' : pages.find((name) => name.toLowerCase() === section) ?? 'Routes';
    const saved = browser.history.state?.proxyNavigation;
    const matches = (saved?.page === page || (saved?.page === 'Files' && ['Folders', 'Settings'].includes(page))) && saved.wizard?.kind === kind &&
      (!domainName || (saved.wizard.initial?.name ?? saved.wizard.domainName) === domainName) &&
      (code === null || (saved.wizard.code ?? 404) === code) &&
      !(section === 'domains' && action === 'new' && saved.wizard?.initial);
    const wizard = kinds.includes(kind) ? (matches ? saved.wizard : { kind, domainName, ...(code ? { code } : {}) }) : null;
    const id = wizard ? (matches ? saved.id : null) ?? browser.crypto.randomUUID() : null;
    const maxStep = wizard?.kind === 'route'
      ? (wizard.publishOnly ? 0 : 3)
      : 1;
    const requestedStep = Math.floor(Number(url.searchParams.get('step'))) || 0;
    return {
      page, wizard, id,
      settingsSection: code !== null ? 'error-pages' : page === 'Settings' && ['general', 'certificates', 'error-pages', 'access', 'backup'].includes(kind) ? kind : 'general',
      step: wizard ? Math.min(maxStep, Math.max(0, requestedStep)) : 0,
      draft: drafts.get(id) ?? (wizard && saved?.id === id ? saved.draft : null) ?? {},
    };
  }
  let current = read();
  function write(next, method = 'replaceState') {
    current = next;
    if (next.id) drafts.set(next.id, next.draft);
    const domainName = next.wizard?.initial?.name ?? next.wizard?.domainName;
    const wizardPath = next.wizard?.kind === 'domains'
      ? domainName ? `/edit/${domainName}` : '/new'
      : next.wizard?.kind === 'pages' ? `/pages/${next.wizard.code ?? 404}` : `/${next.wizard?.kind}`;
    const path = `/${next.page.toLowerCase()}${next.wizard ? `${wizardPath}?step=${next.step}` : next.page === 'Settings' ? `/${next.settingsSection ?? 'general'}` : ''}`;
    browser.history[method]({ ...browser.history.state, proxyNavigation: next }, '', path);
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
      write({ page, wizard: null, step: 0, draft: {}, id: null, settingsSection: 'general' }, 'pushState');
    },
    setWizard(wizard) {
      write({
        ...current, wizard, step: 0, draft: {},
        ...(wizard?.kind === 'pages' ? { page: 'Settings', settingsSection: 'error-pages' } : {}),
        id: wizard ? browser.crypto.randomUUID() : null,
      }, wizard ? 'pushState' : 'replaceState');
    },
    setStep(step) {
      if (step !== current.step) write({ ...current, step }, 'pushState');
    },
    setSettingsSection(settingsSection) {
      write({ ...current, settingsSection }, 'pushState');
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
    setSettingsSection: source.setSettingsSection,
  };
}
export function useWizardField(key, initial) {
  const { draft } = useNavigation();
  return [
    Object.hasOwn(draft, key) ? draft[key] : initial,
    (value) => store().setField(key, value, initial),
  ];
}
