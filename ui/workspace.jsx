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
  LockKeyhole,
  ChevronRight,
} from 'lucide-react';
import { api } from './api.js';
import { freshRoute, folderRules, listener, destination, portLabel } from './routes.js';
import { RouteWizard, ErrorPagesWizard } from './wizards.jsx';
import Settings from './settings.jsx';
import Modal from './dialog.jsx';
import Folders, { FolderWizard } from './folders.jsx';
import DomainsWizard from './domains-wizard.jsx';

const when = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
const icons = { http: Globe, static: FolderOpen, tcp: Cable, udp: Radio };

export default function Workspace({ onLogout, onRecovery }) {
  const [state, setState] = useState(null),
    [page, setPage] = useState('Routes'),
    [wizard, setWizard] = useState(null),
    [filter, setFilter] = useState('all'),
    [notice, setNotice] = useState(null),
    [confirmation, setConfirmation] = useState(null),
    [working, setWorking] = useState(false),
    [catalog, setCatalog] = useState({ folders: [], error: null });
  const report = (message, error = false) => setNotice({ message, error });
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
        initial={wizard.initial}
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
    return <ErrorPagesWizard state={state} onClose={() => setWizard(null)} onSaved={saved} />;
  if (wizard?.kind === 'domains')
    return <DomainsWizard state={state} onClose={() => setWizard(null)} onSaved={saved} />;
  const live = state.routes.filter((r) => r.published).length,
    edgeReady = state.edge.available === true;
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
              {name === 'Routes' && <span className="nav-count">{state.routes.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={edgeReady ? 'dot' : 'dot offline'} />
            {edgeReady ? 'Edge online' : 'Edge offline'}
          </div>
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
        <header className="topbar">
          <span>
            <LockKeyhole size={14} />
            {new URL(state.policy.origin).hostname}
          </span>
        </header>
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
                Manage domains
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
              className={`notice dismissible ${notice.error ? 'error' : 'success'}`}
              role={notice.error ? 'alert' : 'status'}
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
          {edgeReady && !state.edge.inSync && (
            <div className="notice error" role="alert">
              Configuration out of sync. Reapply from Settings.
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
                <span className="hint">
                  {live} published · {state.routes.length - live} drafts
                </span>
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
                          <span
                            className={`badge ${route.published ? (edgeReady && state.edge.inSync ? 'green' : 'amber') : 'muted'}`}
                          >
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
                <span className={`badge ${state.discovery.stale ? 'amber' : 'green'}`}>
                  {state.discovery.stale ? 'Stale' : 'Current'}
                </span>
                <span>{when(state.discovery.lastSuccess)}</span>
              </div>
              {state.discovery.servers.map((server) => (
                <section className="server-group" key={server.id}>
                  <h2>
                    <Server size={18} />
                    {server.name}
                    <code>{server.address}</code>
                  </h2>
                  {server.error && <div className="notice">{server.error}</div>}
                  {state.discovery.services
                    .filter((s) => s.server === server.id)
                    .map((service) => (
                      <article
                        className="discovered-service"
                        key={`${service.server}:${service.containerId}:${service.name}`}
                      >
                        <div className="service-heading">
                          <strong>{service.name}</strong>
                          <span
                            className={`badge ${service.state === 'running' ? 'green' : 'muted'}`}
                          >
                            {service.state}
                          </span>
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
                        {!service.ports.length && <p className="hint">No host ports</p>}
                      </article>
                    ))}
                  {!state.discovery.services.some((s) => s.server === server.id) && (
                    <p className="quiet-empty">No services</p>
                  )}
                </section>
              ))}
            </>
          )}
          {page === 'Files' && (
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
          )}
          {page === 'Domains' && !state.domains.length && (
            <div className="empty-state">
              <Globe size={28} />
              <h2>No domains</h2>
              <p>Choose Manage domains to add one.</p>
            </div>
          )}
          {page === 'Domains' && (
            <div className="domain-grid">
              {state.domains.map((d) => (
                <section className="domain-card" key={d.name}>
                  <div className="section-title">
                    <Globe size={22} />
                    <span className={`badge ${d.ready && !d.staging ? 'green' : 'amber'}`}>
                      {d.staging ? 'Staging' : d.ready ? 'Ready' : 'Pending'}
                    </span>
                  </div>
                  <h2>{d.name}</h2>
                  <code>*.{d.name}</code>
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
                    <p className="hint">Test certificate. Switch staging off before publishing.</p>
                  )}
                  {d.error && (
                    <p className="error-text" role="alert">
                      {d.error}
                    </p>
                  )}
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
              onEditPages={() => setWizard({ kind: 'pages' })}
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
