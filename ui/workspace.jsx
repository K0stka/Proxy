import React, { useState, useEffect } from 'react';
import {
  Waypoints,
  ShieldCheck,
  ArrowUpRight,
  Plus,
  Server,
  Globe,
  FolderOpen,
  Cable,
  Radio,
  RefreshCw,
  X,
  LogOut,
  Trash2,
  Pencil,
  ChevronRight,
} from 'lucide-react';
import { api } from './api.js';
import { freshRoute, folderRules, listener, destination, portLabel } from './routes.js';
import { RouteWizard, ErrorPagesWizard } from './wizards.jsx';
import Settings from './settings.jsx';
import Modal from './dialog.jsx';
import Folders, { FolderWizard } from './folders.jsx';
import DomainWizard from './domains-wizard.jsx';
import { useNavigation } from './navigation.js';

const when = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
const icons = { http: Globe, static: FolderOpen, tcp: Cable, udp: Radio };

export default function Workspace({ onLogout, onRecovery }) {
  const { page, setPage, wizard, setWizard } = useNavigation();
  const [state, setState] = useState(null),
    [filter, setFilter] = useState('all'),
    [notice, setNotice] = useState(null),
    [confirmation, setConfirmation] = useState(null),
    [working, setWorking] = useState(false),
    [catalog, setCatalog] = useState({ folders: [], error: null });
  const report = (message, error = false) => setNotice(error ? { message } : null);
  async function refresh() {
    try {
      setState(await api('/state'));
    } catch (e) {
      if (e.status === 401) onLogout();
      else report(e.message, true);
    }
  }
  async function loadFiles() {
    try {
      setCatalog(await api('/sites'));
    } catch (e) {
      setCatalog({ folders: [], error: e.message });
    }
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (page === 'Files') loadFiles();
  }, [page]);
  async function action(route, op) {
    setWorking(true);
    try {
      await api(`/routes/${route.id}/${op}`, { method: 'POST' });
      await refresh();
      report(
        op === 'sync'
          ? 'Files synced'
          : op === 'disable'
            ? 'Disabled · connections may drain for 30s'
            : 'Done',
      );
    } catch (e) {
      report(e.message, true);
    } finally {
      setWorking(false);
    }
  }
  async function remove() {
    setWorking(true);
    try {
      await api(`/routes/${confirmation.id}`, { method: 'DELETE' });
      setConfirmation(null);
      await refresh();
      report('Draft deleted');
    } catch (e) {
      report(e.message, true);
    } finally {
      setWorking(false);
    }
  }
  function connect(service, port) {
    setWizard({
      kind: 'route',
      initial: {
        ...freshRoute(state),
        name: service.name,
        kind: port.protocol === 'udp' ? 'udp' : 'http',
        targetHost: port.targetHost,
        targetPort: port.hostPort,
        portStart: port.hostPort,
        portEnd: port.hostPort,
        source: {
          server: service.server,
          container: service.name,
          containerId: service.containerId,
          containerPort: port.containerPort,
        },
      },
    });
  }
  function hostFolder(directory) {
    setWizard({
      kind: 'route',
      initial: {
        ...freshRoute(state),
        name: directory.split('/').at(-1),
        kind: 'static',
        staticSite: folderRules(state, directory),
      },
    });
  }
  async function saved(message) {
    setWizard(null);
    await refresh();
    report(message);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  if (!state)
    return (
      <div className="loading">
        <Waypoints />
        Loading…{notice && <p role="alert">{notice.message}</p>}
      </div>
    );
  if (wizard?.kind === 'route')
    return (
      <RouteWizard
        initial={wizard.initial ?? freshRoute(state)}
        state={state}
        publishOnly={wizard.publishOnly}
        onClose={() => setWizard(null)}
        onSaved={saved}
      />
    );
  if (wizard?.kind === 'folder')
    return (
      <FolderWizard
        initial={wizard.initial}
        onClose={() => setWizard(null)}
        onSaved={async (message) => {
          await saved(message);
          await loadFiles();
        }}
      />
    );
  if (wizard?.kind === 'pages')
    return <ErrorPagesWizard code={wizard.code ?? 404} state={state} onClose={() => setWizard(null)} onSaved={saved} />;
  if (wizard?.kind === 'domains')
    return <DomainWizard initial={wizard.initial ?? state.settings.domains.find((d) => d.name === wizard.domainName)} emailConfigured={Boolean(state.settings.certificates.email)} onClose={() => setWizard(null)} onSaved={saved} />;
  const edgeReady = state.edge.available === true;
  const portServices = state.discovery.services.filter((service) => service.ports.length > 0);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Waypoints />
          proxy
        </div>
        <nav aria-label="Main navigation">
          {[
            ['Routes', Waypoints],
            ['Services', Server],
            ['Files', FolderOpen],
            ['Domains', Globe],
            ['Settings', ShieldCheck],
          ].map(([name, Icon]) => (
            <button
              key={name}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => setPage(name)}
            >
              <Icon size={18} />
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="text-button"
            onClick={async () => {
              try {
                await api('/auth/logout', { method: 'POST' });
                onLogout();
              } catch (e) {
                report(e.message, true);
              }
            }}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="workspace">
        <main>
          <div className="page-heading">
            <h1>{page}</h1>
            {page === 'Routes' && (
              <button
                className="primary"
                onClick={() => setWizard({ kind: 'route', initial: freshRoute(state) })}
              >
                <Plus size={17} />
                New route
              </button>
            )}
            {page === 'Domains' && (
              <button className="primary" onClick={() => setWizard({ kind: 'domains' })}>
                <Plus size={17} />
                Add domain
              </button>
            )}
            {['Services', 'Files'].includes(page) && (
              <button
                className="secondary"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  try {
                    if (page === 'Files') await loadFiles();
                    else {
                      await api('/discovery/refresh', { method: 'POST' });
                      await refresh();
                    }
                  } catch (e) {
                    report(e.message, true);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                <RefreshCw size={15} />
                Refresh
              </button>
            )}
          </div>
          {notice && (
            <div
              className="notice dismissible error"
              role="alert"
            >
              <span>{notice.message}</span>
              <button
                className="icon-button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notice"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {state.edge.error && (
            <div className="notice error" role="alert">
              {state.edge.error}
            </div>
          )}
          {!edgeReady && !state.edge.error && (
            <div className="notice error" role="alert">Edge unavailable</div>
          )}
          {edgeReady && !state.edge.inSync && (
            <div className="notice error" role="alert">
              Configuration out of sync.
              <button
                className="secondary"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  try {
                    await api('/reconcile', { method: 'POST' });
                    await refresh();
                  } catch (e) {
                    report(e.message, true);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                Retry
              </button>
            </div>
          )}
          {page === 'Routes' && (
            <>
              <div className="routes-toolbar">
                <div className="filter-tabs" aria-label="Route filter">
                  {[
                    ['all', 'All'],
                    ['http', 'Websites'],
                    ['static', 'Static'],
                    ['tcp', 'TCP'],
                    ['udp', 'UDP'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="route-list">
                {state.routes
                  .filter((r) => filter === 'all' || r.kind === filter)
                  .map((route) => {
                    const Icon = icons[route.kind];
                    return (
                      <article className="route-row" key={route.id}>
                        <div className="service-icon">
                          <Icon size={20} />
                        </div>
                        <button
                          className="route-info"
                          onClick={() => setWizard({ kind: 'route', initial: route })}
                        >
                          <strong>{listener(route)}</strong>
                          <span>
                            {route.name}
                            <span className="inline-arrow">→</span>
                            {destination(route)}
                          </span>
                        </button>
                        <div className="route-actions">
                          <span className="status-text">
                            {route.published
                              ? edgeReady && state.edge.inSync
                                ? 'Published'
                                : 'Unverified'
                              : 'Draft'}
                          </span>
                          <button
                            className="secondary small"
                            onClick={() => setWizard({ kind: 'route', initial: route })}
                            aria-label={`Edit ${route.name}`}
                          >
                            <Pencil size={14} />
                          </button>
                          {route.published ? (
                            <>
                              {route.kind === 'static' && (
                                <button
                                  className="secondary small"
                                  disabled={!edgeReady || working}
                                  onClick={() => action(route, 'sync')}
                                >
                                  <RefreshCw size={13} />
                                  Sync files
                                </button>
                              )}
                              <button
                                className="secondary small"
                                disabled={working || !edgeReady}
                                onClick={() => action(route, 'disable')}
                              >
                                Disable
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="secondary small"
                                disabled={!edgeReady || working}
                                onClick={() =>
                                  setWizard({ kind: 'route', initial: route, publishOnly: true })
                                }
                              >
                                Publish
                                <ArrowUpRight size={14} />
                              </button>
                              <button
                                className="icon-button"
                                onClick={() => setConfirmation(route)}
                                aria-label={`Delete ${route.name}`}
                              >
                                <Trash2 size={15} />
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                {!state.routes.some((r) => filter === 'all' || r.kind === filter) && (
                  <div className="empty-state">
                    <Waypoints size={28} />
                    <h2>No routes</h2>
                    <button
                      className="secondary"
                      onClick={() => setWizard({ kind: 'route', initial: freshRoute(state) })}
                    >
                      <Plus size={15} />
                      Create route
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {page === 'Services' && (
            <>
              {state.discovery.error && <div className="notice">{state.discovery.error}</div>}
              <div className="inventory-status">
                {state.discovery.stale && <span>Discovery out of date</span>}
                <span>Updated {when(state.discovery.lastSuccess)}</span>
              </div>
              {state.discovery.servers.filter((server) => server.error || portServices.some((s) => s.server === server.id)).map((server) => (
                <section className="server-group" key={server.id}>
                  <h2>
                    <Server size={18} />
                    {server.name}
                    <code>{server.address}</code>
                  </h2>
                  {server.error && <div className="notice">{server.error}</div>}
                  {portServices
                    .filter((s) => s.server === server.id)
                    .map((service) => (
                      <article
                        className="discovered-service"
                        key={`${service.server}:${service.containerId}:${service.name}`}
                      >
                        <div className="service-heading">
                          <strong>{service.name}</strong>
                          {service.state !== 'running' && (
                            <span className="status-text">{service.state}</span>
                          )}
                        </div>
                        {service.ports.map((port, i) => (
                          <div className="port-row" key={i}>
                            <code>{portLabel(port)}</code>
                            {!port.usable && <span className="hint">{port.reason}</span>}
                            <button
                              className="secondary small"
                              disabled={!port.usable || service.state !== 'running'}
                              onClick={() => connect(service, port)}
                            >
                              Connect
                              <ChevronRight size={14} />
                            </button>
                          </div>
                        ))}
                      </article>
                    ))}
                </section>
              ))}
              {!portServices.length && !state.discovery.error && (
                <div className="empty-state"><Server size={28} /><h2>No services with ports</h2></div>
              )}
            </>
          )}
          {page === 'Files' && (
            <>
              <section className="error-pages-section" aria-label="Error pages">
                <h2>Error pages</h2>
                <div className="error-pages-grid">
                {[
                  ['404', state.pages.notFoundSite, state.pages.notFoundDocument],
                  ['502', state.pages.badGatewaySite, state.pages.badGatewayDocument],
                ].map(([code, site, document]) => (
                  <article className="error-page-card" key={code}>
                    <div className="error-page-heading">
                      <div><span className="error-page-code">{code}</span><h3>{code === '404' ? 'Not found' : 'Service unavailable'}</h3></div>
                      <button className="secondary" aria-label={`Edit ${code} page`} onClick={() => setWizard({ kind: 'pages', code: Number(code) })}>
                        <Pencil size={14} /> Edit
                      </button>
                    </div>
                    <code>{site ? `/sites/${site.directory}/${document}` : 'Built-in page'}</code>
                  </article>
                ))}
                </div>
              </section>
              <Folders
                catalog={catalog}
                onHost={hostFolder}
                onCreate={() => setWizard({ kind: 'folder' })}
                onEdit={(initial) => setWizard({ kind: 'folder', initial })}
                onSaved={async (message) => {
                  await refresh();
                  await loadFiles();
                  report(message);
                }}
              />
            </>
          )}
          {page === 'Domains' && !state.domains.length && (
            <div className="empty-state">
              <Globe size={28} />
              <h2>No domains</h2>
            </div>
          )}
          {page === 'Domains' && (
            <div className="domain-grid">
              {state.domains.map((d) => (
                <section className="domain-card" key={d.name}>
                  <div className="section-title">
                    <Globe size={22} />
                    <span className="status-text">
                      {d.staging ? 'Staging' : d.ready ? 'Ready' : 'Pending'}
                    </span>
                  </div>
                  <h2>{d.name}</h2>
                  <code>{d.subdomains ? `${d.name}, *.${d.name}` : d.name}</code>
                  <div className="domain-facts">
                    <div>
                      <span>Expires</span>
                      <strong>{when(d.expires)}</strong>
                    </div>
                    <div>
                      <span>Last check</span>
                      <strong>{when(d.lastCheck)}</strong>
                    </div>
                  </div>
                  {d.staging && (
                    <p className="hint">Test certificate. Disable staging in Settings to publish.</p>
                  )}
                  {d.error && (
                    <p className="error-text" role="alert">
                      {d.error}
                    </p>
                  )}
                  <div className="domain-actions">
                  <button className="secondary" onClick={() => setWizard({ kind: 'domains', initial: { name: d.name, subdomains: d.subdomains } })}>
                    <Pencil size={15} /> Edit
                  </button>
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        await api('/certificates/retry', {
                          method: 'POST',
                          body: { domain: d.name },
                        });
                        report('Check queued');
                      } catch (e) {
                        report(e.message, true);
                      }
                    }}
                  >
                    <RefreshCw size={15} />
                    Check
                  </button>
                  <button className="icon-button" aria-label={`Delete ${d.name}`} onClick={async () => {
                    try {
                      await api(`/domains/${encodeURIComponent(d.name)}`, { method: 'DELETE' });
                      await refresh();
                    } catch (e) { report(e.message, true); }
                  }}><Trash2 size={15} /></button>
                  </div>
                </section>
              ))}
            </div>
          )}
          {page === 'Settings' && (
            <Settings
              state={state}
              refresh={refresh}
              report={report}
              onRecovery={onRecovery}
              onLogout={onLogout}
            />
          )}
        </main>
      </div>
      {confirmation && (
        <Modal title="Delete draft?" onClose={() => !working && setConfirmation(null)}>
          <p>{confirmation.name}</p>
          <div className="dialog-actions">
            <button className="secondary" disabled={working} onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button className="primary" disabled={working} onClick={remove}>
              {working ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
