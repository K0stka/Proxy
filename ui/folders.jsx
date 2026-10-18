import { Button } from './controls.jsx';
import { TextInput, Alert, Paper, Tooltip } from '@mantine/core';
import React, { useState } from 'react';
import { FolderOpen, Pencil, Trash2, GitPullRequest } from 'lucide-react';
import { api } from './api.js';
import { useToast } from './toasts.jsx';
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
export default function Folders({ catalog, onEdit, onSaved }) {
  const report = useToast();
  const [busy, setBusy] = useState(false);
  const [pulling, setPulling] = useState(null);
  async function pull(directory) {
    setPulling(directory);
    try {
      const updated = await api('/sites/pull', { method: 'POST', body: { directory } });
      await onSaved(updated.changed ? 'Folder updated' : 'Already up to date');
    } catch (e) {
      report(e.message, true);
    } finally {
      setPulling(null);
    }
  }
  async function remove(directory) {
    setBusy(true);
    try {
      await api('/sites/config', {
        method: 'DELETE',
        body: {
          directory,
        },
      });
      await onSaved('Folder removed');
    } catch (e) {
      report(e.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="folders-section" aria-label="Folders">
      {catalog.error && (
        <Alert className="notice error" role="alert" color="red" variant="light">
          {catalog.error}
        </Alert>
      )}
      <div className="folder-grid">
        {catalog.folders.map((folder) => (
          <Paper
            className="folder-card"
            key={folder.directory}
            component="article"
            withBorder={true}
          >
            <div className="service-icon"><FolderOpen size={20} /></div>
            <h3 className="folder-name">
              {folder.directory.split('/')[0].replace(/^./u, (letter) => letter.toLocaleUpperCase())}
            </h3>
            <code className="folder-path">/sites/{folder.directory}</code>
            <div className="folder-actions">
              <Tooltip label="Edit folder">
                <Button
                  className="icon-button"
                  aria-label={`Edit ${folder.directory}`}
                  onClick={() => onEdit(folder)}
                  disabled={busy || Boolean(pulling)}
                >
                  <Pencil size={17} />
                </Button>
              </Tooltip>
              {(catalog.repositories ?? []).some(
                (repo) => repo.directory === folder.directory && repo.git,
              ) && (
                <Tooltip label="Git pull">
                  <Button
                    className="icon-button"
                    aria-label={`Git pull ${folder.directory}`}
                    loading={pulling === folder.directory}
                    disabled={busy || Boolean(pulling && pulling !== folder.directory)}
                    onClick={() => pull(folder.directory)}
                  >
                    <GitPullRequest size={17} />
                  </Button>
                </Tooltip>
              )}
              <Tooltip label="Remove folder">
                <Button
                  className="icon-button"
                  aria-label={`Remove ${folder.directory}`}
                  color="red.6"
                  disabled={busy || Boolean(pulling)}
                  onClick={() => remove(folder.directory)}
                >
                  <Trash2 size={17} />
                </Button>
              </Tooltip>
            </div>
          </Paper>
        ))}
      </div>
      {!catalog.folders.length && !catalog.error && (
        <div className="empty-state">
          <FolderOpen size={28} />
          <h2>No folders configured</h2>
        </div>
      )}
    </section>
  );
}
