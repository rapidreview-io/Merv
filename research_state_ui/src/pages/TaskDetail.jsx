import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { useStreamAwarePoll } from '../store/useEventStream';
import FSMStrip from '../components/FSMStrip';
import GateBanner from '../components/GateBanner';
import FileRenderer from '../components/FileRenderer';
import ReviewCard from '../components/ReviewCard';
import StatusPill from '../components/StatusPill';
import ObjId from '../components/ObjId';
import IndependentRead from '../components/IndependentRead';
import { pickIndependentRead } from '../utils/independentRead';

// The task lifecycle rendered through the shared strip: two working states,
// two endings (mirrors task_workflow.py; `failed` lands on the last cell).
const TASK_STAGES = [
  { id: 'in_progress', label: 'In progress' },
  { id: 'in_review',   label: 'Review' },
  { id: 'done',        label: 'Done' },
];
const TASK_GATES = new Set(['in_review']);
const TASK_TERMINAL = new Set(['done', 'failed']);

const NEXT_ACTION_TO_TRANSITION = {
  submit_delivery_for_review: { transition: 'submit_delivery', label: 'Submit delivery for review' },
  accept_task:                { transition: 'accept',          label: 'Accept task' },
};
const SECONDARY_TRANSITIONS = [
  { transition: 'mark_failed', label: 'End task (mark failed)' },
];

