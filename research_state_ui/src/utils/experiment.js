import { fmtDuration } from './format';
import { classifyExperiment, outcomeLabel } from './evidence';

// The experiment's display identity: the short unique name (also its folder
// name under experiments/). Experiments that predate the name requirement
// fall back to their id.
export function expName(exp) {
  return (exp?.name || '').trim() || exp?.id || '';
}

// The backend's name rule for experiments and tasks alike: folder-safe,
// starts with a letter/digit, <= 48 chars.
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

/**
 * Artifacts grouped by the workflow target that owns them, keyed
 * `${target_type}:${target_id}`. Group order mirrors the workflow's gravity:
 * experiments first in the home snapshot's order, then reflections, then the
 * rest; inside a group, newest attempt first.
 */
export function groupArtifactsByTarget(artifacts, experiments) {
  const expOrder = new Map(experiments.map((e, i) => [e.id, i]));
  const groups = new Map();
  for (const a of artifacts) {
    const key = `${a.target_type}:${a.target_id}`;
    if (!groups.has(key)) groups.set(key, { target_type: a.target_type, target_id: a.target_id, rows: [] });
    groups.get(key).rows.push(a);
  }
  const rank = (g) => {
    if (g.target_type === 'experiment') return expOrder.get(g.target_id) ?? 1e6;
    if (g.target_type === 'reflection') return 2e6;
    return 3e6;
  };
  const out = Array.from(groups.values()).sort((a, b) => rank(a) - rank(b));
  for (const g of out) {
    g.rows.sort((a, b) =>
      (b.attempt_index ?? 0) - (a.attempt_index ?? 0)
      || (a.role || '').localeCompare(b.role || '')
      || (a.created_at || '').localeCompare(b.created_at || ''));
  }
  return out;
}

/**
 * The /reviews payload as the two lists both review screens show, plus the
 * submitted reviews grouped by the record they judged.
 */
export function reviewQueue(payload) {
  const openRequests = payload.requests || payload.open_requests || payload.openRequests || [];
  const submitted = payload.reviews || payload.submitted || [];
  const byTarget = new Map();
  for (const r of submitted) {
    const id = r.target_id || r.experiment_id;
    if (!byTarget.has(id)) byTarget.set(id, []);
    byTarget.get(id).push(r);
  }
  return { openRequests, submitted, byTarget };
}

/**
 * Which of an experiment's artifacts and reviews each surface shows, derived
 * once so the desktop page and the mobile page can never disagree.
 *
 * The plan falls back to the newest earlier-attempt plan when the current
 * attempt has not submitted one yet; the report never does (a prior attempt's
 * report is history, not the face of this attempt). `result` artifacts feed
 * the metrics exhibit and are deliberately not surfaced.
 */
export function experimentDocs(experiment) {
  const currentRes = (experiment.current_attempt_artifacts || [])
    .slice()
    .sort((a, b) => (a.role || '').localeCompare(b.role || ''));
  const currentIds = new Set(currentRes.map(r => r.id));
  const allReviews = (experiment.reviews || []).slice().sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || ''),
  );
  const isDesign = (r) => (r.role || '').toLowerCase().includes('design');
  return {
    currentRes,
    planRes: currentRes.find(r => r.role === 'plan')
      || (experiment.artifacts || [])
        .filter(r => r.role === 'plan')
        .sort((a, b) => (a.attempt_index ?? 0) - (b.attempt_index ?? 0))
        .pop()
      || null,
    reportRes: currentRes.find(r => r.role === 'report') || null,
    otherRes: currentRes.filter(r => !['plan', 'report', 'graph', 'result'].includes(r.role)),
    historicalRes: (experiment.artifacts || [])
      .filter(r => r.attempt_index !== experiment.attempt_index)
      .filter(r => !currentIds.has(r.id)),
    // Ascending by created_at, so the stepper reads left-to-right as a timeline.
    designReviews: allReviews.filter(isDesign),
    experimentReviews: allReviews.filter(r => !isDesign(r)),
  };
}

// Statuses where an experiment is done evolving — the figure/logic-graph
// canvases stop polling once an experiment reaches one of these.
export const TERMINAL_STATUSES = ['complete', 'failed', 'abandoned'];

// The one semantic color per experiment state, shared by every 3px index
// (mobile experiment rows, ledger timeline): orange = needs you, green =
// healthy motion/outcome, red = failed, faint = abandoned, steel = queued.
export function statusColor(status) {
  if (status === 'design_review' || status === 'experiment_review') return 'var(--active)';
  if (status === 'running' || status === 'complete') return 'var(--supports)';
  if (status === 'failed') return 'var(--refutes)';
  if (status === 'abandoned') return 'var(--faint)';
  return 'var(--steel)'; // planned / ready_to_run
}

// The one-sentence state of an experiment, shared by the mobile list rows
// and the detail page's status statement: what it's doing, and — when it
// matters — for how long or with what outcome.
export function statusLine(e, status, now) {
  switch (status) {
    case 'design_review': return 'design review · awaiting you';
    case 'experiment_review': return 'experiment review · awaiting you';
    case 'running': {
      const since = e.updated_at ? now - Date.parse(e.updated_at) : NaN;
      return Number.isFinite(since) ? `running · ${fmtDuration(since)}` : 'running';
    }
    case 'ready_to_run': return 'ready to run';
    case 'complete': {
      const outcome = classifyExperiment(e);
      return outcome === 'supports' ? 'complete · supports claim' : `complete · ${outcomeLabel(outcome)}`;
    }
    case 'failed': return 'failed';
    default: return status.replace(/_/g, ' ');
  }
}
