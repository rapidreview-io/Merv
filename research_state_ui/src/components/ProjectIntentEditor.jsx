import { useId, useState } from 'react';
import { api } from '../api';
import { useProjectStore } from '../store/useProjectStore';
import './project-document.css';

/** The Introduction is the project summary; both users and agents use its CAS write. */
export default function ProjectIntentEditor({ project }) {
  const inputId = useId();
  const update = useProjectStore(s => s.updateProjectContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [expected, setExpected] = useState('');
  // undefined: no conflict; null: current text still needs to load.
  const [latest, setLatest] = useState();
  const conflict = latest !== undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  function start() {
    setDraft(project.summary || '');
    setExpected(project.summary || '');
    setLatest(undefined);
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
      setError(`Could not load current Introduction. ${err.message}`);
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
        setLatest(null);
        await readLatest();
      } else { setError(err.message); }
    } finally { setBusy(false); }
  }

  if (!editing) return (
    <div className="intent-editor-action">
      <button type="button" className="btn btn--ghost btn--sm" onClick={start}>
        {project.summary ? 'Edit Introduction' : 'Write Introduction'}
      </button>
      {saved && <span role="status" className="muted">Introduction saved.</span>}
    </div>
  );

  return (
    <form className="intent-editor stack stack--sm" onSubmit={save}>
      <label className="label" htmlFor={inputId}>Introduction</label>
      <p className="muted">Write a brief paragraph describing the problem, background, goal and scope, including relevant constraints.</p>
      <textarea id={inputId} className="textarea" rows={7} autoFocus value={draft}
        disabled={busy} onChange={event => setDraft(event.target.value)} />
      {conflict && <div className="intent-conflict" role="alert">
        <p>The Introduction changed while you were editing. Your draft is preserved. Review the current text and reconcile your draft before saving.</p>
        {latest !== null ? <>
          <strong>Current Introduction</strong>
          <p className="project-intent-text">{latest || 'No Introduction yet.'}</p>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => {
            setExpected(latest); setLatest(undefined);
          }}>I’ve reconciled my draft</button>
        </> : <button type="button" className="btn btn--sm" disabled={busy} onClick={readLatest}>Load current Introduction</button>}
      </div>}
      {error && <div role="alert" className="error-message">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy || conflict}>
          {busy ? 'Saving…' : 'Save Introduction'}
        </button>
      </div>
    </form>
  );
}
