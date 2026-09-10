import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useRecordStatus } from '../store/usePolling';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import { useStreamAwarePoll } from '../store/useEventStream';
import FSMStrip from '../components/FSMStrip';
import GateBanner from '../components/GateBanner';
import PlanSpotlight from '../components/PlanSpotlight';
import ReportSpotlight from '../components/ReportSpotlight';
import ExperimentGraphs from '../components/ExperimentGraphs';
import SandboxTerminal from '../components/SandboxTerminal';
import ArtifactList from '../components/ArtifactList';
import TerminalTransitionConfirm from '../components/TerminalTransitionConfirm';
import DetailsDrawer, {
  DetailsButton, OpsPosition, OpsTimeline, OpsVersions, useDetailsDrawer,
  linkedNodes, orderedTimeline, reviewRows, sortedArtifacts, versionRows,
} from '../components/DetailsDrawer';
import { expName, experimentDocs } from '../utils/experiment';
import { gateToSectionId, useScrollToHash } from '../utils/useScrollToHash';
import { workflowActionButtons } from '../utils/workflowActions';
import InlineMd from '../components/InlineMd';

const PRIMARY_TRANSITIONS = {
  submit_design:  { transition: 'submit_design',  label: 'Submit for design review' },
  submit_results: { transition: 'submit_results', label: 'Submit results for review' },
  complete:       { transition: 'complete',       label: 'Complete experiment' },
};
const SECONDARY_TRANSITIONS = [
  { transition: 'mark_failed', label: 'Mark failed' },
  { transition: 'abandon',     label: 'Abandon' },
];
const TERMINAL_TRANSITIONS = new Set([
  'complete',
  ...SECONDARY_TRANSITIONS.map(a => a.transition),
]);

