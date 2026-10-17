import React, { useState, useEffect, useRef } from 'react';
import {
  Waypoints,
  ArrowLeft,
  ArrowRight,
  Check,
  Globe,
  FolderOpen,
  Cable,
  Radio,
  File,
  Server as ServerIcon,
} from 'lucide-react';
import { api } from './api.js';
import { useNavigation, useWizardField } from './navigation.js';
import {
  blankSite,
  folderRules,
  isWebsite,
  listener,
  destination,
  kindName,
  portLabel,
  serviceEndpoints,
} from './routes.js';

export function Wizard({
  title,
  steps,
  step,
  onStep,
  onClose,
  busy,
  children,
  onSubmit,
  submitLabel,
  error,
  canContinue = true,
}) {
  const heading = useRef(null);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    heading.current?.focus();
  }, [step]);
  return (
    <div className="wizard-shell">
      <header className="wizard-top">
        <div className="brand">
          <Waypoints />
          proxy
        </div>
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </header>
      <div className="wizard-body">
        <nav className="wizard-steps" aria-label="Progress">
          {steps.map((label, i) => (
            <div
              key={label}
              aria-current={i === step ? 'step' : undefined}
              className={i < step ? 'complete' : ''}
            >
              <span>{i < step ? <Check size={14} /> : i + 1}</span>
              {label}
            </div>
          ))}
        </nav>
        <main className="wizard-main">
          <div className="wizard-heading">
            <span className="hint">{title}</span>
            <h1 ref={heading} tabIndex={-1}>
              {steps[step]}
            </h1>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || !canContinue) return;
              if (step < steps.length - 1) onStep(step + 1);
              else onSubmit();
            }}
          >
            <fieldset disabled={busy}>{children}</fieldset>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <div className="wizard-actions">
              {step > 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => onStep(step - 1)}
                >
                  <ArrowLeft size={16} />
                  Back
                </button>
              )}
              <button className="primary" disabled={busy || !canContinue}>
                {busy ? 'Applying…' : step === steps.length - 1 ? submitLabel : 'Continue'}
                {step === steps.length - 1 ? <Check size={16} /> : <ArrowRight size={16} />}
              </button>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
}

