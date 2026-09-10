import { shortSha } from '../../utils/format';

/**
 * consolidationModel — pure semantics for the Consolidation Ledger, shared by
 * the desktop ProjectReflectionPanel and the mobile MobileReflectionScreen so
 * the two surfaces never drift. No JSX, no fetching.
 *
 * Source of truth is GET /reflections/{id}/consolidation (see
 * application/reflections.py consolidation_packet): the frozen corpus, the
 * consolidator's immutable per-experiment decisions, the independent review
 * rows, and the runner's central-advance receipt with verified ancestry.
 *
 * Two separate vocabularies, deliberately never mixed:
 *   decision — the human consolidator's call on each experiment's code;
 *   landing  — what mechanically happened on Merv central, which the UI only
 *              asserts after the runner has settled (advance status 'bound').
 */

// Wave statuses before code consolidation can exist at all.
export const PRE_CONSOLIDATION = new Set([
  'reflecting', 'synthesizing', 'reflection_review',
]);

// disposition enum → plain language. `order` groups the ledger calmly:
// landed work first, then set-aside work, then anything still undecided.
export const DECISIONS = {
  used_as_is: { label: 'Used as-is', order: 0 },
  adapted: { label: 'Adapted', order: 1 },
  superseded: { label: 'Superseded', order: 2 },
  reviewed_not_used: { label: 'Reviewed, not used', order: 3 },
  pending: { label: 'Awaiting decision', order: 4 },
};

// landing → label + how the row's connector meets the central spine.
//   solid  — touches the spine: true Git ancestry (verified merge/ff only)
//   dotted — stops at an applied marker short of the spine: content was
//            re-created on central (cherry-pick/rewrite/adaptation), NOT
//            an ancestry-preserving merge
//   cap    — neutral end cap: reviewed work that lands nothing
//   halt   — interrupted landing (stale / failed advance)
//   none   — no positive connector: nothing settled yet
export const LANDINGS = {
  merged: { label: 'Merged into central', join: 'solid' },
  applied: { label: 'Applied to central', join: 'dotted' },
  not_applied: { label: 'Not applied', join: 'cap' },
  pending: { label: 'Not landed yet', join: 'none' },
  stale: { label: 'Landing stale', join: 'halt' },
  failed: { label: 'Landing failed', join: 'halt' },
};

export const INTEGRATION_KIND_LABEL = {
  merge: 'merge',
  fast_forward: 'fast-forward',
  cherry_pick: 'cherry-pick',
  rewrite: 'rewrite',
  none: 'none',
};

// Research Core resolves this review through the exact proposal snapshot,
// never by timestamps or "latest review" guesswork.
export function consolidationReview(packet) {
  return packet?.consolidation?.review || null;
}

/**
 * Where the consolidation actually stands. One of:
 *   proposing | review_wait | review_rejected | advance_wait |
 *   advance_stale | advance_failed | bound | settled | abandoned | legacy
 * 'settled' only when the wave itself is published; 'bound' is the brief
 * runner-receipt-recorded window before publication.
 */
export function consolidationPhase(packet, waveStatus) {
  const c = packet?.consolidation || {};
  const proposal = c.proposal || null;
  const advance = c.advance || null;
  if (!proposal && !advance && (waveStatus === 'published' || waveStatus === 'abandoned')) {
    return 'legacy';
  }
  if (advance?.status === 'bound') {
    return waveStatus === 'published' ? 'settled' : 'bound';
  }
  if (waveStatus === 'abandoned') return 'abandoned';
  if (advance) {
    if (advance.status === 'stale') return 'advance_stale';
    if (advance.status === 'failed') return 'advance_failed';
    return 'advance_wait'; // 'intended': the runner's compare-and-swap is in flight
  }
  if (proposal) {
    const review = consolidationReview(packet);
    if (!review) return 'review_wait';
    if (review.verdict === 'pass') return 'advance_wait';
    return 'review_rejected';
  }
  return 'proposing';
}