function deriveActionButtons(workflow) {
  if (!workflow) return { primary: null, secondary: [] };
  const allowsTransition = (workflow.allowed_actions || []).some(a => a === 'task.transition' || (a && !a.includes('.')));
  if (!allowsTransition) return { primary: null, secondary: [] };
  const actionKey = String(workflow.next_action || '').split(/[\s(]/)[0];
  const primary = NEXT_ACTION_TO_TRANSITION[actionKey] || null;
  const inFlight = !['terminal', 'done', 'failed'].includes(workflow.current_gate);
  return { primary, secondary: inFlight ? SECONDARY_TRANSITIONS : [] };
}

export default function TaskDetail() {
  const { taskId } = useParams();
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);

  const [statusData, setStatusData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(new Set());
  const [actionError, setActionError] = useState(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [pendingEnd, setPendingEnd] = useState(false);
  const [endReason, setEndReason] = useState('');
  const [acceptOutcome, setAcceptOutcome] = useState('');

  useEffect(() => { setPendingEnd(false); setEndReason(''); }, [taskId]);

  const lastStatusJsonRef = useRef(null);
  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getTaskStatus(projectId, taskId);
      const json = JSON.stringify(data);
      if (lastStatusJsonRef.current !== json) {
        lastStatusJsonRef.current = json;
        setStatusData(data);
      }
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [projectId, taskId]);

  useStreamAwarePoll(fetchStatus, {
    matches: (row) => row.target_id === taskId || row.payload?.task_id === taskId,
  });

  const task = statusData?.task;
  const workflow = statusData?.workflow;
  const { primary, secondary } = useMemo(() => deriveActionButtons(workflow), [workflow]);

  const onAction = useCallback(async (transition, evidence) => {
    setBusy(prev => { const n = new Set(prev); n.add(transition); return n; });
    setActionError(null);
    let applied = false;
    try {
      await api.transitionTask(projectId, taskId, transition, evidence);
      applied = true;
      await Promise.all([fetchStatus(), refreshHome()]);
      return true;
    } catch (err) {
      setActionError(`${transition}: ${err.message}`);
      return applied;
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(transition); return n; });
    }
  }, [projectId, taskId, fetchStatus, refreshHome]);

  const requestAction = useCallback((transition) => {
    if (transition === 'mark_failed') {
      setActionError(null);
      setPendingEnd(true);
      return;
    }
    if (transition === 'accept') {
      onAction('accept', acceptOutcome.trim() ? { outcome: acceptOutcome.trim() } : undefined);
      return;
    }
    onAction(transition);
  }, [onAction, acceptOutcome]);

  if (error) {
    return (
      <div className="page-stage">
        <div className="error-message">{error}</div>
        <Link className="btn" to={px('/tasks')} style={{ marginTop: 12 }}>← Tasks</Link>
      </div>
    );
  }
  if (!task) {
    return <div className="page-stage"><div className="empty">Loading…</div></div>;
  }

  const isClosed = TASK_TERMINAL.has(task.status);
  const current = (task.current_attempt_artifacts || []).slice();
  const briefRes = current.find(r => r.role === 'brief') || null;
  const deliveryRes = current.find(r => r.role === 'delivery') || null;
  // The backend lists reviews newest-first; the page reads them as a timeline.
  const reviews = (task.reviews || []).slice().reverse();
  const independentRead = pickIndependentRead(reviews, { ...task, intent: task.goal });
  const checks = Array.isArray(task.checks) ? task.checks : [];
  const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];

  return (
    <div className="page-stage">
      <section className="exp-fsm">
        <FSMStrip
          status={task.status}
          stages={TASK_STAGES}
          gateStates={TASK_GATES}
          terminal={TASK_TERMINAL}
          ariaLabel="Task lifecycle"
          badge={!isClosed && primary ? 'action' : null}
          expanded={!isClosed && gateOpen}
          onToggle={isClosed ? null : () => setGateOpen(v => !v)}
        >
          <div className="fsm-gate-panel">
            <GateBanner
              workflow={workflow}
              primaryAction={primary}
              secondaryActions={secondary}
              actionsBusy={busy}
              onAction={requestAction}
            />
            {primary?.transition === 'accept' && (
              <div className="form-row" style={{ marginTop: 10 }}>
                <label className="label">Outcome note (optional)</label>
                <input
                  className="input"
                  value={acceptOutcome}
                  onChange={e => setAcceptOutcome(e.target.value)}
                  placeholder="What the project can now rely on."
                />
              </div>
            )}
          </div>
        </FSMStrip>
        {actionError && <div className="error-message">{actionError}</div>}
      </section>

      {pendingEnd && (
        <section className="form-card" style={{ marginBottom: 18 }}>
          <div className="form-row">
            <label className="label">End this task — why?</label>
            <textarea
              className="textarea"
              value={endReason}
              onChange={e => setEndReason(e.target.value)}
              placeholder="The dataset license forbids this use; the source is gone; the goal moved."
              autoFocus
            />
            <div className="form-hint">
              This is final: a failed task never reopens. The next reflection reads the reason.
            </div>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn--ghost" onClick={() => setPendingEnd(false)}>Keep working</button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={busy.has('mark_failed') || !endReason.trim()}
              onClick={async () => {
                const ok = await onAction('mark_failed', { reason: endReason.trim() });
                if (ok) setPendingEnd(false);
              }}
            >
              {busy.has('mark_failed') ? 'Ending…' : 'End task'}
            </button>
          </div>
        </section>
      )}

      <header className="exp-orient">
        <div className="page-eyebrow">
          <Link to={px('/tasks')}>Tasks</Link>
          {' · '}<ObjId id={task.id} />
        </div>
        <h1 className="page-title exp-title-name">{task.name || task.id}</h1>
        {task.goal && <p className="page-lede">{task.goal}</p>}
      </header>

      {/* The reviewer's plain-language read leads the page once one exists;
          until then the goal in the header already says what this is. */}
      {independentRead.kind === 'review' && <IndependentRead read={independentRead} />}

      {(task.status === 'failed' || task.outcome) && (
        <section className="spotlight" id="outcome">
          <div className="spotlight-eyebrow">
            {task.status === 'failed' ? `Ended by ${task.failed_by || 'owner'}` : 'Outcome'}
          </div>
          <div className="spotlight-body">
            <p>{task.outcome || 'No note recorded.'}</p>
          </div>
        </section>
      )}

      <section className="spotlight" id="checks">
        <header className="spotlight-head spotlight-head--row">
          <div className="spotlight-head-left">
            <span className="spotlight-eyebrow">Done when</span>
            <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              {checks.length ? `${checks.length} check${checks.length === 1 ? '' : 's'} from the brief` : 'no brief submitted yet'}
            </span>
          </div>
        </header>
        {checks.length > 0 && (
          <ol className="spotlight-body task-checks">
            {checks.map((check, i) => <li key={i}>{check}</li>)}
          </ol>
        )}
      </section>

      {dependencies.length > 0 && (
        <section className="spotlight" id="dependencies">
          <header className="spotlight-head spotlight-head--row">
            <div className="spotlight-head-left">
              <span className="spotlight-eyebrow">Waits on</span>
            </div>
          </header>
          <div className="spotlight-body stack stack--sm">
            {dependencies.map(dep => (
              <div key={dep.id} className="cluster">
                <StatusPill value={dep.status} />
                <Link to={px(dep.node_type === 'task' ? `/tasks/${dep.id}` : `/experiments/${dep.id}`)}>
                  {dep.name || dep.id}
                </Link>
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>{dep.node_type}</span>
                {dep.settled && <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>· done</span>}
                {dep.failed && <span className="error-message" style={{ fontSize: 'var(--text-xs)' }}>ended without succeeding</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <TaskDocSpotlight
        id="delivery"
        projectId={projectId}
        eyebrow="Delivery"
        artifact={deliveryRes}
        emptyText="No delivery submitted yet."
        reviews={reviews}
        defaultOpen
      />
      <TaskDocSpotlight
        id="brief"
        projectId={projectId}
        eyebrow="Brief"
        artifact={briefRes}
        emptyText="No brief submitted yet — the executor writes tasks/<name>/brief.md."
        defaultOpen={!deliveryRes}
      />
    </div>
  );
}

function TaskDocSpotlight({ id, projectId, eyebrow, artifact, emptyText, reviews = [], defaultOpen = true }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showBody, setShowBody] = useState(defaultOpen);
  const [showReview, setShowReview] = useState(false);

  useEffect(() => {
    if (!artifact) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    api.getArtifactContent(projectId, artifact.id)
      .then(d => { if (!cancelled) setContent(d); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [projectId, artifact?.id]);

  const artifactId = artifact?.id;
  const resolveImageSrc = useCallback(
    (src) => api.artifactFigureUrl(projectId, artifactId, src),
    [projectId, artifactId],
  );

  if (!artifact) {
    return (
      <section id={id} className="spotlight">
        <div className="spotlight-eyebrow">{eyebrow}</div>
        <div className="spotlight-empty">{emptyText}</div>
      </section>
    );
  }
  const latest = reviews[reviews.length - 1];
  return (
    <section id={id} className="spotlight">
      <header className="spotlight-head spotlight-head--row">
        <div className="spotlight-head-left">
          <span className="spotlight-eyebrow">{eyebrow}</span>
          {latest && <StatusPill value={latest.verdict} />}
        </div>
        <div className="spotlight-head-right">
          <span className="mono spotlight-bar-path">{artifact.path}</span>
          {reviews.length > 0 && (
            <button type="button" className="btn btn--sm" onClick={() => setShowReview(v => !v)}>
              <span className="toggle-verb">{showReview ? 'Hide' : 'Show'}</span>{` review${reviews.length === 1 ? '' : 's'}`}
            </button>
          )}
          <button type="button" className="btn btn--sm" onClick={() => setShowBody(v => !v)}>
            <span className="toggle-verb">{showBody ? 'Hide' : 'Show'}</span>{` ${eyebrow.toLowerCase()}`}
          </button>
        </div>
      </header>
      {showReview && reviews.length > 0 && (
        <div className="spotlight-review stack stack--sm">
          {reviews.slice().reverse().map(r => <ReviewCard key={r.id} review={r} />)}
        </div>
      )}
      {showBody && (
        <div className="spotlight-body">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : error ? (
            <div className="error-message">{error}</div>
          ) : content ? (
            content.available === false ? (
              <div className="empty">No submitted content is available.</div>
            ) : content.is_binary ? (
              <div className="empty">Binary file</div>
            ) : (
              <FileRenderer text={content.content ?? ''} path={artifact.path} resolveImageSrc={resolveImageSrc} />
            )
          ) : null}
        </div>
      )}
    </section>
  );
}
