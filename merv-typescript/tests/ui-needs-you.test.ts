/**
 * Whose move each record is, said by the owners on the server and drawn by Needs you. The
 * gate's `yours` is Workflows' rule over the owner's description of its record; Reviews says
 * which subjects are out for review and which a verdict sent back; Code words the move each of
 * its blockers asks. This file drives those reads over one project and checks that the page
 * lists exactly the rows the browser used to work out for itself from the same facts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  check,
  createService,
  type Caller,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';
import type { WorkflowDecision } from '@merv/workflows/models';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { ReviewService } from '@merv/reviews';
import { WorkflowsService } from '@merv/workflows';
import { LIMIT_ASK, yoursOf } from '@merv/workflows/evaluation';
import { firstPersonMove, heldMoves } from '@merv/code-work/blockers';
import { UiRegistry } from '@merv/ui';
import { homeRead } from '@merv/ui/home';
import reviewUiPlugin from '@merv/reviews/ui';
import { openState } from './fixtures/state.js';
import { assessment, ownReviews } from './fixtures/review-verdict.js';
import './ui-render.js';

// components.tsx first: it and list-filters.tsx import each other through a view.
await import('../packages/ui/web/components.js');
const { needsYou } = await import('../packages/ui/web/views/needs-you.js');

const ASK = 'Submit the chore for review';

test('the gate says a record is its owner’s move by the rule Needs you used to apply itself', () => {
  const me = 'actor_me';
  const owner = { actorId: me, asks: { submit: ASK }, leased: ['deliver'] };
  const action = (name: string, status: string) => ({
    action: name,
    tool: `chore.${name}`,
    status,
  });
  const blocker = (code: string) => ({ code, message: code, status: 400 });
  const gate = (over: Record<string, unknown> = {}) =>
    ({
      terminal: false,
      workStart: null,
      actions: [],
      nextAction: null,
      blockers: [],
      currentGate: 'working',
      providerBlockers: [],
      ...over,
    }) as unknown as WorkflowDecision;
  const input = gate({
    nextAction: action('submit', 'needs_input'),
    actions: [action('submit', 'needs_input')],
    blockers: [blocker('input_required')],
  });
  assert.deepEqual(yoursOf(input, owner, me), { ask: ASK });
  // Another's record, an ended one, and one whose program names no owner are nobody's here.
  assert.equal(yoursOf(input, owner, 'actor_ada'), undefined);
  assert.equal(yoursOf({ ...input, terminal: true }, owner, me), undefined);
  assert.equal(yoursOf(input, undefined, me), undefined);
  // A refusal that is not about the owner's input or a failed prerequisite is not theirs.
  for (const code of ['forbidden', 'dependencies_pending', 'a_code_from_next_year'])
    assert.equal(yoursOf(gate({ blockers: [blocker(code)] }), owner, me), undefined, code);
  // A failed prerequisite is theirs to decide, in no ask's words.
  assert.deepEqual(
    yoursOf(
      gate({
        nextAction: action('end', 'needs_input'),
        blockers: [blocker('dependency_failed'), blocker('input_required')],
      }),
      owner,
      me,
    ),
    {},
  );
  // Nothing refused: theirs only where it holds one of their asks open, and a step somebody
  // else began holds none of theirs.
  const waiting = gate({
    nextAction: action('begin', 'ready'),
    actions: [action('begin', 'ready'), action('submit', 'needs_input')],
  });
  assert.deepEqual(yoursOf(waiting, owner, me), { ask: ASK });
  assert.deepEqual(yoursOf({ ...waiting, workStart: { actorId: me } } as never, owner, me), {
    ask: ASK,
  });
  assert.equal(
    yoursOf({ ...waiting, workStart: { actorId: 'actor_bot' } } as never, owner, me),
    undefined,
  );
  assert.equal(yoursOf(gate({ nextAction: action('begin', 'ready') }), owner, me), undefined);
  // A move only a leased worker makes is never the owner's, asked for input or not.
  const delivery = gate({
    nextAction: action('deliver', 'needs_input'),
    actions: [action('deliver', 'needs_input')],
    blockers: [blocker('input_required')],
  });
  assert.equal(yoursOf(delivery, owner, me), undefined);
  assert.deepEqual(yoursOf(delivery, { actorId: me }, me), {});
  // A blocker another plugin published says whose move ending it is, on ended work too.
  const published = (whose: 'owner' | 'admin') =>
    gate({ providerBlockers: [{ ...blocker('held'), next: 'Do it', whose }] });
  assert.deepEqual(yoursOf(published('owner'), owner, me), { ask: 'Do it' });
  assert.deepEqual(yoursOf({ ...published('owner'), terminal: true }, owner, me), {
    ask: 'Do it',
  });
  assert.equal(yoursOf(published('owner'), owner, 'actor_ada', true), undefined);
  assert.equal(yoursOf(published('admin'), owner, me), undefined);
  assert.deepEqual(yoursOf(published('admin'), undefined, 'actor_ada', true), { ask: 'Do it' });
  // Every round used is a project admin's move, never the owner's as such.
  const capped = gate({
    currentGate: 'loop_limit_reached',
    blockers: [blocker('loop_limit_reached')],
  });
  assert.equal(yoursOf(capped, owner, me), undefined);
  assert.deepEqual(yoursOf(capped, owner, 'actor_ada', true), { ask: LIMIT_ASK });
  assert.equal(yoursOf({ ...capped, terminal: true }, owner, 'actor_ada', true), undefined);
});

test('work at a used-up limit, though out for review, and work a blocker holds for an admin, are an admin’s line', () => {
  const me = 'actor_admin';
  const rows = [
    {
      id: 'tasks',
      label: 'Tasks',
      group: 'hidden',
      order: 1,
      path: '/tasks',
      workflow: 'task',
      view: { kind: 'tasks' },
      status: {},
      readable: true,
      needs: { name: 'title', owner: 'producerId' },
    },
    {
      id: 'reviews',
      label: 'Reviews',
      group: 'hidden',
      order: 2,
      path: '/reviews',
      view: { kind: 'reviews' },
      status: {},
      readable: true,
    },
  ];
  const at = '2026-10-06T00:00:00.000Z';
  const task = (id: string) => ({
    id,
    title: id,
    producerId: 'actor_producer',
    workflow: { state: 'in_review', updatedAt: at, revision: 7 },
  });
  const gate = (instanceId: string, over: Record<string, unknown>) => ({
    instanceId,
    terminal: false,
    workStart: null,
    nextAction: null,
    actions: [],
    blockers: [],
    providerBlockers: [],
    dependencies: [],
    instruction: '',
    ...over,
  });
  const held = {
    provider: 'session-dispatch',
    key: 'launch',
    code: 'launch_held',
    message: 'Dispatch holds this work after 5 failed launches: exit 70',
    next: 'Fix why its launches fail, then release the hold',
    whose: 'admin',
    since: at,
  };
  const home = {
    tasks: [task('capped'), task('held')],
    // The capped task's review is open and was never claimed; the held one was sent back.
    reviews: [
      { id: 'rev_open', subjectId: 'capped', open: true, claimable: false, createdAt: at },
      { id: 'rev_old', subjectId: 'held', returned: true, createdAt: at },
    ],
    workflows: {
      workflows: [
        gate('capped', {
          currentGate: 'loop_limit_reached',
          blockers: [
            { code: 'loop_limit_reached', message: 'review_rounds is exhausted', status: 409 },
          ],
          yours: { ask: LIMIT_ASK },
        }),
        gate('held', {
          currentGate: 'launch_held',
          blockers: [{ code: 'launch_held', message: held.message, status: 409 }],
          providerBlockers: [held],
          yours: { ask: held.next },
        }),
      ],
    },
  };
  const lines = needsYou(
    rows as never,
    home as never,
    { id: me, role: 'operator' },
    () => undefined,
  );
  assert.deepEqual(
    lines.map((line: { id: string; sentence: string }) => [line.id, line.sentence]).sort(),
    [
      ['capped', LIMIT_ASK],
      ['held', held.next],
    ],
  );
  // Why the work is held stands beside the move.
  assert.ok(lines.find((line: { id: string }) => line.id === 'held')!.says.includes(held.message));
});

/** A chore: worked, then done, or ended. Its owner submits it; a review may send it back. */
const definition: WorkflowDefinition = {
  name: 'chore',
  version: 1,
  managed: true,
  initial: 'working',
  states: ['working', 'done', 'failed'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'working', action: 'submit', to: 'done' },
    { from: 'working', action: 'end', to: 'failed' },
  ],
};
const policy: WorkflowPolicy = {
  successStates: ['done'],
  dependencyFailureAction: 'end',
  actions: [
    {
      name: 'submit',
      states: ['working'],
      transitions: ['submit'],
      tool: 'chore.submit',
      instruction: 'Submit the chore.',
      requiresDependencies: true,
      requiredInput: ({ snapshot }) => (snapshot.data.needsInput ? ['text'] : []),
      check: () => {},
    },
    {
      name: 'end',
      states: ['working'],
      transitions: ['end'],
      tool: 'chore.end',
      instruction: 'End the chore with a reason.',
      suggested: false,
      requiredInput: ['reason'],
      check: () => {},
    },
  ],
  describe: ({ snapshot }) => ({
    label: String(snapshot.data.title),
    references: [],
    owner: { actorId: String(snapshot.data.ownerId), asks: { submit: ASK } },
  }),
};

