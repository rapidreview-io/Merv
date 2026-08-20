import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { useStreamAwarePoll } from '../store/useEventStream';
import FSMStrip from '../components/FSMStrip';
import GateBanner from '../components/GateBanner';
import FileRenderer from '../components/FileRenderer';
import MarkdownView from '../components/MarkdownView';
import ReviewCard from '../components/ReviewCard';
import StatusPill from '../components/StatusPill';
import ObjId from '../components/ObjId';
import InlineMd from '../components/InlineMd';
import DetailsDrawer, { DetailsButton, OpsTimeline, OpsVersions, OpsPosition } from '../components/DetailsDrawer';
import { fmtAgo, fmtSpan, formatBytes } from '../utils/format';

/*
 * TaskDetail — a task is scoped work with a verifiable finish line, so the
 * page is a ledger, not an essay:
 *
 *   description   the brief's Goal as structure — headline, deliverables, purpose
 *   requirements  one row per Done-when check: what must be true · got it? · evidence
 *   process       the prose — outcome, the delivery's Report and Caveats, the reviews
 *   details       status, timeline, unblocks / waits on, files, record —
 *                 in the shared DetailsDrawer, on press, never as a column
 *
 * The strip at the top is still the status truth and the gate panel still
 * carries the transitions. Everything the table and rail show is parsed
 * server-side from the brief and delivery (task.description / requirements /
 * results / report / caveats / dependents) — nothing is re-derived here.
 */

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

const ago = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? fmtAgo(Date.now() - t) : null;
};
const msBetween = (a, b) => {
  const t0 = Date.parse(a || ''), t1 = Date.parse(b || '');
  return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : null;
};
const nodeHref = (px, node) => px(node.node_type === 'task' ? `/tasks/${node.id}` : `/experiments/${node.id}`);

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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsBtnRef = useRef(null);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    detailsBtnRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => { setPendingEnd(false); setEndReason(''); setDetailsOpen(false); }, [taskId]);

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
  // The backend lists reviews newest-first; the timeline and the process
  // section both want them in time order.
  const reviews = (task.reviews || []).slice().reverse();

  return (
    <div className="page-stage">
      <section className="exp-fsm">
        <div className="fsm-row">
          <div className="fsm-row-strip">
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
          </div>
          <DetailsButton
            open={detailsOpen}
            onToggle={() => setDetailsOpen(v => !v)}
            controls="task-details"
            buttonRef={detailsBtnRef}
          />
        </div>
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

      <header className="exp-orient task-orient">
        <div className="page-eyebrow">
          <Link to={px('/tasks')}>Tasks</Link>
          {' · '}<ObjId id={task.id} />
        </div>
        <h1 className="page-title exp-title-name">{task.name || task.id}</h1>
      </header>

      <TaskDescription description={task.description} goal={task.goal} />
      <RequirementsTable task={task} />
      <ProcessSection task={task} reviews={reviews} />
      <TaskDocSpotlight
        id="delivery"
        projectId={projectId}
        eyebrow="Delivery"
        artifact={deliveryRes}
        verdict={reviews.length ? reviews[reviews.length - 1].verdict : null}
        emptyText="No delivery submitted yet."
      />
      <TaskDocSpotlight
        id="brief"
        projectId={projectId}
        eyebrow="Brief"
        artifact={briefRes}
        emptyText="No brief submitted yet — the executor writes tasks/<name>/brief.md."
      />

      <DetailsDrawer id="task-details" open={detailsOpen} onClose={closeDetails}>
        <TaskFacts task={task} reviews={reviews} px={px} />
      </DetailsDrawer>
    </div>
  );
}

/* ───────────── Description: the brief's Goal as structure ───────────── */

function TaskDescription({ description, goal }) {
  const d = description || {};
  if (!d.structured) {
    const text = String(d.text || goal || '').trim();
    if (!text) return null;
    // Plain prose (a task created before the Goal shape, or written without
    // it): one measured paragraph, still the lead of the page.
    return (
      <section className="task-desc">
        <p className="task-desc-summary task-desc-summary--plain"><InlineMd text={text} /></p>
      </section>
    );
  }
  return (
    <section className="task-desc">
      {d.summary && <p className="task-desc-summary"><InlineMd text={d.summary} /></p>}
      <dl className="task-desc-grid">
        {d.deliverables?.length > 0 && (
          <>
            <dt>Deliverables</dt>
            <dd>
              <ul className="task-deliverables">
                {d.deliverables.map((item, i) => <li key={i}><InlineMd text={item} /></li>)}
              </ul>
            </dd>
          </>
        )}
        {d.purpose && (
          <>
            <dt>Purpose</dt>
            <dd className="task-purpose"><InlineMd text={d.purpose} /></dd>
          </>
        )}
      </dl>
    </section>
  );
}

