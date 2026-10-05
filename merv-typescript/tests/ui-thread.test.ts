/**
 * A loop read as a thread. The record's own process graph says who moved it and when;
 * its reviews say what each review found. A submission is its producer's post, the
 * verdict that answered it the reviewer's, a return a quiet line after it, and a gate
 * still open the last line — with no number, no id and nothing made up in between.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mount, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { Thread, threadOf } = await import('../packages/ui/web/thread.js');

const BRIEF = 'art_00000000000000000000000000000001';
const FIRST = 'art_00000000000000000000000000000002';
const SECOND = 'art_00000000000000000000000000000003';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();
const names: Record<string, string> = { actor_ada: 'Ada Byron', actor_rex: 'Rex Reviewer' };
const nameOf = (id: string | null | undefined) => names[id ?? ''];
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
) => ({
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
});
const finding = (criterionNumber: number, status: string) => ({
  criterionNumber,
  status,
  evidenceIds: [],
  notes: 'Noted.',
});
/** An entry as a reader meets it: its kind, then who and what, or the line's words. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (entries: any[]) =>
  entries.map((entry) =>
    entry.kind === 'post'
      ? [entry.role, entry.who, entry.said ?? entry.review?.verdict, entry.files ?? null]
      : ['line', entry.said, entry.review ?? null],
  );

const EXPERIMENT = [
  'planned',
  'design_review',
  'running',
  'experiment_review',
  'failed',
  'complete',
];

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
  const entries = threadOf({
    graph: graph('complete', EXPERIMENT, [
      edge('planned', 'design_review', [crossing(1, 'actor_ada', 0), crossing(3, 'actor_ada', 20)]),
      edge('design_review', 'planned', [crossing(2, 'actor_rex', 10)]),
      edge('design_review', 'running', [crossing(4, 'actor_rex', 30)]),
      edge('running', 'experiment_review', [crossing(5, 'actor_ada', 40)]),
      edge('experiment_review', 'complete', [crossing(6, 'actor_rex', 50)]),
      edge('running', 'failed'),
    ]),
    // Out of order, and with another record's review among them.
    reviews: [
      review('review_results', 5, 41),
      review('review_elsewhere', 1, 0, { subjectId: 'wf_other' }),
      returned,
      review('review_design_2', 3, 21),
    ],
    subject: 'wf_unit',
    nameOf,
  });
  assert.deepEqual(read(entries), [
    ['Producer', 'Ada Byron', 'Submitted the design', null],
    ['Reviewer', 'Rex Reviewer', 'needs_changes', null],
    ['line', 'Returned to planned', null],
    ['Producer', 'Ada Byron', 'Submitted the design', null],
    ['Reviewer', 'Rex Reviewer', 'pass', null],
    ['Producer', 'Ada Byron', 'Submitted the results', null],
    ['Reviewer', 'Rex Reviewer', 'pass', null],
  ]);
  // Each verdict is the review that answered the submission before it, posted when it moved.
  assert.deepEqual(
    entries.flatMap((entry) => (entry.kind === 'post' && entry.review ? [entry.review.id] : [])),
    ['review_design_1', 'review_design_2', 'review_results'],
  );
  assert.equal(entries[1]!.kind === 'post' && entries[1]!.at, at(10));
});

const TASK = ['in_progress', 'in_review', 'failed', 'done'];
const delivered = (state: string, extra: ReturnType<typeof edge>[] = []) =>
  graph(state, TASK, [
    edge('in_progress', 'in_review', [crossing(1, 'actor_ada', 0), crossing(3, 'actor_ada', 20)]),
    edge('in_review', 'in_progress', [crossing(2, 'actor_rex', 10)]),
    edge('in_review', 'done'),
    ...extra,
  ]);
const sentBack = review('review_1', 1, 1, {
  verdict: 'needs_changes',
  artifactIds: [BRIEF, FIRST],
  synopsis: null,
  notes: 'The curve is there; the seed is not.',
  // A check that could not be verified was not met either.
  findings: [finding(1, 'met'), finding(2, 'not_met'), finding(3, 'not_verified')],
});

test('a delivery still in review ends the thread on the review open at its gate', () => {
  const open = (over: Record<string, unknown>) =>
    threadOf({
      graph: delivered('in_review'),
      reviews: [
        sentBack,
        review('review_2', 3, 21, { artifactIds: [BRIEF, FIRST, SECOND], verdict: null, ...over }),
      ],
      subject: 'wf_unit',
      briefId: BRIEF,
      nameOf,
    });
  // Each delivery carries what its round pinned, less the brief every round pins.
  assert.deepEqual(read(open({ status: 'requested', reviewerId: null })), [
    ['Producer', 'Ada Byron', 'Delivered', [FIRST]],
    ['Reviewer', 'Rex Reviewer', 'needs_changes', null],
    ['line', 'Returned to in progress', null],
    ['Producer', 'Ada Byron', 'Delivered', [FIRST, SECOND]],
    ['line', 'Review unclaimed', 'review_2'],
  ]);
  assert.deepEqual(read(open({ status: 'started' })).at(-1), [
    'line',
    'In review with Rex Reviewer',
    'review_2',
  ]);
  assert.deepEqual(read(open({ status: 'started', reviewerId: 'actor_nobody' })).at(-1), [
    'line',
    'Review claimed',
    'review_2',
  ]);
});

test('a review reissued at its gate replaces the one it superseded', () => {
  const entries = threadOf({
    graph: delivered('in_review', [edge('in_review', 'in_review', [crossing(4, 'actor_ada', 25)])]),
    reviews: [
      sentBack,
      review('review_2', 3, 21, { verdict: null, status: 'superseded' }),
      review('review_3', 4, 26, { verdict: null, status: 'requested', reviewerId: null }),
    ],
    subject: 'wf_unit',
    briefId: BRIEF,
    nameOf,
  });
  assert.deepEqual(read(entries).slice(-2), [
    ['line', 'In review', null],
    ['line', 'Review unclaimed', 'review_3'],
  ]);
});

test('without a process graph the reviews alone are the thread', () => {
  const entries = threadOf({
    reviews: [review('review_2', 3, 21, { verdict: null, status: 'requested' }), sentBack],
    subject: 'wf_unit',
    nameOf,
  });
  assert.deepEqual(read(entries), [
    ['Reviewer', 'Rex Reviewer', 'needs_changes', null],
    ['line', 'Review unclaimed', 'review_2'],
  ]);
  assert.equal(entries[0]!.kind === 'post' && entries[0]!.at, sentBack.createdAt);
});

test('a thread is read in words: the role alone for a stranger, files to open, no ids', async (t) => {
  t.after(async () => await unmount());
  // A review opens at the reviews row's page, where the composition has one.
  serve('/tools/ui.shell', {
    body: { result: { rows: [{ id: 'reviews', path: '/reviews', view: { kind: 'reviews' } }] } },
  });
  serve('/tools/artifact.list', {
    body: {
      result: [FIRST, SECOND].map((id, index) => ({
        id,
        projectId: 'project_1',
        createdBy: 'actor_stranger',
        title: index ? 'Delivery: second try' : 'Delivery: first try',
        mediaType: 'text/markdown',
        hash: 'abc',
        size: 120,
        createdAt: at(0),
      })),
    },
  });
  const graphed = delivered('in_review');
  graphed.edges[0]!.traversals = graphed.edges[0]!.traversals.map((step) => ({
    ...step,
    actorId: 'actor_stranger',
  }));
  const entries = threadOf({
    graph: graphed,
    reviews: [sentBack, review('review_2', 3, 21, { verdict: null, status: 'requested' })],
    subject: 'wf_unit',
    briefId: BRIEF,
    nameOf,
  });
  await mount(createElement(MemoryRouter, null, createElement(Thread, { entries })));
  const posts = [...document.querySelectorAll('.thread > li:not(.feed-line)')];
  // Nobody the reader can name is a disc with a dot, and the part they played.
  assert.equal(posts[0]!.querySelector('.feed-avatar')?.textContent, '·');
  assert.deepEqual(
    [...posts[0]!.querySelectorAll('.feed-author, .thread-role')].map((said) => said.textContent),
    ['Producer'],
  );
  // The earlier delivery still opens from its own post.
  assert.match(posts[0]!.querySelector('details.crit-file summary')!.textContent!, /first try/);
  assert.deepEqual(
    [...posts[1]!.querySelectorAll('.feed-author, .thread-role')].map((said) => said.textContent),
    ['Rex Reviewer', 'Reviewer'],
  );
  // A verdict is its word, what it found short, its sentence — the notes, wanting a
  // synopsis — and the way to it.
  assert.deepEqual(
    [...posts[1]!.querySelectorAll('.thread-body > p')].map((said) => said.textContent),
    ['needs changes2 of 3 not met', 'The curve is there; the seed is not.', 'Open the review '],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.thread a.hit')].map((link) => link.getAttribute('href')),
    ['/reviews/review_1', '/reviews/review_2'],
  );
  assert.deepEqual(
    [...document.querySelectorAll('.feed-said')].map((line) => line.textContent),
    ['Returned to in progress', 'Review unclaimed'],
  );
  assert.doesNotMatch(text(), /review_|art_|wf_|actor_|round|attempt/i, 'no id and no number');
});
