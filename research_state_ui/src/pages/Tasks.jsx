import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useProjectStore, selectTasks, selectExperiments, useProjectHref,
} from '../store/useProjectStore';
import { api } from '../api';
import ObjId from '../components/ObjId';
import StatusPill from '../components/StatusPill';
import { expName } from '../utils/experiment';
import { fmtDayTime, fmtDuration } from '../utils/format';
import { composeGoal } from '../utils/taskGoal';

// Task lifecycle: two working states, two endings (mirrors task_workflow.py).
const LIFECYCLE = ['in_progress', 'in_review', 'done'];
const TERMINAL = ['done', 'failed'];
const STATUS_ORDER = ['in_progress', 'in_review', 'done', 'failed'];

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function rowFacts(t, nowMs) {
  const status = (t.status || 'in_progress').toLowerCase();
  const createdMs = t.created_at ? Date.parse(t.created_at) : NaN;
  const settled = isTerminal(status);
  const endMs = settled && t.updated_at ? Date.parse(t.updated_at) : nowMs;
  const durationMs = Number.isFinite(createdMs) ? Math.max(0, endMs - createdMs) : NaN;
  return { status, createdMs, settled, endMs, durationMs };
}

const SORTS = {
  created: (a, b) => (a.facts.createdMs || 0) - (b.facts.createdMs || 0),
  finished: (a, b) => (a.facts.settled ? a.facts.endMs : 0) - (b.facts.settled ? b.facts.endMs : 0),
  duration: (a, b) => (a.facts.durationMs || 0) - (b.facts.durationMs || 0),
  status: (a, b) => STATUS_ORDER.indexOf(a.facts.status) - STATUS_ORDER.indexOf(b.facts.status),
  title: (a, b) => a.title.localeCompare(b.title),
};

export default function Tasks() {
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const tasks = useProjectStore(selectTasks);
  const experiments = useProjectStore(selectExperiments);
  const [showForm, setShowForm] = useState(false);
  const [sortKey, setSortKey] = useState('created');
  const [sortDir, setSortDir] = useState('desc');

  const rows = useMemo(() => {
    const nowMs = Date.now();
    const list = tasks.map(t => ({
      task: t,
      title: t.name || t.id,
      facts: rowFacts(t, nowMs),
    }));
    const cmp = SORTS[sortKey] || SORTS.created;
    list.sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));
    return list;
  }, [tasks, sortKey, sortDir]);

  function toggleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'title' ? 'asc' : 'desc');
    }
  }

  return (
    <div className="page-stage">
      <header className="page-header page-header--lg">
        <div className="page-head-row">
          <div>
            <h1 className="page-title">What we build</h1>
            <p className="page-lede">
              Scoped work with a verifiable finish line and no claim — a literature
              sweep, data preparation, a harness, a memo. A brief of checks goes in,
              a delivery of evidence comes out, one review verifies it.
            </p>
          </div>
          <div className="page-actions">
            <button className="btn btn--primary" onClick={() => setShowForm(v => !v)}>
              {showForm ? 'Cancel' : 'New task'}
            </button>
          </div>
        </div>
      </header>

      {showForm && (
        <NewTaskForm
          projectId={projectId}
          tasks={tasks}
          experiments={experiments}
          onCancel={() => setShowForm(false)}
          onCreated={async () => { setShowForm(false); await refreshHome(); }}
        />
      )}

      {rows.length === 0 ? (
        <div className="empty-state">
          <h2>No tasks yet</h2>
          <p>Work that tests a claim is an experiment; everything else the project needs is a task.</p>
        </div>
      ) : (
        <TaskTable rows={rows} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
      )}
    </div>
  );
}

const COLUMNS = [
  { key: 'title', label: 'Task' },
  { key: 'status', label: 'Status' },
  { key: 'created', label: 'Created' },
  { key: 'finished', label: 'Finished' },
  { key: 'duration', label: 'Duration', right: true },
];

function WhenCell({ parts, title }) {
  if (!parts) return <div className="expt-when expt-when--none">—</div>;
  return (
    <div className="expt-when" title={title}>
      <span className="expt-when-day">{parts.day}</span>
      <span className="expt-when-time">{parts.time}</span>
    </div>
  );
}

