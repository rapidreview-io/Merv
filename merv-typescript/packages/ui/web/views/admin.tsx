import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, useScopeVersion } from '../api';
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
        if (!disposed) setError(e instanceof Error ? e.message : 'Unable to refresh');
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
          (source === 'all' || r.source === source) &&
          (stage === 'all' ||
            (stage === 'active'
              ? !terminal(r)
              : stage === 'attention'
                ? ['failed', 'awaiting_payment', 'ready'].includes(r.state)
                : r.sessions > 0)) &&
          [r.title, r.project, r.customer, r.id, r.requestId ?? '']
            .join(' ')
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [data, source, stage, query],
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
  const cards = [
    ['In progress', (data?.rows ?? []).filter((r) => !terminal(r)).length, 'active'],
    ['Agents assigned', (data?.rows ?? []).filter((r) => r.sessions > 0).length, 'working'],
    [
      'Needs attention',
      (data?.rows ?? []).filter((r) => ['failed', 'awaiting_payment', 'ready'].includes(r.state))
        .length,
      'attention',
    ],
    ['All experiments', data?.rows.length ?? 0, 'all'],
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
            <p className="admin-eyebrow">ACROSS MERV</p>
            <h1>Experiment overview</h1>
            <p>Every customer. One place.</p>
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
        <div className="admin-stats">
          {cards.map(([label, count, value]) => (
            <button key={value} onClick={() => setStage(value)} aria-pressed={stage === value}>
              <span>{label}</span>
              <strong>{data ? count : '—'}</strong>
            </button>
          ))}
        </div>
        <div className="admin-toolbar">
          <div className="admin-tabs">
            {[
              ['all', 'All'],
              ['project', 'Projects'],
              ['standalone', 'Standalone'],
            ].map(([value, label]) => (
              <button key={value} aria-pressed={source === value} onClick={() => setSource(value!)}>
                {label}
              </button>
            ))}
          </div>
          <input
            aria-label="Search experiments"
            placeholder="Search experiments, owners, projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="admin-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Experiment</th>
                <th>Customer / owner</th>
                <th>Status</th>
                <th>Activity</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <button className="admin-title" onClick={() => setSelected(r.id)}>
                      {r.title}
                    </button>
                    <small>{r.source === 'standalone' ? 'Standalone' : r.project}</small>
                  </td>
                  <td>
                    {r.customer}
                    <small>
                      {r.source === 'standalone'
                        ? r.paid
                          ? 'Paid'
                          : 'Not paid'
                        : 'Project experiment'}
                    </small>
                  </td>
                  <td>
                    <span className={'admin-status status-' + r.state}>{words(r.state)}</span>
                  </td>
                  <td>
                    <span className={r.sessions ? 'admin-live' : ''}>
                      {r.sessions ? '● ' : ''}
                      {r.activity}
                    </span>
                    {r.sessions > 0 && (
                      <small>
                        {r.sessions} assigned agent{r.sessions === 1 ? '' : 's'}
                      </small>
                    )}
                  </td>
                  <td title={r.updatedAt}>{age(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
                ['Experiment ID', detail.id],
                ...(detail.requestId ? [['Request ID', detail.requestId]] : []),
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
