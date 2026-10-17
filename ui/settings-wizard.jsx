import React, { useState } from 'react';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { Wizard } from './wizards.jsx';
import { api } from './api.js';

const rangesText = (ranges) =>
  ranges
    .map((range) => (range.from === range.to ? range.from : `${range.from}-${range.to}`))
    .join(', ');
function ranges(text) {
  if (!text.trim()) return [];
  return text.split(',').map((part) => {
    const match = part.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!match) throw Error('Use port numbers or ranges separated by commas');
    const from = Number(match[1]),
      to = Number(match[2] ?? match[1]);
    if (from < 1 || to > 65535 || to < from)
      throw Error('Ports must be 1–65535 in ascending order');
    return { from, to };
  });
}
export default function SettingsWizard({ state, onClose, onSaved, initialStep = 0 }) {
  const [value, setValue] = useState(state.settings),
    [step, setStep] = useState(initialStep),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [available, setAvailable] = useState([]);
  const [targets, setTargets] = useState(
    state.settings.targets.map((target) => ({ ...target, portsText: rangesText(target.ports) })),
  );
  const [tcp, setTCP] = useState(
      rangesText(state.settings.ingressPorts.filter((range) => range.protocol === 'tcp')),
    ),
    [udp, setUDP] = useState(
      rangesText(state.settings.ingressPorts.filter((range) => range.protocol === 'udp')),
    );
  const setCore = (url) => setValue((v) => ({ ...v, komodo: { ...v.komodo, url } }));
  function updateServer(index, patch) {
    setValue((v) => ({
      ...v,
      komodo: {
        ...v.komodo,
        servers: v.komodo.servers.map((server, i) =>
          i === index ? { ...server, ...patch } : server,
        ),
      },
    }));
  }
  function updateTarget(index, patch) {
    setTargets((list) => list.map((target, i) => (i === index ? { ...target, ...patch } : target)));
  }
  async function loadServers() {
    setLoading(true);
    setError('');
    try {
      setAvailable(
        await api('/komodo/servers', { method: 'POST', body: { url: value.komodo.url } }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  function candidate() {
    return {
      ...value,
      targets: targets.map(({ portsText, ...target }) => ({ ...target, ports: ranges(portsText) })),
      ingressPorts: [
        ...ranges(tcp).map((range) => ({ ...range, protocol: 'tcp' })),
        ...ranges(udp).map((range) => ({ ...range, protocol: 'udp' })),
      ],
    };
  }
  async function save() {
    setError('');
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: candidate() });
      await onSaved('Settings applied');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function next(s) {
    setError('');
    try {
      if (step === 2 && s > step) candidate();
      setStep(s);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <Wizard
      title="Proxy settings"
      steps={['Komodo', 'Servers', 'Access', 'Domains', 'Review']}
      step={step}
      onStep={next}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      submitLabel="Apply settings"
      error={error}
    >
      {step === 0 && (
        <>
          <label>
            Core URL
            <input
              type="url"
              value={value.komodo.url}
              onChange={(e) => setCore(e.target.value)}
              placeholder="Komodo Core URL"
            />
          </label>
          <p className="hint">API credentials come from Komodo environment variables.</p>
        </>
      )}
      {step === 1 && (
        <>
          <div className="section-title">
            <h2>Server mappings</h2>
            <button
              type="button"
              className="secondary"
              disabled={loading || !value.komodo.url}
              onClick={loadServers}
            >
              <RefreshCw size={15} />
              {loading ? 'Loading…' : 'Load from Core'}
            </button>
          </div>
          <datalist id="komodo-server-list">
            {available.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </datalist>
          {value.komodo.servers.map((server, index) => (
            <section className="configuration-card" key={index}>
              <div className="section-title">
                <strong>{server.name || 'Server'}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove server ${index + 1}`}
                  onClick={() =>
                    setValue((v) => ({
                      ...v,
                      komodo: {
                        ...v.komodo,
                        servers: v.komodo.servers.filter((_, i) => i !== index),
                      },
                    }))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <label>
                Komodo server
                <input
                  required
                  list="komodo-server-list"
                  value={server.id}
                  onChange={(e) =>
                    updateServer(index, {
                      id: e.target.value,
                      ...(available.find((item) => item.id === e.target.value)
                        ? { name: available.find((item) => item.id === e.target.value).name }
                        : {}),
                    })
                  }
                  placeholder="Choose a loaded server or enter its ID"
                />
              </label>
              <div className="field-pair">
                <label>
                  Name
                  <input
                    required
                    maxLength={80}
                    value={server.name}
                    onChange={(e) => updateServer(index, { name: e.target.value })}
                  />
                </label>
                <label>
                  Reachable IP
                  <input
                    required
                    value={server.address}
                    onChange={(e) => updateServer(index, { address: e.target.value })}
                    placeholder="Tailscale IP or VPS loopback"
                  />
                </label>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={server.local}
                  onChange={(e) => updateServer(index, { local: e.target.checked })}
                />
                This VPS
              </label>
            </section>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={value.komodo.servers.length >= 20}
            onClick={() =>
              setValue((v) => ({
                ...v,
                komodo: {
                  ...v.komodo,
                  servers: [...v.komodo.servers, { id: '', name: '', address: '', local: false }],
                },
              }))
            }
          >
            <Plus size={15} />
            Add server
          </button>
        </>
      )}
      {step === 2 && (
        <>
          <h2>Destinations</h2>
          <p className="hint">Approve the IPs and host ports routes can reach.</p>
          {targets.map((target, index) => (
            <section className="configuration-card" key={index}>
              <div className="section-title">
                <strong>{target.name || 'Destination'}</strong>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove destination ${index + 1}`}
                  onClick={() => setTargets((list) => list.filter((_, i) => i !== index))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="field-pair">
                <label>
                  Name
                  <input
                    required
                    maxLength={80}
                    value={target.name}
                    onChange={(e) => updateTarget(index, { name: e.target.value })}
                  />
                </label>
                <label>
                  IP address
                  <input
                    required
                    value={target.address}
                    onChange={(e) => updateTarget(index, { address: e.target.value })}
                  />
                </label>
              </div>
              <label>
                Allowed ports
                <input
                  required
                  value={target.portsText}
                  onChange={(e) => updateTarget(index, { portsText: e.target.value })}
                  placeholder="Ports and ranges, separated by commas"
                />
              </label>
            </section>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={targets.length >= 100}
            onClick={() =>
              setTargets((list) => [...list, { name: '', address: '', portsText: '' }])
            }
          >
            <Plus size={15} />
            Add destination
          </button>
          <section className="option-group">
            <h2>Public port blocks</h2>
            <p className="hint">HTTP/HTTPS ports 80 and 443 are handled automatically.</p>
            <div className="field-pair">
              <label>
                TCP
                <input
                  value={tcp}
                  onChange={(e) => setTCP(e.target.value)}
                  placeholder="Ports and ranges"
                />
              </label>
              <label>
                UDP
                <input
                  value={udp}
                  onChange={(e) => setUDP(e.target.value)}
                  placeholder="Ports and ranges"
                />
              </label>
            </div>
            <label>
              Stream port budget
              <input
                type="number"
                min={1}
                max={10000}
                required
                value={value.maxRangePorts}
                onChange={(e) => setValue((v) => ({ ...v, maxRangePorts: Number(e.target.value) }))}
              />
            </label>
            <p className="hint">VPS ingress: {state.policy.ingressIPs.join(', ')}</p>
          </section>
        </>
      )}
      {step === 3 && (
        <>
          {value.domains.map((domain, index) => (
            <div className="domain-input" key={index}>
              <label>
                Domain
                <input
                  required
                  value={domain.name}
                  onChange={(e) =>
                    setValue((v) => ({
                      ...v,
                      domains: v.domains.map((item, i) =>
                        i === index ? { name: e.target.value } : item,
                      ),
                    }))
                  }
                />
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove domain ${index + 1}`}
                onClick={() =>
                  setValue((v) => ({ ...v, domains: v.domains.filter((_, i) => i !== index) }))
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={value.domains.length >= 50}
            onClick={() => setValue((v) => ({ ...v, domains: [...v.domains, { name: '' }] }))}
          >
            <Plus size={15} />
            Add domain
          </button>
          <section className="option-group">
            <h2>Certificates</h2>
            <label>
              ACME email
              <input
                type="email"
                required={value.domains.length > 0}
                value={value.certificates.email}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, email: e.target.value },
                  }))
                }
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value.certificates.staging}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, staging: e.target.checked },
                  }))
                }
              />
              Test certificates (staging)
            </label>
            <p className="hint">Switch staging off before publishing HTTPS routes.</p>
            <label>
              DNS propagation (seconds)
              <input
                type="number"
                required
                min={10}
                max={600}
                value={value.certificates.propagationSeconds}
                onChange={(e) =>
                  setValue((v) => ({
                    ...v,
                    certificates: { ...v.certificates, propagationSeconds: Number(e.target.value) },
                  }))
                }
              />
            </label>
          </section>
        </>
      )}
      {step === 4 && (
        <>
          <dl className="review-list">
            <div>
              <dt>Core</dt>
              <dd>{value.komodo.url || 'Not connected'}</dd>
            </div>
            <div>
              <dt>Servers</dt>
              <dd>{value.komodo.servers.map((server) => server.name).join(', ') || 'None'}</dd>
            </div>
            <div>
              <dt>Destinations</dt>
              <dd>
                {targets
                  .map((target) => `${target.name} · ${target.address} · ${target.portsText}`)
                  .join('; ') || 'None'}
              </dd>
            </div>
            <div>
              <dt>Public TCP</dt>
              <dd>{tcp || 'None'}</dd>
            </div>
            <div>
              <dt>Public UDP</dt>
              <dd>{udp || 'None'}</dd>
            </div>
            <div>
              <dt>Domains</dt>
              <dd>{value.domains.map((domain) => domain.name).join(', ') || 'None'}</dd>
            </div>
            <div>
              <dt>Certificates</dt>
              <dd>{value.certificates.staging ? 'Staging' : 'Production'}</dd>
            </div>
          </dl>
          <p className="review-note">Changes are validated against saved routes before applying.</p>
        </>
      )}
    </Wizard>
  );
}
