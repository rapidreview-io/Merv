/**
 * Home and Now. Each test states one thing the two pages must do for a person:
 * say a move in a sentence of their own rather than the agent's instruction, keep
 * the ordering policy while doing it, put the control on the card, agree a word
 * with its number, and draw relations where a verb can never sit on a record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { StandingLine, recordSentence, reviewSentence, standingOf } =
  await import('../packages/ui/web/views/overview.js');
const { CARD_H, graphOf, inFlightFirst, layoutOf, plural, share, verdictWord } =
  await import('../packages/ui/web/views/map-data.js');
const { Graph } = await import('../packages/ui/web/views/map.js');

const row = (kind: string) => ({
  id: kind,
  label: kind,
  group: 'work',
  order: 1,
  path: `/${kind}`,
  view: { kind },
  status: {},
  readable: true,
});
const rows = ['tasks', 'experiments', 'research', 'reviews', 'paper'].map(row);
const me = { id: 'actor_me', role: 'operator' };
const names: Record<string, string> = {
  actor_me: 'Me',
  actor_ada: 'Ada',
  actor_bot: 'Sweep agent',
};
const named = (id: string | null | undefined) => (id ? names[id] : undefined);

const INSTRUCTION =
  'Read the task context and inspect any completed prerequisites through their referenced records.';
const INPUT =
  'Supply artifactIds, confirmations and a stable requestId when calling task.submit_delivery.';
const flow = (state: string, updatedAt = '2026-09-20T10:00:00.000Z') => ({ state, updatedAt });
const task = (id: string, producerId: string, state = 'in_progress') => ({
  id,
  title: `Task ${id}`,
  goal: '',
  producerId,
  acceptanceChecks: [],
  deliveryIds: [],
  dependencies: [],
  workflow: flow(state),
});
/** A gate as workflow.status_and_next answers it, with only what the page reads filled in. */
const gate = (instanceId: string, over: Record<string, unknown> = {}) => ({
  instanceId,
  workflow: 'task',
  version: 2,
  state: 'in_progress',
  revision: 0,
  label: instanceId,
  terminal: false,
  available: true,
  currentGate: 'delivery_required',
  nextAction: null,
  instruction: INSTRUCTION,
  actions: [],
  blockers: [],
  references: [],
  dependencies: [],
  workStart: null,
  ...over,
});
const blocker = (code: string, message = code) => ({ code, message, status: 400 });
const dependency = (name: string, over: Record<string, unknown> = {}) => ({
  id: name,
  workflow: 'task',
  version: 2,
  name,
  state: 'in_progress',
  settled: false,
  failed: false,
  ...over,
});
const home = (over: Record<string, unknown>) => ({
  project: null,
  actors: null,
  experiments: null,
  tasks: null,
  reviews: null,
  cycles: null,
  files: null,
  posts: null,
  workflows: null,
  reflections: null,
  paper: null,
  sessions: null,
  connections: null,
  archive: null,
  ...over,
});

