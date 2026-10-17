import { Button } from './controls.jsx';
import { Alert, Paper, NavLink, Menu, Switch } from '@mantine/core';
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
import {
  freshRoute,
  folderRules,
  listener,
  destination,
  portLabel,
  visibleServicePorts,
  serviceProxies,
} from './routes.js';
import { RouteWizard, ErrorPagesWizard } from './wizards.jsx';
import Settings from './settings.jsx';
import Modal from './dialog.jsx';
import Folders, { FolderWizard } from './folders.jsx';
import DomainWizard from './domains-wizard.jsx';
import { useNavigation } from './navigation.js';
const when = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
const icons = {
  http: Globe,
  static: FolderOpen,
  tcp: Cable,
  udp: Radio,
};
export default function Workspace({ onLogout, onRecovery }) {
  const { page, setPage, wizard, setWizard } = useNavigation();
  const [state, setState] = useState(null),
    [filter, setFilter] = useState('all'),
    [notice, setNotice] = useState(null),
    [confirmation, setConfirmation] = useState(null),
    [working, setWorking] = useState(false),
    [catalog, setCatalog] = useState({
      folders: [],
      error: null,
    });
  const report = (message, error = false) =>
    setNotice(
      error
        ? {
            message,
          }
        : null,
    );
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
      setCatalog({
        folders: [],
        error: e.message,
      });
    }
  }
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    window.scrollTo({
      top: 0,
      behavior: 'instant',
    });
    if (page === 'Files') loadFiles();
  }, [page]);
  async function action(route, op) {
    setWorking(true);
    try {
      await api(`/routes/${route.id}/${op}`, {
        method: 'POST',
      });
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
      await api(`/routes/${confirmation.id}`, {
        method: 'DELETE',
      });
      setConfirmation(null);
      await refresh();
      report('Route deleted');
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
    window.scrollTo({
      top: 0,
      behavior: 'instant',
    });
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
    return (
      <ErrorPagesWizard
        code={wizard.code ?? 404}
        state={state}
        onClose={() => setWizard(null)}
        onSaved={saved}
      />
    );
  if (wizard?.kind === 'domains')
    return (
      <DomainWizard
        initial={wizard.initial ?? state.settings.domains.find((d) => d.name === wizard.domainName)}
        emailConfigured={Boolean(state.settings.certificates.email)}
        onClose={() => setWizard(null)}
        onSaved={saved}
      />
    );
  const edgeReady = state.edge.available === true;
  const portServices = state.discovery.services
    .map((service) => ({ ...service, ports: visibleServicePorts(service) }))
    .filter((service) => service.ports.length > 0);
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
            <NavLink
              component="button"
              type="button"
              key={name}
              label={name}
              leftSection={<Icon size={18} />}
              active={page === name}
              aria-current={page === name ? 'page' : undefined}
              onClick={() => setPage(name)}
            />
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Button
            className="text-button"
            onClick={async () => {
              try {
                await api('/auth/logout', {
                  method: 'POST',
                });
                onLogout();
              } catch (e) {
                report(e.message, true);
              }
            }}
          >
            <LogOut size={14} />
            Sign out
          </Button>
        </div>
      </aside>
      <div className="workspace">
        <main>
          <div className="page-heading">
            <h1>{page}</h1>
            {page === 'Routes' && (
              <Button
                className="primary"
                onClick={() =>
                  setWizard({
                    kind: 'route',
                    initial: freshRoute(state),
                  })
                }
              >
                <Plus size={17} />
                New route
              </Button>
            )}
            {page === 'Domains' && (
              <Button
                className="primary"
                onClick={() =>
                  setWizard({
                    kind: 'domains',
                  })
                }
              >
                <Plus size={17} />
                Add domain
              </Button>
            )}
            {['Services', 'Files'].includes(page) && (
              <Button
                className="secondary"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  try {
                    if (page === 'Files') await loadFiles();
                    else {
                      await api('/discovery/refresh', {
                        method: 'POST',
                      });
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
              </Button>
            )}
          </div>
          {notice && (
            <Alert className="notice dismissible error" role="alert" color="red" variant="light">
              <span>{notice.message}</span>
              <Button
                className="icon-button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss notice"
              >
                <X size={16} />
              </Button>
            </Alert>
          )}
          {state.edge.error && (
            <Alert className="notice error" role="alert" color="red" variant="light">
              {state.edge.error}
            </Alert>
          )}
          {!edgeReady && !state.edge.error && (
            <Alert className="notice error" role="alert" color="red" variant="light">
              Edge unavailable
            </Alert>
          )}
          {edgeReady && !state.edge.inSync && (
            <Alert className="notice error" role="alert" color="red" variant="light">
              Configuration out of sync.
              <Button
                className="secondary"
                disabled={working}
                onClick={async () => {
                  setWorking(true);
                  try {
                    await api('/reconcile', {
                      method: 'POST',
                    });
                    await refresh();
                  } catch (e) {
                    report(e.message, true);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                Retry
              </Button>
            </Alert>
          )}
          {page === 'Routes' && (
            <>
              <div className="routes-toolbar">
                <div className="filter-tabs" aria-label="Route filter">
                  {[
                    ['all', 'All'],
                    ['http', 'Services'],
                    ['static', 'Static'],
                    ['tcp', 'TCP'],
                    ['udp', 'UDP'],
                  ].map(([value, label]) => (
                    <Button
                      key={value}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="route-list">
                {state.routes
                  .filter((r) => filter === 'all' || r.kind === filter)
                  .map((route) => {
                    const Icon = icons[route.kind];
                    return (
                      <Paper
                        className={`route-row ${route.published ? 'proxy-enabled' : 'proxy-disabled'}`}
                        key={route.id}
                        component="article"
                        withBorder={true}
                        p="md"
                      >
                        <Switch
                          checked={route.published}
                          disabled={working || !edgeReady}
                          aria-label={`${route.published ? 'Disable' : 'Enable'} ${route.name}`}
                          onChange={() => action(route, route.published ? 'disable' : 'publish')}
                        />
                        <div className="service-icon">
                          <Icon size={20} />
                        </div>
                        <Button
                          className="route-info"
                          onClick={() =>
                            setWizard({
                              kind: 'route',
                              initial: route,
                            })
                          }
                        >
                          <strong>{listener(route)}</strong>
                          <span>
                            {route.name}
                            <span className="inline-arrow">→</span>
                            {destination(route)}
                          </span>
                        </Button>
                        <div className="route-actions">
                          <Button
                            className="secondary small"
                            onClick={() =>
                              setWizard({
                                kind: 'route',
                                initial: route,
                              })
                            }
                            aria-label={`Edit ${route.name}`}
                          >
                            <Pencil size={14} />
                          </Button>
                          {route.published ? (
                            <>
                              {route.kind === 'static' && (
                                <Button
                                  className="secondary small"
                                  disabled={!edgeReady || working}
                                  onClick={() => action(route, 'sync')}
                                >
                                  <RefreshCw size={13} />
                                  Sync files
                                </Button>
                              )}
                            </>
                          ) : (
                            <>
                              <Button
                                className="icon-button"
                                onClick={() => setConfirmation(route)}
                                aria-label={`Delete ${route.name}`}
                              >
                                <Trash2 size={15} />
                              </Button>
                            </>
                          )}
                        </div>
                      </Paper>
                    );
                  })}
                {!state.routes.some((r) => filter === 'all' || r.kind === filter) && (
                  <div className="empty-state">
                    <Waypoints size={28} />
                    <h2>No routes</h2>
                    <Button
                      className="secondary"
                      onClick={() =>
                        setWizard({
                          kind: 'route',
                          initial: freshRoute(state),
                        })
                      }
                    >
                      <Plus size={15} />
                      Create route
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
          {page === 'Services' && (
            <>
              {state.discovery.error && (
                <Alert className="notice" color="blue" variant="light">
                  {state.discovery.error}
                </Alert>
              )}
              <div className="inventory-status">
                {state.discovery.stale && <span>Discovery out of date</span>}
                <span>Updated {when(state.discovery.lastSuccess)}</span>
              </div>
              {state.discovery.servers
                .filter(
                  (server) => server.error || portServices.some((s) => s.server === server.id),
                )
                .map((server) => (
                  <section className="server-group" key={server.id}>
                    <h2>
                      <Server size={18} />
                      {server.name}
                      <code>{server.address}</code>
                    </h2>
                    {server.error && (
                      <Alert className="notice" color="blue" variant="light">
                        {server.error}
                      </Alert>
                    )}
                    <div className="service-grid">
                      {portServices
                        .filter((s) => s.server === server.id)
                        .map((service) => (
                          <Paper
                            className={`discovered-service${service.ports.some((port) => serviceProxies(state.routes, service, port).length) ? ' proxied' : ''}${service.ports.some((port) => serviceProxies(state.routes, service, port).some((route) => route.published)) ? ' proxy-enabled' : ''}`}
                            key={`${service.server}:${service.containerId}:${service.name}`}
                            component="article"
                            withBorder={true}
                            p="lg"
                          >
                            <div className="service-heading">
                              <strong>{service.name}</strong>
                              {service.state !== 'running' && (
                                <span className="status-text">{service.state}</span>
                              )}
                            </div>
                            {service.ports.map((port, i) => {
                              const proxies = serviceProxies(state.routes, service, port);
                              const edit = (route) => setWizard({ kind: 'route', initial: route });
                              const button = (
                                <Button
                                  className="secondary small"
                                  disabled={!proxies.length && service.state !== 'running'}
                                  onClick={
                                    proxies.length > 1
                                      ? undefined
                                      : () =>
                                          proxies.length ? edit(proxies[0]) : connect(service, port)
                                  }
                                >
                                  {proxies.length ? 'Edit proxy' : 'Create proxy'}
                                  <ChevronRight size={14} />
                                </Button>
                              );
                              return (
                                <div className="port-row" key={i}>
                                  <code>{portLabel(port)}</code>
                                  {!port.usable && <span className="hint">{port.reason}</span>}
                                  {proxies.length > 1 ? (
                                    <Menu position="bottom-end" withinPortal>
                                      <Menu.Target>{button}</Menu.Target>
                                      <Menu.Dropdown>
                                        {proxies.map((route) => (
                                          <Menu.Item key={route.id} onClick={() => edit(route)}>
                                            {route.name} · {listener(route)}
                                          </Menu.Item>
                                        ))}
                                      </Menu.Dropdown>
                                    </Menu>
                                  ) : (
                                    button
                                  )}
                                </div>
                              );
                            })}
                          </Paper>
                        ))}
                    </div>
                  </section>
                ))}
              {!portServices.length && !state.discovery.error && (
                <div className="empty-state">
                  <Server size={28} />
                  <h2>No services with published ports</h2>
                </div>
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
                    <Paper
                      className="error-page-card"
                      key={code}
                      component="article"
                      withBorder={true}
                      p="lg"
                    >
                      <div className="error-page-heading">
                        <div>
                          <span className="error-page-code">{code}</span>
                          <h3>{code === '404' ? 'Not found' : 'Service unavailable'}</h3>
                        </div>
                        <Button
                          className="secondary"
                          aria-label={`Edit ${code} page`}
                          onClick={() =>
                            setWizard({
                              kind: 'pages',
                              code: Number(code),
                            })
                          }
                        >
                          <Pencil size={14} /> Edit
                        </Button>
                      </div>
                      <code>{site ? `/sites/${site.directory}/${document}` : 'Built-in page'}</code>
                    </Paper>
                  ))}
                </div>
              </section>
              <Folders
                catalog={catalog}
                onHost={hostFolder}
                onCreate={() =>
                  setWizard({
                    kind: 'folder',
                  })
                }
                onEdit={(initial) =>
                  setWizard({
                    kind: 'folder',
                    initial,
                  })
                }
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
                <Paper
                  className="domain-card"
                  key={d.name}
                  component="section"
                  withBorder={true}
                  p="lg"
                >
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
                    <p className="hint">
                      Test certificate. Disable staging in Settings to enable routes.
                    </p>
                  )}
                  {d.error && (
                    <p className="error-text" role="alert">
                      {d.error}
                    </p>
                  )}
                  <div className="domain-actions">
                    <Button
                      className="secondary"
                      onClick={() =>
                        setWizard({
                          kind: 'domains',
                          initial: {
                            name: d.name,
                            subdomains: d.subdomains,
                          },
                        })
                      }
                    >
                      <Pencil size={15} /> Edit
                    </Button>
                    <Button
                      className="secondary"
                      onClick={async () => {
                        try {
                          await api('/certificates/retry', {
                            method: 'POST',
                            body: {
                              domain: d.name,
                            },
                          });
                          report('Check queued');
                        } catch (e) {
                          report(e.message, true);
                        }
                      }}
                    >
                      <RefreshCw size={15} />
                      Check
                    </Button>
                    <Button
                      className="icon-button"
                      aria-label={`Delete ${d.name}`}
                      onClick={async () => {
                        try {
                          await api(`/domains/${encodeURIComponent(d.name)}`, {
                            method: 'DELETE',
                          });
                          await refresh();
                        } catch (e) {
                          report(e.message, true);
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </Paper>
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
        <Modal title="Delete route?" onClose={() => !working && setConfirmation(null)}>
          <p>{confirmation.name}</p>
          <div className="dialog-actions">
            <Button className="secondary" disabled={working} onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button className="primary" disabled={working} onClick={remove}>
              {working ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
