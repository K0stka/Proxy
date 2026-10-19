import { errorPageTypes } from '../shared/pages.js';
import { Button, NumberField, Disclosure } from './controls.jsx';
import { TextInput, Switch, Stack, Group, Text, Anchor, Alert } from '@mantine/core';
import React, { useState, useEffect } from 'react';
import { Plus, KeyRound, Trash2, Pencil, Copy } from 'lucide-react';
import Modal from './dialog.jsx';
import { api } from './api.js';
import { useNavigation } from './navigation.js';
import { compareNames } from './order.js';
import DiscordAlerts from './discord.jsx';
import { formatDateTime as when } from './date-time.js';
export default function Settings({ state, refresh, report, onLogout, onEditPage }) {
  const { settingsSection } = useNavigation();
  const [preferences, setPreferences] = useState(state.settings);
  const [renaming, setRenaming] = useState(null),
    [nameError, setNameError] = useState(''),
    [savingName, setSavingName] = useState(false);
  const [keys, setKeys] = useState([]),
    [busy, setBusy] = useState(false),
    [deviceLink, setDeviceLink] = useState(null),
    [copied, setCopied] = useState(false);
  async function load(silent = false) {
    try {
      setKeys(
        await api('/auth/passkeys', {
          method: 'POST',
        }),
      );
    } catch (e) {
      if (!silent) report(e.message, true);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (settingsSection === 'general') return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(settingsSection)?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [settingsSection]);
  async function addDevice() {
    setBusy(true);
    try {
      setCopied(false);
      setDeviceLink(
        await api('/auth/devices/link', {
          method: 'POST',
        }),
      );
    } catch (e) {
      report(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(deviceLink.url);
      setCopied(true);
    } catch {
      report('Could not copy the link. Select it manually.', true);
    }
  }
  async function removeKey(id) {
    try {
      await api('/auth/passkeys/remove', {
        method: 'POST',
        body: {
          id,
        },
      });
      onLogout();
    } catch (e) {
      report(e.message, true);
    }
  }
  async function renameKey(e) {
    e.preventDefault();
    setSavingName(true);
    setNameError('');
    try {
      await api('/auth/passkeys/rename', { method: 'POST', body: renaming });
      setKeys((keys) =>
        keys.map((key) => (key.id === renaming.id ? { ...key, name: renaming.name.trim() } : key)),
      );
      setRenaming(null);
    } catch (e) {
      setNameError(e.message);
    } finally {
      setSavingName(false);
    }
  }
  async function savePreferences(e, section) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/preferences', {
        method: 'PUT',
        body:
          section === 'general'
            ? {
                adminHostname: preferences.adminHostname,
              }
            : {
                certificates: preferences.certificates,
              },
      });
      await refresh();
      report('Settings saved');
    } catch (e) {
      report(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  function certificate(key, value) {
    setPreferences((p) => ({
      ...p,
      certificates: {
        ...p.certificates,
        [key]: value,
      },
    }));
  }
  return (
    <div className="settings-page">
      <section id="general" className="settings-section" aria-labelledby="general-heading">
        <form onSubmit={(e) => savePreferences(e, 'general')}>
          <Stack gap="lg">
            <h2 id="general-heading">Admin panel</h2>
            <TextInput
              label="Public hostname"
              placeholder="proxy.example.com"
              value={preferences.adminHostname}
              description="Leave empty for private access only. The hostname needs a configured domain and certificate."
              onChange={(e) => {
                setPreferences((p) => ({ ...p, adminHostname: e.target.value }));
              }}
            />
            <div className="settings-address">
              <Text size="sm" c="dimmed">
                Private address
              </Text>
              <Anchor href={state.policy.origin} size="sm">
                {state.policy.origin}
              </Anchor>
            </div>
            <Group justify="flex-end">
              <Button className="primary" type="submit" loading={busy}>
                Save changes
              </Button>
            </Group>
          </Stack>
        </form>
      </section>
      <section id="certificates" className="settings-section" aria-labelledby="certificates-heading">
        <form onSubmit={(e) => savePreferences(e, 'certificates')}>
          <Stack gap="lg">
            <h2 id="certificates-heading">Certificates</h2>
            <TextInput
              label="Contact email"
              description="Shared by all domains."
              type="email"
              required
              value={preferences.certificates.email}
              onChange={(e) => certificate('email', e.target.value)}
            />
            <Disclosure
              title="Certificate diagnostics"
              defaultOpen={preferences.certificates.staging}
            >
              <Switch
                label="Use test certificates"
                description="Test certificates cannot enable HTTPS routes."
                checked={preferences.certificates.staging}
                onChange={(e) => certificate('staging', e.target.checked)}
              />
              <NumberField
                label="DNS propagation"
                description="Seconds to wait for the DNS challenge."
                min={10}
                max={600}
                required
                value={preferences.certificates.propagationSeconds}
                onChange={(e) => certificate('propagationSeconds', Number(e.target.value))}
              />
            </Disclosure>
            <Group justify="flex-end">
              <Button className="primary" type="submit" loading={busy}>
                Save changes
              </Button>
            </Group>
          </Stack>
        </form>
      </section>
      <section id="error-pages" className="settings-section" aria-labelledby="error-pages-heading">
        <h2 id="error-pages-heading">Error pages</h2>
        <div className="error-page-list">
          {errorPageTypes.map(([code, key, label]) => (
            <article className="error-page-row" key={code}>
              <span className="error-page-code">{code}</span>
              <div className="error-page-info">
                <h3>{label}</h3>
                <code>{state.pages[key + 'Site']
                  ? `/sites/${state.pages[key + 'Site'].directory}/${state.pages[key + 'Document']}`
                  : 'Built-in page'}</code>
              </div>
              <Button className="icon-button" aria-label={`Edit ${code} page`} onClick={() => onEditPage(code)}>
                <Pencil size={17} />
              </Button>
            </article>
          ))}
        </div>
      </section>
      <section id="notifications" className="settings-section" aria-label="Discord notifications">
        <DiscordAlerts />
      </section>
      <section id="access" className="settings-section" aria-labelledby="access-heading">
        <Group justify="space-between" mb="lg">
          <h2 id="access-heading">Devices</h2>
          <Button className="secondary" onClick={addDevice} loading={busy}>
            <Plus size={16} />
            Add device
          </Button>
        </Group>
        <Text size="sm" c="dimmed" mb="md">
          Each device registers its own passkey. Add one from a signed-in device with a one-time
          link, or rename and revoke existing devices here.
        </Text>
        {keys
          .map((key, index) => ({ ...key, displayName: key.name || `Device ${index + 1}` }))
          .sort((a, b) => compareNames(a.displayName, b.displayName))
          .map((key) => (
            <div className="key-row" key={key.id}>
              <KeyRound size={20} />
              <div>
                <Text size="sm" fw={500}>
                  {key.displayName}
                </Text>
                <Text size="xs" c="dimmed">
                  {key.hostname} · {when(key.created)}
                </Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                <Button
                  className="icon-button"
                  aria-label={`Rename ${key.displayName}`}
                  onClick={() => {
                    setNameError('');
                    setRenaming({ id: key.id, name: key.name || '' });
                  }}
                >
                  <Pencil size={16} />
                </Button>
                <Button
                  className="icon-button"
                  disabled={keys.length < 2}
                  onClick={() => removeKey(key.id)}
                  aria-label={`Revoke ${key.displayName} and sign out all sessions`}
                >
                  <Trash2 size={16} />
                </Button>
              </Group>
            </div>
          ))}
      </section>
      {renaming && (
        <Modal
          title="Name device"
          onClose={() => {
            if (!savingName) setRenaming(null);
          }}
        >
          <form onSubmit={renameKey}>
            <Stack gap="lg">
              <TextInput
                label="Name"
                placeholder="e.g. Laptop or phone"
                autoFocus
                required
                maxLength={80}
                disabled={savingName}
                value={renaming.name}
                onChange={(e) => {
                  setNameError('');
                  setRenaming((key) => ({ ...key, name: e.target.value }));
                }}
              />
              {nameError && (
                <Alert color="red" role="alert">
                  {nameError}
                </Alert>
              )}
              <Group justify="flex-end" gap="lg">
                <Button
                  className="text-button"
                  disabled={savingName}
                  onClick={() => setRenaming(null)}
                >
                  Cancel
                </Button>
                <Button
                  className="primary"
                  type="submit"
                  loading={savingName}
                  disabled={!renaming.name.trim()}
                >
                  Save name
                </Button>
              </Group>
            </Stack>
          </form>
        </Modal>
      )}
      {deviceLink && (
        <Modal title="Add device" onClose={() => setDeviceLink(null)}>
          <Text size="sm" c="dimmed">
            Open this link on the new device to register its passkey. The link works once and
            expires {when(deviceLink.expires)}.
          </Text>
          <code className="recovery-code">{deviceLink.url}</code>
          <Group justify="flex-end" gap="lg">
            <Button className="text-button" onClick={() => setDeviceLink(null)}>
              Done
            </Button>
            <Button className="primary" onClick={copyLink}>
              <Copy size={16} />
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </Group>
        </Modal>
      )}
    </div>
  );
}
