import { Button, NumberField, Disclosure } from './controls.jsx';
import { TextInput, Switch, Tabs, Paper, Stack, Group, Text, Anchor, Alert } from '@mantine/core';
import React, { useState, useEffect } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Plus, KeyRound, Trash2, Download, Pencil } from 'lucide-react';
import Modal from './dialog.jsx';
import { api, setCSRF } from './api.js';
import { useNavigation } from './navigation.js';
const when = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
export default function Settings({ state, refresh, report, onRecovery, onLogout }) {
  const { settingsSection: section, setSettingsSection } = useNavigation();
  const [preferences, setPreferences] = useState(state.settings);
  const [saved, setSaved] = useState(false);
  const [renaming, setRenaming] = useState(null),
    [nameError, setNameError] = useState(''),
    [savingName, setSavingName] = useState(false);
  const [keys, setKeys] = useState([]),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setKeys(
        await api('/auth/passkeys', {
          method: 'POST',
        }),
      );
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
      const optionsJSON = await api('/auth/register/options', {
        method: 'POST',
      });
      const response = await startRegistration({
        optionsJSON,
      });
      const result = await api('/auth/register/verify', {
        method: 'POST',
        body: response,
      });
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
  async function savePreferences(e) {
    e.preventDefault();
    setBusy(true);
    setSaved(false);
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
      setSaved(true);
    } catch (e) {
      report(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  function certificate(key, value) {
    setSaved(false);
    setPreferences((p) => ({
      ...p,
      certificates: {
        ...p.certificates,
        [key]: value,
      },
    }));
  }
  return (
    <Tabs
      value={section}
      onChange={(next) => {
        setSaved(false);
        setSettingsSection(next);
      }}
      className="settings-tabs"
      keepMounted={false}
    >
      <Tabs.List mb="xl">
        <Tabs.Tab value="general">General</Tabs.Tab>
        <Tabs.Tab value="certificates">Certificates</Tabs.Tab>
        <Tabs.Tab value="access">Access</Tabs.Tab>
        <Tabs.Tab value="backup">Backup</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="general">
        <Paper withBorder p="xl" radius="lg" className="settings-pane">
          <form onSubmit={savePreferences}>
            <Stack gap="lg">
              <h2>Admin panel</h2>
              <TextInput
                label="Public hostname"
                placeholder="proxy.example.com"
                value={preferences.adminHostname}
                description="Leave empty for private access only. The hostname needs a configured domain and certificate."
                onChange={(e) => {
                  setSaved(false);
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
                  {saved ? 'Saved' : 'Save changes'}
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Tabs.Panel>
      <Tabs.Panel value="certificates">
        <Paper withBorder p="xl" radius="lg" className="settings-pane">
          <form onSubmit={savePreferences}>
            <Stack gap="lg">
              <h2>Certificates</h2>
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
                  {saved ? 'Saved' : 'Save changes'}
                </Button>
              </Group>
            </Stack>
          </form>
        </Paper>
      </Tabs.Panel>
      <Tabs.Panel value="access">
        <Paper withBorder p="xl" radius="lg" className="settings-pane">
          <Group justify="space-between" mb="lg">
            <h2>Passkeys</h2>
            <Button className="secondary" onClick={addKey} loading={busy}>
              <Plus size={16} />
              Add passkey
            </Button>
          </Group>
          {keys.map((key, index) => (
            <div className="key-row" key={key.id}>
              <KeyRound size={20} />
              <div>
                <Text size="sm" fw={500}>
                  {key.name || `Passkey ${index + 1}`}
                </Text>
                <Text size="xs" c="dimmed">
                  {key.hostname} · {when(key.created)}
                </Text>
              </div>
              <Group gap="xs" wrap="nowrap">
                <Button
                  className="icon-button"
                  aria-label={`Rename ${key.name || `passkey ${index + 1}`}`}
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
                  aria-label={'Revoke passkey ' + (index + 1) + ' and sign out all sessions'}
                >
                  <Trash2 size={16} />
                </Button>
              </Group>
            </div>
          ))}
        </Paper>
      </Tabs.Panel>
      <Tabs.Panel value="backup">
        <Paper withBorder p="xl" radius="lg" className="settings-pane">
          <Stack gap="lg">
            <h2>Configuration backup</h2>
            <Text size="sm" c="dimmed">
              Routes, domains and file rules. Authentication, certificates and secrets are excluded.
            </Text>
            <Group>
              <Button component="a" className="secondary" href="/api/export" download>
                <Download size={16} />
                Export configuration
              </Button>
            </Group>
          </Stack>
        </Paper>
      </Tabs.Panel>
      {renaming && (
        <Modal
          title="Name passkey"
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
    </Tabs>
  );
}
