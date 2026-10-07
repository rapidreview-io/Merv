/**
 * A unit's history, told once by Reviews' pure rule and served by each owner: the record's own
 * process graph says who moved it and when, its reviews what each found. A submission is its
 * producer's post, the verdict that answered it the reviewer's, a return a quiet line after it,
 * and a gate still open the last line. A superseded review is no review: it never reads as in
 * review, and the claims it was asked to judge are withdrawn with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewWord, unitHistory } from '../packages/reviews/src/unit-history.js';
import { TASK_STATES, taskUnit } from '../packages/tasks/src/running.js';
import { EXPERIMENT_STATES, experimentUnit } from '../packages/experiments/src/running.js';
import { waveUnit } from '../packages/reflections/src/running.js';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
const node = (state: string, over: Record<string, unknown> = {}) => ({
  state,
  initial: false,
  terminal: false,
  current: false,
  entries: 0,
  firstEnteredAt: null,
  blockers: [],
  ...over,
});
const crossing = (revision: number, actorId: string, minute: number) => ({
  revision,
  actorId,
  requestId: `request_${revision}`,
  at: at(minute),
});
const edge = (from: string, to: string, traversals: ReturnType<typeof crossing>[] = []) => ({
  from,
  action: `${from} to ${to}`,
  to,
  traversals,
  status: null,
  tool: null,
  blockers: [],
});
const graph = (state: string, nodes: string[], edges: ReturnType<typeof edge>[]) => ({
  instanceId: 'wf_unit',
  workflow: 'test',
  version: 1,
  revision: 9,
  state,
  currentGate: state,
  terminal: false,
  nodes: nodes.map((name, index) => node(name, { initial: !index, current: name === state })),
  edges,
  dependencies: [],
});
/** A review, pinned at the revision the crossing that requested it made. */
const review = (
  id: string,
  subjectRevision: number,
  minute: number,
  over: Record<string, unknown> = {},
) =>
  ({
    id,
    subjectId: 'wf_unit',
    subjectRevision,
    artifactIds: [],
    criteria: ['One', 'Two', 'Three', 'Four'],
    formatVersion: 2 as const,
    status: 'submitted',
    reviewerId: 'actor_rex',
    claimId: null,
    verdict: 'pass',
    notes: null,
    synopsis: 'Every check was read against the pinned files.',
    findings: [],
    createdAt: at(minute),
    ...over,
  }) as never;
const finding = (criterionNumber: number, status: string) => ({
  criterionNumber,
  status,
  evidenceIds: [],
  notes: 'Noted.',
});
/** An entry as a reader meets it: who, and what was said or decided. */
const read = (entries: ReturnType<typeof unitHistory>) =>
  entries.map((entry) => [entry.role ?? 'line', entry.said ?? entry.verdict?.word]);

const EXPERIMENT = [
  'planned',
  'design_review',
  'running',
  'experiment_review',
  'failed',
  'complete',
];
const TASK = ['in_progress', 'in_review', 'failed', 'done'];

test('a design sent back and resubmitted reads as one conversation, the return between', () => {
  const returned = review('review_design_1', 1, 1, {
    verdict: 'needs_changes',
    returnTo: 'planned',
    findings: [
      finding(1, 'met'),
      finding(2, 'not_met'),
      finding(3, 'not_verified'),
      finding(4, 'waived'),
    ],
  });
  const entries = unitHistory({
    states: EXPERIMENT_STATES,
    graph: graph('complete', EXPERIMENT, [
      edge('planned', 'design_review', [crossing(1, 'actor_ada', 0), crossing(3, 'actor_ada', 20)]),
      edge('design_review', 'planned', [crossing(2, 'actor_rex', 10)]),
      edge('design_review', 'running', [crossing(4, 'actor_rex', 30)]),
      edge('running', 'experiment_review', [crossing(5, 'actor_ada', 40)]),
      edge('experiment_review', 'complete', [crossing(6, 'actor_rex', 50)]),
      edge('running', 'failed'),
    ]) as never,
    // Out of order, and with another record's review among them.
    reviews: [
      review('review_results', 5, 41),
      review('review_elsewhere', 1, 0, { subjectId: 'wf_other' }),
      returned,
      review('review_design_2', 3, 21),
    ],
  });
  assert.deepEqual(read(entries), [
    ['producer', 'Submitted the design'],
    ['reviewer', 'needs_changes'],
    ['line', 'Returned to planned'],
    ['producer', 'Submitted the design'],
    ['reviewer', 'pass'],
    ['producer', 'Submitted the results'],
    ['reviewer', 'pass'],
  ]);
  // Each verdict is the review that answered the submission before it, posted when it moved,
  // with how many checks it found met of all it judged.
  assert.deepEqual(
    entries.flatMap((entry) => (entry.verdict ? [entry.review] : [])),
    ['review_design_1', 'review_design_2', 'review_results'],
  );
  assert.deepEqual(entries[1], {
    role: 'reviewer',
    stage: 'design_review',
    actor: 'actor_rex',
    at: at(10),
    verdict: {
      word: 'needs_changes',
      met: 1,
      of: 4,
      text: 'Every check was read against the pinned files.',
    },
    review: 'review_design_1',
  });
});

