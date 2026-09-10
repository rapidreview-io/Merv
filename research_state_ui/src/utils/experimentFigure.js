/**
 * The experiment figure, derived from the state the experiment page already
 * fetched: every node is read off the attempt chain, the sealed submissions,
 * the artifacts, the review verdicts, the sandbox, the conclusion and the
 * tested claims, so nothing here is agent-authored.
 *
 * The spine is a timeline of beats — attempt k, its review, submission k.1,
 * its review, … conclusion, claims — and everything else is a satellite
 * naming the beat it belongs to and the side of the spine it sits on.
 *
 * `experimentFigure.test.js` is the specification: it pins the exact nodes and
 * edges for each fixture state, so read a rule off the fixtures, not off prose.
 */

// Artifact roles that read as a proposal when nothing has sealed them yet
// (legacy untyped roles remain readable on rows backfilled from the resource era).
const UPSTREAM_ROLES = new Set(['plan', 'input', 'code', 'config', 'model']);

// Per-beat, per-lane cap on individual artifact nodes. Old sandbox syncs could
// attach hundreds of files to one round.
export const ARTIFACT_FANOUT_CAP = 6;

// Which artifacts survive the cap, most load-bearing first (nearest the spine).
const ROLE_PRIORITY = { plan: 0, report: 1, result: 2, model: 3, input: 4, code: 5, config: 6, note: 7 };

const REJECTIONS = new Set(['needs_changes', 'fail']);
// The experiment lifecycle, as the attempt marker colors it (see FSMStrip).
const ATTEMPT_STATUS = {
  planned: 'pending', design_review: 'pending', running: 'active',
  experiment_review: 'active', complete: 'done', failed: 'failed', abandoned: 'abandoned',
};
const REVIEW_LABELS = {
  design_reviewer: 'Design review', experiment_reviewer: 'Experiment review',
  human: 'Human review', automated_check: 'Automated check',
};
// Seals taken by the transition into the result review gate; and the one into
// the design gate, which froze the proposal the design reviewer read.
const RESULT_SUBMISSION_TRANSITIONS = new Set(['submit_results']);
const PROPOSAL_TRANSITIONS = new Set(['submit_design']);
// A review request with no verdict yet.
const OPEN_REQUEST_STATUSES = new Set(['requested', 'started']);
// Sandbox vocabulary, which the sandbox module owns: `status` is the public
// word, `phase` the provider state behind it.
const LIVE_SANDBOX_STATUSES = new Set(['running', 'provisioning']);
const ACTIVE_SANDBOX_PHASES = new Set(['requested', 'provisioning', 'bootstrapping', 'ready', 'unknown', 'failed']);

const text = (value) => (value == null ? '' : String(value));
const roleOf = (row) => text(row.role) || 'other';
const humanize = (value) => text(value).replace(/_/g, ' ');
const orNull = (value) => (value === undefined ? null : value);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Chronological key shared by reviews and seals. `created_seq` is the
 * authoritative insertion order, with created_at and the id as tie-breakers so
 * rows that predate the column still sort deterministically. */
function seqOrder(row) {
  return [toInt(row?.created_seq), text(row?.created_at), text(row?.id)];
}
const cmpOrder = (a, b) => (a[0] - b[0]) || cmpStr(a[1], b[1]) || cmpStr(a[2], b[2]);

/** A review's attempt rides in its target snapshot id — either
 * `experiment|<id>|<status>|<attempt>|<artifacts>` or, for workflow snapshots
 * past version 1, a `workflow:` JSON blob. 0 when the id says nothing, which
 * clamps to the current attempt. */
function snapshotAttempt(snapshotId) {
  const id = text(snapshotId);
  if (id.startsWith('workflow:')) {
    try {
      return toInt(JSON.parse(id.slice('workflow:'.length)).attempt_index);
    } catch {
      return 0;
    }
  }
  return id.includes('|') ? toInt(id.split('|')[3]) : 0;
}

