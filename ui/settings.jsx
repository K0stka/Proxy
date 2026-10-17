import React, { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Plus, KeyRound, Trash2, Download, RefreshCw } from 'lucide-react';
import { api, setCSRF } from './api.js';
const when = (value) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function Settings({
  state,
  refresh,
  report,
  onRecovery,
  onLogout,
  onEditPages,
  onConfigure,
}) {
  const [keys, setKeys] = useState([]),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setKeys(await api('/auth/passkeys', { method: 'POST' }));
    } catch (e) {
      report(e.message, true);
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function addKey() {
    setBusy(true);
    try {
      const optionsJSON = await api('/auth/register/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON });
      const result = await api('/auth/register/verify', { method: 'POST', body: response });
      setCSRF(result.csrf);
      if (result.recoveryCode) onRecovery(result.recoveryCode);
      await load();
      report('Passkey added.');
    } catch (e) {
      report(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  async function removeKey(id) {
    try {
      await api('/auth/passkeys/remove', { method: 'POST', body: { id } });
      onLogout();
    } catch (e) {
      report(e.message, true);
    }
  }
  return (
    <div className="settings-grid">
      <div>
        <section className="settings-block">
          <div className="section-title">
            <h3>Passkeys</h3>
            <button className="secondary" onClick={addKey} disabled={busy}>
              <Plus size={15} />
              Add passkey
            </button>
          </div>
          {keys.map((key, i) => (
            <div className="key-row" key={key.id}>
              <KeyRound size={17} />
              <div>
                Passkey {i + 1}
                <small>Added {when(key.created)}</small>
              </div>
              <button
                className="icon-button"
                disabled={keys.length < 2}
                onClick={() => removeKey(key.id)}
                aria-label={`Revoke passkey ${i + 1} and sign out all sessions`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </section>
        <section className="settings-block">
          <div className="section-title">
            <h3>Error pages</h3>
            <button className="secondary" onClick={onEditPages}>
              Edit pages
            </button>
          </div>
          {[
            ['404', state.pages.notFoundSite],
            ['502', state.pages.badGatewaySite],
          ].map(([code, site]) => (
            <div className="policy-row" key={code}>
              <strong>{code}</strong>
              <code>{site ? `/sites/${site.directory}` : 'Built-in'}</code>
            </div>
          ))}
        </section>
      </div>
      <div>
        <section className="settings-block">
          <div className="section-title">
            <h3>Connections & routing</h3>
            <button className="secondary" onClick={onConfigure}>
              Configure
            </button>
          </div>
          <p>{state.settings.komodo.url || 'Komodo is not connected.'}</p>
          <div className="policy-row">
            <strong>Servers</strong>
            <span>{state.settings.komodo.servers.length}</span>
          </div>
          {state.policy.targets.map((t) => (
            <div className="policy-row" key={t.address}>
              <strong>{t.name}</strong>
              <code>{t.address}</code>
              <small>
                {t.ports.map((p) => (p.from === p.to ? p.from : `${p.from}–${p.to}`)).join(', ')}
              </small>
            </div>
          ))}
          <div className="hint">Ingress: {state.policy.ingressIPs.join(', ')}</div>
        </section>
        <section className="settings-block">
          <h3>Backups</h3>
          <p>Configuration only. Authentication, certificates and secrets are excluded.</p>
          <a className="secondary" href="/api/export" download>
            <Download size={15} />
            Export configuration
          </a>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api('/reconcile', { method: 'POST' });
                await refresh();
                report('Configuration applied');
              } catch (e) {
                report(e.message, true);
              }
            }}
          >
            <RefreshCw size={15} />
            Reapply configuration
          </button>
        </section>
      </div>
    </div>
  );
}