/**
 * Needs you as the browser computed it before the owners answered: from the gate's codes, the
 * review lifecycle, the work start and the row's asks. Kept here only to prove that the page
 * draws the same rows from the owners' answers.
 */
function before(
  rows: { id: string; path: string; view: { kind: string }; needs?: Record<string, unknown> }[],
  home: Record<string, any>,
  viewer: { id: string; role: string; signedIn?: boolean },
  asks: Record<string, string>,
) {
  const me = viewer.id;
  const gate = new Map<string, any>(
    (home.workflows?.workflows ?? []).map((item: any) => [item.instanceId, item]),
  );
  const word = (key = '') => (Object.hasOwn(asks, key) ? asks[key] : undefined);
  const reviews: any[] = home.reviews ?? [];
  const open = reviews.filter((item) => ['requested', 'started'].includes(item.status));
  const under = new Set(open.map((item) => item.subjectId));
  const last = new Map<string, string | null>();
  for (const review of [...reviews.filter((item) => item.status === 'submitted')].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  ))
    if (!last.has(review.subjectId)) last.set(review.subjectId, review.verdict);
  const lines: [string, string][] = [];
  const work = rows.flatMap((row) =>
    row.needs && Array.isArray(home[row.id])
      ? home[row.id].map((item: any) => ({ ...item, row, owner: item[row.needs!.owner as string] }))
      : [],
  );
  for (const item of work) {
    const decision = gate.get(item.id);
    if (!decision || under.has(item.id)) continue;
    const held = firstPersonMove(decision.providerBlockers ?? []);
    if (held) {
      if (held.move.whose !== 'nobody' && viewer.role === 'operator' && viewer.signedIn)
        lines.push([item.id, held.move.sentence]);
      continue;
    }
    if (decision.terminal) continue;
    const began = decision.workStart?.actorId;
    const ask =
      !began || began === me
        ? decision.actions.find((a: any) => word(a.action) && a.status !== 'blocked')
        : undefined;
    const next = ask || decision.nextAction;
    const codes = decision.blockers.map((b: any) => b.code);
    const yours =
      item.owner === me &&
      (codes.length
        ? codes.includes('input_required') || codes.includes('dependency_failed')
        : !!ask);
    if (!yours) continue;
    const ended = decision.dependencies.find((d: any) => d.failed);
    const verdict = last.get(item.id);
    const said = word(next?.action);
    lines.push([
      item.id,
      ended
        ? `Decide what happens next: ${ended.name} ${ended.state}`
        : !said
          ? 'Needs your input'
          : verdict && verdict !== 'pass'
            ? `Changes requested: ${said[0].toLowerCase()}${said.slice(1)}`
            : said,
    ]);
  }
  for (const review of open) {
    const start = gate
      .get(review.subjectId)
      ?.actions.find((action: any) => action.tool === 'review.start');
    const mine =
      review.status === 'requested'
        ? !!review.claimable && start?.status !== 'blocked'
        : review.reviewerId === me;
    if (mine)
      lines.push([review.id, review.reviewerId ? 'Finish your review' : 'Review this work']);
  }
  return lines.sort();
}

