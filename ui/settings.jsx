import React, { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Plus, KeyRound, Trash2, Download } from 'lucide-react';
import { api, setCSRF } from './api.js';
import { useNavigation } from './navigation.js';
const when = (value) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function Settings({ state, refresh, report, onRecovery, onLogout }) {
  const { settingsSection: section, setSettingsSection } = useNavigation();
  const [preferences, setPreferences] = useState(state.settings);
  const [saved, setSaved] = useState(false);
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
    if (section === 'access') load();
  }, [section]);
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
  async function savePreferences(e) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
    try {
      await api('/preferences', { method: 'PUT', body: section === 'general'
        ? { adminHostname: preferences.adminHostname } : { certificates: preferences.certificates } });
      await refresh();
      setSaved(true);
    } catch (e) { report(e.message, true); }
    finally { setBusy(false); }
  }
  function certificate(key, value) {
    setSaved(false);
    setPreferences((p) => ({ ...p, certificates: { ...p.certificates, [key]: value } }));
  }
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings">
        {['general', 'certificates', 'access', 'backup'].map((name) => (
          <button key={name} aria-current={section === name ? 'page' : undefined}
            onClick={() => { setSaved(false); setSettingsSection(name); }}>
            {{general:'General', certificates:'Certificates', access:'Access', backup:'Backup'}[name]}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {section === 'general' && <section>
          <h2>Admin panel</h2>
          <form onSubmit={savePreferences}>
            <label>Public hostname
              <input value={preferences.adminHostname} placeholder="proxy.example.com"
                onChange={(e) => { setSaved(false); setPreferences((p) => ({ ...p, adminHostname: e.target.value })); }} />
            </label>
            <p className="hint">Leave empty to disable public access. Requires a configured domain and certificate.</p>
            <div className="settings-row"><span>Private address</span><a href={state.policy.origin}>{state.policy.origin}</a></div>
            <button className="primary" disabled={busy}>{saved ? 'Saved' : 'Save changes'}</button>
          </form>
        </section>}
        {section === 'certificates' && <section>
          <h2>Certificates</h2>
          <form onSubmit={savePreferences}>
            <label>Email
              <input type="email" required value={preferences.certificates.email}
                onChange={(e) => certificate('email', e.target.value)} />
              <span className="hint">Used for every domain.</span>
            </label>
            <details className="route-options" open={preferences.certificates.staging || undefined}>
              <summary>Diagnostics</summary>
              <label className="checkbox"><input type="checkbox" checked={preferences.certificates.staging}
                onChange={(e) => certificate('staging', e.target.checked)} />Use test certificates</label>
              <label>DNS propagation (seconds)<input type="number" min={10} max={600} required
                value={preferences.certificates.propagationSeconds}
                onChange={(e) => certificate('propagationSeconds', Number(e.target.value))} /></label>
            </details>
            <button className="primary" disabled={busy}>{saved ? 'Saved' : 'Save changes'}</button>
          </form>
        </section>}
        {section === 'access' && <section>
          <h2>Access</h2>
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
                <small>{key.hostname} · Added {when(key.created)}</small>
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
        </section>}
        {section === 'backup' && <section>
          <h2>Backup</h2>
          <p>Configuration only. Authentication, certificates and secrets are excluded.</p>
          <a className="secondary" href="/api/export" download>
            <Download size={15} />
            Export configuration
          </a>
        </section>}
      </div>
    </div>
  );
}