const delivered = (state: string, extra: ReturnType<typeof edge>[] = []) =>
  graph(state, TASK, [
    edge('in_progress', 'in_review', [crossing(1, 'actor_ada', 0), crossing(3, 'actor_ada', 20)]),
    edge('in_review', 'in_progress', [crossing(2, 'actor_rex', 10)]),
    edge('in_review', 'done'),
    ...extra,
  ]) as never;
const sentBack = review('review_1', 1, 1, { verdict: 'needs_changes' });

test('a delivery still in review ends on the review open at its gate, as Reviews says it stands', () => {
  const open = (over: Record<string, unknown>) =>
    unitHistory({
      states: TASK_STATES,
      graph: delivered('in_review'),
      reviews: [sentBack, review('review_2', 3, 21, { verdict: null, ...over })],
    });
  assert.deepEqual(read(open({ status: 'requested', reviewerId: null })), [
    ['producer', 'Delivered'],
    ['reviewer', 'needs_changes'],
    ['line', 'Returned to in progress'],
    ['producer', 'Delivered'],
    ['reviewer', 'Review unclaimed'],
  ]);
  assert.deepEqual(open({ status: 'started', waiting: true }).at(-1), {
    role: 'reviewer',
    stage: 'in_review',
    said: 'In review',
    actor: 'actor_rex',
    review: 'review_2',
    attention: true,
  });
  // A review superseded at its gate, and no other asked yet, leaves no line open.
  assert.deepEqual(read(open({ status: 'superseded' })).at(-1), ['producer', 'Delivered']);
});

test('a review reissued at its gate replaces the one it superseded', () => {
  const entries = unitHistory({
    states: TASK_STATES,
    graph: delivered('in_review', [edge('in_review', 'in_review', [crossing(4, 'actor_ada', 25)])]),
    reviews: [
      sentBack,
      review('review_2', 3, 21, { verdict: null, status: 'superseded' }),
      review('review_3', 4, 26, { verdict: null, status: 'requested', reviewerId: null }),
    ],
  });
  assert.deepEqual(read(entries).slice(-2), [
    ['line', 'In review'],
    ['reviewer', 'Review unclaimed'],
  ]);
  assert.equal(entries.at(-1)!.review, 'review_3');
});

test('a review says one word: its verdict, in review while open, nothing once superseded', () => {
  assert.equal(reviewWord({ status: 'requested', verdict: null }), 'in_review');
  assert.equal(reviewWord({ status: 'started', verdict: null }), 'in_review');
  assert.equal(reviewWord({ status: 'submitted', verdict: 'fail' }), 'fail');
  assert.equal(reviewWord({ status: 'superseded', verdict: null }), undefined);
  assert.equal(reviewWord(undefined), undefined);
});

