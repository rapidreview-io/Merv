import { useEffect, useState } from 'react';
import { api } from '../../api';
import { shortDateTime } from '../../utils/time';
import { cx, shortSha } from '../../utils/format';
import {
  PRE_CONSOLIDATION, DECISIONS, LANDINGS, INTEGRATION_KIND_LABEL,
  consolidationPhase, provenanceSteps, ledgerRows, consolidationReview,
} from './consolidationModel';

/**
 * ConsolidationLedger — what happened to the code after the authoritative
 * reflection, for one selected wave. Shared by desktop and mobile.
 *
 * Not a Git commit graph: one calm row per corpus experiment, the human
 * decision in words first, the mechanical landing second, and a single
 * "Merv central" spine on the right that a row may only join solidly when
 * the runner verified real ancestry (merge / fast-forward). Everything a row
 * means is carried by its text; the track graphics are aria-hidden decor.
 *
 * Fetches its own packet lazily (GET .../consolidation) for the selected wave
 * only — the /reflections poll is never multiplied. Polls gently (12s) while
 * the wave is actively consolidating; terminal waves fetch once.
 */

// Phase → the one honest sentence under the ledger. Never implies completion
// before runner settlement.
function phaseNote(phase, packet) {
  const c = packet?.consolidation || {};
  const proposal = c.proposal || null;
  const advance = c.advance || null;
  switch (phase) {
    case 'proposing':
      return 'The consolidator is working through the corpus. Nothing has landed on central yet.';
    case 'review_wait':
      return `Proposal r${proposal?.revision ?? '?'} is with the independent consolidation reviewer. Nothing lands until the review passes and the runner advances central.`;
    case 'review_rejected':
      return 'The reviewer requested changes; the consolidator is revising the code proposal. The reflection itself stays authoritative.';
    case 'advance_wait':
      return `Review passed. The Merv runner will now attempt to advance central to ${shortSha(proposal?.proposal_sha) || 'the proposal'}.`;
    case 'advance_stale':
      return `Central moved to ${shortSha(advance?.observed_sha) || 'a new commit'} while this proposal was in flight — the proposal is stale and must be rebuilt on the new base.`;
    case 'advance_failed':
      return `The runner could not advance central${advance?.error ? `: ${advance.error}` : '.'}`;
    case 'abandoned':
      return 'This wave was abandoned; no code from it landed on central.';
    case 'legacy':
      return 'This wave completed before code consolidation tracking was introduced.';
    default:
      return '';
  }
}

// The runner's settlement receipt — shown only once the advance is bound.
function AdvanceReceipt({ advance }) {
  if (!advance || advance.status !== 'bound') return null;
  const diff = advance.diffstat || {};
  const stats = cx(
    diff.files_changed != null && `${diff.files_changed} files`,
    diff.insertions != null && `+${diff.insertions}`,
    diff.deletions != null && `−${diff.deletions}`,
  );
  return (
    <div className="cons-receipt">
      Runner advanced central to{' '}
      <code className="cons-sha">{shortSha(advance.observed_sha || advance.target_sha)}</code>
      {advance.bound_at && <> · {shortDateTime(advance.bound_at)}</>}
      {stats && <> · {stats}</>}
      {advance.runner_id && <span className="cons-receipt-runner"> · runner {advance.runner_id}</span>}
    </div>
  );
}