test('a move is one sentence made from the gate’s facts, never the agent’s instruction', () => {
  const ready = (action: string) => ({ nextAction: { action }, dependencies: [] });
  assert.equal(recordSentence('yours', ready('submit_delivery')), 'Deliver the work for review');
  assert.equal(recordSentence('yours', ready('submit_design')), 'Submit the design for review');
  assert.equal(recordSentence('yours', ready('submit_results')), 'Submit the results for review');
  assert.equal(recordSentence('yours', ready('an_action_nobody_named')), 'Needs your input');
  assert.equal(
    recordSentence('yours', {
      nextAction: { action: 'end' },
      dependencies: [dependency('Baseline run', { failed: true, state: 'failed' })],
    }),
    'Decide what happens next: Baseline run failed',
  );

  const idle = { nextAction: null, dependencies: [] };
  assert.equal(recordSentence('agent', idle, 'Sweep agent'), 'With Sweep agent');
  assert.equal(recordSentence('agent', idle), 'With its owner');
  // Work that is out for review is not in its owner's hands, whoever began it.
  const out = (currentGate: string) => ({ ...idle, currentGate });
  assert.equal(recordSentence('agent', out('review_required'), 'Ada'), 'Waiting for a reviewer');
  assert.equal(recordSentence('agent', out('independent_review'), 'Ada'), 'In review');
  assert.equal(recordSentence('agent', out('delivery_required'), 'Ada'), 'With Ada');

  const waits = (...list: string[]) => ({
    nextAction: null,
    dependencies: [
      dependency('Settled', { settled: true }),
      ...list.map((name) => dependency(name)),
    ],
  });
  assert.equal(recordSentence('nobody', waits('Baseline run')), 'Waiting on Baseline run');
  assert.equal(recordSentence('nobody', waits('A', 'B')), 'Waiting on A and B');
  assert.equal(recordSentence('nobody', waits('A', 'B', 'C', 'D')), 'Waiting on A, B and 2 more');
  assert.equal(recordSentence('nobody', idle), 'Waiting on earlier work');

  // A gate the page cannot read says the server's own reason, and only waits without one.
  assert.equal(recordSentence('unknown', idle), 'Waiting');
  assert.equal(
    recordSentence('unknown', { ...idle, blockers: [{ message: 'Fill the problem first' }] }),
    'Fill the problem first',
  );
  // Work out for review reads as that whichever code its gate refuses with.
  assert.equal(recordSentence('unknown', out('independent_review')), 'In review');
  // Work a review sent back says so, in the ask's own words.
  assert.equal(
    recordSentence('yours', ready('submit_delivery'), undefined, true),
    'Changes requested: deliver the work for review',
  );
  assert.equal(
    recordSentence('unknown', {
      nextAction: null,
      dependencies: [dependency('Baseline run', { failed: true, state: 'failed' })],
    }),
    'Stopped: Baseline run failed',
  );

  assert.equal(reviewSentence('open', 'in_review'), 'Review this delivery');
  assert.equal(reviewSentence('open', 'design_review'), 'Review this design');
  assert.equal(reviewSentence('open', 'experiment_review'), 'Review these results');
  assert.equal(reviewSentence('open'), 'Review this work');
  assert.equal(reviewSentence('yours', 'in_review'), 'Finish your review');
  assert.equal(reviewSentence('unclaimed', 'in_review'), 'Waiting for a reviewer');
  assert.equal(reviewSentence('theirs', 'in_review', 'Ada'), 'In review with Ada');
  assert.equal(reviewSentence('theirs'), 'In review');
});

