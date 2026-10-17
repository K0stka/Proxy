import { Button } from './controls.jsx';
import { TextInput, Alert, Paper, Group, Text, Menu } from '@mantine/core';
import React, { useState } from 'react';
import { FolderOpen, Plus, Pencil, Trash2, MoreHorizontal, GitPullRequest } from 'lucide-react';
import { api } from './api.js';
import { blankSite } from './routes.js';
import { SitePicker, Wizard } from './wizards.jsx';
import { useNavigation, useWizardField } from './navigation.js';
export function FolderWizard({ initial, onClose, onSaved }) {
  const { step, setStep } = useNavigation();
  const [value, setValue] = useWizardField('folder', initial ?? blankSite(''));
  const [check, setCheck] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/sites/config', {
        method: 'PUT',
        body: {
          ...value,
          ...(initial
            ? {
                previousDirectory: initial.directory,
              }
            : {}),
        },
      });
      await onSaved('Folder saved');
    } catch (e) {
      if ([400, 409].includes(e.status)) setStep(0);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Wizard
      title={initial ? 'Edit folder' : 'Add folder'}
      steps={['Folder', 'Review']}
      step={step}
      onStep={setStep}
      onClose={onClose}
      busy={busy}
      onSubmit={save}
      onValidate={() =>
        api('/validate', {
          method: 'POST',
          body: {
            kind: 'folder',
            value,
            previousDirectory: initial?.directory,
          },
        })
      }
      submitLabel="Save folder"
      error={error}
      canContinue={step > 0 || (Boolean(check) && check.directory === value.directory)}
    >
      {step === 0 ? (
        <>
          <TextInput
            required
            value={value.directory}
            onChange={(e) =>
              setValue((v) => ({
                ...v,
                directory: e.target.value,
              }))
            }
            placeholder="websites/portfolio (no leading or trailing /)"
            label={'Path inside /sites'}
          />
          <SitePicker
            value={value}
            onChange={setValue}
            onStatus={setCheck}
            editRules
            fixedDirectory
          />
        </>
      ) : (
        <>
          <dl className="review-list">
            <div>
              <dt>Path</dt>
              <dd>/sites/{value.directory}</dd>
            </div>
            <div>
              <dt>Only expose</dt>
              <dd>{value.include.join(', ') || 'All files'}</dd>
            </div>
            <div>
              <dt>Hide</dt>
              <dd>{value.exclude.join(', ') || 'None'}</dd>
            </div>
            <div>
              <dt>Files exposed</dt>
              <dd>{check?.count}</dd>
            </div>
          </dl>
          <p className="review-note">Updates every route and error page using this folder.</p>
        </>
      )}
    </Wizard>
  );
}
export default function Folders({ catalog, onEdit, onCreate, onSaved }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(null),
    [result, setResult] = useState(null);
  async function pull(directory) {
    setPulling(directory);
    setError('');
    setResult(null);
    try {
      const updated = await api('/sites/pull', { method: 'POST', body: { directory } });
      setResult({ directory, message: updated.changed ? 'Updated' : 'Already up to date' });
      await onSaved('Folder updated');
    } catch (e) {
      setError(e.message);
    } finally {
      setPulling(null);
    }
  }
  async function remove(directory) {
    setBusy(true);
    setError('');
    try {
      await api('/sites/config', {
        method: 'DELETE',
        body: {
          directory,
        },
      });
      await onSaved('Folder removed');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="section-title">
        <h2>Folders</h2>
        <Button className="primary" onClick={onCreate}>
          <Plus size={15} />
          Add folder
        </Button>
      </div>
      {(error || catalog.error) && (
        <Alert className="notice error" role="alert" color="red" variant="light">
          {error || catalog.error}
        </Alert>
      )}
      <div className="folder-grid">
        {catalog.folders.map((folder) => (
          <Paper
            className="folder-card"
            key={folder.directory}
            component="article"
            withBorder={true}
            p="lg"
          >
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <div className="folder-heading">
                <FolderOpen size={22} />
                <div>
                  <h3>
                    {folder.directory
                      .split('/')[0]
                      .replace(/^./u, (letter) => letter.toLocaleUpperCase())}
                  </h3>
                  <code>/sites/{folder.directory}</code>
                </div>
              </div>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <Button
                    className="icon-button"
                    aria-label={`Folder actions for ${folder.directory}`}
                    disabled={busy || Boolean(pulling)}
                  >
                    <MoreHorizontal size={18} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    color="red"
                    leftSection={<Trash2 size={15} />}
                    onClick={() => remove(folder.directory)}
                  >
                    Remove folder
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
            <div className="folder-rules">
              <div>
                <Text size="xs" c="dimmed">
                  Include
                </Text>
                <Text size="sm" lineClamp={2} title={folder.include.join(', ')}>
                  {folder.include.join(', ') || 'All files'}
                </Text>
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  Exclude
                </Text>
                <Text size="sm" lineClamp={2} title={folder.exclude.join(', ')}>
                  {folder.exclude.join(', ') || 'None'}
                </Text>
              </div>
            </div>
            <Group justify="space-between" gap="sm" className="folder-actions">
              <Button
                className="secondary"
                onClick={() => onEdit(folder)}
                disabled={busy || Boolean(pulling)}
              >
                <Pencil size={15} />
                Edit rules
              </Button>
              {(catalog.repositories ?? []).some(
                (repo) => repo.directory === folder.directory && repo.git,
              ) && (
                <Button
                  className="secondary"
                  loading={pulling === folder.directory}
                  disabled={busy || Boolean(pulling && pulling !== folder.directory)}
                  onClick={() => pull(folder.directory)}
                >
                  <GitPullRequest size={15} />
                  Git pull
                </Button>
              )}
              {result?.directory === folder.directory && (
                <Text size="xs" c="dimmed" role="status">
                  {result.message}
                </Text>
              )}
            </Group>
          </Paper>
        ))}
      </div>
      {!catalog.folders.length && !catalog.error && (
        <div className="empty-state">
          <FolderOpen size={28} />
          <h2>No folders configured</h2>
        </div>
      )}
    </>
  );
}