test('Needs you lists, from the owners’ answers, exactly the rows it used to work out itself', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-needs-you-'));
  const state = await openState();
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.credentials.bootstrap({
    projectName: 'Needs you',
    actorName: 'Operator',
  });
  const me: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const issue = async (name: string, role: 'reviewer' | 'reader') => ({
    actorId: (await scope.credentials.issueActor(me, { name, role })).actor.id,
    projectId: me.projectId,
  });
  const ada = await issue('Ada', 'reviewer');
  const reader = await issue('Reader', 'reader');
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  ownReviews(reviews);
  const workflows = await createService(new WorkflowsService(state, scope));
  const chores = await workflows.register(definition, policy);
  const start = async (title: string, data: Record<string, unknown> = {}, dependsOn?: string) =>
    await chores.start(me, {
      workflow: 'chore',
      requestId: title,
      data: { title, ownerId: me.actorId, ...data },
      ...(dependsOn ? { dependsOn } : {}),
    });

  // Its owner's input is wanted.
  const input = await start('Input', { needsInput: true });
  // A prerequisite ended without succeeding: what happens next is its owner's to decide.
  const upstream = await start('Upstream');
  const stranded = await start('Stranded', {}, upstream.id);
  await chores.transition(me, {
    instanceId: upstream.id,
    expectedRevision: 0,
    action: 'end',
    requestId: 'end-upstream',
    input: { reason: 'It cannot be done.' },
  });
  // A review sent it back for changes.
  const evidence = await artifacts.create(me, { title: 'Evidence', content: 'It works.' });
  const review = async (subjectId: string, requestId: string) =>
    await reviews.request(me, {
      subjectId,
      subjectRevision: 0,
      producerId: me.actorId,
      criteria: ['The chore is done.'],
      artifactIds: [evidence.id],
      formatVersion: 2,
      requestId,
    });
  const returned = await start('Returned');
  const sentBack = await reviews.start(ada, (await review(returned.id, 'review-returned')).id);
  await reviews.submit(ada, {
    reviewId: sentBack.id,
    claimId: sentBack.claimId!,
    verdict: 'needs_changes',
    notes: 'It is not done yet.',
    ...assessment(sentBack, 'not_met'),
    requestId: 'verdict-returned',
  });
  // Out for review, held by somebody else.
  const held = await start('Held');
  await reviews.start(ada, (await review(held.id, 'review-held')).id);
  // Code holds it for an operator.
  const coded = await start('Coded');
  await state.transaction(
    async (tx) =>
      await workflows.replaceBlockers(
        {
          projectId: me.projectId,
          instanceId: coded.id,
          provider: 'code',
          blockers: [
            {
              key: 'publication',
              code: 'code_publication_disabled',
              status: 409,
              message: 'publication is not enabled for this project',
              next: 'An operator enables publication.',
            },
          ],
        },
        tx,
      ),
  );

  // The rows as the plugins register them, with this program's row beside them.
  const registry = new UiRegistry();
  reviewUiPlugin.apply({ effect: (fn: () => unknown) => fn(), ui: registry, reviews } as never);
  registry.register({
    id: 'chores',
    label: 'Chores',
    group: 'hidden',
    order: 1,
    path: '/chores',
    workflow: 'chore',
    view: { kind: 'chores' },
    home: {
      keep: ['id', 'title', 'ownerId', 'workflow'],
      list: async (caller) =>
        (await workflows.list(caller, undefined, 'chore')).map((flow) => ({
          id: flow.id,
          title: flow.data.title,
          ownerId: flow.data.ownerId,
          workflow: flow,
        })),
    },
    needs: { name: 'title', owner: 'ownerId' },
  });
  registry.register({
    id: 'code',
    label: 'Code',
    group: 'operations',
    order: 2,
    path: '/code',
    view: { kind: 'code' },
    home: {
      keep: ['instanceId', 'provider', 'key', 'move'],
      list: async (caller) => heldMoves(await workflows.blockers(caller)),
    },
  });
  const tools = {
    call: async (name: string, caller: Caller) => {
      check(name === 'review.list', 'tool_not_found', name, 404);
      return await reviews.list(caller);
    },
  };
  const read = async (caller: Caller) =>
    (await homeRead(
      {
        tools: tools as never,
        isolated: async (fn) => await fn(),
        gates: async (caller) => ({
          workflows: (await workflows.overview(caller, undefined, { open: true })).workflows,
        }),
      },
      registry.rows(),
      caller,
    )) as Record<string, any>;
  const rows = registry.rows().map(({ status: _status, read: _read, home: _home, ...row }) => ({
    ...row,
    status: {},
    readable: true,
  }));
  const named = () => undefined;

  const operator = { id: me.actorId, role: 'operator', signedIn: true };
  const home = await read(me);
  const lines = needsYou(rows as never, home as never, operator, named);
  const said = lines.map((line: { id: string; sentence: string }) => [line.id, line.sentence]);
  assert.deepEqual(
    said.sort(),
    [
      [coded.id, 'Publication is disabled for this project until an operator clears it'],
      [input.id, ASK],
      [returned.id, 'Changes requested: submit the chore for review'],
      [stranded.id, 'Decide what happens next: Upstream failed'],
    ].sort(),
  );
  assert.deepEqual(said, before(rows, home, operator, { submit: ASK }));
  // Code's move is an operator's, signed in as a person: for anyone else the record is
  // held, and not their move.
  for (const viewer of [
    { ...operator, signedIn: false },
    { id: reader.actorId, role: 'reader', signedIn: true },
  ]) {
    const theirs = viewer.id === me.actorId ? home : await read(reader);
    const listed = needsYou(rows as never, theirs as never, viewer, named)
      .map((line: { id: string; sentence: string }) => [line.id, line.sentence])
      .sort();
    assert.ok(!listed.some(([id]: string[]) => id === coded.id), viewer.role);
    assert.deepEqual(listed, before(rows, theirs, viewer, { submit: ASK }), viewer.role);
  }
  // The review somebody else holds is theirs to finish: Ada's list holds it, and nothing else.
  const adas = await read(ada);
  assert.deepEqual(
    needsYou(rows as never, adas as never, { id: ada.actorId, role: 'reviewer' }, named).map(
      (line: { sentence: string }) => line.sentence,
    ),
    ['Finish your review'],
  );
  assert.deepEqual(
    needsYou(rows as never, adas as never, { id: ada.actorId, role: 'reviewer' }, named).map(
      (line: { id: string; sentence: string }) => [line.id, line.sentence],
    ),
    before(rows, adas, { id: ada.actorId, role: 'reviewer' }, { submit: ASK }),
  );
});