test('the ordering policy holds: four codes, and an unknown one is never promoted', () => {
  const data = home({
    tasks: [
      task('wf_mine', me.id),
      task('wf_theirs', 'actor_ada'),
      task('wf_waits', 'actor_ada'),
      task('wf_odd', me.id),
      task('wf_running', me.id),
      task('wf_done', me.id, 'done'),
    ],
    workflows: {
      workflows: [
        gate('wf_mine', {
          nextAction: {
            action: 'submit_delivery',
            tool: 'task.submit_delivery',
            status: 'needs_input',
          },
          blockers: [blocker('input_required', INPUT)],
        }),
        gate('wf_theirs', {
          blockers: [blocker('forbidden', 'Only this task’s producer may submit its delivery')],
          workStart: { actorId: 'actor_bot' },
        }),
        gate('wf_waits', {
          blockers: [blocker('dependencies_pending')],
          dependencies: [dependency('Task wf_theirs')],
        }),
        gate('wf_odd', { blockers: [blocker('a_code_from_next_year', 'Something new')] }),
        gate('wf_running'),
        gate('wf_done', { terminal: true, blockers: [blocker('input_required')] }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, me, named);
  const read = (bucket: keyof typeof lines) =>
    lines[bucket].map((line: { id: string; sentence: string }) => [line.id, line.sentence]);
  assert.deepEqual(read('yours'), [['wf_mine', 'Deliver the work for review']]);
  // Whoever began the step holds it, ahead of the producer the task was written for.
  assert.deepEqual(read('agent'), [['wf_theirs', 'With Sweep agent']]);
  assert.deepEqual(read('nobody'), [['wf_waits', 'Waiting on Task wf_theirs']]);
  assert.deepEqual(
    read('unknown'),
    [['wf_odd', 'Something new']],
    'mine, and still not “needs you”',
  );

  // The server’s words are kept whole for whoever operates the agents, and only there.
  assert.deepEqual(lines.yours[0].says, [INSTRUCTION, INPUT]);
  // The reason that became the headline is not said again in the fold.
  assert.deepEqual(lines.unknown[0].says, [INSTRUCTION]);
  assert.ok(!lines.yours[0].sentence.includes('artifactIds'));

  // A card carries a control only where a page of this app makes the move: a delivery
  // has its desk on the task's own page, and nothing that is not the reader's has one.
  assert.deepEqual(lines.yours[0].desk, {
    label: 'Submit delivery',
    to: '/tasks/wf_mine#deliver',
  });
  for (const other of [...lines.agent, ...lines.nobody, ...lines.unknown])
    assert.equal(other.desk, undefined);
});

test('work whose delivery waits on the reader is theirs even when its gate reports no blocker', () => {
  // Sent back for changes, or never begun: only `begin` is ready and nothing blocks.
  const waiting = {
    nextAction: { action: 'begin', tool: 'workflow.begin', status: 'ready' },
    actions: [
      { action: 'begin', tool: 'workflow.begin', status: 'ready' },
      { action: 'submit_delivery', tool: 'task.submit_delivery', status: 'needs_input' },
    ],
  };
  const data = home({
    tasks: [
      task('wf_returned', me.id),
      task('wf_fresh', me.id),
      task('wf_held', me.id),
      task('wf_theirs', 'actor_ada'),
      task('wf_out', me.id, 'in_review'),
    ],
    workflows: {
      workflows: [
        gate('wf_returned', waiting),
        gate('wf_fresh', waiting),
        gate('wf_held', { ...waiting, workStart: { actorId: 'actor_bot' } }),
        gate('wf_theirs', waiting),
        gate('wf_out', {
          currentGate: 'independent_review',
          blockers: [blocker('review_independence', 'A producer may not review their own work')],
        }),
      ],
    },
    reviews: [
      {
        id: 'review_old',
        subjectId: 'wf_returned',
        status: 'submitted',
        reviewerId: 'actor_ada',
        verdict: 'needs_changes',
        createdAt: '2026-09-20T09:00:00.000Z',
      },
      {
        id: 'review_open',
        subjectId: 'wf_out',
        status: 'started',
        reviewerId: 'actor_ada',
        verdict: null,
        createdAt: '2026-09-20T11:00:00.000Z',
      },
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, me, named);
  const yours = Object.fromEntries(
    lines.yours.map((line: { id: string; sentence: string }) => [line.id, line]),
  );
  assert.deepEqual(Object.keys(yours).sort(), ['wf_fresh', 'wf_returned']);
  assert.equal(yours.wf_returned.sentence, 'Changes requested: deliver the work for review');
  assert.equal(yours.wf_fresh.sentence, 'Deliver the work for review');
  assert.deepEqual(yours.wf_returned.desk, {
    label: 'Submit delivery',
    to: '/tasks/wf_returned#deliver',
  });
  // Work an agent began, and work that is another's, stay off the list while they run.
  const all = [...lines.yours, ...lines.agent, ...lines.nobody, ...lines.unknown];
  const ids = all.map((line: { id: string }) => line.id);
  assert.ok(!ids.includes('wf_held') && !ids.includes('wf_theirs'));
  // A record out for review is listed once, as its review.
  assert.ok(!ids.includes('wf_out'), 'not as itself');
  assert.deepEqual(
    lines.agent.map((line: { id: string; sentence: string }) => [line.id, line.sentence]),
    [['review_open', 'In review with Ada']],
  );
});

test('a review is yours when the server says so and its gate lets you claim it, and claimed here only then', () => {
  const review = (id: string, subjectId: string, over: Record<string, unknown> = {}) => ({
    id,
    subjectId,
    status: 'requested',
    reviewerId: null,
    claimable: false,
    verdict: null,
    createdAt: '2026-09-20T11:00:00.000Z',
    ...over,
  });
  const start = (status: string) => ({
    state: 'in_review',
    actions: [{ action: 'start_review', tool: 'review.start', status }],
  });
  const data = home({
    tasks: ['wf_a', 'wf_b', 'wf_c', 'wf_d', 'wf_e'].map((id) => task(id, 'actor_ada', 'in_review')),
    workflows: {
      workflows: [
        gate('wf_a', start('ready')),
        gate('wf_b', start('blocked')),
        gate('wf_c', start('blocked')),
        gate('wf_d', start('blocked')),
        gate('wf_e', start('blocked')),
      ],
    },
    reviews: [
      review('review_a', 'wf_a', { claimable: true }),
      review('review_b', 'wf_b', { claimable: true }),
      review('review_c', 'wf_c'),
      review('review_d', 'wf_d', { status: 'started', reviewerId: me.id }),
      review('review_e', 'wf_e', { status: 'started', reviewerId: 'actor_ada' }),
      review('review_f', 'wf_a', { status: 'submitted', verdict: 'pass' }),
    ],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, me, named);
  const byId = Object.fromEntries(
    [...lines.yours, ...lines.agent].map((line: { id: string }) => [line.id, line]),
  );
  assert.deepEqual(lines.yours.map((line: { id: string }) => line.id).sort(), [
    'review_a',
    'review_d',
  ]);
  assert.equal(byId.review_a.sentence, 'Review this delivery');
  assert.equal(byId.review_a.who, 'Ada', 'whose work it is');
  assert.equal(byId.review_a.claim, 'review_a');
  // A review the server would let this reader claim, but whose gate refuses the claim, is not
  // the reader's move: a Git task's review waits for a leased reviewer (C2).
  assert.equal(byId.review_b.sentence, 'Waiting for a reviewer');
  assert.equal(byId.review_b.claim, undefined, 'a gate that is not ready offers no claim here');
  assert.equal(byId.review_d.sentence, 'Finish your review');
  assert.equal(byId.review_d.claim, undefined);
  assert.equal(byId.review_c.sentence, 'Waiting for a reviewer');
  assert.equal(byId.review_e.sentence, 'In review with Ada');
  assert.equal(byId.review_f, undefined, 'a review that is over is on no list');
});

const line = (over: Record<string, unknown>) => ({
  id: 'wf_1',
  kind: 'tasks',
  name: 'Check training configuration',
  to: '/tasks/wf_1',
  at: new Date().toISOString(),
  mine: true,
  sentence: 'Deliver the work for review',
  says: [INSTRUCTION, INPUT],
  ...over,
});
const standing = (lines: Record<string, unknown[]>, data: unknown = {}) =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/now'] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/now',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        element: createElement(StandingLine as any, {
          rows,
          lines: { yours: [], agent: [], nobody: [], unknown: [], ...lines },
          load: { loading: false, error: undefined, data, loadedAt: undefined },
        }),
      }),
      createElement(Route, {
        path: '/reviews/:id',
        element: createElement('p', null, 'The verdict desk'),
      }),
    ),
  );

test('a needs-you card reads kind, name, sentence, who and when, and carries its control', async (t) => {
  t.after(async () => await unmount());
  await mount(
    standing({
      yours: [
        line({ desk: { label: 'Submit delivery', to: '/tasks/wf_1#deliver' } }),
        line({ id: 'wf_3', kind: 'experiments', sentence: 'Submit the design for review' }),
      ],
      agent: [line({ id: 'wf_2', name: 'Sweep', sentence: 'With Sweep agent', mine: false })],
    }),
  );
  const [yours, undoable, agents] = [...document.querySelectorAll('.ov-row')];
  assert.deepEqual(
    [...yours.querySelectorAll('.kind, .ov-name, .ov-say, .ov-meta time')].map(
      (node) => node.textContent,
    ),
    ['Task', 'Check training configuration', 'Deliver the work for review', 'just now'],
  );
  // The control goes to the desk where the move is made, which the name beside it does not.
  const open = yours.querySelector<HTMLAnchorElement>('a.btn--primary')!;
  assert.equal(open.textContent?.trim(), 'Submit delivery');
  assert.equal(open.getAttribute('href'), '/tasks/wf_1#deliver');
  assert.equal(
    undoable.querySelector('.btn'),
    null,
    'a move no page can make offers no control: the name is already the way to the record',
  );
  assert.equal(agents.querySelector('.btn'), null, 'a card that is not your move has no control');

  // The server’s instruction stays on the card for the curious, folded and never the headline.
  const said = yours.querySelector('details')!;
  assert.equal(said.open, false);
  assert.equal(said.querySelector('summary')!.textContent, 'Agent instructions');
  assert.ok(said.textContent!.includes(INPUT));
  assert.ok(!yours.querySelector('.ov-say')!.textContent!.includes('requestId'));
});

test('a review that is ready is claimed where it stands, and the page opens its desk', async (t) => {
  t.after(async () => await unmount());
  serve('/tools/review.start', { body: { result: { id: 'review_1', status: 'started' } } });
  await mount(
    standing({
      yours: [
        line({
          id: 'review_1',
          kind: 'reviews',
          to: '/reviews/review_1',
          sentence: 'Review this delivery',
          who: 'Ada',
          says: [],
          claim: 'review_1',
        }),
      ],
    }),
  );
  assert.equal(document.querySelector('.ov-meta')!.textContent, 'Adajust now');
  assert.equal(document.querySelector('details'), null, 'nothing was said, so nothing is folded');
  await click('Claim review');
  assert.ok(requests.includes('POST /tools/review.start'));
  assert.equal(text(), 'The verdict desk');
});

test('with nothing to do the page says so once, and an unwell row still needs someone', async (t) => {
  t.after(async () => await unmount());
  await mount(standing({}));
  assert.equal(document.querySelector('.empty-title')!.textContent, 'Nothing needs you');
  assert.ok(!text().includes('Needs you'));
  await unmount();

  rows[0].status = { state: 'degraded', detail: 'The task store is read-only' } as never;
  t.after(() => (rows[0].status = {}));
  await mount(standing({}));
  assert.equal(document.querySelector('.empty-state'), null);
  assert.ok(text().includes('The task store is read-only'));
});

test('a word agrees with its number, a whole is said once, and a verdict is what happened', () => {
  assert.equal(plural(1, 'Review', 'Reviews'), 'Review');
  assert.equal(plural(0, 'Review', 'Reviews'), 'Reviews');
  assert.equal(plural(2, 'Review', 'Reviews'), 'Reviews');
  assert.equal(plural(undefined, 'File', 'Files'), 'Files', 'a count not yet read is many');
  assert.equal(share(2, 2), '2');
  assert.equal(share(1, 2), '1/2');
  assert.equal(share(0, 0), '0');
  assert.equal(verdictWord('pass'), 'passed');
  assert.equal(verdictWord('fail'), 'failed');
  assert.equal(verdictWord('needs_changes'), 'asked for changes');
  assert.equal(verdictWord('something_else'), 'something else');
});

const graph = () =>
  graphOf(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows as any,
    {
      experiments: [
        {
          id: 'wf_exp',
          name: 'decay-sweep',
          intent: '',
          ownerId: 'actor_ada',
          workflow: flow('planned', '2026-09-20T09:30:00.000Z'),
        },
      ],
      tasks: [
        {
          ...task('wf_done', 'actor_ada', 'done'),
          workflow: flow('done', '2026-09-20T12:00:00.000Z'),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          ...task('wf_open', 'actor_ada'),
          dependencies: [dependency('wf_done', { id: 'wf_done' })] as any,
        },
      ],
      reviews: [
        {
          id: 'review_1',
          subjectId: 'wf_done',
          status: 'submitted',
          reviewerId: 'actor_me',
          verdict: 'pass',
          createdAt: '2026-09-20T12:30:00.000Z',
        },
      ],
      reflections: [],
      paper: {
        documents: {
          results: {
            current: {
              revision: 1,
              sections: [{ content: 'Retrieval findings' }],
              updatedAt: '2026-09-20T10:00:00.000Z',
            },
            published: { publication: { source: { id: 'wf_exp' } } },
          },
        },
      },
    },
    named,
  );

test('the graph is anchored to the page, and a verb is never written on a record', () => {
  const { pool, edges } = graph();
  // A review is never an object of the chart: it is a fact on the card of the work it judged.
  assert.equal(
    pool.find((node) => node.kind === 'reviews'),
    undefined,
  );
  assert.ok(
    pool.find((node) => node.id === 'wf_done')!.props.some(([label]) => label === 'Review'),
  );
  assert.ok(!edges.some((edge) => edge.verb === 'reviewed by'));
  const nodes = [0, 1, 2, 3].flatMap((col) =>
    inFlightFirst(pool.filter((node) => node.col === col)),
  );
  assert.deepEqual(
    nodes.filter((node) => node.col === 1).map((node) => node.id),
    ['wf_open', 'wf_exp', 'wf_done'],
    'what is in flight leads its column, newest first, then what has ended',
  );

  assert.equal(layoutOf(nodes, edges, 390), null, 'too narrow to draw: the list says it in words');
  const lone = nodes.filter((node) => node.col === 1);
  assert.equal(layoutOf(lone, [], 1072), null, 'one column of records has nothing to draw between');

  const layout = layoutOf(nodes, edges, 1072)!;
  const xs = layout.columns.map((column) => column.x);
  assert.equal(xs[0], 0, 'the first column stands on the page’s left edge');
  assert.equal(xs.at(-1)! + layout.card, 1072, 'and the last on its right: no dead field');
  assert.equal(layout.columns.length, 2, 'a column with no record is not laid out');

  // A record stands level with what it is related to, so that line is straight.
  const y = (id: string) => layout.at.get(id)!.y;
  assert.equal(y('wf_exp'), y('paper:results'));
  assert.deepEqual(layout.lines.map((item) => item.edge.verb).sort(), ['cites', 'depends on']);

  // Every verb is written in the room between two columns, clear of every card.
  for (const { x, y: at, anchor, edge } of layout.lines) {
    const wide = edge.verb.length * 6.5;
    const [left, right] =
      anchor === 'middle'
        ? [x - wide / 2, x + wide / 2]
        : anchor === 'start'
          ? [x, x + wide]
          : [x - wide, x];
    for (const node of nodes) {
      const card = layout.at.get(node.id)!;
      const over =
        right > card.x && left < card.x + layout.card && at > card.y && at < card.y + CARD_H;
      assert.ok(!over, `“${edge.verb}” is written over ${node.id}`);
    }
  }
});

test('a line past a column runs between the rows, and two verbs in one gap never share a line', () => {
  const node = (id: string, col: number) => ({
    id,
    kind: 'tasks',
    name: id,
    to: `/tasks/${id}`,
    at: '2026-09-20T10:00:00.000Z',
    col,
    state: 'done',
    live: false,
    props: [],
  });
  const nodes = [node('claim', 0), node('first', 1), node('second', 1), node('review', 3)];
  const edges = [
    { from: 'claim', to: 'review', verb: 'cites' },
    { from: 'first', to: 'review', verb: 'reviewed by' },
    { from: 'first', to: 'review', verb: 'depends on' },
  ];
  const layout = layoutOf(nodes, edges, 1072)!;
  assert.equal(layout.columns.length, 3);

  // The long line's level run is the one `L` of its path: it lies in no card's rows.
  const long = layout.lines.find((line) => line.edge.verb === 'cites')!;
  const lane = Number(/ L [\d.-]+ ([\d.-]+) /.exec(long.d)![1]);
  for (const item of nodes) {
    const card = layout.at.get(item.id)!;
    assert.ok(lane <= card.y || lane >= card.y + CARD_H, `the lane crosses ${item.id}`);
  }

  // Two relations between the same two records would write their verbs on one spot.
  const [one, other] = layout.lines.filter((line) => line.edge.from === 'first');
  assert.equal(one!.x, other!.x);
  assert.ok(Math.abs(one!.y - other!.y) >= 14, 'the second verb steps down a line');
});

test('with no room to draw a line, a record says what it points at in words', async (t) => {
  t.after(async () => await unmount());
  const { pool, edges } = graph();
  await mount(
    createElement(
      MemoryRouter,
      null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createElement(Graph as any, {
        nodes: pool,
        edges,
        more: [{ col: 1, count: 3, noun: 'work', to: '/work' }],
        selected: null,
        onSelect() {},
      }),
    ),
  );
  assert.equal(document.querySelector('svg.map-edges'), null);
  const card = document.querySelector('[data-object="paper:results"]')!;
  assert.equal(card.querySelector('.map-rel')!.textContent, 'cites Experiment decay-sweep');
  assert.equal(card.getAttribute('aria-pressed'), 'false');
  const more = document.querySelector<HTMLAnchorElement>('.map-more a')!;
  assert.equal(more.textContent, '+3 more work');
  assert.equal(more.getAttribute('href'), '/work');
});

test('a Code blocker whose next move is a person’s stands on Now, in the person’s words', () => {
  // Exactly what a real project serves: the task has ended, and the only opinion left
  // about it is Code's, that a person still has to carry its accepted code to main.
  const publication = {
    instanceId: 'wf_pub',
    provider: 'code',
    key: 'publication',
    code: 'code_publication_pending',
    status: 409,
    message: 'waiting on publication: a signed-in operator merges the pull request',
    next: 'A signed-in project operator merges pull request #1 with code.publication.merge.',
    related: [{ kind: 'pull-request', id: 'https://github.com/x/y/pull/1', label: '#1' }],
    since: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-21T09:00:00.000Z',
  };
  const data = home({
    tasks: [task('wf_pub', me.id, 'done'), task('wf_quiet', me.id)],
    workflows: {
      workflows: [
        gate('wf_pub', { terminal: true, state: 'done', providerBlockers: [publication] }),
        // A code nobody prints is not a move: the record keeps its own gate, its own
        // sentence and its own desk, exactly as if Code had published nothing about it.
        gate('wf_quiet', {
          providerBlockers: [{ ...publication, instanceId: 'wf_quiet', code: 'code_base_wait' }],
          nextAction: { action: 'submit_delivery', tool: 'task.submit_delivery', status: 'ready' },
          actions: [{ action: 'submit_delivery', tool: 'task.submit_delivery', status: 'ready' }],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, { ...me, signedIn: true }, named);
  const [line, ordinary] = lines.yours;
  assert.equal(line?.id, 'wf_pub');
  assert.equal(line.sentence, 'Waiting on a person to merge the pull request');
  assert.equal(line.who, 'A signed-in operator');
  // Since it took this code, not since the record last moved.
  assert.equal(line.at, '2026-09-21T09:00:00.000Z');
  // The move this app makes is on the card; the agent's words stay in the fold.
  assert.deepEqual(line.desk, { label: 'Merge reviewed proposal', to: '/code' });
  assert.ok(line.says.includes(publication.next), JSON.stringify(line.says));
  assert.ok(!line.says.includes(line.sentence));
  // The quiet record is read by its gate and not by Code's opinion of it.
  assert.equal(ordinary?.id, 'wf_quiet');
  assert.equal(ordinary.sentence, 'Deliver the work for review');
  assert.equal(ordinary.who, undefined);
  assert.deepEqual(ordinary.desk, { label: 'Submit delivery', to: '/tasks/wf_quiet#deliver' });
  assert.deepEqual([...lines.agent, ...lines.nobody, ...lines.unknown], []);

  // The publication verbs answer a signed-in person and nobody else, so a reader — and an
  // operator holding a key rather than an account — get the wait and no control at all.
  for (const other of [
    { id: me.id, role: 'reader', signedIn: true },
    { ...me, signedIn: false },
  ]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reading = standingOf(rows as any, data as any, other, named);
    assert.deepEqual(
      reading.yours.map((item) => item.id),
      ['wf_quiet'],
      other.role + String(other.signedIn),
    );
    assert.equal(reading.unknown[0]?.sentence, 'Waiting on a person to merge the pull request');
    assert.equal(reading.unknown[0]?.desk, undefined);
  }
});

test('an operator’s move with no control here is still theirs, and promises nothing', () => {
  // A publication an operator disabled: nothing on any page of this app turns it back on,
  // and the ruling prints it precisely because the next move is that operator's.
  const data = home({
    tasks: [task('wf_off', me.id, 'done')],
    workflows: {
      workflows: [
        gate('wf_off', {
          terminal: true,
          state: 'done',
          providerBlockers: [
            {
              instanceId: 'wf_off',
              provider: 'code',
              key: 'publication',
              code: 'code_publication_disabled',
              status: 409,
              message: 'publication is not enabled for this project',
              related: [],
            },
          ],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, { ...me, signedIn: true }, named);
  assert.equal(lines.yours[0]?.id, 'wf_off');
  assert.equal(
    lines.yours[0].sentence,
    'Publication is disabled for this project until an operator clears it',
  );
  assert.equal(lines.yours[0].desk, undefined, 'no page here makes this move');
  assert.deepEqual([...lines.agent, ...lines.nobody, ...lines.unknown], []);
});

test('a cycle its abandoned wave stopped names the wave, not the work it reflects on', () => {
  const data = home({
    cycles: [{ id: 'wf_cycle', name: 'Cycle 1', ownerId: me.id, workflow: flow('reflecting') }],
    workflows: {
      workflows: [
        gate('wf_cycle', {
          workflow: 'research',
          state: 'reflecting',
          currentGate: 'dependency_failed',
          nextAction: { action: 'end', tool: 'research.end', status: 'needs_input' },
          blockers: [
            blocker('dependency_failed', 'The reflection wf_wave was abandoned.'),
            blocker('input_required'),
          ],
          // As the server reads them: the work first, then the wave the cycle opened. Work a
          // cycle selected may fail and still be reflected on: it stopped nothing.
          dependencies: [
            dependency('Seed sweep', { state: 'abandoned', failed: true, workflow: 'experiment' }),
            dependency('Wave 1', { state: 'abandoned', failed: true, workflow: 'reflection' }),
          ],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = standingOf(rows as any, data as any, me, named);
  assert.deepEqual(
    lines.yours.map((line: { id: string; sentence: string }) => [line.id, line.sentence]),
    [['wf_cycle', 'Decide what happens next: Wave 1 abandoned']],
  );
});
