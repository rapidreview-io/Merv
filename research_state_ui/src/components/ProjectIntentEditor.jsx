import { useId, useState } from 'react';
import { api } from '../api';
import { useProjectStore } from '../store/useProjectStore';
import './project-document.css';

/** User intent has its own CAS write; research narrative never enters this form. */
export default function ProjectIntentEditor({ project }) {
  const inputId = useId();
  const update = useProjectStore(s => s.updateProjectContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expected, setExpected] = useState('');
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function start() {
    setDraft(project.summary || '');
    setExpected(project.summary || '');
    setConflict(false);
    setLatest(null);
    setError('');
    setSaved(false);
    setEditing(true);
  }

  async function readLatest() {
    setBusy(true);
    try {
      const result = await api.getProject(project.id);
      setLatest((result.project || result).summary || '');
      setError('');
    } catch (err) {
      setError(`Could not load current intent. ${err.message}`);
    } finally { setBusy(false); }
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await update(project.id, { summary: draft, expected_summary: expected });
      setEditing(false);
      setSaved(true);
    } catch (err) {
      if (err.data?.reason === 'stale_project_context') {
        setConflict(true);
        setLatest(null);
        await readLatest();
      } else { setError(err.message); }
    } finally { setBusy(false); }
  }

  if (!editing) return (
    <div className="intent-editor-action">
      <button type="button" className="btn btn--ghost btn--sm" onClick={start}>
        {project.summary ? 'Edit intent' : 'Add intent'}
      </button>
      {saved && <span role="status" className="muted">Intent saved.</span>}
    </div>
  );

  return (
    <form className="intent-editor stack stack--sm" onSubmit={save}>
      <label className="label" htmlFor={inputId}>Your project intent</label>
      <p className="muted">Describe the problem, background, goal or scope in your own words. Add what is useful now; there is no required outline.</p>
      <textarea id={inputId} className="textarea" rows={7} autoFocus value={draft}
        disabled={busy} onChange={event => setDraft(event.target.value)} />
      {conflict && <div className="intent-conflict" role="alert">
        <p>Project intent changed while you were editing. Your draft is preserved. Review the current text and reconcile your draft before saving.</p>
        {latest !== null ? <>
          <strong>Current saved intent</strong>
          <p className="project-intent-text">{latest || 'No intent provided.'}</p>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => {
            setExpected(latest); setConflict(false);
          }}>I’ve reconciled my draft</button>
        </> : <button type="button" className="btn btn--sm" disabled={busy} onClick={readLatest}>Load current intent</button>}
      </div>}
      {error && <div role="alert" className="error-message">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || conflict}>
          {busy ? 'Saving…' : 'Save intent'}
        </button>
      </div>
    </form>
  );
}
