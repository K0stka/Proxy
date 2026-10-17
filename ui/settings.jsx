import React, { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Plus, KeyRound, Trash2, Download } from 'lucide-react';
import { api, setCSRF } from './api.js';
const when = (value) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export default function Settings({ report, onRecovery, onLogout }) {
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
      </div>
      <div>
        <section className="settings-block">
          <h3>Configuration</h3>
          <p>Configuration only. Authentication, certificates and secrets are excluded.</p>
          <a className="secondary" href="/api/export" download>
            <Download size={15} />
            Export configuration
          </a>
        </section>
      </div>
    </div>
  );
}