export function SitePicker({
  value,
  onChange,
  onStatus,
  editRules = false,
  fixedDirectory = false,
}) {
  const [catalog, setCatalog] = useState({ folders: [], error: null }),
    [inspection, setInspection] = useState(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [showAll, setShowAll] = useState(false),
    [search, setSearch] = useState('');
  const [includeText, setIncludeText] = useState((value?.include ?? []).join('\n')),
    [excludeText, setExcludeText] = useState((value?.exclude ?? []).join('\n'));
  const callback = useRef(onStatus);
  callback.current = onStatus;
  const key = JSON.stringify(value);
  useEffect(() => {
    if (fixedDirectory) return;
    let current = true;
    api('/sites')
      .then((data) => {
        if (current) setCatalog(data);
      })
      .catch((e) => {
        if (current) setCatalog({ folders: [], error: e.message });
      });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setError('');
    setInspection(null);
    setPending(Boolean(value?.directory));
    callback.current?.(null);
    if (!value?.directory) return;
    const timer = setTimeout(() => {
      api('/sites/inspect', { method: 'POST', body: value })
        .then((data) => {
          if (!current) return;
          setInspection(data);
          callback.current?.(data);
        })
        .catch((e) => {
          if (current) setError(e.message);
        })
        .finally(() => {
          if (current) setPending(false);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [key]);
  function patterns(which, text) {
    const next = {
      ...value,
      [which]: text
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    onChange(next);
  }
  function toggle(file) {
    const hidden = value.exclude.includes(file.path);
    const exclude = hidden
      ? value.exclude.filter((p) => p !== file.path)
      : [...value.exclude, file.path];
    setExcludeText(exclude.join('\n'));
    onChange({ ...value, exclude });
  }
  const files = inspection?.files ?? [];
  return (
    <div className="site-picker">
      {!fixedDirectory && (
        <label>
          Folder
          <select
            value={value?.directory ?? ''}
            required
            onChange={(e) => onChange({ ...value, directory: e.target.value })}
          >
            <option value="">Choose a folder</option>
            {catalog.folders.map((folder) => (
              <option key={folder.directory} value={folder.directory}>
                /sites/{folder.directory}
              </option>
            ))}
          </select>
        </label>
      )}
      {catalog.error && (
        <p className="error-text" role="alert">
          {catalog.error}
        </p>
      )}
      {!fixedDirectory && !catalog.error && !catalog.folders.length && (
        <p className="hint">No folders configured. Add one in Files.</p>
      )}
      {editRules && (
        <>
          <div className="field-pair file-patterns">
            <label>
              Only expose
              <textarea
                rows={3}
                value={includeText}
                placeholder={'*.svg\nassets/**'}
                onChange={(e) => {
                  setIncludeText(e.target.value);
                  patterns('include', e.target.value);
                }}
              />
              <span className="hint">Empty = all files</span>
            </label>
            <label>
              Hide
              <textarea
                rows={3}
                value={excludeText}
                onChange={(e) => {
                  setExcludeText(e.target.value);
                  patterns('exclude', e.target.value);
                }}
                placeholder={'private/**\n**/*.map'}
              />
            </label>
          </div>
        </>
      )}
      {pending && (
        <p className="hint" role="status">
          Checking files…
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {inspection && (
        <>
          <div className="file-summary">
            <strong>{inspection.count} exposed</strong>
            <span>{files.length - inspection.count} hidden</span>
          </div>
          {editRules ? (
            <>
              <label className="file-search">
                Find a file
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search paths"
                />
              </label>
              <div className="file-list">
                {files
                  .filter((file) => file.path.toLowerCase().includes(search.toLowerCase()))
                  .slice(0, showAll || search ? files.length : 10)
                  .map((file) => (
                    <label
                      className={`file-row ${file.allowed ? '' : 'file-hidden'}`}
                      key={file.path}
                    >
                      <input
                        type="checkbox"
                        checked={file.allowed}
                        disabled={
                          file.reason === 'Dotfile' ||
                          file.reason === 'Symlink' ||
                          (!file.allowed && !value.exclude.includes(file.path))
                        }
                        onChange={() => toggle(file)}
                      />
                      <File size={14} />
                      <code>{file.path}</code>
                      {file.reason && <small>{file.reason}</small>}
                    </label>
                  ))}
              </div>
              {files.length > 10 && !search && (
                <button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show less' : `Show all ${files.length} files`}
                </button>
              )}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function Summary({ route }) {
  return (
    <dl className="review-list">
      <div>
        <dt>Type</dt>
        <dd>{kindName[route.kind]}</dd>
      </div>
      <div>
        <dt>Address</dt>
        <dd>{listener(route)}</dd>
      </div>
      <div>
        <dt>Destination</dt>
        <dd>{destination(route)}</dd>
      </div>
      {route.kind === 'udp' && (
        <div>
          <dt>Ports</dt>
          <dd>{route.portEnd - route.portStart + 1} · same port on destination</dd>
        </div>
      )}
      {route.sourceCIDRs.length > 0 && (
        <div>
          <dt>Allowed sources</dt>
          <dd>{route.sourceCIDRs.join(', ')}</dd>
        </div>
      )}
    </dl>
  );
}
export function RouteWizard({ initial, state, onClose, onSaved, publishOnly = false }) {
  const { step, setStep } = useNavigation();
  const [route, setRoute] = useWizardField('route', {
    ...initial, staticSite: initial.staticSite ?? null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [check, setCheck] = useState(null);
  const [udpBlock, setUDPBlock] = useWizardField('udpBlock',
    initial.kind === 'udp' && initial.portEnd > initial.portStart);
  const [cidrs, setCIDRs] = useWizardField('cidrs', initial.sourceCIDRs.join('\n'));
  const initialDomain =
    state.domains.find(
      (d) => initial.hostname === d.name || initial.hostname.endsWith(`.${d.name}`),
    )?.name ??
    state.domains[0]?.name ??
    '';
  const [domain, setDomain] = useWizardField('domain', initialDomain),
    [subdomain, setSubdomain] = useWizardField('subdomain',
      initial.hostname
        ? initial.hostname === initialDomain
          ? ''
          : initial.hostname.slice(0, -initialDomain.length - 1)
        : 'app',
    );
  const set = (key, value) => setRoute((r) => ({ ...r, [key]: value }));
  const steps = publishOnly
    ? ['Review & publish']
    : ['Route type', 'Destination', 'Address', 'Review'];
  const endpoints = serviceEndpoints(state.discovery.services, route.kind);
  const reviewed = {
    ...route,
    hostname: isWebsite(route) ? `${subdomain ? subdomain + '.' : ''}${domain}` : '',
    portEnd:
      route.kind === 'tcp' || (route.kind === 'udp' && !udpBlock) ? route.portStart : route.portEnd,
    sourceCIDRs: cidrs.split(/[\s,]+/).filter(Boolean),
  };
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (publishOnly) await api(`/routes/${initial.id}/publish`, { method: 'POST' });
      else
        await api(initial.id ? `/routes/${initial.id}` : '/routes', {
          method: initial.id ? 'PUT' : 'POST',
          body: reviewed,
        });
      await onSaved(
        publishOnly ? 'Published' : initial.published ? 'Changes applied' : 'Draft saved',
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function sourceChange(key) {
    const endpoint = endpoints.find((e) => e.key === key);
    if (endpoint?.reason) return;
    if (!endpoint) {
      set('source', null);
      return;
    }
    const { service, port } = endpoint;
    setRoute((r) => ({
      ...r,
      targetHost: port.targetHost,
      targetPort: port.hostPort,
      portStart: route.kind === 'udp' ? port.hostPort : r.portStart,
      portEnd: route.kind === 'udp' ? port.hostPort : r.portEnd,
      source: {
        server: service.server,
        container: service.name,
        containerId: service.containerId,
        containerPort: port.containerPort,
      },
    }));
  }
  const selected = route.source
    ? (endpoints.find(
        (e) =>
          e.service.containerId === route.source.containerId &&
          e.service.server === route.source.server &&
          e.port.targetHost === route.targetHost &&
          e.port.hostPort === route.targetPort,
      )?.key ?? '')
    : '';
  const validFiles = route.kind !== 'static' || Boolean(check);
  return (
    <Wizard
      title={publishOnly ? 'Publish route' : initial.id ? 'Edit route' : 'New route'}
      steps={steps}
      step={step}
      onStep={(s) => {
        setError('');
        setStep(s);
      }}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      submitLabel={
        publishOnly
          ? 'Publish publicly'
          : initial.published
            ? 'Apply changes'
            : initial.id
              ? 'Save changes'
              : 'Create draft'
      }
      error={error}
      canContinue={!(step === 1 && !validFiles) && (!publishOnly || state.edge.available)}
    >
      {!publishOnly && step === 0 && (
        <>
          <div className="type-grid">
            {[
              ['http', 'Website', Globe, 'Proxy a web service'],
              ['static', 'Static site', FolderOpen, 'Serve a folder'],
              ['tcp', 'TCP', Cable, 'Forward a TCP port'],
              ['udp', 'UDP', Radio, 'Forward a port or block'],
            ].map(([kind, label, Icon, hint]) => (
              <button
                key={kind}
                className="type-choice"
                type="button"
                aria-pressed={route.kind === kind}
                onClick={() =>
                  setRoute((r) =>
                    r.kind === kind
                      ? r
                      : {
                          ...r,
                          kind,
                          staticSite: kind === 'static' ? (r.staticSite ?? blankSite('')) : null,
                          streamTLS: false,
                          proxyProtocol: false,
                          upstreamTLS: false,
                          source: null,
                          portEnd: r.portStart,
                        },
                  )
                }
              >
                <Icon size={22} />
                <strong>{label}</strong>
                <span>{hint}</span>
                {route.kind === kind && <Check size={15} />}
              </button>
            ))}
          </div>
          <label>
            Name
            <input
              required
              maxLength={80}
              autoComplete="off"
              value={route.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Portfolio"
            />
          </label>
        </>
      )}
      {!publishOnly &&
        step === 1 &&
        (route.kind === 'static' ? (
          <SitePicker
            value={route.staticSite}
            onChange={(value) => set('staticSite', folderRules(state, value.directory))}
            onStatus={setCheck}
          />
        ) : (
          <>
            <label>
              Service
              <select
                value={route.source && !selected ? 'saved' : selected}
                onChange={(e) => sourceChange(e.target.value)}
              >
                <option value="">Custom endpoint</option>
                {route.source && !selected && (
                  <option value="saved">{route.source.container} · saved endpoint</option>
                )}
                {endpoints.map((e) => (
                  <option value={e.key} key={e.key} disabled={Boolean(e.reason)}>
                    {e.service.serverName} / {e.service.name} · {portLabel(e.port)}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </option>
                ))}
              </select>
            </label>
            {!endpoints.length && (
              <p className="hint">
                No {route.kind === 'udp' ? 'UDP' : 'TCP'} ports discovered. Check Services or use a
                custom endpoint.
              </p>
            )}
            {!route.source && (
              <>
                <div className="field-pair">
                  <label>
                    Destination IP
                    <input
                      required
                      value={route.targetHost}
                      onChange={(e) =>
                        setRoute((r) => ({ ...r, targetHost: e.target.value, source: null }))
                      }
                      list="discovered-servers"
                    />
                  </label>
                  {route.kind !== 'udp' && (
                    <label>
                      Host port
                      <input
                        required
                        type="number"
                        min={1}
                        max={65535}
                        value={route.targetPort}
                        onChange={(e) =>
                          setRoute((r) => ({
                            ...r,
                            targetPort: Number(e.target.value),
                            source: null,
                          }))
                        }
                      />
                    </label>
                  )}
                </div>
                <datalist id="discovered-servers">
                  {state.discovery.servers
                    .filter((server) => server.address)
                    .map((t) => (
                      <option key={t.id} value={t.address}>
                        {t.name}
                      </option>
                    ))}
                </datalist>
              </>
            )}
            {route.source && (
              <div className="selected-endpoint">
                <ServerIcon />
                <div>
                  <strong>{route.source.container}</strong>
                  <code>{destination(route)}</code>
                </div>
                {!selected && (
                  <span className="hint">Using saved endpoint · service unavailable</span>
                )}
              </div>
            )}
            {route.kind === 'http' && (
              <>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={route.upstreamTLS}
                    onChange={(e) => set('upstreamTLS', e.target.checked)}
                  />
                  HTTPS backend
                </label>
                {route.upstreamTLS && (
                  <label>
                    Certificate hostname
                    <input
                      required
                      value={route.upstreamServerName}
                      onChange={(e) => set('upstreamServerName', e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </>
        ))}
      {!publishOnly && step === 2 && (
        <>
          {isWebsite(route) ? (
            <div className="field-pair">
              <label>
                Subdomain
                <input
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                  pattern="[a-zA-Z0-9-]*"
                  placeholder="Leave empty for apex"
                />
              </label>
              <label>
                Domain
                <select value={domain} required onChange={(e) => setDomain(e.target.value)}>
                  <option value="">Choose domain</option>
                  {state.domains.map((d) => (
                    <option key={d.name}>{d.name}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <>
              {state.policy.ingressIPs.length > 1 && (
                <label>
                  Ingress IP
                  <select value={route.ingressIP} onChange={(e) => set('ingressIP', e.target.value)}>
                    {state.policy.ingressIPs.map((ip) => (
                      <option key={ip}>{ip}</option>
                    ))}
                  </select>
                </label>
              )}
              {route.kind === 'udp' && (
                <div className="segmented">
                  <button type="button" aria-pressed={!udpBlock} onClick={() => setUDPBlock(false)}>
                    Single port
                  </button>
                  <button type="button" aria-pressed={udpBlock} onClick={() => setUDPBlock(true)}>
                    Port block
                  </button>
                </div>
              )}
              <div className="field-pair">
                <label>
                  {route.kind === 'udp' && udpBlock ? 'Start port' : 'Public port'}
                  <input
                    type="number"
                    required
                    min={1}
                    max={65535}
                    value={route.portStart}
                    onChange={(e) => set('portStart', Number(e.target.value))}
                  />
                </label>
                {route.kind === 'udp' && udpBlock && (
                  <label>
                    End port
                    <input
                      type="number"
                      required
                      min={route.portStart}
                      max={65535}
                      value={route.portEnd}
                      onChange={(e) => set('portEnd', Number(e.target.value))}
                    />
                  </label>
                )}
              </div>
            </>
          )}
          <details className="route-options">
            <summary>{route.kind === 'static' ? 'Access restrictions' : 'More options'}</summary>
            <section className="option-group">
              <h3>Access</h3>
              <label>
                Allowed networks
                <textarea
                  rows={2}
                  value={cidrs}
                  onChange={(e) => setCIDRs(e.target.value)}
                  placeholder="Public · or enter one CIDR per line"
                />
              </label>
            </section>
            {route.kind !== 'static' && (
              <section className="option-group">
                <h3>Limits</h3>
                <div className="field-pair">
                  <label>
                    Timeout (seconds)
                    <input
                      type="number"
                      min={5}
                      max={86400}
                      value={route.timeout}
                      onChange={(e) => set('timeout', Number(e.target.value))}
                    />
                  </label>
                  {route.kind === 'http' && (
                    <label>
                      Upload size (MB)
                      <input
                        type="number"
                        min={1}
                        max={1024}
                        value={route.uploadMB}
                        onChange={(e) => set('uploadMB', Number(e.target.value))}
                      />
                    </label>
                  )}
                </div>
              </section>
            )}
            {route.kind === 'tcp' && (
              <section className="option-group">
                <h3>TCP options</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={route.streamTLS}
                    onChange={(e) => set('streamTLS', e.target.checked)}
                  />
                  Terminate TLS
                </label>
                {route.streamTLS && (
                  <label>
                    Certificate
                    <select
                      required
                      value={route.tlsDomain}
                      onChange={(e) => set('tlsDomain', e.target.value)}
                    >
                      <option value="">Choose certificate</option>
                      {state.domains.map((d) => (
                        <option key={d.name}>{d.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={route.proxyProtocol}
                    onChange={(e) => set('proxyProtocol', e.target.checked)}
                  />
                  Send client address with PROXY protocol
                </label>
                <p className="hint">Enable only if the backend supports it.</p>
              </section>
            )}
          </details>
        </>
      )}
      {(publishOnly || step === 3) && (
        <>
          <Summary route={reviewed} />
          <p className="review-note">
            {publishOnly
              ? 'This opens public ingress.'
              : initial.published
                ? 'Changes apply to the live route.'
                : 'Saved as a draft. Publish it when ready.'}
          </p>
          {!state.edge.available && (publishOnly || initial.published) && (
            <div className="notice error">Edge unavailable</div>
          )}
        </>
      )}
    </Wizard>
  );
}

export function ErrorPagesWizard({ state, onClose, onSaved }) {
  const pages = state.pages;
  const { step, setStep } = useNavigation();
  const [value, setValue] = useWizardField('pages', pages);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [check, setCheck] = useState(null);
  const selections = [
    ['notFoundSite', '404 page', 'notFoundDocument'],
    ['badGatewaySite', '502 page', 'badGatewayDocument'],
  ];
  const key = selections[step]?.[0],
    site = value[key],
    documentKey = selections[step]?.[2];
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/pages', { method: 'PUT', body: value });
      await onSaved('Error pages updated');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Wizard
      title="Error pages"
      steps={[...selections.map((s) => s[1]), 'Review']}
      step={step}
      onStep={(s) => {
        setStep(s);
        setCheck(null);
        setError('');
      }}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      submitLabel="Apply pages"
      error={error}
      canContinue={
        step === selections.length || !site || Boolean(check?.exposed.includes(value[documentKey]))
      }
    >
      {step < selections.length ? (
        <>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={!site}
              onClick={() => setValue((v) => ({ ...v, [key]: null }))}
            >
              Built-in
            </button>
            <button
              type="button"
              aria-pressed={Boolean(site)}
              onClick={() => setValue((v) => ({ ...v, [key]: v[key] ?? blankSite('') }))}
            >
              Folder
            </button>
          </div>
          {site ? (
            <>
              <SitePicker
                key={key}
                value={site}
                onChange={(spec) =>
                  setValue((v) => ({
                    ...v,
                    [key]: folderRules(state, spec.directory),
                  }))
                }
                onStatus={setCheck}
              />
              <label>
                Page document
                <input
                  required
                  value={value[documentKey]}
                  list="error-page-documents"
                  onChange={(e) => setValue((v) => ({ ...v, [documentKey]: e.target.value }))}
                />
              </label>
              <datalist id="error-page-documents">
                {check?.exposed.map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
              {check && !check.exposed.includes(value[documentKey]) && (
                <p className="error-text">Choose a document exposed by the folder rules.</p>
              )}
              <p className="hint">Use relative asset URLs, such as ./style.css.</p>
            </>
          ) : (
            <div className="builtin-page">
              <span>{step === 0 ? '404' : '502'}</span>
              <h2>{step === 0 ? pages.notFoundTitle : pages.badGatewayTitle}</h2>
            </div>
          )}
        </>
      ) : (
        <dl className="review-list">
          {selections.map(([key, label, documentKey]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {value[key] ? `/sites/${value[key].directory}/${value[documentKey]}` : 'Built-in'}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Wizard>
  );
}
