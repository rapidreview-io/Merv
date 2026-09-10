import { useMemo, useState } from 'react';
import {
  useProjectStore, selectTasks, selectExperiments, useProjectHref,
} from '../store/useProjectStore';
import { api } from '../api';
import ObjId from '../components/ObjId';
import StatusPill from '../components/StatusPill';
import NameField from '../components/NameField';
import ConsoleTable, {
  DurationCell, SPAN_SORTS, WhenCell, spanFacts, useTableSort,
} from '../components/ConsoleTable';
import { NAME_RE, expName } from '../utils/experiment';
import { fmtDayTime } from '../utils/format';

// Task lifecycle: two working states, two endings (mirrors task_workflow.py).
const TERMINAL = ['done', 'failed'];
const STATUS_ORDER = ['in_progress', 'in_review', 'done', 'failed'];

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function rowFacts(t, nowMs) {
  const status = (t.status || 'in_progress').toLowerCase();
  return {
    status,
    ...spanFacts({ createdAt: t.created_at, endAt: t.updated_at, settled: isTerminal(status) }, nowMs),
  };
}

const SORTS = {
  ...SPAN_SORTS,
  status: (a, b) => STATUS_ORDER.indexOf(a.facts.status) - STATUS_ORDER.indexOf(b.facts.status),
  title: (a, b) => a.title.localeCompare(b.title),
};

export default function Tasks() {
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);
  const tasks = useProjectStore(selectTasks);
  const experiments = useProjectStore(selectExperiments);
  const [showForm, setShowForm] = useState(false);
  const sort = useTableSort('created', { ascKeys: ['title'] });

  const rows = useMemo(() => {
    const nowMs = Date.now();
    return sort.sorted(
      tasks.map(t => ({ task: t, title: t.name || t.id, facts: rowFacts(t, nowMs) })),
      SORTS,
    );
  }, [tasks, sort.sortKey, sort.sortDir]);

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
        <TaskTable rows={rows} sort={sort} />
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

function TaskTable({ rows, sort }) {
  const px = useProjectHref();
  return (
    <ConsoleTable
      label="Tasks"
      columns={COLUMNS}
      sort={sort}
      rows={rows.map(({ task: t, title, facts }) => {
        const checkCount = Array.isArray(t.deliverables) ? t.deliverables.length : 0;
        const depCount = Array.isArray(t.dependencies) ? t.dependencies.length : 0;
        const unblockCount = Array.isArray(t.dependents) ? t.dependents.length : 0;
        const reviewCount = Array.isArray(t.reviews) ? t.reviews.length : 0;
        return {
          key: t.id,
          href: px(`/tasks/${t.id}`),
          cells: (
            <>
              <div className="expt-main">
                <div className="expt-title" title={title}>{title}</div>
                {t.goal && <div className="expt-desc" title={t.goal}>{t.goal}</div>}
                <div className="expt-sub">
                  {checkCount > 0 ? `${checkCount} deliverable${checkCount === 1 ? '' : 's'}` : 'no deliverables'}
                  {depCount > 0 && <> · waits on {depCount}</>}
                  {unblockCount > 0 && <> · unblocks {unblockCount}</>}
                  {reviewCount > 0 && <> · {reviewCount} review{reviewCount === 1 ? '' : 's'}</>}
                  {t.status === 'failed' && t.failed_by && <> · ended by {t.failed_by}</>}
                </div>
              </div>
              <div><StatusPill value={t.status} /></div>
              <WhenCell parts={fmtDayTime(t.created_at)} title={t.created_at || ''} />
              <WhenCell
                parts={facts.settled ? fmtDayTime(t.updated_at) : null}
                title={t.updated_at || ''}
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
const OPEN_EXPERIMENT = new Set(['planned', 'design_review', 'ready_to_run', 'running', 'experiment_review']);
const OPEN_TASK = new Set(['in_progress', 'in_review']);

function NewTaskForm({ projectId, tasks, experiments, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [deliverables, setDeliverables] = useState('');
  const [deps, setDeps] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const nameOk = NAME_RE.test(name);
  const deliverableLines = deliverables
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  const goalOk = goal.trim().length > 0 && deliverableLines.length > 0;
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
        goal: goal.trim(),
        deliverables: deliverableLines,
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
      <NameField
        value={name}
        onChange={setName}
        placeholder="prep-cifar-splits"
        folder="tasks"
        unique="unique among the project's tasks"
      />
      <div className="form-row">
        <label className="label">Goal</label>
        <textarea
          className="textarea"
          value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder="Build one shared modular-addition dataset, model, and evaluation harness, so the wd-sweep and width-sweep experiments train and evaluate on identical, correct data and code."
          required
        />
        <div className="form-hint">
          Short prose — what needs to be done and why. Standalone: a person just opening
          the task must understand it, so name datasets and experiments by their own
          names, never "the wave" or "this reflection". Immutable after creation.
        </div>
      </div>
      <div className="form-row">
        <label className="label">Deliverables</label>
        <textarea
          className="textarea"
          value={deliverables}
          onChange={e => setDeliverables(e.target.value)}
          placeholder={'data/modadd_p97.npz holds all 9,409 ordered (a,b) pairs modulo 97, split deterministically from a recorded seed\nmodel.py defines a one-layer Transformer with configurable d_model\neval.py prints labelled train and validation accuracy on CPU'}
          required
        />
        <div className="form-hint">
          One per line — the things that must exist when it is done, each verifiable as
          written (carry the criterion in the sentence). Immutable after creation; the
          delivery answers them one by one.
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
