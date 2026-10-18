import { Button } from './controls.jsx';
import { Alert, Paper, NavLink, Menu, Switch, Tooltip } from '@mantine/core';
import React, { useState, useEffect, useRef } from 'react';
import {
  Waypoints,
  Settings as SettingsIcon,
  Plus,
  Server,
  Globe,
  FolderOpen,
  Cable,
  Radio,
  RefreshCw,
  LogOut,
  Trash2,
  Pencil,
  ArrowRight,
  CornerUpRight,
} from 'lucide-react';
import { api } from './api.js';
import { useToast } from './toasts.jsx';
import { byName } from './order.js';
import {
  freshRoute,
  listener,
  destination,
  destinationLabel,
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
  redirect: CornerUpRight,
  tcp: Cable,
  udp: Radio,
};
export default function Workspace({ onLogout }) {
  const { page, setPage, wizard, setWizard } = useNavigation();
  const [state, setState] = useState(null),
    [filter, setFilter] = useState('all'),
    [confirmation, setConfirmation] = useState(null),
    [working, setWorking] = useState(false),
    [catalog, setCatalog] = useState({
      folders: [],
      error: null,
    });
  const report = useToast();
  const content = useRef(null);
  async function refresh() {
    try {
      const next = await api('/state');
      setState({
        ...next,
        routes: next.routes.toSorted(byName),
        sites: next.sites.toSorted(byName),
        domains: next.domains.toSorted(byName),
        discovery: {
          ...next.discovery,
          servers: next.discovery.servers.toSorted(byName),
          services: next.discovery.services.toSorted(byName),
        },
      });
    } catch (e) {
      if (e.status === 401) onLogout();
      else report(e.message, true);
    }
  }
  async function loadFolders() {
    try {
      const next = await api('/sites');
      setCatalog({ ...next, folders: next.folders.toSorted(byName) });
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
    content.current?.scrollTo({
      top: 0,
      behavior: 'instant',
    });
    if (page === 'Folders') loadFolders();
  }, [page, wizard]);
  async function action(route, op) {
    setWorking(true);
    try {
      await api(`/routes/${route.id}/${op}`, {
        method: 'POST',
      });
      await refresh();
      report(op === 'disable' ? 'Proxy disabled' : 'Proxy enabled');
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
  async function saved(message) {
    setWizard(null);
    await refresh();
    report(message);
    content.current?.scrollTo({
      top: 0,
      behavior: 'instant',
    });
  }
  if (!state)
    return (
      <div className="loading">
        <Waypoints />
        Loading…
      </div>
    );
  let flow = null;
  if (wizard?.kind === 'route')
    flow = (
      <RouteWizard
        initial={wizard.initial ?? freshRoute(state)}
        state={state}
        publishOnly={wizard.publishOnly}
        onClose={() => setWizard(null)}
        onSaved={saved}
      />
    );
  if (wizard?.kind === 'folder')
    flow = (
      <FolderWizard
        initial={wizard.initial}
        onClose={() => setWizard(null)}
        onSaved={async (message) => {
          await saved(message);
          await loadFolders();
        }}
      />
    );
  if (wizard?.kind === 'pages')
    flow = (
      <ErrorPagesWizard
        code={wizard.code ?? 404}
        state={state}
        onClose={() => setWizard(null)}
        onSaved={saved}
      />
    );
  if (wizard?.kind === 'domains')
    flow = (
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
          <span className="brand-mark">
            <Waypoints />
          </span>
          Proxy
        </div>
        <nav aria-label="Main navigation">
          {[
            ['Routes', Waypoints],
            ['Services', Server],
            ['Folders', FolderOpen],
            ['Domains', Globe],
            ['Settings', SettingsIcon],
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
            aria-label="Sign out"
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
            <span>Sign out</span>
          </Button>
        </div>
      </aside>
      <div className="workspace" ref={content}>
        {flow ?? (
          <main className={page === 'Settings' ? 'settings-main' : undefined}>
            <div className="page-heading">
              <h1>{page}</h1>
              {page === 'Routes' && (
                <div className="routes-toolbar">
                  <div className="filter-tabs" aria-label="Route filter">
                    {[
                      ['all', 'All'],
                      ['http', 'Services'],
                      ['static', 'Static'],
                      ['redirect', 'Redirects'],
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
              )}
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
                  Create route
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
              {page === 'Folders' && (
                <Button className="primary" onClick={() => setWizard({ kind: 'folder' })}>
                  <Plus size={17} /> Add folder
                </Button>
              )}
              {['Services', 'Folders'].includes(page) && (
                <Button
                  className="secondary"
                  aria-label="Refresh"
                  disabled={working}
                  onClick={async () => {
                    setWorking(true);
                    try {
                      if (page === 'Folders') await loadFolders();
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
                  <span>Refresh</span>
                </Button>
              )}
            </div>
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
                  aria-label="Refresh"
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
                <div className="route-list">
                  {state.routes
                    .filter((r) => filter === 'all' || r.kind === filter)
                    .map((route) => {
                      const Icon = icons[route.kind];
                      const forwarding = ['tcp', 'udp'].includes(route.kind);
                      return (
                        <Paper
                          className={`route-row ${route.published ? 'proxy-enabled' : 'proxy-disabled'}`}
                          key={route.id}
                          component="article"
                          withBorder={true}
                        >
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
                            <strong>{route.name}</strong>
                            <span className="route-endpoints">
                              <span>
                                {listener(route)}
                              </span>
                              <ArrowRight className="inline-arrow" size={20} aria-label="to" />
                              <span title={destination(route)}>
                                {destinationLabel(route, state.discovery)}
                                {forwarding && <small className="route-protocol"> ({route.kind.toUpperCase()})</small>}
                              </span>
                            </span>
                          </Button>
                          <div className="route-footer">
                            <Switch
                              checked={route.published}
                              disabled={working || !edgeReady}
                              aria-label={`${route.published ? 'Disable' : 'Enable'} ${route.name}`}
                              onChange={() => action(route, route.published ? 'disable' : 'publish')}
                            />
                            <div className="route-actions">
                              <Tooltip label="Edit proxy">
                                <Button
                                  className="icon-button"
                                  onClick={() =>
                                    setWizard({
                                      kind: 'route',
                                      initial: route,
                                    })
                                  }
                                  aria-label={`Edit ${route.name}`}
                                >
                                  <Pencil size={17} />
                                </Button>
                              </Tooltip>
                              <Tooltip label="Delete proxy">
                                <Button
                                  className="icon-button"
                                  color="red.6"
                                  disabled={working || (route.published && !edgeReady)}
                                  onClick={() => setConfirmation(route)}
                                  aria-label={`Delete ${route.name}`}
                                >
                                  <Trash2 size={17} />
                                </Button>
                              </Tooltip>
                            </div>
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
                {state.discovery.stale && (
                  <p className="inventory-status">Discovery out of date</p>
                )}
                {state.discovery.servers.filter((server) => server.error).map((server) => (
                  <Alert key={server.id} className="notice" color="blue" variant="light">
                    {server.name}: {server.error}
                  </Alert>
                ))}
                {state.discovery.servers.filter((host) => portServices.some((service) => service.server === host.id)).map((host) => (
                  <section className="service-host-group" key={host.id} aria-label={host.name}>
                    <h2><Server size={18} />{host.name}<code>{host.address}</code></h2>
                    <div className="service-list">
                      {portServices.filter((service) => service.server === host.id).flatMap((service) => service.ports.map((port) => {
                        const proxies = serviceProxies(state.routes, service, port);
                        const edit = (route) => setWizard({ kind: 'route', initial: route });
                        const button = (
                          <Button
                            className="icon-button"
                            aria-label={`${proxies.length ? 'Edit' : 'Create'} proxy for ${service.name} ${portLabel(port)}`}
                            disabled={!proxies.length && service.state !== 'running'}
                            onClick={proxies.length > 1 ? undefined : () =>
                              proxies.length ? edit(proxies[0]) : connect(service, port)}
                          >
                            {proxies.length ? <Pencil size={17} /> : <Plus size={17} />}
                          </Button>
                        );
                        return (
                          <Paper className="service-row" component="article" withBorder
                            key={`${service.server}:${service.containerId}:${service.name}:${port.hostPort}:${port.containerPort}:${port.protocol}`}>
                            <div className="service-icon"><Server size={20} /></div>
                            <div className="service-name">
                              <strong>{service.name}</strong>
                              {service.state !== 'running' && <span className="status-text">{service.state}</span>}
                            </div>
                            <code className="service-port">{portLabel(port)}</code>
                            <div className="service-actions">
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
                              ) : <Tooltip label={proxies.length ? 'Edit proxy' : 'Create proxy'}>{button}</Tooltip>}
                            </div>
                          </Paper>
                        );
                      }))}
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
            {page === 'Folders' && (
              <div className="folders-layout">
                <Folders
                  catalog={catalog}
                  onEdit={(initial) =>
                    setWizard({
                      kind: 'folder',
                      initial,
                    })
                  }
                  onSaved={async (message) => {
                    await refresh();
                    await loadFolders();
                    report(message);
                  }}
                />
              </div>
            )}
            {page === 'Domains' && !state.domains.length && (
              <div className="empty-state">
                <Globe size={28} />
                <h2>No domains</h2>
              </div>
            )}
            {page === 'Domains' && (
              <div className="domain-list">
                {state.domains.map((d) => (
                  <Paper
                    className="domain-row"
                    key={d.name}
                    component="section"
                    withBorder={true}
                  >
                    <div className="service-icon"><Globe size={20} /></div>
                    <div className="domain-identity">
                      <h2>{d.name}</h2>
                      <code>{d.subdomains ? `${d.name}, *.${d.name}` : d.name}</code>
                      {!d.ready && <span className="status-text">{d.staging ? 'Staging' : 'Pending'}</span>}
                    </div>
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
                      <p className="hint domain-note">
                        Test certificate. Disable staging in Settings to enable routes.
                      </p>
                    )}
                    {d.error && (
                      <p className="error-text domain-note" role="alert">
                        {d.error}
                      </p>
                    )}
                    <div className="domain-actions">
                      <Button
                        className="icon-button"
                        aria-label={`Edit ${d.name}`}
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
                        <Pencil size={17} />
                      </Button>
                      <Button
                        className="icon-button"
                        aria-label={`Check certificate for ${d.name}`}
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
                        <RefreshCw size={17} />
                      </Button>
                      <Button
                        className="icon-button"
                        color="red.6"
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
                onLogout={onLogout}
                onEditPage={(code) => setWizard({ kind: 'pages', code })}
              />
            )}
          </main>
        )}
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
