import React, { useState } from 'react';
import { ArrowLeft, ArrowUpRight, FolderOpen, Save } from 'lucide-react';
import { api } from './api.js';
import { folderRules } from './routes.js';
import { SitePicker } from './wizards.jsx';

export default function Files({ catalog, state, onHost, onSaved }) {
  const [selected, setSelected] = useState(null),
    [check, setCheck] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function open(directory) {
    setSelected(folderRules(state, directory));
    setCheck(null);
    setError('');
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/sites/config', { method: 'PUT', body: selected });
      await onSaved('File rules saved');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (selected) {
    const uses = state.routes
      .filter(
        (route) => route.kind === 'static' && route.staticSite.directory === selected.directory,
      )
      .map((route) => route.hostname);
    if (state.pages.notFoundSite?.directory === selected.directory) uses.push('404 page');
    if (state.pages.badGatewaySite?.directory === selected.directory) uses.push('502 page');
    return (
      <section className="files-editor">
        <div className="files-heading">
          <button className="text-button" disabled={busy} onClick={() => setSelected(null)}>
            <ArrowLeft size={15} />
            Folders
          </button>
          <h2>{selected.directory}</h2>
        </div>
        {uses.length > 0 && <p className="folder-uses">Used by {uses.join(', ')}</p>}
        <fieldset disabled={busy}>
          <SitePicker
            key={selected.directory}
            value={selected}
            onChange={setSelected}
            onStatus={setCheck}
            editRules
            fixedDirectory
          />
        </fieldset>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="files-actions">
          <span className="hint">Saved rules apply to every use of this folder.</span>
          <button
            className="primary"
            disabled={busy || !check?.exposed.includes('index.html')}
            onClick={save}
          >
            <Save size={15} />
            {busy ? 'Saving…' : 'Save rules'}
          </button>
        </div>
      </section>
    );
  }
  return (
    <>
      {catalog.error && (
        <div className="notice error" role="alert">
          {catalog.error}
        </div>
      )}
      <div className="folder-grid">
        {catalog.folders
          .filter((folder) => folder.hasIndex)
          .map((folder) => (
            <article className="folder-card" key={folder.directory}>
              <FolderOpen size={23} />
              <strong>{folder.directory}</strong>
              <code>/sites/{folder.directory}</code>
              <div className="folder-actions">
                <button className="primary" onClick={() => open(folder.directory)}>
                  File rules
                </button>
                <button className="secondary" onClick={() => onHost(folder.directory)}>
                  Host folder
                  <ArrowUpRight size={15} />
                </button>
              </div>
            </article>
          ))}
      </div>
      {!catalog.folders.some((folder) => folder.hasIndex) && !catalog.error && (
        <div className="empty-state">
          <FolderOpen size={28} />
          <h2>No websites</h2>
          <p>Add folders containing index.html to /sites.</p>
        </div>
      )}
    </>
  );
}
