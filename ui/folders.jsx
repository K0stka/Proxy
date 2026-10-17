import React, { useState } from 'react';
import { ArrowUpRight, FolderOpen, Plus, Pencil, Trash2 } from 'lucide-react';
import { api } from './api.js';
import { blankSite } from './routes.js';
import { SitePicker, Wizard } from './wizards.jsx';

export function FolderWizard({ initial, onClose, onSaved }) {
  const [value, setValue] = useState(initial ?? blankSite('')),
    [step, setStep] = useState(0),
    [check, setCheck] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/sites/config', {
        method: 'PUT',
        body: { ...value, ...(initial ? { previousDirectory: initial.directory } : {}) },
      });
      await onSaved('Folder saved');
    } catch (e) {
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
      submitLabel="Save folder"
      error={error}
      canContinue={Boolean(check) && check.directory === value.directory}
    >
      {step === 0 ? (
        <>
          <label>
            Path inside /sites
            <input
              required
              value={value.directory}
              onChange={(e) => setValue((v) => ({ ...v, directory: e.target.value }))}
              placeholder="Relative folder path"
            />
          </label>
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
      await api('/sites/config', { method: 'DELETE', body: { directory } });
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
        <button className="primary" onClick={onCreate}>
          <Plus size={15} />
          Add folder
        </button>
      </div>
      {(error || catalog.error) && (
        <div className="notice error" role="alert">
          {error || catalog.error}
        </div>
      )}
      <div className="folder-grid">
        {catalog.folders.map((folder) => (
          <article className="folder-card" key={folder.directory}>
            <FolderOpen size={23} />
            <strong>{folder.directory}</strong>
            <code>/sites/{folder.directory}</code>
            <div className="folder-actions">
              <button className="secondary" onClick={() => onEdit(folder)}>
                <Pencil size={15} />
                Edit
              </button>
              <button className="secondary" onClick={() => onHost(folder.directory)}>
                Host folder
                <ArrowUpRight size={15} />
              </button>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`Remove folder definition ${folder.directory}`}
                onClick={() => remove(folder.directory)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </article>
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