function artifactLabel(artifact) {
  const title = text(artifact.title).trim();
  if (title) return title;
  const segments = text(artifact.path || artifact.id || 'artifact').split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

/** The one sandbox row the figure draws: the live one if there is one, else
 * the newest. Ties keep the order the project listing gave them. */
function pickSandbox(rows) {
  const live = (row) => (ACTIVE_SANDBOX_PHASES.has(text(row.phase)) ? 1 : 0);
  return [...(rows || [])]
    .sort((a, b) => (live(b) - live(a)) || cmpStr(text(b.created_at), text(a.created_at)))[0] || null;
}

/**
 * Project one experiment's fetched state into the figure graph.
 *
 * `experiment` is the rich experiment state (the /status payload's
 * `experiment`), `reviews` the /reviews payload for it — only its open
 * requests are read, oldest first, the order the endpoint's newest-first list
 * reverses into — and `sandboxes` that experiment's sandbox rows.
 */
export function experimentFigure({ experiment, reviews, sandboxes } = {}) {
  const exp = experiment || {};
  const currentAttempt = Math.max(1, toInt(exp.attempt_index || 1, 1));
  const status = text(exp.status) || 'planned';

  const nodes = [];
  const edges = [];
  const addEdge = (from, to, type) => edges.push({ id: `${from}->${to}:${type}`, from, to, type });
  const clampAttempt = (value) => {
    const attempt = toInt(value);
    return attempt < 1 || attempt > currentAttempt ? currentAttempt : attempt;
  };

  // Round markers in temporal order, and what each one is called.
  const spine = [];
  const roundName = new Map();
  const markerAttempt = new Map();

  // ---- seals: every forward transition froze the live composition ----
  const seals = [...(exp.submissions || [])].sort((a, b) => cmpOrder(seqOrder(a), seqOrder(b)));
  const sealById = new Map(seals.map(row => [text(row.id), row]));
  const sealedAttempts = new Set(seals.map(row => clampAttempt(row.attempt_index)));
  const resultRounds = new Map();
  for (const row of seals) {
    if (!RESULT_SUBMISSION_TRANSITIONS.has(text(row.transition))) continue;
    const attempt = clampAttempt(row.attempt_index);
    if (!resultRounds.has(attempt)) resultRounds.set(attempt, []);
    resultRounds.get(attempt).push(row);
  }
  const submissionNodes = new Map();

  // ---- attempt markers + the result-submission rounds inside them ----
  for (let k = 1; k <= currentAttempt; k += 1) {
    const isCurrent = k === currentAttempt;
    const attemptId = `attempt:${k}`;
    nodes.push({
      id: attemptId, type: 'attempt', label: `Attempt ${k}`, group: attemptId,
      sublabel: isCurrent ? humanize(status) : 'superseded',
      status: isCurrent ? (ATTEMPT_STATUS[status] || 'pending') : 'superseded',
      ref: { kind: 'experiment', id: orNull(exp.id) },
    });
    spine.push(attemptId);
    roundName.set(attemptId, `attempt ${k}`);
    markerAttempt.set(attemptId, k);
    // Only result-submission seals become beats. A plan seal is already drawn
    // by the attempt marker; what has no home otherwise is the report round,
    // which is exactly what a return to running repeats without bumping the
    // attempt.
    (resultRounds.get(k) || []).forEach((row, position) => {
      const index = position + 1;
      const nodeId = `submission:${k}.${index}`;
      submissionNodes.set(text(row.id), nodeId);
      nodes.push({
        id: nodeId, type: 'submission', label: `Submission ${k}.${index}`,
        sublabel: 'results submitted', status: 'done', group: attemptId,
        ref: { kind: 'submission', id: orNull(row.id) },
        meta: { attempt_index: k, submission_index: index },
      });
      spine.push(nodeId);
      roundName.set(nodeId, `round ${k}.${index}`);
      markerAttempt.set(nodeId, k);
    });
  }

  // ---- submitted reviews, chained after the marker they graded ----
  // A review of a result submission hangs off that submission; a design review
  // (or any review predating submissions) hangs off the attempt.
  const reviewsByRoot = new Map();
  for (const review of exp.reviews || []) {
    const attempt = clampAttempt(snapshotAttempt(review.target_snapshot_id));
    const root = submissionNodes.get(text(review.submission_id)) || `attempt:${attempt}`;
    if (!reviewsByRoot.has(root)) reviewsByRoot.set(root, []);
    reviewsByRoot.get(root).push(review);
  }

  // tails[marker] = [last spine node of that round, its verdict or null]
  const tails = new Map();
  // Link a spine beat to whatever preceded it. A null verdict means the source
  // is a round marker; a rejecting verdict earns the dashed revision arrow.
  const chain = (source, verdict, target) => {
    if (verdict === null) addEdge(source, target, 'reviewed_by');
    else addEdge(source, target, REJECTIONS.has(verdict) ? 'revised_to' : 'then');
  };
  for (const root of spine) {
    const rounds = reviewsByRoot.get(root);
    if (!rounds) continue;
    rounds.sort((a, b) => cmpOrder(seqOrder(a), seqOrder(b)));
    let source = root;
    let sourceVerdict = null;
    for (const review of rounds) {
      const reviewId = text(review.id);
      const verdict = text(review.verdict);
      const nodeId = `review:${reviewId}`;
      nodes.push({
        id: nodeId, type: 'review', label: REVIEW_LABELS[text(review.role)] || 'Review',
        sublabel: humanize(verdict), status: verdict || 'open',
        group: `attempt:${markerAttempt.get(root)}`, qualifier: roundName.get(root),
        ref: { kind: 'review', id: reviewId },
        meta: { role: orNull(review.role), synopsis: review.synopsis || '', notes: review.notes || '' },
      });
      chain(source, sourceVerdict, nodeId);
      source = nodeId;
      sourceVerdict = verdict;
    }
    tails.set(root, [source, sourceVerdict]);
  }

  // ---- open review gates (requested/started, no verdict yet) ----
  // They land after the newest verdict on the round being reviewed, not back
  // on the marker.
  const currentRounds = resultRounds.get(currentAttempt) || [];
  const openRoot = currentRounds.length
    ? submissionNodes.get(text(currentRounds[currentRounds.length - 1].id))
    : `attempt:${currentAttempt}`;
  const openRequests = ((reviews && reviews.requests) || [])
    .filter(row => OPEN_REQUEST_STATUSES.has(text(row.status)))
    .reverse();
  for (const request of openRequests) {
    const nodeId = `review_request:${request.id}`;
    nodes.push({
      id: nodeId, type: 'review', label: REVIEW_LABELS[text(request.role)] || 'Review',
      sublabel: 'awaiting verdict', status: 'open',
      group: `attempt:${currentAttempt}`, qualifier: roundName.get(openRoot),
      ref: { kind: 'review_request', id: orNull(request.id) },
    });
    const [source, verdict] = tails.get(openRoot) || [openRoot, null];
    chain(source, verdict, nodeId);
    tails.set(openRoot, [nodeId, '']);
  }

  const tailOf = (marker) => tails.get(marker) || [marker, null];

  // A round wears its verdict: a submission that was sent back reads as
  // returned (amber), one that failed as failed, so the spine is honest at a
  // glance instead of every round looking like a success.
  for (const node of nodes) {
    if (node.type !== 'submission') continue;
    const verdict = tailOf(node.id)[1];
    if (verdict === 'fail') Object.assign(node, { status: 'failed', sublabel: 'failed review' });
    else if (REJECTIONS.has(verdict)) Object.assign(node, { status: 'returned', sublabel: 'sent back' });
  }

  // ---- spine succession ----
  // Two facts per step. The backbone: round j+1 followed round j (marker →
  // marker, plain `then`) — the straight line the reader follows. The verdict
  // path: the review that closed round j leads to round j+1, a rejection
  // dashed. When a round has no verdict the two coincide.
  for (let i = 0; i + 1 < spine.length; i += 1) {
    const [previous, following] = [spine[i], spine[i + 1]];
    addEdge(previous, following, 'then');
    const [source, verdict] = tailOf(previous);
    if (source !== previous) addEdge(source, following, REJECTIONS.has(verdict) ? 'revised_to' : 'then');
  }

  // ---- artifacts, one node per (artifact, attempt) association ----
  const currentIds = new Set((exp.current_attempt_artifacts || []).map(row => text(row.id)));
  const resultSealOrders = new Map([...resultRounds].map(([k, rows]) => [k, rows.map(seqOrder)]));

  /** The spine beat an unsubmitted file trails: the verdict on the last result
   * round sealed before it, else the attempt's design verdict. */
  const executionAnchor = (attempt, before) => {
    const rounds = resultRounds.get(attempt) || [];
    const orders = resultSealOrders.get(attempt) || [];
    let marker = `attempt:${attempt}`;
    for (let i = 0; i < rounds.length; i += 1) {
      if (before !== null && cmpOrder(orders[i], before) >= 0) break;
      marker = submissionNodes.get(text(rounds[i].id));
    }
    return tailOf(marker)[0];
  };

  /** [anchor, lane, marker, edgeType] for one artifact row. Evidence feeds its
   * marker (artifact → marker); execution output is produced by its attempt. */
  const place = (row) => {
    const attempt = clampAttempt(row.attempt_index);
    const attemptId = `attempt:${attempt}`;
    const seal = sealById.get(text(row.submission_id));
    if (seal) {
      const submission = submissionNodes.get(text(seal.id));
      if (submission) return [submission, 'evidence', submission, 'feeds'];
      if (PROPOSAL_TRANSITIONS.has(text(seal.transition))) return [attemptId, 'evidence', attemptId, 'feeds'];
      return [executionAnchor(attempt, seqOrder(seal)), 'execution', attemptId, 'produced'];
    }
    // Unsealed. Once this attempt has sealed anything, an unsealed row was
    // registered after that seal: work in progress trailing the latest beat.
    if (!sealedAttempts.has(attempt) && UPSTREAM_ROLES.has(roleOf(row))) {
      return [attemptId, 'evidence', attemptId, 'feeds'];
    }
    return [executionAnchor(attempt, null), 'execution', attemptId, 'produced'];
  };

  const buckets = new Map();
  const seen = new Set();
  for (const row of exp.artifacts || []) {
    const assoc = `${text(row.id)} ${clampAttempt(row.attempt_index)}`;
    if (seen.has(assoc)) continue;
    seen.add(assoc);
    const key = place(row);
    const bucketId = key.join(' ');
    if (!buckets.has(bucketId)) buckets.set(bucketId, { key, rows: [] });
    buckets.get(bucketId).rows.push(row);
  }

  // Emit in spine order so a bucket's most load-bearing file sits nearest the
  // spine and columns fill left to right. A satellite is named after the beat
  // it hangs on: a marker's round, or the round a verdict graded.
  const spineIndex = new Map(nodes.map((node, i) => [node.id, i]));
  const beatName = new Map(nodes.map(node => [node.id, roundName.get(node.id) || text(node.qualifier)]));
  const attach = (nodeId, marker, edgeType) => {
    if (edgeType === 'feeds') addEdge(nodeId, marker, edgeType);
    else addEdge(marker, nodeId, edgeType);
  };
  const ordered = [...buckets.values()].sort((a, b) =>
    (spineIndex.get(a.key[0]) ?? 0) - (spineIndex.get(b.key[0]) ?? 0)
    || cmpStr(a.key[0], b.key[0]) || cmpStr(a.key[1], b.key[1])
    || cmpStr(a.key[2], b.key[2]) || cmpStr(a.key[3], b.key[3]));

  for (const { key: [anchor, lane, marker, edgeType], rows } of ordered) {
    rows.sort((a, b) =>
      ((ROLE_PRIORITY[roleOf(a)] ?? 9) - (ROLE_PRIORITY[roleOf(b)] ?? 9))
      || cmpStr(text(a.path), text(b.path)));
    const qualifier = beatName.get(anchor) || roundName.get(marker) || '';
    const group = `attempt:${markerAttempt.get(marker) ?? currentAttempt}`;
    const overflow = rows.slice(ARTIFACT_FANOUT_CAP);
    for (const row of rows.slice(0, ARTIFACT_FANOUT_CAP)) {
      const role = roleOf(row);
      const nodeId = `artifact:${row.id}:a${clampAttempt(row.attempt_index)}`;
      const superseded = currentIds.size > 0 && !currentIds.has(text(row.id));
      nodes.push({
        id: nodeId, type: 'artifact', label: artifactLabel(row),
        sublabel: superseded ? `${role} · superseded` : role,
        status: superseded ? 'superseded' : 'none',
        group, anchor, lane, qualifier,
        ref: { kind: 'artifact', id: orNull(row.id) },
        meta: { role, path: orNull(row.path), superseded },
      });
      attach(nodeId, marker, edgeType);
    }
    if (overflow.length) {
      const roles = [...new Set(overflow.map(roleOf))].sort(cmpStr);
      const nodeId = `artifact_group:${anchor}:${lane}`;
      nodes.push({
        id: nodeId, type: 'artifact_group', label: `${overflow.length} more files`,
        sublabel: roles.join(' · '), status: 'none',
        group, anchor, lane, qualifier,
        ref: { kind: 'artifact_group', id: null },
        meta: { count: overflow.length, roles, artifact_ids: overflow.map(row => text(row.id)) },
      });
      attach(nodeId, marker, edgeType);
    }
  }

  // ---- sandbox / execution ----
  // Hangs below the beat where this attempt's execution began: its design
  // approval when there is one, else the attempt marker itself.
  const sandbox = pickSandbox(sandboxes);
  const sandboxStatus = text(sandbox && sandbox.status) || 'none';
  if (sandbox && sandboxStatus !== 'none') {
    const attemptId = `attempt:${currentAttempt}`;
    const [designTail, designVerdict] = tailOf(attemptId);
    const anchor = designVerdict === 'pass' ? designTail : attemptId;
    nodes.push({
      id: 'sandbox', type: 'sandbox', label: 'Sandbox',
      sublabel: text(sandbox.gpu || sandbox.instance_type || sandboxStatus),
      status: LIVE_SANDBOX_STATUSES.has(sandboxStatus) ? 'active' : 'done',
      group: attemptId, anchor, lane: 'execution',
      qualifier: beatName.get(anchor) || roundName.get(attemptId),
      ref: { kind: 'sandbox', id: orNull(exp.id) },
      meta: { sandbox_status: sandboxStatus },
    });
    addEdge(attemptId, 'sandbox', 'ran_on');
  }

  // ---- conclusion + tested claims, after the final beat ----
  const endSource = tailOf(spine[spine.length - 1])[0];
  const conclusion = text(exp.conclusion).trim();
  let claimSource = endSource;
  if (conclusion) {
    nodes.push({
      id: 'conclusion', type: 'conclusion', label: 'Conclusion', sublabel: conclusion,
      status: 'done', group: `attempt:${currentAttempt}`,
      ref: { kind: 'experiment', id: orNull(exp.id) },
    });
    addEdge(endSource, 'conclusion', 'concludes');
    claimSource = 'conclusion';
  }
  // The beat that is "now" — the reader's reference point.
  const currentBeat = nodes.find(node => node.id === claimSource);
  if (currentBeat) currentBeat.current = true;
  for (const claim of exp.tested_claims || []) {
    const nodeId = `claim:${claim.id}`;
    nodes.push({
      id: nodeId, type: 'claim', label: text(claim.statement || claim.id),
      sublabel: humanize(claim.status), status: text(claim.status) || 'active',
      ref: { kind: 'claim', id: orNull(claim.id) },
    });
    addEdge(claimSource, nodeId, 'tests');
  }

  return { nodes, edges };
}