/* ───────────── Requirements: what must be true · got it? · evidence ───── */

// The per-row state a reader sees, from the delivery entry's claim and the
// task's status. The claim is the executor's; only acceptance makes it
// "verified" — one review covers the whole task, there is no per-row verdict.
function rowState(result, status) {
  const claim = result?.state || null;
  if (!claim) {
    if (status === 'failed') return { tone: 'open', glyph: '○', word: 'not delivered', sub: null };
    return { tone: 'open', glyph: '○', word: 'not yet', sub: null };
  }
  if (claim === 'unmet') {
    return {
      tone: 'bad', glyph: '✗', word: 'unmet',
      sub: status === 'done' ? 'waived in review' : status === 'in_review' ? 'awaiting review' : status === 'failed' ? 'task ended' : 'stated by the executor',
    };
  }
  if (claim === 'partial') {
    return {
      tone: 'wait', glyph: '◐', word: 'partial',
      sub: status === 'done' ? 'accepted in review' : status === 'in_review' ? 'awaiting review' : status === 'failed' ? 'task ended' : 'stated by the executor',
    };
  }
  if (status === 'done') return { tone: 'ok', glyph: '✓', word: 'met', sub: 'verified in review' };
  if (status === 'in_review') return { tone: 'wait', glyph: '◐', word: 'claimed', sub: 'awaiting review' };
  if (status === 'failed') return { tone: 'wait', glyph: '◐', word: 'claimed', sub: 'task ended' };
  return { tone: 'wait', glyph: '◐', word: 'claimed', sub: 'not submitted' };
}