function TaskTable({ rows, sortKey, sortDir, onSort }) {
  const navigate = useNavigate();
  const px = useProjectHref();
  return (
    <div className="expt-scroll">
      <div className="expt" role="table" aria-label="Tasks">
        <div className="expt-head con-head" role="row">
          {COLUMNS.map(col => (
            <button
              key={col.key}
              type="button"
              role="columnheader"
              aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
              className={[
                'th', 'th--con', col.right ? 'th--r' : '', sortKey === col.key ? 'on' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSort(col.key)}
            >
              {col.label}
              {sortKey === col.key && (
                <span className="arr" aria-hidden="true">{sortDir === 'asc' ? '▲' : '▼'}</span>
              )}
            </button>
          ))}
        </div>
        {rows.map(({ task: t, title, facts }) => {
          const checkCount = Array.isArray(t.checks) ? t.checks.length : 0;
          const depCount = Array.isArray(t.dependencies) ? t.dependencies.length : 0;
          const unblockCount = Array.isArray(t.dependents) ? t.dependents.length : 0;
          const reviewCount = Array.isArray(t.reviews) ? t.reviews.length : 0;
          const created = fmtDayTime(t.created_at);
          const finished = facts.settled ? fmtDayTime(t.updated_at) : null;
          return (
            <div
              key={t.id}
              className="expt-row"
              role="row"
              tabIndex={0}
              onClick={() => navigate(px(`/tasks/${t.id}`))}
              onKeyDown={ev => { if (ev.key === 'Enter') navigate(px(`/tasks/${t.id}`)); }}
            >
              <div className="expt-main">
                <div className="expt-title" title={title}>{title}</div>
                {(t.summary || t.goal) && (
                  <div className="expt-desc" title={t.summary || t.goal}>{t.summary || t.goal}</div>
                )}
                <div className="expt-sub">
                  {checkCount > 0 ? `${checkCount} requirement${checkCount === 1 ? '' : 's'}` : 'no brief yet'}
                  {depCount > 0 && <> · waits on {depCount}</>}
                  {unblockCount > 0 && <> · unblocks {unblockCount}</>}
                  {reviewCount > 0 && <> · {reviewCount} review{reviewCount === 1 ? '' : 's'}</>}
                  {t.status === 'failed' && t.failed_by && <> · ended by {t.failed_by}</>}
                </div>
              </div>
              <div><StatusPill value={t.status} /></div>
              <WhenCell parts={created} title={t.created_at || ''} />
              {finished ? (
                <WhenCell parts={finished} title={t.updated_at || ''} />
              ) : (
                <div className="expt-when expt-when--none" title="still in progress">—</div>
              )}
              <div
                className={`expt-dur${facts.settled ? '' : ' expt-dur--live'}`}
                title={facts.settled ? 'created → last transition' : 'elapsed since created'}
              >
                {fmtDuration(facts.durationMs)}
                {!facts.settled && <span className="expt-live-dot" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Mirrors the backend rule: folder-safe, starts with a letter/digit, ≤48 chars.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const OPEN_EXPERIMENT = new Set(['planned', 'design_review', 'ready_to_run', 'running', 'experiment_review']);
const OPEN_TASK = new Set(['in_progress', 'in_review']);

function NewTaskForm({ projectId, tasks, experiments, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [deliverables, setDeliverables] = useState('');
  const [purpose, setPurpose] = useState('');
  const [deps, setDeps] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const nameOk = NAME_RE.test(name);
  const deliverableLines = deliverables.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const goalOk = summary.trim().length > 0 && deliverableLines.length > 0 && purpose.trim().length > 0;
  // Only live nodes are sensible dependencies: a finished one is already met,
  // a failed one would block this task from the start.
  const candidates = [
    ...tasks.filter(t => OPEN_TASK.has(t.status)).map(t => ({ id: t.id, label: t.name || t.id, kind: 'task' })),
    ...experiments.filter(e => OPEN_EXPERIMENT.has(e.status)).map(e => ({ id: e.id, label: expName(e), kind: 'experiment' })),
  ];

  function toggleDep(id) {
    setDeps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!nameOk || !goalOk) return;
    setBusy(true);
    setError(null);
    try {
      await api.createTask(projectId, {
        name: name.trim(),
        goal: composeGoal({ summary, deliverables, purpose }),
        depends_on: Array.from(deps),
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
          placeholder="prep-cifar-splits"
          maxLength={48}
          autoFocus
          required
        />
        <div className="form-hint">
          Becomes the task folder <code>tasks/{nameOk ? name : '<name>'}/</code> —
          letters, digits, dots, dashes, underscores; unique among the project's tasks.
        </div>
        {name && !nameOk && (
          <div className="error-message">
            Folder-safe names start with a letter or digit and use only letters,
            digits, '.', '_' and '-'.
          </div>
        )}
      </div>
      <div className="form-row">
        <label className="label">What this task builds</label>
        <input
          className="input"
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="Build one shared modular-addition dataset, model, and evaluation harness."
          maxLength={200}
          required
        />
        <div className="form-hint">One line — the headline of the task.</div>
      </div>
      <div className="form-row">
        <label className="label">Deliverables</label>
        <textarea
          className="textarea"
          value={deliverables}
          onChange={e => setDeliverables(e.target.value)}
          placeholder={'the complete dataset of ordered (a,b) pairs modulo p, with a fixed train/validation split\na tiny reusable PyTorch evaluation harness\na shared model definition'}
          required
        />
        <div className="form-hint">One per line — the things that will exist when it is done. Not how to make them.</div>
      </div>
      <div className="form-row">
        <label className="label">So that…</label>
        <input
          className="input"
          value={purpose}
          onChange={e => setPurpose(e.target.value)}
          placeholder="the wd-sweep and width-sweep experiments train and evaluate on identical data and code."
          required
        />
        <div className="form-hint">
          Why the project needs it — name the experiments or decisions that wait on it, by
          their own names: the task must read standalone, so never "the wave" or "this
          reflection". The numbered Done-when checks go in the brief the executor submits.
        </div>
      </div>
      {candidates.length > 0 && (
        <div className="form-row">
          <label className="label">Depends on (optional)</label>
          <div className="stack stack--sm">
            {candidates.map(c => (
              <label key={c.id} className="cluster" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={deps.has(c.id)}
                  onChange={() => toggleDep(c.id)}
                  style={{ marginTop: 4 }}
                />
                <span style={{ fontSize: 'var(--text-base)' }}>
                  <span className="muted">{c.kind}</span> {c.label}
                  <span style={{ marginLeft: 8 }}><ObjId id={c.id} /></span>
                </span>
              </label>
            ))}
          </div>
          <div className="form-hint">This task will not deliver until each dependency has succeeded.</div>
        </div>
      )}
      {error && <div className="error-message">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={busy || !nameOk || !goalOk}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </form>
  );
}
