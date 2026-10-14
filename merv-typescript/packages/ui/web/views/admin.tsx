import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useScopeVersion, ApiError } from '../api';
import type { AdminExperiment, AdminOverview } from '../../src/admin-models';
import './admin.css';

const terminal = (r: AdminExperiment) => ['complete', 'failed', 'abandoned'].includes(r.state);
const words = (s: string) => s.replaceAll('_', ' ');
const age = (s: string) => {
  const n = Math.max(0, Math.floor((Date.now() - Date.parse(s)) / 60000));
  return n < 1
    ? 'Just now'
    : n < 60
      ? `${n}m ago`
      : n < 1440
        ? `${Math.floor(n / 60)}h ago`
        : `${Math.floor(n / 1440)}d ago`;
};
export function AdminView() {
  const identity = useScopeVersion();
  const [data, setData] = useState<AdminOverview>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [user, setUser] = useState('all');
  const [stage, setStage] = useState('active');
  const [selected, setSelected] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setData(undefined);
    setError('');
    const load = async () => {
      try {
        const result = await accountRequest<AdminOverview>('/admin/experiments');
        if (!disposed) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : 'Unable to refresh');
          if (e instanceof ApiError && [401, 403].includes(e.status)) setData(undefined);
        }
      } finally {
        if (!disposed) timer = setTimeout(load, 15000);
      }
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [identity, refresh]);
  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (user === 'all' || r.customerKey === user) &&
          (source === 'all' || r.source === source) &&
          (stage === 'all' ||
            (stage === 'active'
              ? !terminal(r)
              : stage === 'past'
                ? terminal(r)
                : r.sessions > 0)) &&
          [r.title, r.project, r.customer, r.id, r.requestId ?? '']
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data, source, stage, query, user],
  );
  useEffect(() => {
    if (!selected) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(undefined);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [selected]);
  const detail = data?.rows.find((r) => r.id === selected);
  const scoped = (data?.rows ?? []).filter((r) => user === 'all' || r.customerKey === user);
  const stages = [
    ['active', 'Active', scoped.filter((r) => !terminal(r)).length],
    ['past', 'Past', scoped.filter(terminal).length],
    ['all', 'All', scoped.length],
  ] as const;
  return (
    <div className="admin-page">
      <header className="admin-nav">
        <Link to="/">
          merv<span>.</span>
        </Link>
        <span>ADMIN / OPERATIONS</span>
        <Link to="/">Back to workspace ↗</Link>
      </header>
      <main>
        <div className="admin-heading">
          <div>
            <p className="admin-eyebrow">YOUR OVERVIEW</p>
            <h1>Experiments</h1>
            <p>
              {data
                ? `${data.users.length} users · ${data.rows.length} experiments`
                : 'Across Merv'}
            </p>
          </div>
          <div className="admin-refresh">
            <span>{data ? `Updated ${age(data.at)}` : 'Connecting…'}</span>
            <button onClick={() => setRefresh((x) => x + 1)}>Refresh ↻</button>
          </div>
        </div>
        {error && (
          <div role="alert" className="admin-error">
            {error}
            {data && ' · Showing the last successful snapshot.'}
          </div>
        )}
        {data?.unavailable.length ? (
          <p className="admin-error">Unavailable sources: {data.unavailable.join(', ')}.</p>
        ) : null}
        <div className="admin-layout">
          <aside className="admin-users" aria-label="Users">
            <div className="admin-users-heading">
              Users <span>{data?.users.length ?? 0}</span>
            </div>
            <button
              className="admin-user"
              aria-pressed={user === 'all'}
              onClick={() => setUser('all')}
            >
              <span className="admin-avatar">↗</span>
              <span>
                Everyone<small>Across Merv</small>
              </span>
              <b>{data?.rows.length ?? 0}</b>
            </button>
            {(data?.users ?? []).map((u) => (
              <button
                className="admin-user"
                key={u.key}
                aria-pressed={user === u.key}
                onClick={() => setUser(u.key)}
              >
                <span className="admin-avatar">
                  {u.label.replace('Guest · ', '').slice(0, 2).toUpperCase()}
                </span>
                <span className="admin-user-name">
                  {u.label}
                  <small>{u.active ? u.active + ' active' : 'No active experiments'}</small>
                </span>
                <b>{u.experiments}</b>
              </button>
            ))}
          </aside>
          <section className="admin-experiments" aria-label="Experiments">
            <div className="admin-toolbar">
              <div className="admin-tabs">
                {stages.map(([value, label, count]) => (
                  <button
                    key={value}
                    aria-pressed={stage === value}
                    onClick={() => setStage(value)}
                  >
                    {label}
                    <span>{count}</span>
                  </button>
                ))}
              </div>
              <select
                aria-label="Experiment type"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="project">Project</option>
                <option value="standalone">Standalone</option>
              </select>
            </div>
            <input
              className="admin-search"
              aria-label="Search experiments"
              placeholder="Find an experiment…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="admin-grid">
              {rows.map((r) => (
                <button className="experiment-card" key={r.id} onClick={() => setSelected(r.id)}>
                  <div className="experiment-card-top">
                    <span className={'admin-status status-' + r.state}>{words(r.state)}</span>
                    <span className="experiment-arrow">↗</span>
                  </div>
                  <h2>{r.title}</h2>
                  <p>{r.source === 'standalone' ? 'Standalone' : r.project}</p>
                  <div className="experiment-card-owner">
                    <span className="owner-dot" />
                    {r.customer}
                  </div>
                  <div className="experiment-card-foot">
                    <span className={r.sessions ? 'admin-live' : ''}>
                      {r.sessions
                        ? '● ' + r.sessions + ' agent' + (r.sessions === 1 ? '' : 's')
                        : r.source === 'standalone'
                          ? r.paid
                            ? 'Paid'
                            : 'Not paid'
                          : 'Project'}
                    </span>
                    <span>{age(r.updatedAt)}</span>
                  </div>
                </button>
              ))}
            </div>
            {!rows.length && (
              <div className="admin-empty">
                {!data
                  ? error
                    ? 'Administrator access is required.'
                    : 'Loading experiments…'
                  : 'No experiments match this view.'}
              </div>
            )}
            <footer>
              {data?.truncated
                ? 'Showing the first 1,000 experiments; active work appears first.'
                : `${rows.length} experiments shown`}
              <span>Read-only · Refreshes every 15s</span>
            </footer>
          </section>
        </div>
      </main>
      {detail && (
        <div className="admin-backdrop" onClick={() => setSelected(undefined)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={detail.title}
            className="admin-detail"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="admin-close" autoFocus onClick={() => setSelected(undefined)}>
              Close ×
            </button>
            <p className="admin-eyebrow">
              {detail.source === 'standalone' ? 'STANDALONE EXPERIMENT' : 'PROJECT EXPERIMENT'}
            </p>
            <h2>{detail.title}</h2>
            <span className={'admin-status status-' + detail.state}>{words(detail.state)}</span>
            <dl>
              {[
                ['Customer / owner', detail.customer],
                ['Project', detail.project],
                ['Current activity', detail.activity],
                ['Attempt', String(detail.attempt)],
                ['Created', new Date(detail.createdAt).toLocaleString()],
                ['Last workflow change', new Date(detail.updatedAt).toLocaleString()],
                ['Experiment', detail.id.replace(/^[a-z]+_/, '').slice(0, 4)],
                ...(detail.requestId
                  ? [['Request', detail.requestId.replace(/^[a-z]+_/, '').slice(0, 4)]]
                  : []),
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p>
              Workflow status and live agent leases. This view does not grant customer approval or
              payment access.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
