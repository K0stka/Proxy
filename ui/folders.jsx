import { Button } from './controls.jsx';
import { TextInput, Alert, Paper } from '@mantine/core';
import React, { useState } from 'react';
import { ArrowUpRight, FolderOpen, Plus, Pencil, Trash2 } from 'lucide-react';
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
export default function Folders({ catalog, onHost, onEdit, onCreate, onSaved }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
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
            <FolderOpen size={23} />
            <strong>{folder.directory}</strong>
            <code>/sites/{folder.directory}</code>
            <div className="folder-actions">
              <Button className="secondary" onClick={() => onEdit(folder)}>
                <Pencil size={15} />
                Edit
              </Button>
              <Button className="secondary" onClick={() => onHost(folder.directory)}>
                Host folder
                <ArrowUpRight size={15} />
              </Button>
              <Button
                className="icon-button"
                disabled={busy}
                aria-label={`Remove folder definition ${folder.directory}`}
                onClick={() => remove(folder.directory)}
              >
                <Trash2 size={15} />
              </Button>
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
    </>
  );
}