export default function ExperimentDetail() {
  const { experimentId } = useParams();
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);
  const refreshHome = useProjectStore(s => s.refreshHome);

  const [busy, setBusy] = useState(new Set());
  const [actionError, setActionError] = useState(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [pendingTerminalTransition, setPendingTerminalTransition] = useState(null);
  const { detailsOpen, setDetailsOpen, toggleDetails, closeDetails, detailsBtnRef } = useDetailsDrawer();

  useEffect(() => {
    setPendingTerminalTransition(null);
  }, [experimentId]);

  // Cross-page deep links (e.g. /experiments/:id#execution) — once the
  // experiment has loaded and its sections rendered, scroll the matching id
  // into view.
  useScrollToHash([statusData]);

  const [statusData, error, fetchStatus] = useRecordStatus(
    () => api.getExperimentStatus(projectId, experimentId),
    [projectId, experimentId],
  );

  // 3s poll only while the event stream is down; otherwise refetch when an
  // event touches this experiment (safety poll catches event-less changes).
  useStreamAwarePoll(fetchStatus, {
    matches: (row) => row.target_id === experimentId || row.payload?.experiment_id === experimentId,
  });

  const experiment = statusData?.experiment;
  const workflow = statusData?.workflow;

  const { primary, secondary } = useMemo(() => workflowActionButtons(workflow, PRIMARY_TRANSITIONS, SECONDARY_TRANSITIONS), [workflow]);

  const onAction = useCallback(async (transition) => {
    setBusy(prev => { const n = new Set(prev); n.add(transition); return n; });
    setActionError(null);
    let transitionApplied = false;
    try {
      await api.transitionExperiment(projectId, experimentId, transition);
      transitionApplied = true;
      await Promise.all([fetchStatus(), refreshHome()]);
      return true;
    } catch (err) {
      setActionError(`${transition}: ${err.message}`);
      // If only a follow-up refresh failed, the irreversible transition still
      // landed. Close the confirmation rather than offering a dangerous retry;
      // stream/poll reconciliation will refresh the page state.
      return transitionApplied;
    } finally {
      setBusy(prev => { const n = new Set(prev); n.delete(transition); return n; });
    }
  }, [projectId, experimentId, fetchStatus, refreshHome]);

  const requestAction = useCallback((transition) => {
    if (TERMINAL_TRANSITIONS.has(transition)) {
      setActionError(null);
      setPendingTerminalTransition(transition);
      return;
    }
    onAction(transition);
  }, [onAction]);

  const confirmTerminalTransition = useCallback(async () => {
    if (!pendingTerminalTransition) return;
    const completed = await onAction(pendingTerminalTransition);
    if (completed) setPendingTerminalTransition(null);
  }, [onAction, pendingTerminalTransition]);

  const cancelTerminalTransition = useCallback(() => {
    setPendingTerminalTransition(null);
  }, []);

  if (error) {
    return (
      <div className="page-stage">
        <div className="error-message">{error}</div>
        <Link className="btn" to={px('/experiments')} style={{ marginTop: 12 }}>← Experiments</Link>
      </div>
    );
  }
  if (!experiment) {
    return <div className="page-stage"><div className="empty">Loading…</div></div>;
  }

  const currentAttempt = experiment.attempt_index;
  const isClosed = ['complete', 'failed', 'abandoned'].includes(experiment.status);

  // Partition artifacts by role.
  const {
    planRes, reportRes, otherRes, historicalRes, designReviews, experimentReviews,
  } = experimentDocs(experiment);

  return (
    <div className="page-stage">
      {/* ─────────────  STAGE  ──────────────────────────────────────── */}
      {/* The strip is the page's status truth. For a live experiment the
          current step discloses the gate panel (details + transitions);
          closed experiments need no panel — the strip already says it. */}
      <section className="exp-fsm">
        <div className="fsm-row">
          <div className="fsm-row-strip">
        <FSMStrip
          status={experiment.status}
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
              linkTo={(() => {
                const section = gateToSectionId(workflow?.current_gate);
                return section ? `#${section}` : null;
              })()}
            />
          </div>
        </FSMStrip>
          </div>
          <DetailsButton
            open={detailsOpen}
            onToggle={toggleDetails}
            controls="experiment-details"
            buttonRef={detailsBtnRef}
          />
        </div>
        {actionError && <div className="error-message">{actionError}</div>}
      </section>

      <TerminalTransitionConfirm
        transition={pendingTerminalTransition}
        experimentName={expName(experiment)}
        busy={pendingTerminalTransition ? busy.has(pendingTerminalTransition) : false}
        error={actionError}
        onConfirm={confirmTerminalTransition}
        onCancel={cancelTerminalTransition}
      />

      {/* ─────────────  ORIENTATION  ────────────────────────────────── */}
      <header className="exp-orient">
        <div className="page-eyebrow">
          <Link to={px('/experiments')}>Experiments</Link>
          {' · '}<span className="exp-orient-attempt">attempt {currentAttempt}</span>
        </div>
        <h1 className="page-title exp-title-name">{expName(experiment)}</h1>
      </header>

      {/* ─────────────  THE ASK (permanent lede)  ───────────────────────
          The intent line the experiment was created with, always visible;
          the creator's optional details sit behind the header's disclosure.
          Both are immutable — the approved plan below supersedes the details
          on anything about how. */}
      <AskCard experiment={experiment} />

      {/* ─────────────  MAP (pinned overview: figure ⇄ logic graph)  ── */}
      <ExperimentGraphs
        projectId={projectId}
        experimentId={experimentId}
        experimentStatus={experiment.status}
        attemptIndex={currentAttempt}
      />

      {/* ═════════════  RESULTS  ════════════════════════════════════════
          Newest-first: the executed experiment's output leads the page. The
          report (with its experiment review behind a "Show review" disclosure)
          comes first, then durable metrics. Each piece is simply absent until
          it exists — the order itself never changes. (Raw `result`-role
          artifacts are intentionally not surfaced here.) */}
      {reportRes && (
        <ReportSpotlight
          projectId={projectId}
          reportArtifact={reportRes}
          experimentReviews={experimentReviews}
          experimentStatus={experiment.status}
        />
      )}

      {/* ═════════════  EXECUTION  ══════════════════════════════════════
          The sandbox: expanded while a run is live/provisioning, collapsed to
          its header once the run has ended (collapsible). */}
      <SandboxTerminal
        projectId={projectId}
        experimentId={experimentId}
        collapsible
      />

      {/* ═════════════  DESIGN  ═════════════════════════════════════════
          The framing document, oldest so it anchors the bottom. Its design
          review lives behind a "Show review" disclosure on the header. */}
      <PlanSpotlight
        projectId={projectId}
        planArtifact={planRes}
        designReviews={designReviews}
        attemptIndex={currentAttempt}
        experimentStatus={experiment.status}
        defaultOpen={!reportRes}
      />

      {(otherRes.length > 0 || historicalRes.length > 0) && (
        <FooterMisc
          projectId={projectId}
          otherRes={otherRes}
          historicalRes={historicalRes}
        />
      )}

      <DetailsDrawer id="experiment-details" open={detailsOpen} onClose={closeDetails}>
        <ExperimentFacts
          experiment={experiment}
          designReviews={designReviews}
          experimentReviews={experimentReviews}
          px={px}
        />
      </DetailsDrawer>
    </div>
  );
}

