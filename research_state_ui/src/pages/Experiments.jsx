import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useProjectStore, selectExperiments, selectClaims, useProjectHref } from '../store/useProjectStore';
import ExperimentMap from '../expmap/ExperimentMap';
import { api } from '../api';
import ObjId from '../components/ObjId';
import GraphExpandButton from '../components/GraphExpandButton';
import StatusPill from '../components/StatusPill';
import ConsoleTable, {
  DurationCell, SPAN_SORTS, WhenCell, spanFacts, useTableSort,
} from '../components/ConsoleTable';
import { NAME_RE, expName } from '../utils/experiment';
import { fmtDayTime } from '../utils/format';

const LIFECYCLE = ['planned', 'design_review', 'running', 'experiment_review', 'complete'];
const TERMINAL = ['failed', 'abandoned'];
// Sort rank for the status column: lifecycle order, then terminal states.
const STATUS_ORDER = Object.fromEntries([...LIFECYCLE, ...TERMINAL].map((status, index) => [status, index]));
STATUS_ORDER.ready_to_run = STATUS_ORDER.running; // Historical snapshots.

function isTerminal(status) {
  return status === 'complete' || TERMINAL.includes(status);
}

// Duration is created→last transition for settled experiments, created→now
// for ones still in flight (the 3s home poll keeps the live value ticking).
function rowFacts(e, nowMs) {
  const status = (e.status || 'planned').toLowerCase();
  return {
    status,
    ...spanFacts({ createdAt: e.created_at, endAt: e.updated_at, settled: isTerminal(status) }, nowMs),
  };
}

const SORTS = {
  ...SPAN_SORTS,
  status: (a, b) => (STATUS_ORDER[a.facts.status] ?? -1) - (STATUS_ORDER[b.facts.status] ?? -1),
  title: (a, b) => a.title.localeCompare(b.title),
};

export default function Experiments() {
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const experiments = useProjectStore(selectExperiments);
  const claims = useProjectStore(selectClaims);
  const [showForm, setShowForm] = useState(false);
  const sort = useTableSort('created', { ascKeys: ['title'] });
  // The map expands like every other graph. Escape leaves it — the map's own
  // Escape handler takes precedence while the detail sidebar is open.
  const [mapExpanded, setMapExpanded] = useState(false);
  // View state lives in the URL (?view=map) like ?focus=, but replaces
  // instead of pushing: a mode toggle shouldn't stack history entries.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'map' ? 'map' : 'table';
  function setView(v) {
    const next = new URLSearchParams(searchParams);
    if (v === 'map') next.set('view', 'map'); else next.delete('view');
    setSearchParams(next, { replace: true });
  }

  const rows = useMemo(() => {
    const nowMs = Date.now();
    return sort.sorted(
      experiments.map(e => ({ exp: e, title: expName(e), facts: rowFacts(e, nowMs) })),
      SORTS,
    );
  }, [experiments, sort.sortKey, sort.sortDir]);

  return (
    <div className={`page-stage${view === 'map' ? ' xmap-stage' : ''}`}>
      <header className="page-header page-header--lg">
        <div className="page-head-row">
          <div className="xmap-title-row">
            <h1 className="page-title">What we try</h1>
            <span className="fig-title-tabs" role="tablist" aria-label="Experiments view">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'table'}
                className={`fig-title-tab${view === 'table' ? ' fig-title-tab--on' : ''}`}
                onClick={() => setView('table')}
              >
                Table
              </button>
              <span className="fig-title-tab-sep" aria-hidden="true">/</span>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'map'}
                className={`fig-title-tab${view === 'map' ? ' fig-title-tab--on' : ''}`}
                onClick={() => setView('map')}
              >
                Map
              </button>
            </span>
          </div>
          <div className="page-actions">
            {view === 'map' && (
              <GraphExpandButton
                expanded={mapExpanded}
                onToggle={() => setMapExpanded(v => !v)}
                label="map"
              />
            )}
            <button className="btn btn--primary" onClick={() => setShowForm(v => !v)}>
              {showForm ? 'Cancel' : 'New experiment'}
            </button>
          </div>
        </div>
      </header>

      {showForm && (
        <NewExperimentForm
          projectId={projectId}
          claims={claims}
          onCancel={() => setShowForm(false)}
          onCreated={async () => { setShowForm(false); await refreshHome(); }}
        />
      )}

      {view === 'map' ? (
        <ExperimentMap expanded={mapExpanded} onCollapse={() => setMapExpanded(false)} />
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <h2>No experiments yet</h2>
        </div>
      ) : (
        <ExperimentTable rows={rows} sort={sort} />
      )}
    </div>
  );
}