function DetailKv({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div className="cons-kv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// One corpus experiment: decision + landing in words, a track into the spine,
// and a quiet disclosure with the technical receipt.
function LedgerRow({ row, packet }) {
  const [open, setOpen] = useState(false);
  const decision = DECISIONS[row.decision];
  const landing = LANDINGS[row.landing];
  const pendingDecision = row.decision === 'pending';
  const ws = row.workspace;
  const proposal = packet?.consolidation?.proposal || null;
  const advance = packet?.consolidation?.advance || null;
  const kind = row.integrationKind || 'none';
  const integrationText = row.landing === 'merged'
    ? `${INTEGRATION_KIND_LABEL[kind] || kind} — ancestry verified by the runner`
    : row.landing === 'applied'
      ? `${INTEGRATION_KIND_LABEL[kind] || kind} — re-created on central, not an ancestry merge`
      : kind !== 'none' ? (INTEGRATION_KIND_LABEL[kind] || kind) : '';
  return (
    <li className={`cons-row cons-row--${landing.join}`}>
      <div className="cons-row-main">
        <button
          type="button"
          className="cons-row-head"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
        >
          <span className="cons-row-name">{row.name}</span>
          <span className="cons-row-sub">
            <span className={`cons-row-decision cons-row-decision--${row.decision}`}>
              {decision.label}
              {row.decision === 'superseded' && row.supersededByName ? ` by ${row.supersededByName}` : ''}
            </span>
            {!pendingDecision && (
              <span className="cons-row-landing"> · {landing.label}</span>
            )}
          </span>
          <span className="cons-row-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="cons-row-detail">
            {row.rationale && <p className="cons-row-rationale">{row.rationale}</p>}
            <dl className="cons-kv">
              <DetailKv label="Branch">{ws?.branch}</DetailKv>
              <DetailKv label="Integration">{integrationText}</DetailKv>
              <DetailKv label="Source">
                {row.sourceSha && <code className="cons-sha">{shortSha(row.sourceSha)}</code>}
              </DetailKv>
              <DetailKv label="Base">
                {(proposal?.base_sha || packet?.base_sha)
                  && <code className="cons-sha">{shortSha(proposal?.base_sha || packet?.base_sha)}</code>}
              </DetailKv>
              <DetailKv label="Proposal">
                {proposal?.proposal_sha && <code className="cons-sha">{shortSha(proposal.proposal_sha)}</code>}
              </DetailKv>
              <DetailKv label="Central">
                {advance?.observed_sha && <code className="cons-sha">{shortSha(advance.observed_sha)}</code>}
              </DetailKv>
              <DetailKv label="Decided">{shortDateTime(row.decidedAt)}</DetailKv>
              <DetailKv label="Workspace">
                {ws && `${ws.commit_count ?? 0} commits · ${ws.files_changed ?? 0} files · +${ws.insertions ?? 0} −${ws.deletions ?? 0}`}
              </DetailKv>
            </dl>
          </div>
        )}
      </div>
      {/* Decorative track into the central spine; the words above carry the
          meaning, so screen readers and no-color renderings lose nothing. */}
      <div className="cons-row-track" aria-hidden="true">
        <span className="cons-track-line" />
        <span className="cons-track-mark" />
      </div>
    </li>
  );
}

