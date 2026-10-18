import { Button } from './controls.jsx';
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { Waypoints, Check, KeyRound, Fingerprint, CircleAlert } from 'lucide-react';
import { api, setCSRF } from './api.js';
import Modal from './dialog.jsx';
import Workspace from './workspace.jsx';
import { ToastProvider } from './toasts.jsx';
import { MantineProvider, createTheme, PasswordInput, Alert } from '@mantine/core';
import '@mantine/core/styles.css';
import './style.css';
function Recovery({ code, onClose }) {
  return (
    <Modal title="Save your recovery code" onClose={onClose}>
      <p>Save this code in your password manager. It is shown once.</p>
      <code className="recovery-code">{code}</code>
      <Button className="primary full" onClick={onClose}>
        <Check size={16} /> I've saved it
      </Button>
    </Modal>
  );
}
function AuthScreen({ status, onAuth }) {
  const [token, setToken] = useState(''),
    [code, setCode] = useState(''),
    [recover, setRecover] = useState(status.enrolled && status.originEnrolled === false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let result;
      if (recover)
        result = await api('/auth/recover', {
          method: 'POST',
          body: {
            code,
          },
        });
      else if (!status.enrolled) {
        const optionsJSON = await api('/auth/register/options', {
          method: 'POST',
          body: {
            token,
          },
        });
        const response = await startRegistration({
          optionsJSON,
        });
        result = await api('/auth/register/verify', {
          method: 'POST',
          body: response,
        });
      } else {
        const optionsJSON = await api('/auth/login/options', {
          method: 'POST',
        });
        const response = await startAuthentication({
          optionsJSON,
        });
        result = await api('/auth/login/verify', {
          method: 'POST',
          body: response,
        });
      }
      setCSRF(result.csrf);
      if (recover && status.originEnrolled === false) {
        try {
          const optionsJSON = await api('/auth/register/options', {
            method: 'POST',
          });
          const response = await startRegistration({
            optionsJSON,
          });
          const registered = await api('/auth/register/verify', {
            method: 'POST',
            body: response,
          });
          setCSRF(registered.csrf);
          result = {
            ...registered,
            recoveryCode: result.recoveryCode,
          };
        } catch {
          // Recovery already rotated the code; show it even if passkey setup was cancelled.
          onAuth(result);
          return;
        }
      }
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
          <span className="brand-mark">
            <Waypoints />
          </span>
          Proxy
        </div>
        <div className="auth-symbol">
          <Fingerprint size={32} />
        </div>
        <h1>{recover ? 'Recovery' : status.enrolled ? 'Sign in' : 'Set up Proxy'}</h1>
        <form onSubmit={submit}>
          {recover ? (
            <PasswordInput
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              label="Recovery code"
              description={
                status.originEnrolled === false && status.enrolled
                  ? 'Authorize a passkey for this hostname.'
                  : undefined
              }
            />
          ) : (
            !status.enrolled && (
              <PasswordInput
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                label={'Enrollment token'}
                description={'PROXY_BOOTSTRAP_TOKEN from Komodo.'}
              />
            )
          )}
          {error && (
            <Alert className="notice error" role="alert" color="red" variant="light">
              {error}
            </Alert>
          )}
          <Button className="primary full" disabled={busy} type="submit">
            <KeyRound size={17} />
            {busy
              ? 'Waiting…'
              : recover
                ? 'Recover access'
                : status.enrolled
                  ? 'Sign in with a passkey'
                  : 'Create passkey'}
          </Button>
        </form>
        {status.enrolled && (
          <Button
            className="text-button"
            onClick={() => {
              setRecover(!recover);
              setError('');
            }}
          >
            {recover ? 'Back to sign in' : 'Lost your passkey?'}
          </Button>
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
          <Button className="secondary" onClick={load}>
            Try again
          </Button>
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
            setStatus({
              ...status,
              authenticated: false,
            });
          }}
          onRecovery={setRecovery}
        />
      ) : (
        <AuthScreen
          status={status}
          onAuth={(result) => {
            setStatus({
              enrolled: true,
              authenticated: true,
            });
            if (result.recoveryCode) setRecovery(result.recoveryCode);
          }}
        />
      )}
      {recovery && <Recovery code={recovery} onClose={() => setRecovery(null)} />}
    </>
  );
}
const theme = createTheme({
  primaryColor: 'teal',
  primaryShade: 6,
  colors: {
    teal: [
      '#e9f6f3', '#ceebe3', '#a0d7c9', '#6fc1ad', '#45ad92',
      '#29977e', '#1d816c', '#156b5a', '#105648', '#0b453a',
    ],
  },
  defaultRadius: 'md',
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  headings: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontWeight: '600',
  },
  components: {
    Button: {
      defaultProps: {
        fw: 550,
      },
    },
    TextInput: {
      defaultProps: {
        size: 'sm',
      },
    },
    Select: {
      defaultProps: {
        size: 'sm',
      },
    },
    TagsInput: {
      defaultProps: {
        size: 'sm',
      },
    },
  },
});
createRoot(document.getElementById('root')).render(
  <MantineProvider
    theme={theme}
    defaultColorScheme="auto"
    getStyleNonce={() => document.querySelector('meta[name="style-nonce"]')?.content}
  >
    <ToastProvider>
      <App />
    </ToastProvider>
  </MantineProvider>,
);