function RequirementsTable({ task }) {
  const requirements = Array.isArray(task.requirements) && task.requirements.length
    ? task.requirements
    : (task.checks || []).map((text, i) => ({ number: i + 1, statement: text, verify: null, text }));
  const results = new Map((task.results || []).map(r => [r.number, r]));
  const total = requirements.length;
  const status = task.status;
  const rows = requirements.map(req => ({ req, result: results.get(req.number) || null, state: rowState(results.get(req.number) || null, status) }));
  const claimed = rows.filter(r => r.result?.state).length;
  const metCount = rows.filter(r => r.result?.state === 'met').length;

  let countLine = null;
  if (total) {
    if (status === 'done') countLine = <><b>{metCount} of {total}</b> met and verified{metCount < total ? ' · the rest waived in review' : ''}</>;
    else if (status === 'in_review') countLine = <><b>{claimed} of {total}</b> answered · awaiting review</>;
    else if (status === 'failed') countLine = <><b>{claimed} of {total}</b> answered before the task ended</>;
    else countLine = claimed ? <><b>{claimed} of {total}</b> evidenced · {total - claimed} to go</> : <>none evidenced yet</>;
  }

  return (
    <section className="spotlight" id="requirements">
      <header className="spotlight-head spotlight-head--row">
        <div className="spotlight-head-left">
          <span className="spotlight-eyebrow">Done when</span>
          <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
            {total ? <>{total} requirement{total === 1 ? '' : 's'} from the brief · {countLine}</> : 'no brief submitted yet'}
          </span>
        </div>
      </header>
      {total > 0 && (
        <div className="task-req" role="table" aria-label="Requirements">
          <div className="task-req-h" role="columnheader" />
          <div className="task-req-h" role="columnheader">What must be true</div>
          <div className="task-req-h task-req-h--ev" role="columnheader">Evidence</div>
          {rows.map(({ req, result, state }, i) => {
            const last = i === rows.length - 1 ? ' task-req--last' : '';
            return (
              <div key={req.number} role="row" className="task-req-row" style={{ display: 'contents' }}>
                <div
                  className={`task-req-mark task-got--${state.tone}${last}`}
                  role="cell"
                  title={state.word + (state.sub ? ` — ${state.sub}` : '')}
                >
                  <span aria-hidden="true">{state.glyph}</span>
                  <span className="visually-hidden">{state.word}{state.sub ? ` — ${state.sub}` : ''}</span>
                </div>
                <div className={`task-req-stmt-cell${last}`} role="cell">
                  <div className="task-req-stmt"><span className="task-req-n">{req.number}</span><InlineMd text={req.statement} /></div>
                  {req.verify && <div className="task-req-verify"><span className="k">verify · </span><InlineMd text={req.verify} /></div>}
                </div>
                <div className={`task-req-ev${last}`} role="cell">
                  {result?.evidence
                    ? <>
                        {result.state === 'unmet' && <span className="task-req-word task-req-word--bad">unmet · </span>}
                        {result.state === 'partial' && <span className="task-req-word task-req-word--wait">partial · </span>}
                        <InlineMd text={result.evidence} />
                        {result.how && <span className="task-req-how"><span className="k">check · </span><InlineMd text={result.how} /></span>}
                      </>
                    : <span className="task-req-none">— no evidence yet</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ───────────── Process: the prose — outcome, report, caveats, reviews ── */

function ProcessSection({ task, reviews }) {
  const status = task.status;
  const report = String(task.report || '').trim();
  const caveats = String(task.caveats || '').trim();
  const outcome = String(task.outcome || '').trim();
  const latest = reviews.length ? reviews[reviews.length - 1] : null;
  const showOutcome = status === 'done' || status === 'failed';
  const nothing = !showOutcome && !report && !caveats && !latest;
  return (
    <section className="spotlight task-proc" id="notes">
      <header className="spotlight-head"><span className="spotlight-eyebrow">Notes</span></header>
      {showOutcome && (
        <div className="task-proc-sec">
          <h4>{status === 'failed' ? `Ended by ${task.failed_by || 'owner'}` : 'Outcome'}</h4>
          <p><InlineMd text={outcome || (status === 'failed' ? 'No reason recorded.' : 'No outcome note recorded.')} /></p>
        </div>
      )}
      {report && (
        <div className="task-proc-sec">
          <h4>Report <span className="task-proc-from">· from the delivery</span></h4>
          <div className="task-proc-md"><MarkdownView text={report} /></div>
        </div>
      )}
      {caveats && (
        <div className="task-proc-sec">
          <h4>Caveats</h4>
          <div className="task-proc-md task-proc-md--quiet"><MarkdownView text={caveats} /></div>
        </div>
      )}
      {latest && (
        <div className="task-proc-sec">
          <h4>
            Review
            {reviews.length > 1 && (
              <span className="task-proc-from"> · round {reviews.length} of {reviews.length} — earlier rounds in Details</span>
            )}
          </h4>
          <ReviewQuote review={latest} round={reviews.length} />
        </div>
      )}
      {nothing && (
        <div className="spotlight-empty">
          {status === 'in_progress'
            ? 'Nothing to report yet — the delivery’s Report section and the review appear here.'
            : 'No report or review recorded.'}
        </div>
      )}
    </section>
  );
}

function ReviewQuote({ review, round }) {
  const verdict = String(review.verdict || 'pending').toLowerCase();
  const synopsis = String(review.synopsis || '').trim();
  const hasDetail = Boolean(review.notes) || (Array.isArray(review.findings) && review.findings.length > 0);
  return (
    <blockquote className={`task-quote task-quote--${verdict}`}>
      <div className="task-quote-by">
        <StatusPill value={verdict} />
        <span>round {round}</span>
        {review.created_at && <span>· {ago(review.created_at)}</span>}
      </div>
      {synopsis ? <p><InlineMd text={synopsis} /></p> : null}
      {hasDetail && <ReviewCard review={review} bare />}
    </blockquote>
  );
}

/* ───────────── Documents ─────────────────────────────────────────────── */

function TaskDocSpotlight({ id, projectId, eyebrow, artifact, emptyText, verdict = null }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showBody, setShowBody] = useState(false);

  useEffect(() => {
    if (!artifact || !showBody) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.getArtifactContent(projectId, artifact.id)
      .then(d => { if (!cancelled) setContent(d); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [projectId, artifact?.id, showBody]);

  const artifactId = artifact?.id;
  const resolveImageSrc = useCallback(
    (src) => api.artifactFigureUrl(projectId, artifactId, src),
    [projectId, artifactId],
  );

  if (!artifact) {
    return (
      <section id={id} className="spotlight task-doc">
        <div className="spotlight-eyebrow">{eyebrow}</div>
        <div className="spotlight-empty">{emptyText}</div>
      </section>
    );
  }
  return (
    <section id={id} className="spotlight task-doc">
      <header className="spotlight-head spotlight-head--row" style={{ marginBottom: showBody ? 14 : 0 }}>
        <div className="spotlight-head-left">
          <span className="spotlight-eyebrow">{eyebrow}</span>
          {verdict && <StatusPill value={verdict} />}
        </div>
        <div className="spotlight-head-right">
          <span className="mono spotlight-bar-path">{artifact.path}</span>
          <button type="button" className="btn btn--sm" onClick={() => setShowBody(v => !v)}>
            <span className="toggle-verb">{showBody ? 'Hide' : 'Show'}</span>{` ${eyebrow.toLowerCase()}`}
          </button>
        </div>
      </header>
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

/* ───────────── Details drawer body: pure operations ─────────────────────
   Nothing here repeats the page. Three sections:
     Timeline — every step with how long it took (durations between events);
     Versions — the submission history: brief/delivery versions, review rounds;
     Position — what this task is connected to (waits on / unblocks).       */

// The record's events in time order with per-step durations. Timestamps are
// second-resolution, so ties order the way the record actually goes —
// delivery k, then review round k, then delivery k+1, endings last.
function buildTimeline(task, reviews) {
  const items = [];
  if (task.created_at) items.push({ t: task.created_at, rank: 0, tone: null, label: 'created' });
  const arts = (task.artifacts || []).slice().sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || ((a.submitted_order ?? 0) - (b.submitted_order ?? 0)));
  let briefSeen = 0, deliverySeen = 0;
  for (const a of arts) {
    if (a.role === 'brief') {
      briefSeen += 1;
      items.push({ t: a.created_at, rank: 1, tone: null, label: briefSeen === 1 ? 'brief submitted' : 'brief updated' });
    } else if (a.role === 'delivery') {
      deliverySeen += 1;
      items.push({
        t: a.created_at, rank: 2 * deliverySeen, tone: 'live',
        label: deliverySeen === 1 ? 'delivery submitted' : 'delivery resubmitted',
      });
    }
  }
  reviews.forEach((r, i) => {
    const v = String(r.verdict || '').toLowerCase();
    items.push({
      t: r.created_at, rank: 2 * (i + 1) + 1,
      tone: v === 'pass' ? 'ok' : v === 'fail' ? 'bad' : 'warn',
      label: `review round ${i + 1} · ${v.replace(/_/g, ' ') || 'pending'}`,
    });
  });
  if (task.status === 'done' && task.updated_at) {
    items.push({ t: task.updated_at, rank: 99, tone: 'ok', label: 'accepted' });
  } else if (task.status === 'failed' && task.updated_at) {
    items.push({ t: task.updated_at, rank: 99, tone: 'bad', label: `ended by ${task.failed_by || 'owner'}` });
  }
  return items
    .filter(i => i.t)
    .sort((a, b) => String(a.t).localeCompare(String(b.t)) || (a.rank - b.rank));
}

function TaskFacts({ task, reviews, px }) {
  const timeline = buildTimeline(task, reviews);
  const done = task.status === 'done' || task.status === 'failed';
  const arts = (task.artifacts || []).slice().sort((a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || ((a.submitted_order ?? 0) - (b.submitted_order ?? 0)));
  const versionsOf = (role) => arts.filter(a => a.role === role).map((a, i) => ({
    id: a.id,
    name: `v${i + 1}`,
    meta: [a.size_bytes != null ? formatBytes(a.size_bytes) : null, ago(a.created_at)].filter(Boolean).join(' · '),
    title: a.path,
  }));
  const reviewRows = reviews.map((r, i) => ({
    id: r.id,
    name: `round ${i + 1}`,
    pill: String(r.verdict || 'pending').toLowerCase(),
    meta: ago(r.created_at) || '',
  }));
  const withHref = (d) => ({ ...d, href: nodeHref(px, d) });
  const upstream = (task.dependencies || []).map(withHref);
  const downstream = (task.dependents || []).map(withHref);
  const isOpen = !TASK_TERMINAL.has(task.status);
  return (
    <>
      <OpsTimeline items={timeline} done={done} createdAt={task.created_at} endedAt={task.updated_at} />
      <OpsVersions groups={[
        { label: 'brief', rows: versionsOf('brief') },
        { label: 'delivery', rows: versionsOf('delivery') },
        { label: 'reviews', rows: reviewRows },
      ]} />
      <OpsPosition
        upstream={upstream}
        downstream={downstream}
        waitNote={downstream.length > 0 && isOpen
          ? (downstream.length === 1 ? 'it waits until this task is accepted' : 'they wait until this task is accepted')
          : null}
      />
    </>
  );
}