// The provenance sequence: Reflection (authoritative) → Consolidator →
// Independent review → Central advance (runner-controlled). Each step is
// { id, label, state, note } with state ∈ done | active | wait | halt | idle.
export function provenanceSteps(packet, phase) {
  const c = packet?.consolidation || {};
  const proposal = c.proposal || null;
  const advance = c.advance || null;
  const rev = proposal ? `proposal r${proposal.revision}` : '';

  const consolidator = proposal
    ? (phase === 'review_rejected'
      ? { state: 'active', note: `revising ${rev}` }
      : phase === 'advance_stale'
        ? { state: 'active', note: 'rebuilding on the moved base' }
        : { state: 'done', note: rev })
    : phase === 'abandoned'
      ? { state: 'idle', note: 'no proposal' }
      : { state: 'active', note: 'reviewing experiment code' };

  const review = { state: 'idle', note: '' };
  if (phase === 'review_wait') { review.state = 'wait'; review.note = 'in review'; }
  else if (phase === 'review_rejected') { review.state = 'halt'; review.note = 'changes requested'; }
  else if (['advance_wait', 'advance_stale', 'advance_failed', 'bound', 'settled'].includes(phase)) {
    review.state = 'done'; review.note = 'passed';
  }

  const central = { state: 'idle', note: '' };
  if (phase === 'advance_wait') { central.state = 'wait'; central.note = 'awaiting runner'; }
  else if (phase === 'advance_stale') { central.state = 'halt'; central.note = 'stale — central moved'; }
  else if (phase === 'advance_failed') { central.state = 'halt'; central.note = 'failed'; }
  else if (phase === 'bound' || phase === 'settled') {
    central.state = 'done';
    central.note = advance?.observed_sha ? `→ ${shortSha(advance.observed_sha)}` : 'advanced';
  }

  return [
    { id: 'reflection', label: 'Reflection', state: 'done', note: 'authoritative' },
    { id: 'consolidator', label: 'Consolidator', ...consolidator },
    { id: 'review', label: 'Independent review', ...review },
    { id: 'central', label: 'Central advance', ...central },
  ];
}

// The mechanical landing for one decision row. Positive results ('merged',
// 'applied') are asserted ONLY after the runner has settled; the solid-join
// rule (verified ancestry + merge/fast-forward) is enforced here rather than
// trusted from the backend's integration_outcome.
export function rowLanding(decision, phase) {
  const d = decision.disposition;
  if (d === 'reviewed_not_used' || d === 'superseded') return 'not_applied';
  if (d === 'pending' || !DECISIONS[d]) return 'pending';
  // used_as_is / adapted — code that intends to land
  if (phase === 'bound' || phase === 'settled') {
    const ancestry = decision.ancestry_verified
      && (decision.integration_kind === 'merge'
        || decision.integration_kind === 'fast_forward');
    return ancestry ? 'merged' : 'applied';
  }
  if (phase === 'advance_stale') return 'stale';
  if (phase === 'advance_failed') return 'failed';
  if (phase === 'abandoned') return 'not_applied';
  return 'pending';
}

// Exactly one row per experiment in the frozen corpus (the backend already
// materializes a pending decision for every corpus experiment), enriched with
// the workspace receipt and sorted into calm decision groups.
export function ledgerRows(packet, phase) {
  const byId = {};
  for (const e of packet?.experiments || []) byId[String(e.id)] = e;
  const rows = ((packet?.consolidation || {}).decisions || []).map(d => {
    const decision = DECISIONS[d.disposition] ? d.disposition : 'pending';
    const exp = byId[String(d.experiment_id)] || {};
    return {
      id: String(d.experiment_id),
      name: d.experiment_name || exp.name || String(d.experiment_id),
      decision,
      landing: rowLanding(d, phase),
      rationale: d.rationale || '',
      integrationKind: d.integration_kind || 'none',
      ancestryVerified: Boolean(d.ancestry_verified),
      sourceSha: d.source_sha || '',
      supersededBy: d.superseded_by || '',
      decidedAt: d.decided_at || '',
      workspace: exp.workspace || null,
    };
  });
  const nameOf = {};
  rows.forEach(r => { nameOf[r.id] = r.name; });
  rows.forEach(r => {
    if (r.supersededBy) r.supersededByName = nameOf[r.supersededBy] || r.supersededBy;
  });
  rows.sort((a, b) => (
    DECISIONS[a.decision].order - DECISIONS[b.decision].order
    || a.name.localeCompare(b.name)
  ));
  return rows;
}