const COLUMNS = [
  { key: 'title', label: 'Experiment' },
  { key: 'status', label: 'Status' },
  { key: 'created', label: 'Created' },
  { key: 'finished', label: 'Finished' },
  { key: 'duration', label: 'Duration', right: true },
];

function ExperimentTable({ rows, sort }) {
  const px = useProjectHref();
  return (
    <ConsoleTable
      label="Experiments"
      columns={COLUMNS}
      sort={sort}
      rows={rows.map(({ exp: e, title, facts }) => {
        const claimCount = Array.isArray(e.tested_claims) ? e.tested_claims.length : 0;
        const reviewCount = Array.isArray(e.reviews) ? e.reviews.length : 0;
        return {
          key: e.id,
          href: px(`/experiments/${e.id}`),
          cells: (
            <>
              <div className="expt-main">
                <div className="expt-title" title={title}>{title}</div>
                {e.intent && <div className="expt-desc" title={e.intent}>{e.intent}</div>}
                <div className="expt-sub">
                  attempt {e.attempt_index}
                  {claimCount > 0 && <> · tests {claimCount} claim{claimCount === 1 ? '' : 's'}</>}
                  {reviewCount > 0 && <> · {reviewCount} review{reviewCount === 1 ? '' : 's'}</>}
                </div>
              </div>
              <div><StatusPill value={e.status} /></div>
              <WhenCell parts={fmtDayTime(e.created_at)} title={e.created_at || ''} />
              <WhenCell
                parts={facts.settled ? fmtDayTime(e.updated_at) : null}
                title={e.updated_at || ''}
                noneTitle="still in progress"
              />
              <DurationCell
                facts={facts}
                doneTitle="created → last transition"
                liveTitle="elapsed since created"
              />
            </>
          ),
        };
      })}
    />
  );
}

function NewExperimentForm({ projectId, claims, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [intent, setIntent] = useState('');
  const [selectedClaims, setSelectedClaims] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const nameOk = NAME_RE.test(name);

  function toggleClaim(id) {
    setSelectedClaims(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!nameOk || !intent.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createExperiment(projectId, {
        name: name.trim(),
        intent: intent.trim(),
        claim_ids: Array.from(selectedClaims),
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} style={{ marginBottom: 18 }}>
      <div className="form-row">
        <label className="label">Name</label>
        <input
          className="input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="lora-rank-sweep"
          maxLength={48}
          autoFocus
          required
        />
        <div className="form-hint">
          Becomes the experiment folder <code>experiments/{nameOk ? name : '<name>'}/</code> —
          letters, digits, dots, dashes, underscores; unique within the project.
        </div>
        {name && !nameOk && (
          <div className="error-message">
            Folder-safe names start with a letter or digit and use only letters,
            digits, '.', '_' and '-'.
          </div>
        )}
      </div>
      <div className="form-row">
        <label className="label">Intent</label>
        <textarea
          className="textarea"
          value={intent}
          onChange={e => setIntent(e.target.value)}
          placeholder="Compare threshold rule against majority baseline on toy.csv."
          required
        />
      </div>
      {claims.length > 0 && (
        <div className="form-row">
          <label className="label">Tested claims (optional)</label>
          <div className="stack stack--sm">
            {claims.map(c => (
              <label key={c.id} className="cluster" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={selectedClaims.has(c.id)}
                  onChange={() => toggleClaim(c.id)}
                  style={{ marginTop: 4 }}
                />
                <span style={{ fontSize: 'var(--text-base)' }}>
                  {c.statement}
                  <span style={{ marginLeft: 8 }}><ObjId id={c.id} /></span>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {error && <div className="error-message">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={busy || !nameOk || !intent.trim()}>
          {busy ? 'Creating…' : 'Create experiment'}
        </button>
      </div>
    </form>
  );
}
