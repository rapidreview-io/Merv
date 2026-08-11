import { useEffect, useState } from 'react';
import { api } from '../api';

const GIB = 1024 ** 3;
const DEFAULT_BYTES = 50 * GIB;

function displayGiB(bytes) {
  return String(Number((bytes / GIB).toFixed(3)));
}

export default function StorageSettings({ projectId, serverMaxBytes }) {
  const [project, setProject] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const ceiling = Number(serverMaxBytes) || 50 * GIB;

  useEffect(() => {
    let live = true;
    setProject(null);
    setStatus('');
    api.getProject(projectId)
      .then((value) => {
        if (!live) return;
        const row = value?.project || value;
        const configured = Number(row?.settings?.storage_max_upload_bytes)
          || Math.min(DEFAULT_BYTES, ceiling);
        setProject(row);
        setDraft(displayGiB(Math.min(configured, ceiling)));
      })
      .catch((error) => {
        if (!live) return;
        setFailed(true);
        setStatus(error?.message || 'Could not load storage settings.');
      });
    return () => { live = false; };
  }, [projectId, ceiling]);

  async function save() {
    const gib = Number(draft);
    if (!Number.isFinite(gib) || gib <= 0) {
      setFailed(true);
      setStatus('Enter a limit greater than zero.');
      return;
    }
    const bytes = Math.round(gib * GIB);
    if (bytes > ceiling) {
      setFailed(true);
      setStatus(`This server allows at most ${displayGiB(ceiling)} GiB per object.`);
      return;
    }
    setBusy(true);
    setFailed(false);
    setStatus('');
    try {
      const value = await api.patchProject(projectId, { storage_max_upload_bytes: bytes });
      setProject(value?.project || value);
      setDraft(displayGiB(bytes));
      setStatus('Saved. New storage submissions use this project limit.');
    } catch (error) {
      setFailed(true);
      setStatus(error?.message || 'Could not save the storage limit.');
    } finally {
      setBusy(false);
    }
  }

  if (!project && !status) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="settings-panel-head">
        <p className="settings-summary">
          Set the largest single object agents may upload for this project.
          Files above 5 GiB are transferred as multipart uploads automatically.
        </p>
      </div>
      <div className="settings-field">
        <label className="settings-field-label" htmlFor="storage-object-limit">
          Maximum object size (GiB)
        </label>
        <div className="settings-field-row">
          <input
            id="storage-object-limit"
            className="auth-input"
            type="number"
            min="0.001"
            max={displayGiB(ceiling)}
            step="0.001"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy || !project}
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={save}
            disabled={busy || !project || !draft.trim()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <p className="settings-field-note">
          The server-wide ceiling is {displayGiB(ceiling)} GiB. The default is
          50 GiB; deployments may set a different absolute ceiling.
        </p>
        {status && (
          <p
            className={`settings-field-status${failed ? ' settings-field-status--error' : ''}`}
            role="status"
          >
            {status}
          </p>
        )}
      </div>
    </>
  );
}
