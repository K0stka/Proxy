import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { Waypoints, Check, KeyRound, Fingerprint, CircleAlert } from 'lucide-react';
import { api, setCSRF } from './api.js';
import Modal from './dialog.jsx';
import Workspace from './workspace.jsx';
import './style.css';
function Recovery({ code, onClose }) {
  return (
    <Modal title="Save your recovery code" onClose={onClose}>
      <p>Save this code in your password manager. It is shown once.</p>
      <code className="recovery-code">{code}</code>
      <button className="primary full" onClick={onClose}>
        <Check size={16} /> I've saved it
      </button>
    </Modal>
  );
}
function AuthScreen({ status, onAuth }) {
  const [token, setToken] = useState(''),
    [code, setCode] = useState(''),
    [recover, setRecover] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result;
      if (recover) result = await api('/auth/recover', { method: 'POST', body: { code } });
      else if (!status.enrolled) {
        const optionsJSON = await api('/auth/register/options', {
          method: 'POST',
          body: { token },
        });
        const response = await startRegistration({ optionsJSON });
        result = await api('/auth/register/verify', { method: 'POST', body: response });
      } else {
        const optionsJSON = await api('/auth/login/options', { method: 'POST' });
        const response = await startAuthentication({ optionsJSON });
        result = await api('/auth/login/verify', { method: 'POST', body: response });
      }
      setCSRF(result.csrf);
      onAuth(result);
    } catch (e) {
      setError(e.name === 'NotAllowedError' ? 'Passkey prompt cancelled' : e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-panel">
        <div className="brand">
          <Waypoints /> proxy
        </div>
        <div className="auth-symbol">
          <Fingerprint size={32} />
        </div>
        <h1>{recover ? 'Recovery' : status.enrolled ? 'Sign in' : 'Set up Proxy'}</h1>
        <form onSubmit={submit}>
          {recover ? (
            <label>
              Recovery code
              <input
                type="password"
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </label>
          ) : (
            !status.enrolled && (
              <label>
                Enrollment token
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  required
                />
                <span className="hint">PROXY_BOOTSTRAP_TOKEN from Komodo.</span>
              </label>
            )
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          <button className="primary full" disabled={busy}>
            <KeyRound size={17} />
            {busy
              ? 'Waiting…'
              : recover
                ? 'Recover access'
                : status.enrolled
                  ? 'Sign in with a passkey'
                  : 'Create passkey'}
          </button>
        </form>
        {status.enrolled && (
          <button
            className="text-button"
            onClick={() => {
              setRecover(!recover);
              setError('');
            }}
          >
            {recover ? 'Back to sign in' : 'Lost your passkey?'}
          </button>
        )}
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(''),
    [recovery, setRecovery] = useState(null);
  const load = async () => {
    try {
      const s = await api('/auth/status');
      setCSRF(s.csrf);
      setStatus(s);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (error)
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <CircleAlert />
          <h1>Cannot reach Proxy.</h1>
          <p role="alert">{error}</p>
          <button className="secondary" onClick={load}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!status)
    return (
      <div className="loading">
        <Waypoints />
        Loading…
      </div>
    );
  return (
    <>
      {status.authenticated ? (
        <Workspace
          onLogout={() => {
            setCSRF('');
            setStatus({ ...status, authenticated: false });
          }}
          onRecovery={setRecovery}
        />
      ) : (
        <AuthScreen
          status={status}
          onAuth={(result) => {
            setStatus({ enrolled: true, authenticated: true });
            if (result.recoveryCode) setRecovery(result.recoveryCode);
          }}
        />
      )}
      {recovery && <Recovery code={recovery} onClose={() => setRecovery(null)} />}
    </>
  );
}
createRoot(document.getElementById('root')).render(<App />);
