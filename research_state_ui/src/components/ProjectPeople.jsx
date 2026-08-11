import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useProjectStore } from '../store/useProjectStore';

export default function ProjectPeople({ projectId }) {
  const reloadProjects = useProjectStore((s) => s.loadProjects);
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    setBusy('load');
    setError('');
    try {
      const data = await api.listProjectMembers(projectId);
      setMembers(data?.members || []);
    } catch (err) {
      setError(err?.message || 'Could not load project members.');
    } finally {
      setBusy('');
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function add(event) {
    event.preventDefault();
    const target = email.trim();
    if (!target || busy) return;
    setBusy('add');
    setError('');
    setStatus('');
    try {
      const data = await api.addProjectMember(projectId, target);
      setMembers(data?.members || []);
      setEmail('');
      setStatus(`Shared with ${target}.`);
    } catch (err) {
      setError(err?.message || 'Could not share the project.');
    } finally {
      setBusy('');
    }
  }

  async function remove(member) {
    if (busy) return;
    setBusy(member.user_id);
    setError('');
    setStatus('');
    try {
      const data = await api.removeProjectMember(projectId, member.user_id);
      setMembers(data?.members || []);
      if (member.is_self) await reloadProjects();
      else setStatus('Access removed.');
    } catch (err) {
      setError(err?.message || 'Could not remove access.');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="settings-panel-head">
        <p className="settings-summary">
          Share this project with an existing account. Members get full access
          and can manage sharing too.
        </p>
      </div>

      <form className="settings-field people-add" onSubmit={add}>
        <label className="settings-field-label" htmlFor="project-member-email">Email</label>
        <div className="settings-field-row">
          <input
            id="project-member-email"
            className="auth-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="person@example.com"
            autoComplete="email"
            disabled={Boolean(busy)}
          />
          <button type="submit" className="btn btn--primary" disabled={Boolean(busy) || !email.trim()}>
            {busy === 'add' ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </form>

      {error && <div className="error-message people-message">{error}</div>}
      {status && <p className="settings-field-status people-message" role="status">{status}</p>}

      <div className="people-list" aria-label="People with access">
        {busy === 'load' ? (
          <div className="empty-state empty-state--compact"><p>Loading people…</p></div>
        ) : members.map((member) => {
          const name = member.display_name || member.email || member.user_id;
          return (
            <div className="people-row" key={member.user_id}>
              <span className="people-avatar" aria-hidden="true">{String(name).charAt(0).toUpperCase()}</span>
              <span className="people-identity">
                <strong>{name}{member.is_self ? ' (you)' : ''}</strong>
                {member.display_name && member.email && <small>{member.email}</small>}
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => remove(member)}
                disabled={Boolean(busy)}
              >
                {busy === member.user_id ? 'Removing…' : member.is_self ? 'Leave' : 'Remove'}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}
