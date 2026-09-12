import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useIntervalPoll, useRecordStatus } from '../store/usePolling';
import { useProjectStore, useProjectHref } from '../store/useProjectStore';
import SandboxTerminal from '../components/SandboxTerminal';
import MobileGraphSection from './MobileGraphSection';
import MobileDoc from './MobileDoc';
import { Skeleton } from './Skeleton';
import { expName, experimentDocs, statusColor, statusLine, TERMINAL_STATUSES } from '../utils/experiment';
import { agentPrompt } from '../utils/vocab';

/**
 * Mobile experiment detail — one continuous scroll. Status → Plan → Run →
 * Outcomes flow down a single surface, each
 * introduced by a small label and separated by a hairline. No section
 * navigator — just scroll.
 *
 * The artifacts (intent, plan, terminal, report) are the content;
 * everything about the workflow
 * collapses into ONE color-indexed status statement — no FSM enumeration,
 * no gate card, no counts. Heavy panes attach on tap: the terminal (its
 * poller) and the graph mount only when opened, so a long scroll never
 * stacks pollers. Read-only: reviews and transitions are the agent's job.
 */
export default function MobileExperimentDetail() {
  const { experimentId } = useParams();
  const px = useProjectHref();
  const projectId = useProjectStore(s => s.projectId);

  const [termOpen, setTermOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  const [statusData, error, fetchStatus, resetStatus] = useRecordStatus(
    () => api.getExperimentStatus(projectId, experimentId),
    [projectId, experimentId],
  );

  // Run only exists while a sandbox is attached — a terminal with nothing
  // to attach to is dead chrome.
  const hasSandbox = (statusData?.sandboxes || []).length > 0;

  // Navigating experiment→experiment keeps this component mounted; reset so
  // the old experiment never flashes and heavy panes fold back shut.
  useEffect(() => {
    resetStatus();
    setTermOpen(false);
    setGraphOpen(false);
  }, [experimentId]);

  useIntervalPoll(fetchStatus, 5000);

  const experiment = statusData?.experiment;
  const workflow = statusData?.workflow;

  if (error) {
    return (
      <div className="mdetail">
        <div className="error-message">{error}</div>
        <Link className="btn" to={px('/experiments')} style={{ marginTop: 12 }}>← Experiments</Link>
      </div>
    );
  }
  if (!experiment) {
    return (
      <div className="mdetail">
        <header className="page-header"><Skeleton lines={1} /></header>
        <Skeleton lines={5} />
      </div>
    );
  }

  const currentAttempt = experiment.attempt_index;
  const isClosed = TERMINAL_STATUSES.includes(experiment.status);

  const { planRes, reportRes, designReviews, experimentReviews } = experimentDocs(experiment);

  // The lede is the ask the experiment was created with; reviewer synopses
  // live with their reviews below.
  const intent = String(experiment.intent || '').trim();
  const askDetails = String(experiment.details || '').trim();

  return (
    <div className="mdetail">
      <header className="page-header">
        <div className="page-eyebrow">
          <Link to={px('/experiments')}>‹ Experiments</Link>
          {' · '}attempt {currentAttempt}
        </div>
        <h1 className="page-title">{expName(experiment)}</h1>
      </header>

      {/* ── Status ─────────────────────────────────────────────────── */}
      <section className="mdetail-section">
        <div className="mml">Status</div>
        <StatusStatement experiment={experiment} workflow={isClosed ? null : workflow} />
        {intent && <p className="mdetail-lead">{intent}</p>}
        {askDetails && (
          <LazyRow open={askOpen} onOpen={() => setAskOpen(true)} label="details">
            <p className="mdetail-lead mdetail-ask-details">{askDetails}</p>
          </LazyRow>
        )}
        <LazyRow open={graphOpen} onOpen={() => setGraphOpen(true)} label="graph">
          <MobileGraphSection
            projectId={projectId}
            experimentId={experimentId}
            experiment={experiment}
            sandboxes={statusData.sandboxes}
          />
        </LazyRow>
      </section>

      <div className="mbreak" />

      {/* ── Plan ───────────────────────────────────────────────────── */}
      <section className="mdetail-section">
        <div className="mml">Plan</div>
        {planRes ? (
          <MobileDoc
            projectId={projectId}
            artifact={planRes}
            reviews={designReviews}
            kind="plan"
            experimentStatus={experiment.status}
            attemptIndex={currentAttempt}
          />
        ) : (
          <div className="mquiet">no plan synced yet</div>
        )}
      </section>

      <div className="mbreak" />

      {/* ── Run — only while a sandbox is attached; terminal attaches
             (and starts polling) on tap ── */}
      {hasSandbox && (
        <>
          <section className="mdetail-section">
            <div className="mml">Run</div>
            <LazyRow open={termOpen} onOpen={() => setTermOpen(true)} label="terminal">
              <SandboxTerminal projectId={projectId} experimentId={experimentId} readOnly />
            </LazyRow>
          </section>

          <div className="mbreak" />
        </>
      )}

      {/* ── Outcomes ───────────────────────────────────────────────── */}
      <section className="mdetail-section">
        <div className="mml">Outcomes</div>
        {reportRes && (
          <MobileDoc
            projectId={projectId}
            artifact={reportRes}
            reviews={experimentReviews}
            kind="report"
            experimentStatus={experiment.status}
          />
        )}
      </section>
    </div>
  );
}

// The entire workflow apparatus as one statement: a 3px index in the state's
// color (the same facet language as the list rows), the state sentence, and
// — only while live — the agent's next move in the shared vocabulary.
// FSM enumeration, gate cards, and counts are deliberately omitted.
// Renders on the shared .mstatus* grammar (mobile.css) — any mobile detail
// page can reuse it for its own one-line lifecycle statement.
function StatusStatement({ experiment, workflow }) {
  const status = (experiment.status || 'planned').toLowerCase();
  const color = statusColor(status);
  const next = agentPrompt(workflow?.next_action, { state: status, name: expName(experiment) });

  return (
    <div className="mstatus">
      <span className="mstatus-ix" style={{ background: color }} aria-hidden="true" />
      <div className="mstatus-body">
        <div className="mstatus-line" style={{ color }}>
          {statusLine(experiment, status, Date.now())}
        </div>
        {next && <div className="mstatus-next">agent’s move · {next}</div>}
      </div>
    </div>
  );
}

// A heavy pane folded into the surface: a quiet disclosure row that mounts
// its children only once opened (preserves the "polls only when open" rule).
function LazyRow({ open, onOpen, label, children }) {
  if (open) return children;
  return (
    <button type="button" className="mterm-row" onClick={onOpen}>
      <span className="mterm-twist" aria-hidden="true">▸</span>
      {label}
    </button>
  );
}