export default function ConsolidationLedger({ projectId, reflectionId, waveStatus }) {
  const status = String(waveStatus || '');
  const pre = PRE_CONSOLIDATION.has(status);
  const shouldFetch = Boolean(projectId && reflectionId) && !pre;
  const [packet, setPacket] = useState(null);
  const [error, setError] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setPacket(null); setError(null); setLoaded(false);
  }, [projectId, reflectionId]);

  // One lazy fetch per selected wave; re-fires when the wave's status moves
  // (driven by the existing /reflections poll) and ticks every 12s only while
  // the wave is actively consolidating. Aborted on unmount / wave switch.
  useEffect(() => {
    if (!shouldFetch) return undefined;
    const ctrl = new AbortController();
    let timer = null;
    const tick = async () => {
      try {
        const data = await api.getReflectionConsolidation(projectId, reflectionId, ctrl.signal);
        setPacket(data); setError(null); setLoaded(true);
      } catch (e) {
        if (e.name === 'AbortError') return;
        setError(e); setLoaded(true);
      }
    };
    tick();
    if (status === 'consolidating') {
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') tick();
      }, 12000);
    }
    return () => { ctrl.abort(); if (timer) clearInterval(timer); };
  }, [projectId, reflectionId, status, shouldFetch, retryKey]);

  const eyebrow = <div className="refl-eyebrow">Consolidation</div>;

  if (pre) {
    // Honest pre-consolidation state: the stage exists, it just hasn't begun.
    return (
      <div className="cons">
        {eyebrow}
        <div className="cons-note">Code consolidation begins after the reflection review passes.</div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="cons">
        {eyebrow}
        <div className="cons-note">Loading consolidation…</div>
      </div>
    );
  }
  if (error || !packet) {
    return (
      <div className="cons">
        {eyebrow}
        <div className="cons-note cons-note--error">
          Couldn’t load the consolidation ledger.
          <button type="button" className="cons-retry" onClick={() => setRetryKey(k => k + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const phase = consolidationPhase(packet, status);
  const c = packet.consolidation || {};
  const proposal = c.proposal || null;
  const advance = c.advance || null;
  const coverage = c.coverage || { total: 0, considered: 0 };
  const rows = ledgerRows(packet, phase);
  const review = consolidationReview(packet);
  const note = phaseNote(phase, packet);

  // A wave that closed before any consolidation work needs only the sentence.
  if (phase === 'legacy') {
    return (
      <div className="cons">
        {eyebrow}
        <div className="cons-note">{note}</div>
      </div>
    );
  }
  if (!rows.length) {
    return (
      <div className="cons">
        {eyebrow}
        <div className="cons-note">No experiments in this wave’s corpus — there is no code to consolidate.</div>
      </div>
    );
  }

  // Past ~8 rows the flat list gets group headers per decision so the eye can
  // skim by outcome instead of reading every line.
  const grouped = rows.length > 8;
  const groupCounts = {};
  rows.forEach(r => { groupCounts[r.decision] = (groupCounts[r.decision] || 0) + 1; });

  const items = [];
  let lastDecision = null;
  rows.forEach(row => {
    if (grouped && row.decision !== lastDecision) {
      lastDecision = row.decision;
      items.push(
        <li key={`g-${row.decision}`} className="cons-group" role="presentation">
          {DECISIONS[row.decision].label} · {groupCounts[row.decision]}
        </li>,
      );
    }
    items.push(<LedgerRow key={row.id} row={row} packet={packet} />);
  });

  return (
    <div className="cons" aria-label="Consolidation ledger">
      <div className="cons-head">
        {eyebrow}
        <div className={`cons-coverage${coverage.complete ? ' cons-coverage--done' : ''}`}>
          {coverage.considered} of {coverage.total} experiments reviewed
        </div>
      </div>

      {/* Provenance: reflection is authoritative; code follows it, reviewed
          independently, and only the runner may advance central. */}
      <ol className="cons-prov" aria-label="Consolidation provenance">
        {provenanceSteps(packet, phase).map(step => (
          <li key={step.id} className={`cons-prov-step cons-prov-step--${step.state}`}>
            <span className="cons-prov-dot" aria-hidden="true" />
            <span className="cons-prov-label">{step.label}</span>
            {step.note && <span className="cons-prov-note">{step.note}</span>}
          </li>
        ))}
      </ol>

      {proposal?.summary && <p className="cons-summary">{proposal.summary}</p>}
      {review && (
        <div className="cons-review">
          Independent review:{' '}
          {review.verdict === 'pass'
            ? 'passed'
            : review.verdict === 'fail' ? 'failed' : 'changes requested'}
          {review.synopsis ? ` — ${review.synopsis}` : ''}
        </div>
      )}

      <div className="cons-ledger">
        <div className="cons-spinehead" aria-hidden="true">Merv central</div>
        <ul className="cons-rows">{items}</ul>
      </div>

      <AdvanceReceipt advance={advance} />
      {note && <div className="cons-note">{note}</div>}
    </div>
  );
}
