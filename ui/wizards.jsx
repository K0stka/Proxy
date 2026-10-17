import { Button, SelectField, NumberField, Disclosure } from './controls.jsx';
import { TagsInput, Stepper, Group, Alert, TextInput, Switch, Checkbox } from '@mantine/core';
import React, { useState, useEffect, useRef } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import {
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
import { byName, compareNames } from './order.js';
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
  routeSubdomain,
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
  onValidate,
}) {
  const heading = useRef(null);
  const mobile = useMediaQuery('(max-width: 760px)');
  const [validating, setValidating] = useState(false),
    [validationError, setValidationError] = useState('');
  const disabled = busy || validating;
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest('.workspace')?.scrollTo({ top: 0, behavior: 'instant' });
  }, [step]);
  return (
    <main className="wizard-shell">
      <div className={`wizard-body${steps.length === 1 ? ' single-page' : ''}`}>
        {steps.length > 1 && (
          <nav className="wizard-steps" aria-label="Progress">
            <Stepper
              active={step}
              orientation={mobile ? 'horizontal' : 'vertical'}
              size="sm"
              iconSize={28}
              allowNextStepsSelect={false}
            >
              {steps.map((label) => (
                <Stepper.Step key={label} label={label} allowStepSelect={false} />
              ))}
            </Stepper>
          </nav>
        )}
        <section className="wizard-main">
          <div className="wizard-heading">
            <span className="hint">{title}</span>
            <h1 ref={heading} tabIndex={-1}>
              {steps[step]}
            </h1>
          </div>
          <form
            onChangeCapture={() => setValidationError('')}
            onSubmit={async (e) => {
              e.preventDefault();
              if (disabled || !canContinue) return;
              if (step === steps.length - 1) return onSubmit();
              setValidationError('');
              setValidating(true);
              try {
                await onValidate?.(step);
                onStep(step + 1);
              } catch (e) {
                setValidationError(e.message);
              } finally {
                setValidating(false);
              }
            }}
          >
            <fieldset disabled={disabled}>{children}</fieldset>
            {(validationError || error) && (
              <Alert className="notice error" role="alert" color="red" variant="light">
                {validationError || error}
              </Alert>
            )}
            <div className="wizard-actions">
              <Button type="button" className="text-button" disabled={disabled} onClick={onClose}>
                Cancel
              </Button>
              <Group gap="sm">
                {step > 0 && steps.length > 1 && (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setValidationError('');
                      onStep(step - 1);
                    }}
                  >
                    <ArrowLeft size={16} />
                    Back
                  </Button>
                )}
                <Button className="primary" disabled={disabled || !canContinue} type="submit">
                  {validating
                    ? 'Checking…'
                    : busy
                      ? 'Applying…'
                      : step === steps.length - 1
                        ? submitLabel
                        : 'Continue'}
                  {step === steps.length - 1 ? <Check size={16} /> : <ArrowRight size={16} />}
                </Button>
              </Group>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