test('an agent’s question is its work owner’s card and an operator’s, and no wait of Code’s hides it', () => {
  const rows = [
    {
      id: 'tasks',
      label: 'Tasks',
      group: 'hidden',
      order: 1,
      path: '/tasks',
      workflow: 'task',
      view: { kind: 'tasks' },
      status: {},
      readable: true,
      needs: { name: 'title', owner: 'producerId' },
    },
  ];
  const at = '2026-10-06T00:00:00.000Z';
  const question = {
    provider: 'session-question',
    key: 'thr_1',
    code: 'agent_question',
    message: 'Its agent asked its owner: which dataset?',
    next: 'Answer with session.message',
    since: at,
    status: 409,
    whose: 'owner',
  };
  const base = {
    provider: 'code',
    key: 'base',
    code: 'code_base_pending',
    message: 'base',
    next: 'wait',
    since: at,
    status: 409,
  };
  const gate = (yours?: { ask: string }) => ({
    instanceId: 't1',
    terminal: false,
    workStart: null,
    nextAction: null,
    actions: [],
    blockers: [{ code: 'agent_question', message: question.message, status: 409 }],
    providerBlockers: [question, base],
    dependencies: [],
    instruction: '',
    currentGate: 'agent_question',
    ...(yours ? { yours } : {}),
  });
  const home = (yours?: { ask: string }, code: unknown[] | null = null) => ({
    tasks: [
      {
        id: 't1',
        title: 'T1',
        producerId: 'actor_producer',
        workflow: { state: 'in_progress', updatedAt: at, revision: 1 },
      },
    ],
    reviews: [],
    workflows: { workflows: [gate(yours)] },
    sessions: [
      {
        instanceId: 't1',
        provider: 'session-question',
        key: 'thr_1',
        move: { sentence: 'Answer its agent’s question', who: 'x', whose: 'owner' },
      },
    ],
    code,
  });
  const show = (data: unknown, viewer: object) =>
    needsYou(rows as never, data as never, viewer as never, () => undefined).map(
      (line) => line.sentence,
    );
  const operator = { id: 'actor_op', role: 'operator', signedIn: true };
  const ownersGate = { ask: question.next };
  assert.deepEqual(show(home(), operator), ['Answer its agent’s question']);
  assert.deepEqual(
    show(home(ownersGate), { id: 'actor_producer', role: 'producer', signedIn: true }),
    ['Answer its agent’s question'],
  );
  assert.deepEqual(show(home(), { id: 'actor_other', role: 'producer', signedIn: true }), []);
  const nobody = [
    {
      instanceId: 't1',
      provider: 'code',
      key: 'base',
      move: { sentence: 'Nothing to do', who: '', whose: 'nobody' },
    },
  ];
  assert.deepEqual(show(home(undefined, nobody), operator), ['Answer its agent’s question']);
  assert.deepEqual(
    show(home(ownersGate, nobody), { id: 'actor_producer', role: 'producer', signedIn: true }),
    ['Answer its agent’s question'],
  );
});
