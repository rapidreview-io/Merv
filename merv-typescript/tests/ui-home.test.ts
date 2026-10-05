/**
 * Home and Now. Each test states one thing the two pages must do for a person: say a move
 * in a sentence of their own rather than the agent's instruction, list only what is the
 * reader's to do, put the control on the card, and agree a word with its number. Whose
 * hands everything else is in, and what waits on what, is the Work page's map.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, mount, requests, serve, text, unmount } from './ui-render.js';

const { createElement } = await import('react');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
// components.tsx first: it and list-filters.tsx import each other through a view, and
// only this order has every module evaluated before another one calls into it.
await import('../packages/ui/web/components.js');
const { NeedsYou, needsYou, recordSentence, reviewSentence } =
  await import('../packages/ui/web/views/overview.js');

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
const experiment = (id: string, ownerId: string, state = 'planned') => ({
  id,
  name: `Experiment ${id}`,
  ownerId,
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
  research: null,
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
  assert.equal(recordSentence(ready('submit_design')), 'Submit the design for review');
  assert.equal(recordSentence(ready('submit_results')), 'Submit the results for review');
  assert.equal(recordSentence(ready('an_action_nobody_named')), 'Needs your input');
  assert.equal(
    recordSentence({
      nextAction: { action: 'end' },
      dependencies: [dependency('Baseline run', { failed: true, state: 'failed' })],
    }),
    'Decide what happens next: Baseline run failed',
  );
  // Work a review sent back says so, in the ask's own words.
  assert.equal(
    recordSentence(ready('submit_design'), true),
    'Changes requested: submit the design for review',
  );

  assert.equal(reviewSentence(false, 'in_review'), 'Review this delivery');
  assert.equal(reviewSentence(false, 'design_review'), 'Review this design');
  assert.equal(reviewSentence(false, 'experiment_review'), 'Review these results');
  assert.equal(reviewSentence(false), 'Review this work');
  assert.equal(reviewSentence(true, 'in_review'), 'Finish your review');
});

test('only the reader’s own moves are listed, and a code the page cannot read is never promoted', () => {
  const data = home({
    experiments: [experiment('wf_mine', me.id)],
    tasks: [
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
            action: 'submit_design',
            tool: 'experiment.transition',
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
  const lines = needsYou(rows as any, data as any, me, named);
  // What is with an agent, waits on other work, is simply running or has ended is not the
  // reader's move, and neither is their own record under a code this page cannot read.
  assert.deepEqual(
    lines.map((line: { id: string; sentence: string }) => [line.id, line.sentence]),
    [['wf_mine', 'Submit the design for review']],
  );
  // The server’s words are kept whole for whoever operates the agents, and only there.
  assert.deepEqual(lines[0].says, [INSTRUCTION, INPUT]);
  assert.ok(!lines[0].sentence.includes('artifactIds'));
  // A card carries a control only where a page of this app makes the move.
  assert.equal(lines[0].desk, undefined);
});

test('work whose submission waits on the reader is theirs even when its gate reports no blocker', () => {
  // Sent back for changes, or never begun: only `begin` is ready and nothing blocks.
  const waiting = {
    nextAction: { action: 'begin', tool: 'workflow.begin', status: 'ready' },
    actions: [
      { action: 'begin', tool: 'workflow.begin', status: 'ready' },
      { action: 'submit_design', tool: 'experiment.transition', status: 'needs_input' },
    ],
  };
  const data = home({
    experiments: [
      experiment('wf_returned', me.id),
      experiment('wf_fresh', me.id),
      experiment('wf_held', me.id),
      experiment('wf_theirs', 'actor_ada'),
      experiment('wf_out', me.id, 'design_review'),
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
  const lines = needsYou(rows as any, data as any, me, named);
  const yours = Object.fromEntries(
    lines.map((line: { id: string; sentence: string }) => [line.id, line]),
  );
  // Work an agent began, work that is another's, and work out for review with somebody else
  // stay off the list; so does that review, which is its reviewer's.
  assert.deepEqual(Object.keys(yours).sort(), ['wf_fresh', 'wf_returned']);
  assert.equal(yours.wf_returned.sentence, 'Changes requested: submit the design for review');
  assert.equal(yours.wf_fresh.sentence, 'Submit the design for review');
});

test('a task’s delivery is never the reader’s move: only its leased worker can make one', () => {
  const data = home({
    tasks: [task('wf_waiting', me.id), task('wf_returned', me.id)],
    workflows: {
      workflows: [
        // Nobody holds the task: its gate asks for the delivery's input, as it would of a worker.
        gate('wf_waiting', {
          nextAction: {
            action: 'submit_delivery',
            tool: 'task.submit_delivery',
            status: 'needs_input',
          },
          blockers: [blocker('input_required', INPUT)],
        }),
        gate('wf_returned', {
          nextAction: { action: 'begin', tool: 'workflow.begin', status: 'ready' },
          actions: [
            { action: 'begin', tool: 'workflow.begin', status: 'ready' },
            { action: 'submit_delivery', tool: 'task.submit_delivery', status: 'needs_input' },
          ],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(needsYou(rows as any, data as any, me, named), []);
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
  const lines = needsYou(rows as any, data as any, me, named);
  const byId = Object.fromEntries(lines.map((line: { id: string }) => [line.id, line]));
  // A review the server would let this reader claim, but whose gate refuses the claim, is not
  // the reader's move: a Git task's review waits for a leased reviewer (C2). Nor is one the
  // server withholds, one somebody else holds, or one that is over.
  assert.deepEqual(Object.keys(byId).sort(), ['review_a', 'review_d']);
  assert.equal(byId.review_a.sentence, 'Review this delivery');
  assert.equal(byId.review_a.who, 'Ada', 'whose work it is');
  assert.equal(byId.review_a.claim, 'review_a');
  assert.equal(byId.review_d.sentence, 'Finish your review');
  assert.equal(byId.review_d.claim, undefined);
});

const line = (over: Record<string, unknown>) => ({
  id: 'wf_1',
  kind: 'tasks',
  name: 'Check training configuration',
  to: '/tasks/wf_1',
  at: new Date().toISOString(),
  sentence: 'Waiting on a person to merge the pull request',
  says: [INSTRUCTION, INPUT],
  ...over,
});
const standing = (lines: unknown[], data: unknown = {}) =>
  createElement(
    MemoryRouter,
    { initialEntries: ['/now'] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path: '/now',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        element: createElement(NeedsYou as any, {
          rows,
          lines,
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
    standing([
      line({ desk: { label: 'Merge reviewed proposal', to: '/code' } }),
      line({ id: 'wf_3', kind: 'experiments', sentence: 'Submit the design for review' }),
    ]),
  );
  assert.equal(document.querySelector('.ov-h')!.textContent, 'Needs you 2');
  assert.equal(document.querySelectorAll('.ov-h').length, 1, 'one list: what is yours');
  const [yours, undoable] = [...document.querySelectorAll('.ov-row')];
  assert.deepEqual(
    [...yours.querySelectorAll('.kind, .ov-name, .ov-say, .ov-meta time')].map(
      (node) => node.textContent,
    ),
    [
      'Task',
      'Check training configuration',
      'Waiting on a person to merge the pull request',
      'just now',
    ],
  );
  // The control goes to the desk where the move is made, which the name beside it does not.
  const open = yours.querySelector<HTMLAnchorElement>('a.btn--primary')!;
  assert.equal(open.textContent?.trim(), 'Merge reviewed proposal');
  assert.equal(open.getAttribute('href'), '/code');
  assert.equal(
    undoable.querySelector('.btn'),
    null,
    'a move no page can make offers no control: the name is already the way to the record',
  );

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
    standing([
      line({
        id: 'review_1',
        kind: 'reviews',
        to: '/reviews/review_1',
        sentence: 'Review this delivery',
        who: 'Ada',
        says: [],
        claim: 'review_1',
      }),
    ]),
  );
  assert.equal(document.querySelector('.ov-meta')!.textContent, 'Adajust now');
  assert.equal(document.querySelector('details'), null, 'nothing was said, so nothing is folded');
  await click('Claim review');
  assert.ok(requests.includes('POST /tools/review.start'));
  assert.equal(text(), 'The verdict desk');
});

test('with nothing to do the page says so once, and an unwell row still needs someone', async (t) => {
  t.after(async () => await unmount());
  await mount(standing([]));
  assert.equal(document.querySelector('.empty-title')!.textContent, 'Nothing needs you');
  assert.ok(!text().includes('Needs you'));
  await unmount();

  rows[0].status = { state: 'degraded', detail: 'The task store is read-only' } as never;
  t.after(() => (rows[0].status = {}));
  await mount(standing([]));
  assert.equal(document.querySelector('.empty-state'), null);
  assert.ok(text().includes('The task store is read-only'));
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
    tasks: [task('wf_pub', me.id, 'done')],
    experiments: [experiment('wf_quiet', me.id)],
    workflows: {
      workflows: [
        gate('wf_pub', { terminal: true, state: 'done', providerBlockers: [publication] }),
        // A code nobody prints is not a move: the record keeps its own gate, its own
        // sentence and its own desk, exactly as if Code had published nothing about it.
        gate('wf_quiet', {
          providerBlockers: [{ ...publication, instanceId: 'wf_quiet', code: 'code_base_wait' }],
          nextAction: { action: 'submit_design', tool: 'experiment.transition', status: 'ready' },
          actions: [{ action: 'submit_design', tool: 'experiment.transition', status: 'ready' }],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = needsYou(rows as any, data as any, { ...me, signedIn: true }, named);
  const [line, ordinary] = lines;
  assert.equal(lines.length, 2);
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
  assert.equal(ordinary.sentence, 'Submit the design for review');
  assert.equal(ordinary.who, undefined);
  assert.equal(ordinary.desk, undefined);

  // The publication verbs answer a signed-in person and nobody else, so for a reader — and
  // an operator holding a key rather than an account — the wait is not theirs: it is the red
  // card on the Work page's map.
  for (const other of [
    { id: me.id, role: 'reader', signedIn: true },
    { ...me, signedIn: false },
  ])
    assert.deepEqual(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      needsYou(rows as any, data as any, other, named).map((item: { id: string }) => item.id),
      ['wf_quiet'],
      other.role + String(other.signedIn),
    );
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
  const lines = needsYou(rows as any, data as any, { ...me, signedIn: true }, named);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.id, 'wf_off');
  assert.equal(
    lines[0].sentence,
    'Publication is disabled for this project until an operator clears it',
  );
  assert.equal(lines[0].desk, undefined, 'no page here makes this move');
});

test('a cycle its abandoned wave stopped names the wave, not the work it reflects on', () => {
  const data = home({
    research: [{ id: 'wf_cycle', name: 'Cycle 1', ownerId: me.id, workflow: flow('reflecting') }],
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
  const lines = needsYou(rows as any, data as any, me, named);
  assert.deepEqual(
    lines.map((line: { id: string; sentence: string }) => [line.id, line.sentence]),
    [['wf_cycle', 'Decide what happens next: Wave 1 abandoned']],
  );
});

test('work a cycle reflects on may fail and stop nothing: the next cycle still asks for its input', () => {
  const data = home({
    research: [
      { id: 'wf_cycle', name: 'Cycle 1', ownerId: me.id, workflow: flow('consolidating') },
      { id: 'wf_next', name: 'Cycle 2', ownerId: me.id, workflow: flow('reflecting') },
    ],
    workflows: {
      workflows: [
        gate('wf_cycle', {
          workflow: 'research',
          state: 'consolidating',
          currentGate: 'integration_failed',
          blockers: [
            blocker(
              'integration_failed',
              'The consolidation task wf_task ended failed. Retry with research.advance { retryIntegration: true } to inject a fresh task, or end the cycle with research.end.',
            ),
          ],
          dependencies: [
            dependency('Seed sweep', { state: 'failed', failed: true, workflow: 'experiment' }),
            dependency('Wave 1', { state: 'approved', settled: true, workflow: 'reflection' }),
            dependency('Consolidate Wave 1', { state: 'failed', failed: true }),
          ],
        }),
        gate('wf_next', {
          workflow: 'research',
          state: 'reflecting',
          currentGate: 'input_required',
          blockers: [blocker('input_required')],
          dependencies: [
            dependency('Seed sweep', { state: 'failed', failed: true, workflow: 'experiment' }),
            dependency('Wave 2', { state: 'approved', settled: true, workflow: 'reflection' }),
          ],
        }),
      ],
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lines = needsYou(rows as any, data as any, me, named);
  // The stopped cycle asks nothing of its owner here: its own page holds the retry and the end.
  assert.deepEqual(
    lines.map((line: { id: string; sentence: string }) => [line.id, line.sentence]),
    [['wf_next', 'Needs your input']],
  );
});

test('the review of a reflection wave is named by the wave it reviews', () => {
  const data = home({
    reflections: [
      {
        id: 'wf_wave',
        title: 'QA6 Ledgerline cycle: reflection',
        ownerId: 'actor_ada',
        workflow: flow('in_review'),
      },
    ],
    reviews: [
      {
        id: 'review_wave',
        subjectId: 'wf_wave',
        status: 'requested',
        reviewerId: null,
        claimable: false,
        verdict: null,
        createdAt: '2026-09-20T11:00:00.000Z',
      },
    ],
  });
  // One nobody may claim here is its reviewer's, and is not listed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.deepEqual(needsYou(rows as any, data as any, me, named), []);
  // One the viewer may claim is asked for as work: a wave is no delivery.
  data.reviews[0]!.claimable = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yours = needsYou(rows as any, data as any, me, named);
  assert.deepEqual(
    yours.map((line: { name?: unknown; sentence: string }) => [line.name, line.sentence]),
    [['QA6 Ledgerline cycle: reflection', 'Review this work']],
  );
});