function AskCard({ experiment }) {
  const intent = String(experiment.intent || '').trim();
  const details = String(experiment.details || '').trim();
  const [open, setOpen] = useState(false);
  if (!intent && !details) return null;
  return (
    <section id="ask" className="spotlight exp-ask">
      <header className="spotlight-head spotlight-head--row">
        <div className="spotlight-head-left">
          <span className="spotlight-eyebrow">Intent</span>
        </div>
        {details && (
          <div className="spotlight-head-right">
            <button
              type="button"
              className="btn btn--sm"
              aria-expanded={open}
              onClick={() => setOpen(v => !v)}
            >
              <span className="toggle-verb">{open ? 'Hide' : 'Show'}</span>{' details'}
            </button>
          </div>
        )}
      </header>
      {intent && <p className="ask-prose"><InlineMd text={intent} /></p>}
      {open && details && (
        <div className="ask-details"><p className="ask-details-prose"><InlineMd text={details} /></p></div>
      )}
    </section>
  );
}

/* The drawer body: pure operations — durations, versions, placement. The
   page already says status, verdicts, and content; none of that repeats. */
function buildExperimentTimeline(experiment, designReviews, experimentReviews) {
  const items = [];
  if (experiment.created_at) items.push({ t: experiment.created_at, rank: 0, tone: null, label: 'created' });
  const arts = sortedArtifacts(experiment);
  let planSeen = 0, reportSeen = 0;
  for (const a of arts) {
    if (a.role === 'plan') {
      planSeen += 1;
      items.push({ t: a.created_at, rank: 2 * planSeen, tone: null, label: planSeen === 1 ? 'plan submitted' : `plan v${planSeen}` });
    } else if (a.role === 'report') {
      reportSeen += 1;
      items.push({ t: a.created_at, rank: 50 + reportSeen, tone: 'live', label: reportSeen === 1 ? 'report submitted' : `report v${reportSeen}` });
    }
  }
  designReviews.forEach((r, i) => {
    const v = String(r.verdict || '').toLowerCase();
    items.push({
      t: r.created_at, rank: 2 * (i + 1) + 1,
      tone: v === 'pass' ? 'ok' : 'warn',
      label: `design review ${designReviews.length > 1 ? `round ${i + 1} ` : ''}· ${v.replace(/_/g, ' ') || 'pending'}`,
    });
  });
  experimentReviews.forEach((r, i) => {
    const v = String(r.verdict || '').toLowerCase();
    items.push({
      t: r.created_at, rank: 60 + i,
      tone: v === 'pass' ? 'ok' : v === 'fail' ? 'bad' : 'warn',
      label: `experiment review ${experimentReviews.length > 1 ? `round ${i + 1} ` : ''}· ${v.replace(/_/g, ' ') || 'pending'}`,
    });
  });
  const status = experiment.status;
  if (['complete', 'failed', 'abandoned'].includes(status) && experiment.updated_at) {
    items.push({
      t: experiment.updated_at, rank: 99,
      tone: status === 'complete' ? 'ok' : 'bad',
      label: status === 'complete' ? 'complete' : status,
    });
  }
  return orderedTimeline(items);
}

function ExperimentFacts({ experiment, designReviews, experimentReviews, px }) {
  const isClosed = ['complete', 'failed', 'abandoned'].includes(experiment.status);
  const timeline = buildExperimentTimeline(experiment, designReviews, experimentReviews);
  const arts = sortedArtifacts(experiment);
  const upstream = linkedNodes(experiment.dependencies, px);
  const downstream = linkedNodes(experiment.dependents, px);
  return (
    <>
      <OpsTimeline
        items={timeline}
        done={isClosed}
        createdAt={experiment.created_at}
        endedAt={experiment.updated_at}
      />
      <OpsVersions groups={[
        { label: 'plan', rows: versionRows(arts, 'plan') },
        { label: 'report', rows: versionRows(arts, 'report') },
        { label: 'design reviews', rows: reviewRows(designReviews) },
        { label: 'experiment reviews', rows: reviewRows(experimentReviews) },
      ]} />
      <OpsPosition
        upstream={upstream}
        downstream={downstream}
        waitNote={upstream.length > 0 && !isClosed ? 'Execution waits until every dependency has succeeded' : null}
      />
    </>
  );
}

function FooterMisc({ projectId, otherRes, historicalRes }) {
  const [showHist, setShowHist] = useState(false);
  return (
    <section className="exp-footer">
      {otherRes.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="outcomes-subhead">Other artifacts</div>
          <ArtifactList projectId={projectId} artifacts={otherRes} />
        </div>
      )}
      {historicalRes.length > 0 && (
        <div>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setShowHist(v => !v)}
          >
            {showHist
              ? `Hide earlier-attempt artifacts (${historicalRes.length})`
              : `Carried forward from earlier attempts (${historicalRes.length})`}
          </button>
          {showHist && (
            <div style={{ marginTop: 10 }}>
              <ArtifactList projectId={projectId} artifacts={historicalRes} historical />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