export function SitePicker({
  value,
  onChange,
  onStatus,
  editRules = false,
  fixedDirectory = false,
}) {
  const [catalog, setCatalog] = useState({
      folders: [],
      error: null,
    }),
    [inspection, setInspection] = useState(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [showAll, setShowAll] = useState(false),
    [search, setSearch] = useState('');
  const callback = useRef(onStatus);
  callback.current = onStatus;
  const key = JSON.stringify(value);
  useEffect(() => {
    if (fixedDirectory) return;
    let current = true;
    api('/sites')
      .then((data) => {
        if (current) setCatalog({ ...data, folders: data.folders.toSorted(byName) });
      })
      .catch((e) => {
        if (current)
          setCatalog({
            folders: [],
            error: e.message,
          });
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
      api('/sites/inspect', {
        method: 'POST',
        body: value,
      })
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
  function toggle(file) {
    const hidden = value.exclude.includes(file.path);
    const exclude = hidden
      ? value.exclude.filter((p) => p !== file.path)
      : [...value.exclude, file.path];
    onChange({
      ...value,
      exclude,
    });
  }
  const files = (inspection?.files ?? []).toSorted((a, b) => compareNames(a.path, b.path));
  return (
    <div className="site-picker">
      {!fixedDirectory && (
        <SelectField
          value={value?.directory ?? ''}
          required
          onChange={(e) =>
            onChange({
              ...value,
              directory: e.target.value,
            })
          }
          label={'Folder'}
        >
          <option value="">Choose a folder</option>
          {catalog.folders.map((folder) => (
            <option key={folder.directory} value={folder.directory}>
              /sites/{folder.directory}
            </option>
          ))}
        </SelectField>
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
          <div className="file-patterns">
            <TagsInput
              label="Include patterns"
              description="Leave empty to include all files."
              value={value.include}
              placeholder="*.html or assets/**"
              splitChars={['\n']}
              onChange={(include) =>
                onChange({
                  ...value,
                  include,
                })
              }
            />
            <TagsInput
              label="Exclude patterns"
              value={value.exclude}
              placeholder="private/** or **/*.map"
              splitChars={['\n']}
              onChange={(exclude) =>
                onChange({
                  ...value,
                  exclude,
                })
              }
            />
          </div>
        </>
      )}
      {pending && (
        <p className="hint" role="status">
          Checking files…
        </p>
      )}
      {error && (
        <Alert className="notice error" role="alert" color="red" variant="light">
          {error}
        </Alert>
      )}
      {inspection && (
        <>
          <div className="file-summary">
            <strong>{inspection.count} exposed</strong>
            <span>{files.length - inspection.count} hidden</span>
          </div>
          {editRules ? (
            <>
              <TextInput
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search paths"
                label={'Find a file'}
                className="file-search"
              />
              <div className="file-list">
                {files
                  .filter((file) => file.path.toLowerCase().includes(search.toLowerCase()))
                  .slice(0, showAll || search ? files.length : 10)
                  .map((file) => (
                    <Checkbox
                      key={file.path}
                      checked={file.allowed}
                      disabled={
                        file.reason === 'Dotfile' ||
                        file.reason === 'Symlink' ||
                        (!file.allowed && !value.exclude.includes(file.path))
                      }
                      onChange={() => toggle(file)}
                      label={
                        <>
                          <File size={14} />
                          <code>{file.path}</code>
                          {file.reason && <small>{file.reason}</small>}
                        </>
                      }
                      className={`file-row ${file.allowed ? '' : 'file-hidden'}`}
                    />
                  ))}
              </div>
              {files.length > 10 && !search && (
                <Button type="button" className="text-button" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show less' : `Show all ${files.length} files`}
                </Button>
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
  const editing = Boolean(initial.id) && !publishOnly;
  const [route, setRoute] = useWizardField('route', {
    ...initial,
    staticSite: initial.staticSite ?? null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [check, setCheck] = useState(null);
  const [udpBlock, setUDPBlock] = useWizardField(
    'udpBlock',
    initial.kind === 'udp' && initial.portEnd > initial.portStart,
  );
  const [cidrs, setCIDRs] = useWizardField('cidrs', initial.sourceCIDRs.join('\n'));
  const initialDomain =
    state.domains.find(
      (d) => initial.hostname === d.name || initial.hostname.endsWith(`.${d.name}`),
    )?.name ??
    state.domains[0]?.name ??
    '';
  const [domain, setDomain] = useWizardField('domain', initialDomain),
    [customSubdomain, setSubdomain] = useWizardField(
      'subdomain',
      initial.hostname
        ? initial.hostname === initialDomain
          ? ''
          : initial.hostname.slice(0, -initialDomain.length - 1)
        : routeSubdomain(initial.name),
    );
  const [subdomainEdited, setSubdomainEdited] = useWizardField(
    'subdomainEdited',
    Boolean(initial.id || initial.hostname),
  );
  const subdomain = subdomainEdited ? customSubdomain : routeSubdomain(route.name) || 'service';
  const set = (key, value) =>
    setRoute((r) => ({
      ...r,
      [key]: value,
    }));
  const steps = publishOnly
    ? ['Review & enable']
    : editing
      ? ['Route settings']
      : ['Details', 'Destination', 'Address', 'Review'];
  const endpoints = serviceEndpoints(state.discovery.services, route.kind);
  const reviewed = {
    ...route,
    hostname: isWebsite(route)
      ? `${subdomain && state.domains.find((d) => d.name === domain)?.subdomains ? subdomain + '.' : ''}${domain}`
      : '',
    portEnd:
      route.kind === 'tcp' || (route.kind === 'udp' && !udpBlock) ? route.portStart : route.portEnd,
    sourceCIDRs: cidrs.split(/[\s,]+/).filter(Boolean),
  };
  async function save() {
    setBusy(true);
    setError('');
    try {
      if (publishOnly)
        await api(`/routes/${initial.id}/publish`, {
          method: 'POST',
        });
      else
        await api(initial.id ? `/routes/${initial.id}` : '/routes', {
          method: initial.id ? 'PUT' : 'POST',
          body: reviewed,
        });
      await onSaved(publishOnly ? 'Enabled' : 'Route saved');
    } catch (e) {
      if (!publishOnly && !editing && [400, 409].includes(e.status)) setStep(2);
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
      title={publishOnly ? 'Enable route' : initial.id ? 'Edit route' : 'New route'}
      steps={steps}
      step={editing ? 0 : step}
      onStep={(s) => {
        setError('');
        setStep(s);
      }}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      onValidate={(step) =>
        api('/validate', {
          method: 'POST',
          body: {
            kind: 'route',
            step,
            value: reviewed,
          },
        })
      }
      submitLabel={
        publishOnly
          ? 'Enable route'
          : initial.published
            ? 'Apply changes'
            : initial.id
              ? 'Save changes'
              : 'Create disabled route'
      }
      error={error}
      canContinue={
        !((editing || step === 1) && !validFiles) && (!publishOnly || state.edge.available)
      }
    >
      {!publishOnly && (editing || step === 0) && (
        <>
          <TextInput
            required
            maxLength={80}
            autoComplete="off"
            value={route.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Portfolio"
            label="Name"
          />
          <h2>Type</h2>
          <div className="type-grid">
            {[
              ['http', 'Service', Globe, 'Proxy a web service'],
              ['static', 'Static site', FolderOpen, 'Serve a folder'],
              ['tcp', 'TCP', Cable, 'Forward a TCP port'],
              ['udp', 'UDP', Radio, 'Forward a port or block'],
            ].map(([kind, label, Icon, hint]) => (
              <Button
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
              </Button>
            ))}
          </div>
        </>
      )}
      {!publishOnly &&
        (editing || step === 1) &&
        (route.kind === 'static' ? (
          <SitePicker
            value={route.staticSite}
            onChange={(value) => set('staticSite', folderRules(state, value.directory))}
            onStatus={setCheck}
          />
        ) : (
          <>
            <SelectField
              value={route.source && !selected ? 'saved' : selected}
              onChange={(e) => sourceChange(e.target.value)}
              label={'Service'}
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
            </SelectField>
            {!endpoints.length && (
              <p className="hint">
                No {route.kind === 'udp' ? 'UDP' : 'TCP'} ports discovered. Check Services or use a
                custom endpoint.
              </p>
            )}
            {!route.source && (
              <>
                <div className="field-pair">
                  <TextInput
                    required
                    value={route.targetHost}
                    onChange={(e) =>
                      setRoute((r) => ({
                        ...r,
                        targetHost: e.target.value,
                        source: null,
                      }))
                    }
                    list="discovered-servers"
                    label={'Destination IP'}
                  />
                  {route.kind !== 'udp' && (
                    <NumberField
                      required
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
                      label={'Host port'}
                    />
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
                <Switch
                  checked={route.upstreamTLS}
                  onChange={(e) => set('upstreamTLS', e.target.checked)}
                  label={'HTTPS backend'}
                  className="checkbox"
                />
                {route.upstreamTLS && (
                  <TextInput
                    required
                    value={route.upstreamServerName}
                    onChange={(e) => set('upstreamServerName', e.target.value)}
                    label={'Certificate hostname'}
                  />
                )}
              </>
            )}
          </>
        ))}
      {!publishOnly && (editing || step === 2) && (
        <>
          {isWebsite(route) ? (
            <div className="field-pair">
              {state.domains.find((d) => d.name === domain)?.subdomains && (
                <TextInput
                  value={subdomain}
                  onChange={(e) => {
                    setSubdomainEdited(true);
                    setSubdomain(e.target.value.toLowerCase());
                  }}
                  pattern={'[a-zA-Z0-9\\-]*'}
                  placeholder="Leave empty for apex"
                  label={'Subdomain'}
                />
              )}
              <SelectField
                value={domain}
                required
                onChange={(e) => setDomain(e.target.value)}
                label={'Domain'}
              >
                <option value="">Choose domain</option>
                {state.domains.map((d) => (
                  <option key={d.name}>{d.name}</option>
                ))}
              </SelectField>
            </div>
          ) : (
            <>
              {state.policy.ingressIPs.length > 1 && (
                <SelectField
                  value={route.ingressIP}
                  onChange={(e) => set('ingressIP', e.target.value)}
                  label={'Ingress IP'}
                >
                  {state.policy.ingressIPs.map((ip) => (
                    <option key={ip}>{ip}</option>
                  ))}
                </SelectField>
              )}
              {route.kind === 'udp' && (
                <div className="segmented">
                  <Button type="button" aria-pressed={!udpBlock} onClick={() => setUDPBlock(false)}>
                    Single port
                  </Button>
                  <Button type="button" aria-pressed={udpBlock} onClick={() => setUDPBlock(true)}>
                    Port block
                  </Button>
                </div>
              )}
              <div className="field-pair">
                <NumberField
                  required
                  min={1}
                  max={65535}
                  value={route.portStart}
                  onChange={(e) => set('portStart', Number(e.target.value))}
                  label={route.kind === 'udp' && udpBlock ? 'Start port' : 'Public port'}
                />
                {route.kind === 'udp' && udpBlock && (
                  <NumberField
                    required
                    min={route.portStart}
                    max={65535}
                    value={route.portEnd}
                    onChange={(e) => set('portEnd', Number(e.target.value))}
                    label={'End port'}
                  />
                )}
              </div>
            </>
          )}
          <Disclosure
            className="route-options"
            defaultOpen={editing}
            title={route.kind === 'static' ? 'Access restrictions' : 'More options'}
          >
            <section className="option-group">
              <h3>Access</h3>
              <TagsInput
                label="Allowed networks"
                description="Leave empty for public access."
                value={cidrs.split(/[\s,]+/).filter(Boolean)}
                placeholder="100.64.0.0/10"
                onChange={(values) => setCIDRs(values.join('\n'))}
              />
            </section>
            {route.kind !== 'static' && (
              <section className="option-group">
                <h3>Limits</h3>
                <div className="field-pair">
                  <NumberField
                    min={5}
                    max={86400}
                    value={route.timeout}
                    onChange={(e) => set('timeout', Number(e.target.value))}
                    label={'Timeout (seconds)'}
                  />
                  {route.kind === 'http' && (
                    <NumberField
                      min={1}
                      max={1024}
                      value={route.uploadMB}
                      onChange={(e) => set('uploadMB', Number(e.target.value))}
                      label={'Upload size (MB)'}
                    />
                  )}
                </div>
              </section>
            )}
            {route.kind === 'tcp' && (
              <section className="option-group">
                <h3>TCP options</h3>
                <Switch
                  checked={route.streamTLS}
                  onChange={(e) => set('streamTLS', e.target.checked)}
                  label={'Terminate TLS'}
                  className="checkbox"
                />
                {route.streamTLS && (
                  <SelectField
                    required
                    value={route.tlsDomain}
                    onChange={(e) => set('tlsDomain', e.target.value)}
                    label={'Certificate'}
                  >
                    <option value="">Choose certificate</option>
                    {state.domains.map((d) => (
                      <option key={d.name}>{d.name}</option>
                    ))}
                  </SelectField>
                )}
                <Switch
                  checked={route.proxyProtocol}
                  onChange={(e) => set('proxyProtocol', e.target.checked)}
                  label={'Send client address with PROXY protocol'}
                  className="checkbox"
                />
                <p className="hint">Enable only if the backend supports it.</p>
              </section>
            )}
          </Disclosure>
        </>
      )}
      {(publishOnly || (!editing && step === 3)) && (
        <>
          <Summary route={reviewed} />
          <p className="review-note">
            {publishOnly
              ? 'This opens public ingress.'
              : initial.published
                ? 'Changes apply to the live route.'
                : 'Saved disabled. Enable it from Routes when ready.'}
          </p>
          {!state.edge.available && (publishOnly || initial.published) && (
            <Alert className="notice error" color="red" variant="light">
              Edge unavailable
            </Alert>
          )}
        </>
      )}
    </Wizard>
  );
}
export function ErrorPagesWizard({ state, code = 404, onClose, onSaved }) {
  const { step, setStep } = useNavigation();
  const siteKey = code === 404 ? 'notFoundSite' : 'badGatewaySite';
  const documentKey = code === 404 ? 'notFoundDocument' : 'badGatewayDocument';
  const [value, setValue] = useWizardField('errorPage', {
    site: state.pages[siteKey],
    document: state.pages[documentKey],
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [check, setCheck] = useState(null);
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/pages/' + code, {
        method: 'PUT',
        body: value,
      });
      await onSaved('Error page saved');
    } catch (e) {
      if ([400, 409].includes(e.status)) setStep(0);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Wizard
      title={'Edit ' + code + ' page'}
      steps={['Page', 'Review']}
      step={step}
      onStep={(next) => {
        setError('');
        setStep(next);
      }}
      onClose={onClose}
      onSubmit={save}
      submitLabel="Save page"
      busy={busy}
      error={error}
      onValidate={() =>
        api('/validate', {
          method: 'POST',
          body: {
            kind: 'page',
            code,
            value,
          },
        })
      }
      canContinue={
        step > 0 ||
        !value.site ||
        (check?.directory === value.site.directory &&
          Boolean(check?.exposed.includes(value.document)))
      }
    >
      {step === 0 ? (
        <>
          <div className="segmented">
            <Button
              type="button"
              aria-pressed={!value.site}
              onClick={() =>
                setValue((v) => ({
                  ...v,
                  site: null,
                }))
              }
            >
              Built-in
            </Button>
            <Button
              type="button"
              aria-pressed={Boolean(value.site)}
              onClick={() =>
                setValue((v) => ({
                  ...v,
                  site: v.site ?? blankSite(''),
                }))
              }
            >
              Folder
            </Button>
          </div>
          {value.site ? (
            <>
              <SitePicker
                key={code}
                value={value.site}
                onStatus={setCheck}
                onChange={(spec) =>
                  setValue((v) => ({
                    ...v,
                    site: folderRules(state, spec.directory),
                  }))
                }
              />
              <TextInput
                required
                value={value.document}
                placeholder="index.html"
                list="error-page-documents"
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    document: e.target.value,
                  }))
                }
                label={'Page document'}
              />
              <datalist id="error-page-documents">
                {check?.exposed.toSorted(compareNames).map((path) => (
                  <option key={path} value={path} />
                ))}
              </datalist>
              {check && !check.exposed.includes(value.document) && (
                <p className="error-text">Choose a document exposed by the folder rules.</p>
              )}
              <p className="hint">Use relative asset URLs, such as ./style.css.</p>
            </>
          ) : (
            <div className="builtin-page">
              <span>{code}</span>
              <h2>{code === 404 ? state.pages.notFoundTitle : state.pages.badGatewayTitle}</h2>
            </div>
          )}
        </>
      ) : (
        <dl className="review-list">
          <div>
            <dt>{code} page</dt>
            <dd>
              {value.site ? '/sites/' + value.site.directory + '/' + value.document : 'Built-in'}
            </dd>
          </div>
        </dl>
      )}
    </Wizard>
  );
}