test('a task failed while in review reads its delivery as failed, its claims withdrawn', () => {
  const task = {
    id: 'wf_unit',
    goal: 'g',
    briefId: 'art_brief',
    acceptanceChecks: [{ number: 1, text: 'No leak' }],
    deliveryIds: ['art_report'],
    deliveryConfirmations: [{ checkNumber: 1, status: 'met', evidenceIds: [] }],
  };
  const pinned = new Map([
    ['art_report', { id: 'art_report', title: 'Delivery', mediaType: 'text/markdown' }],
  ]);
  const failed = graph('failed', TASK, [
    edge('in_progress', 'in_review', [crossing(2, 'actor_ada', 5)]),
    edge('in_review', 'failed', [crossing(3, 'actor_op', 9)]),
  ]);
  const unit = (status: string) =>
    taskUnit(
      task as never,
      (status === 'superseded' ? failed : delivered('in_review')) as never,
      [
        review('review_1', status === 'superseded' ? 2 : 3, 5, {
          status,
          verdict: null,
          artifactIds: ['art_report'],
        }),
      ],
      pinned,
    );
  // task.mark_failed supersedes the open review: no verdict, and the delivery is no longer judged.
  const superseded = unit('superseded');
  assert.equal(superseded.key?.state, 'failed');
  assert.deepEqual(superseded.checks, [{ text: 'No leak' }]);
  // While the review is open, the delivery's claims stand.
  const open = unit('requested');
  assert.equal(open.key?.state, 'in_review');
  assert.deepEqual(open.checks, [{ text: 'No leak', met: true }]);
});

const submission = (
  id: string,
  stage: 'design' | 'results',
  reviewId: string,
  attemptIndex: number,
  minute: number,
) => ({
  id,
  stage,
  reviewId,
  attemptIndex,
  createdAt: at(minute),
  evidence: [
    {
      id: `ev_${id}`,
      artifactId: `art_${id}`,
      role: stage === 'design' ? 'plan' : 'report',
      path: `${id}.md`,
      attemptIndex,
      current: true,
      figureIds: [],
    },
  ],
  figureIds: [],
});

test('an experiment ended during its results review does not read its report as in review', () => {
  const experiment = {
    id: 'wf_unit',
    intent: 'q',
    workflow: { state: 'failed' },
    attempt: { index: 1 },
    evidence: [],
    submissions: [submission('s1', 'results', 'review_1', 1, 5)],
  };
  const unit = experimentUnit(experiment as never, graph('failed', EXPERIMENT, []) as never, [
    review('review_1', 2, 5, { status: 'superseded', verdict: null }),
  ]);
  assert.equal(unit.key?.label, 'Report');
  assert.equal(unit.key?.state, undefined);
});

test('after revise_plan the current plan is the new attempt’s draft, not the last approved design', () => {
  const experiment = {
    id: 'wf_unit',
    intent: 'q',
    workflow: { state: 'planned' },
    attempt: { index: 2 },
    evidence: [
      {
        id: 'ev_draft2',
        artifactId: 'art_draft2',
        role: 'plan',
        path: 'draft2.md',
        attemptIndex: 2,
        current: true,
        figureIds: [],
      },
    ],
    submissions: [
      submission('plan1', 'design', 'review_1', 1, 1),
      submission('report1', 'results', 'review_2', 1, 5),
    ],
  };
  const unit = experimentUnit(experiment as never, graph('planned', EXPERIMENT, []) as never, [
    review('review_1', 1, 1),
    review('review_2', 2, 5, { verdict: 'needs_changes' }),
  ]);
  assert.deepEqual(unit.key, {
    label: 'Current plan',
    state: 'draft',
    artifact: { id: 'art_draft2', title: 'draft2.md' },
  });
});

const wave = (over: Record<string, unknown>) => ({
  wave: {
    id: 'wf_unit',
    workflow: { state: 'abandoned' },
    lenses: [
      { id: 'wf_lens_1', perspective: 'methods', producerId: null, artifact: null },
      { id: 'wf_lens_2', perspective: 'results', producerId: null, artifact: null },
    ],
    review: { status: 'superseded', verdict: null },
    report: { id: 'art_syn', title: 'Synthesis', mediaType: 'text/markdown' },
    changeSpec: null,
    plan: null,
    ...over,
  },
  leases: [],
  exhausted: false,
});

test('a wave abandoned in review does not read its synthesis as in review, and names its lenses', () => {
  const unit = waveUnit(
    wave({}) as never,
    graph(
      'abandoned',
      ['reflecting', 'synthesizing', 'in_review', 'approved', 'abandoned'],
      [],
    ) as never,
  );
  assert.equal(unit.key?.label, 'Synthesis');
  assert.equal(unit.key?.state, undefined);
  // Each lens is a record of its own, whose agents the wave's Agents tab lists.
  assert.deepEqual(unit.instances, ['wf_lens_1', 'wf_lens_2']);
});
