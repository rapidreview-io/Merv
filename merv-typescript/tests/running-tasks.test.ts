import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  Caller,
  RunningBoard,
  RunningNode,
  RunningPanel,
  Task,
  TaskCreate,
  Verdict,
} from '@merv/contracts';
import { taskNode, type TaskStanding } from '../packages/tasks/src/running.js';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

/**
 * The tasks part of the Running page, read the way the page reads it: the default composition
 * over HTTP, inside the read-only tools' snapshot. Review rounds are capped at one, so a task
 * uses them up in two deliveries.
 */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-running-tasks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry.id === 'tasks'
              ? { ...entry, config: { limits: { reviewRounds: 1 } } }
              : entry,
      ) as never,
    },
  });
  t.after(() => app.stop());
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Running tasks', actorName: 'Op' });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (name: string, role: 'producer' | 'reviewer' | 'reader') => {
    const issued = await app.ctx.scope.issueActor(operator, { name, role });
    const caller: Caller = {
      actorId: issued.actor.id,
      projectId: operator.projectId,
      credentialId: issued.credential.id,
    };
    return { caller, token: issued.token };
  };
  const producer = await issue('Producer', 'producer'),
    reviewer = await issue('Reviewer', 'reviewer'),
    reader = await issue('Reader', 'reader');

  const tool = async (name: string, token: string, input: unknown = {}) => {
    const response = await fetch(`${app.ctx.api.url}/tools/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const board = async (token = boot.token) => {
    const answer = await tool('ui.running', token);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.result as RunningBoard;
  };
  const card = async (task: { id: string }, token = boot.token) =>
    (await board(token)).lanes.work.nodes.find(({ key }) => key === `work:${task.id}`);
  const panel = async (task: { id: string }, token = boot.token) => {
    const answer = await tool('ui.running_panel', token, { key: `work:${task.id}` });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return answer.body.result as RunningPanel;
  };

  let sequence = 0;
  const create = async (title: string, extra: Partial<TaskCreate> = {}) =>
    await app.ctx.tasks.create(producer.caller, {
      title,
      goal: `Finish ${title.toLowerCase()} so the draft can cite it.`,
      checks: ['Every reference resolves.', 'The index is rebuilt from scratch.'],
      requestId: `create-${++sequence}`,
      ...extra,
    });
  const current = async (task: { id: string }) => await app.ctx.tasks.get(operator, task.id);
  const deliver = async (task: { id: string }) => {
    const evidence = await app.ctx.artifacts.create(producer.caller, {
      title: `Evidence ${++sequence}`,
      content: 'Every reference resolved; the index was rebuilt.',
    });
    return await app.ctx.tasks.submitDelivery(
      producer.caller,
      confirmedDelivery(
        {
          taskId: task.id,
          artifactIds: [evidence.id],
          expectedRevision: (await current(task)).workflow.revision,
          requestId: `deliver-${sequence}`,
        },
        2,
      ),
    );
  };
  const verdict = async (pending: Task, value: Verdict) => {
    const claim = await app.ctx.reviews.start(reviewer.caller, pending.reviewId!);
    return await app.ctx.tasks.submitReview(reviewer.caller, {
      ...reviewedFindings(claim),
      reviewId: claim.id,
      claimId: claim.claimId!,
      verdict: value,
      notes: `Independent verdict: ${value}.`,
      ...(value === 'pass' ? { evidence: { outcome: 'Both checks ran.' } } : {}),
      expectedRevision: pending.workflow.revision,
      requestId: `verdict-${++sequence}`,
    });
  };
  const markFailed = async (task: { id: string }) =>
    await app.ctx.tasks.markFailed(producer.caller, {
      taskId: task.id,
      expectedRevision: (await current(task)).workflow.revision,
      reason: 'The source archive is gone.',
      requestId: `fail-${++sequence}`,
    });
  /** A new agent of the operator's takes the task's current step on a lease. */
  const lease = async (task: { id: string }, name: string) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    await app.ctx.sessions.registerAgent(operator, {
      name,
      runnerId: `external-${++sequence}`,
      requestId: `agent-${sequence}`,
      secret,
    });
    return await app.ctx.sessions.assignAgent(secret, {
      instanceId: task.id,
      expectedRevision: (await current(task)).workflow.revision,
      requestId: `assign-${sequence}`,
    });
  };
  return {
    app,
    boot,
    operator,
    producer,
    reviewer,
    reader,
    tool,
    board,
    card,
    panel,
    create,
    deliver,
    verdict,
    markFailed,
    lease,
  };
}

/** Every string in an answer, except inside an actor value and the ladder's drawing data. */
function words(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => words(item, out));
  else if (value && typeof value === 'object') {
    if ('actor' in value) return out;
    for (const [key, item] of Object.entries(value))
      if (!(key === 'graph' && (value as { kind?: string }).kind === 'ladder')) words(item, out);
  }
  return out;
}

test('a task card says what holds it, from ready through review, and leaves the board when done', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  // Read inside the tool's snapshot, where a write would have failed the part.
  assert.deepEqual((await f.board()).lanes.work.failed, []);
  const ready = await f.card(task);
  assert.deepEqual(
    { ...ready, owner: undefined },
    {
      key: `work:${task.id}`,
      lane: 'work',
      kind: 'Task',
      title: 'Rebuild citation index',
      lines: [['Ready']],
      look: 'solid',
      rank: 2,
      owner: undefined,
    },
  );
  assert.equal(ready?.owner, 'tasks');
  assert.equal((await f.card(task, f.reader.token))?.lines[0]?.[0], 'Ready');

  // A producer lease names only what it holds the task for. Its dot is the board's, lent by
  // the session on it, so the card sets none of its own.
  await f.lease(task, 'Producer agent');
  assert.deepEqual((await f.card(task))?.lines, [['Producer on it']]);
  const [own] = (await f.app.ctx.tasks.running(f.operator)).filter(
    ({ key }) => key === `work:${task.id}`,
  );
  assert.equal(own && 'dot' in own, false);
  assert.equal(own?.rank, 1);
  assert.equal((await f.panel(task)).live, true);

  const other = await f.create('Draft section 3.2');
  const pending = await f.deliver(other);
  const review = await f.app.ctx.reviews.get(f.operator, pending.reviewId!);
  assert.deepEqual((await f.card(other))?.lines, [
    ['Review unclaimed · ', { since: review.createdAt }],
  ]);
  const panel = await f.panel(other);
  assert.deepEqual(panel.header.says, [{ state: 'in_review' }, ' · unclaimed']);
  assert.equal(panel.live, false);

  // A claim made in person names its reviewer, for whoever may read names.
  await f.app.ctx.reviews.start(f.reviewer.caller, pending.reviewId!);
  assert.deepEqual((await f.card(other, f.reader.token))?.lines, [
    ['In review · ', { actor: f.reviewer.caller.actorId, prefix: 'with ', unnamed: 'claimed' }],
  ]);
  assert.deepEqual((await f.panel(other)).header.says, [{ state: 'in_review' }]);

  // A leased review names only that it is in review: the reviewer's session says who.
  const leased = await f.create('Check figure units');
  await f.deliver(leased);
  await f.lease(leased, 'Review agent');
  assert.deepEqual((await f.card(leased))?.lines, [['In review']]);

  const started = await f.app.ctx.reviews.get(f.reviewer.caller, pending.reviewId!);
  await f.app.ctx.tasks.submitReview(f.reviewer.caller, {
    ...reviewedFindings(started),
    reviewId: started.id,
    claimId: started.claimId!,
    verdict: 'pass',
    notes: 'Independent verdict: pass.',
    evidence: { outcome: 'Both checks ran.' },
    expectedRevision: pending.workflow.revision,
    requestId: 'accept-other',
  });
  assert.equal(await f.card(other), undefined);
  const done = await f.panel(other);
  assert.deepEqual(done.header.says, [{ state: 'done' }]);
});

test('a waiting task is dashed with its edge, and turns red with who ends the wait when its prerequisite fails', async (t) => {
  const f = await fixture(t);
  const source = await f.create('Collect source archive');
  const second = await f.create('Normalise author names');
  const waiting = await f.create('Rebuild citation index', { dependsOn: [source.id] });
  const both = await f.create('Draft section 3.2', { dependsOn: [source.id, second.id] });

  const answer = await f.board();
  const find = (task: { id: string }) =>
    answer.lanes.work.nodes.find(({ key }) => key === `work:${task.id}`);
  assert.deepEqual(find(waiting)?.lines, [['Waits on ', 'Collect source archive']]);
  assert.equal(find(waiting)?.look, 'dashed');
  assert.equal(find(waiting)?.rank, 3);
  assert.deepEqual(find(both)?.lines, [['Waits on ', 'Collect source archive', ' and 1 more']]);
  assert.deepEqual(
    answer.edges.filter(({ from }) => from === `work:${waiting.id}`),
    [{ from: `work:${waiting.id}`, to: `work:${source.id}`, verb: 'waits on', waiting: true }],
  );
  // Ready work comes before waiting work.
  const order = answer.lanes.work.nodes.map(({ key }) => key);
  assert.ok(order.indexOf(`work:${source.id}`) < order.indexOf(`work:${waiting.id}`));

  const before = await f.panel(waiting);
  assert.deepEqual(before.header.says, [
    { state: 'in_progress' },
    ' · waits on ',
    'Collect source archive',
  ]);
  assert.deepEqual(
    (await f.panel(source)).sections
      .filter(({ owner }) => owner === 'tasks')
      .find(({ title }) => title === 'Unblocks'),
    {
      title: 'Unblocks',
      place: 'relations',
      kind: 'links',
      owner: 'tasks',
      rows: [waiting, both].map((task) => ({
        to: { key: `work:${task.id}`, route: `/tasks/${task.id}` },
        kind: 'Task',
        name: task.title,
        says: [{ state: 'in_progress' }],
      })),
    },
  );

  await f.markFailed(source);
  const failed = await f.board();
  const red = failed.lanes.work.nodes.find(({ key }) => key === `work:${waiting.id}`);
  assert.deepEqual(red?.attention, {
    says: ['Collect source archive', ' failed'],
    who: 'The producer ends this task, or its cycle replans it',
  });
  assert.equal(red?.rank, 0);
  assert.equal(failed.lanes.work.nodes[0]?.attention !== undefined, true);
  assert.ok(failed.lanes.work.needsYou >= 2);
  assert.equal(
    failed.lanes.work.nodes.some(({ key }) => key === `work:${source.id}`),
    false,
  );
  assert.equal(
    failed.edges.some(({ from }) => from === `work:${waiting.id}`),
    false,
  );
  // The failed prerequisite is why it needs a person, so that section leads the sidebar.
  const after = await f.panel(waiting);
  assert.deepEqual(after.header.attention, red?.attention);
  assert.equal(after.sections[0]?.title, 'Waits on');
  assert.equal(after.sections[0]?.attention, true);
  assert.deepEqual(after.sections[0]?.kind === 'links' && after.sections[0].rows, [
    {
      to: { key: `work:${source.id}`, route: `/tasks/${source.id}` },
      kind: 'Task',
      name: 'Collect source archive',
      says: [{ state: 'failed' }],
      attention: true,
    },
  ]);
});

test('used review rounds turn a task red, naming the independent reviewer or an operator', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  await f.verdict(await f.deliver(task), 'needs_changes');
  // Sent back, it is the producer's again, and the claims of the delivery it was sent back
  // with are withdrawn.
  assert.deepEqual((await f.card(task))?.lines, [['Ready']]);
  const back = (await f.panel(task)).sections.find(({ title }) => title === 'Checks');
  assert.deepEqual(back?.kind === 'table' && back.columns, ['Check']);

  const pending = await f.deliver(task);
  const expected = {
    says: ['Every review round is used'],
    who: 'An independent reviewer reviews it by hand, or an operator allows another round',
    to: { route: `/reviews/${pending.reviewId}`, text: 'Open the review' },
  };
  const node = await f.card(task);
  assert.deepEqual(node?.attention, expected);
  const review = await f.app.ctx.reviews.get(f.operator, pending.reviewId!);
  assert.deepEqual(node?.lines, [['Review unclaimed · ', { since: review.createdAt }]]);
  const panel = await f.panel(task, f.reader.token);
  assert.deepEqual(panel.header.attention, expected);
  const checks = panel.sections.find(({ title }) => title === 'Checks');
  assert.ok(checks?.kind === 'table');
  assert.deepEqual(checks.columns, ['Check', 'Claim']);
  assert.deepEqual(
    checks.rows.map(({ cells }) => cells),
    [
      [['1 · Every reference resolves.'], [{ state: 'met' }]],
      [['2 · The index is rebuilt from scratch.'], [{ state: 'met' }]],
    ],
  );
  assert.equal(checks.aside?.[0], 'Delivered ');
});

test('a task another plugin holds back reads Waiting on a dashed card, never Ready', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Merge resolution');
  await f.app.ctx.state.transaction(
    async (tx) =>
      await f.app.ctx.workflows.replaceBlockers(
        {
          projectId: f.operator.projectId,
          instanceId: task.id,
          provider: 'code',
          blockers: [
            {
              key: 'base',
              code: 'code_base_pending',
              message: 'Main has not been imported.',
              status: 409,
              next: 'An administrator imports main.',
            },
          ],
        },
        tx,
      ),
  );
  const node = await f.card(task);
  assert.deepEqual(node?.lines, [['Waiting']]);
  assert.equal(node?.look, 'dashed');
  assert.equal(node?.attention, undefined);
  assert.deepEqual((await f.panel(task)).header.says, [{ state: 'in_progress' }, ' · waiting']);
});

test('a done task stays, quiet, only while another owner holds its key on the board', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  await f.verdict(await f.deliver(task), 'pass');
  assert.deepEqual(await f.app.ctx.tasks.running(f.operator), []);
  assert.deepEqual(await f.app.ctx.tasks.running(f.operator, [`work:${task.id}`]), [
    {
      key: `work:${task.id}`,
      lane: 'work',
      kind: 'Task',
      title: 'Rebuild citation index',
      lines: [[], ['Done']],
      look: 'quiet',
      rank: 4,
    },
  ]);
  assert.equal(await f.card(task), undefined);

  const dispose = f.app.ctx.ui.contribute({
    owner: 'probe-code',
    lanes: ['work'],
    marks: async () => [
      {
        key: `work:${task.id}`,
        says: ['Waiting on a person to merge the pull request'],
        who: 'A signed-in operator',
      },
    ],
  });
  t.after(dispose);
  const held = await f.card(task, f.reader.token);
  assert.deepEqual(held?.lines, [[], ['Done']]);
  assert.equal(held?.look, 'quiet');
  assert.deepEqual(held?.attention, {
    says: ['Waiting on a person to merge the pull request'],
    who: 'A signed-in operator',
  });
});

test('the sidebar holds the ladder, relations, goal, pinned brief, checks and details, and names nobody by id', async (t) => {
  const f = await fixture(t);
  const prerequisite = await f.create('Collect source archive');
  const spec = await f.app.ctx.artifacts.create(f.producer.caller, {
    title: 'Citation index spec',
    content: [
      '# Citation index',
      'Finish rebuild citation index so the draft can cite it.',
      '- Every reference resolves.',
      '- The index is rebuilt from scratch.',
      'Every key maps to one retained file.',
    ].join('\n'),
  });
  const task = await f.create('Rebuild citation index', {
    dependsOn: [prerequisite.id],
    briefId: spec.id,
  });
  const dependent = await f.create('Draft section 3.2', { dependsOn: [task.id] });

  const panel = await f.panel(task, f.reader.token);
  assert.equal(panel.key, `work:${task.id}`);
  assert.deepEqual(panel.header, {
    kind: 'Task',
    title: 'Rebuild citation index',
    says: [{ state: 'in_progress' }, ' · waits on ', 'Collect source archive'],
  });
  assert.equal(panel.route, `/tasks/${task.id}`);
  assert.deepEqual(panel.actions, []);
  assert.equal(panel.live, false);
  const own = panel.sections.filter(({ owner }) => owner === 'tasks');
  assert.deepEqual(
    own.map(({ title, kind, place }) => [title, kind, place]),
    [
      ['Progress', 'ladder', 'progress'],
      ['Waits on', 'links', 'relations'],
      ['Unblocks', 'links', 'relations'],
      ['Goal', 'text', 'content'],
      ['Pinned brief', 'links', 'content'],
      ['Checks', 'table', 'content'],
      ['Details', 'facts', 'details'],
    ],
  );
  const [progress, waits, unblocks, goal, brief, checks, details] = own;
  assert.ok(progress?.kind === 'ladder');
  assert.equal(progress.graph.state, 'in_progress');
  assert.deepEqual(
    waits?.kind === 'links' && waits.rows.map(({ name, attention }) => [name, !!attention]),
    [['Collect source archive', false]],
  );
  assert.deepEqual(unblocks?.kind === 'links' && unblocks.rows.map(({ to }) => to), [
    { key: `work:${dependent.id}`, route: `/tasks/${dependent.id}` },
  ]);
  assert.deepEqual(goal, {
    title: 'Goal',
    place: 'content',
    kind: 'text',
    text: 'Finish rebuild citation index so the draft can cite it.',
    clamp: 4,
    owner: 'tasks',
  });
  assert.deepEqual(brief?.kind === 'links' && brief.rows, [
    { to: { route: `/artifacts/${spec.id}` }, name: 'Citation index spec' },
  ]);
  assert.ok(checks?.kind === 'table');
  assert.deepEqual(checks.columns, ['Check']);
  assert.equal(checks.aside, undefined);
  assert.deepEqual(details, {
    title: 'Details',
    place: 'details',
    kind: 'facts',
    owner: 'tasks',
    rows: [
      { label: 'Producer', value: [{ actor: f.producer.caller.actorId }] },
      { label: 'Created', value: [{ ago: task.createdAt }] },
    ],
  });

  // The brief the server composes only repeats the goal and the checks, so it is not linked.
  const composed = await f.panel(prerequisite);
  assert.equal(
    composed.sections.some(({ title }) => title === 'Pinned brief'),
    false,
  );

  // Ids stay in keys, routes and actor values, never in words.
  const everything = [
    ...words(await f.board()),
    ...words(panel),
    ...words(composed),
    ...words(await f.panel(dependent)),
  ].filter((text) => !/^(work:|\/)/.test(text));
  for (const id of [f.producer.caller.actorId, task.id, prerequisite.id, dependent.id, spec.id])
    assert.equal(
      everything.find((text) => text.includes(id)),
      undefined,
      `${id} is printed`,
    );
});

test('a key that is not a task of this project has no task sidebar', async (t) => {
  const f = await fixture(t);
  const experiment = await f.app.ctx.experiments.create(f.operator, {
    name: 'ablate_retrieval_depth',
    intent: 'Does retrieval depth beyond k = 8 change answer accuracy?',
    requestId: 'experiment',
  });
  assert.equal(await f.app.ctx.tasks.runningPanel(f.operator, experiment.id), null);
  assert.equal(await f.app.ctx.tasks.runningPanel(f.operator, 'nothing'), null);
  assert.equal((await f.app.ctx.tasks.running(f.operator, [`work:${experiment.id}`])).length, 0);
});

test('a task that needs a person says so in the order that decides it', () => {
  const task: TaskStanding = {
    id: 'task_1',
    title: 'Rebuild citation index',
    state: 'in_review',
    lease: null,
    review: {
      id: 'review_1',
      status: 'requested',
      reviewerId: null,
      createdAt: '2026-09-25T10:00:00.000Z',
    },
    dependencies: [],
    roundsUsed: false,
    blocked: false,
  };
  const attention = (standing: Partial<TaskStanding>): RunningNode['attention'] =>
    taskNode({ ...task, ...standing }).attention;
  assert.equal(attention({}), undefined);
  // Only an operator's read carries the independence wait.
  assert.deepEqual(
    attention({ review: { ...task.review!, waiting: 'Every eligible reviewer contributed.' } }),
    {
      says: ['No independent reviewer can take it'],
      who: 'An operator provides one',
      to: { route: '/reviews/review_1', text: 'Open the review' },
    },
  );
  assert.deepEqual(
    attention({
      review: { ...task.review!, waiting: 'Every eligible reviewer contributed.' },
      roundsUsed: true,
    })?.says,
    ['Every review round is used'],
  );
  assert.deepEqual(attention({ state: 'suspended', review: null }), {
    says: ['Suspended'],
    who: 'A signed-in operator allows another review round',
  });
  assert.deepEqual(taskNode({ ...task, state: 'suspended', review: null }).lines, [['Suspended']]);
  // An ended task needs nobody, whatever it last stood at.
  assert.equal(attention({ state: 'done', roundsUsed: true }), undefined);
  assert.deepEqual(taskNode({ ...task, state: 'failed' }).lines, [[], ['Failed']]);
  // A long title is cut to what the page holds, and the card still stands.
  const long = taskNode({ ...task, title: 'x'.repeat(300) }).title;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});
