import type { Task, TaskCreate } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller, RunningBoard, RunningNode, RunningPanel, Verdict } from '@merv/contracts';
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
            : entry,
      ) as never,
    },
  });
  t.after(async () => {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Running tasks',
    actorName: 'Op',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (name: string, role: 'producer' | 'reviewer' | 'reader' | 'operator') => {
    const issued = await app.ctx.scope.credentials.issueActor(operator, { name, role });
    const caller: Caller = {
      actorId: issued.actor.id,
      projectId: operator.projectId,
      credentialId: issued.credential.id,
    };
    return { caller, token: issued.token };
  };
  const producer = await issue('Producer', 'producer'),
    reviewer = await issue('Reviewer', 'operator'),
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
    await currentTask(app.ctx, producer.caller, {
      title,
      goal: `Finish ${title.toLowerCase()} so the draft can cite it.`,
      checks: ['Every reference resolves.', 'The index is rebuilt from scratch.'],
      requestId: `create-${++sequence}`,
      ...extra,
    });
  const current = async (task: { id: string }) => await app.ctx.tasks.get(operator, task.id);
  const work = currentWork(app.ctx, { directory, source: producer.caller });
  /** A delivery of its report and, with `more`, that many further files. */
  const deliver = async (task: { id: string }, more = 0) => {
    const held = await work.lease(await current(task));
    try {
      const evidence = await work.run(
        held,
        'artifact.create',
        {
          title: `Evidence ${++sequence}`,
          content: 'Every reference resolved; the index was rebuilt.',
        },
        (caller, input) => app.ctx.artifacts.create(caller, input as never),
      );
      const extra = [];
      for (let index = 0; index < more; index++)
        extra.push(
          await work.run(
            held,
            'artifact.create',
            {
              title: `Table ${index + 1}`,
              content: 'reference,resolved\nsmith2020,yes',
              mediaType: 'text/csv',
            },
            (caller, input) => app.ctx.artifacts.create(caller, input as never),
          ),
        );
      const commandId = await work.commit(held);
      return await work.run(
        held,
        'task.submit_delivery',
        confirmedDelivery(
          {
            taskId: task.id,
            artifactIds: [evidence.id, ...extra.map((artifact) => artifact.id)],
            commandId,
            expectedRevision: (await current(task)).workflow.revision,
            requestId: `deliver-${sequence}`,
          },
          2,
        ),
        (caller, input) => app.ctx.tasks.submitDelivery(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  const verdict = async (pending: Task, value: Verdict) => {
    const held = await work.lease(pending, reviewer.caller);
    try {
      const claim = await app.ctx.reviews.get(held.worker, pending.reviewId!);
      return await work.run(
        held,
        'review.submit',
        {
          ...reviewedFindings(claim),
          reviewId: claim.id,
          claimId: claim.claimId!,
          verdict: value,
          notes: `Independent verdict: ${value}.`,
          ...(value === 'pass' ? { evidence: { outcome: 'Both checks ran.' } } : {}),
          expectedRevision: pending.workflow.revision,
          requestId: `verdict-${++sequence}`,
        },
        (caller, input) => app.ctx.tasks.submitReview(caller, input as never),
      );
    } finally {
      await work.release(held);
    }
  };
  const markFailed = async (task: { id: string }) =>
    await app.ctx.tasks.markFailed(producer.caller, {
      taskId: task.id,
      expectedRevision: (await current(task)).workflow.revision,
      reason: 'The source archive is gone.',
      requestId: `fail-${++sequence}`,
    });
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
    work,
  };
}

/** Every string in an answer, except inside an actor value and the ladder's drawing data. */
function words(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => words(item, out));
  else if (value && typeof value === 'object') {
    if ('actor' in value) return out;
    for (const [key, item] of Object.entries(value))
      // A file is referred to by its id, as a link by its key: neither is a word drawn.
      if (key !== 'id' && !(key === 'graph' && (value as { kind?: string }).kind === 'ladder'))
        words(item, out);
  }
  return out;
}

test('a current task card moves from ready through its leased review and leaves the board on acceptance', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  assert.deepEqual((await f.card(task))?.lines, [['Ready']]);
  const pending = await f.deliver(task);
  assert.ok(await f.card(task));
  const held = await f.work.lease(pending, f.reviewer.caller);
  assert.deepEqual((await f.card(task))?.lines, [['In review · with an agent']]);
  const review = await f.app.ctx.reviews.get(held.worker, pending.reviewId!);
  const done = await f.work.run(
    held,
    'review.submit',
    {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      verdict: 'pass',
      notes: 'Opened and independently checked the retained index evidence.',
      expectedRevision: pending.workflow.revision,
      requestId: f.work.request(),
    },
    (caller, input) => f.app.ctx.tasks.submitReview(caller, input as never),
  );
  await f.work.release(held);
  assert.equal(done.workflow.state, 'done');
  assert.equal(await f.card(task), undefined);
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
  // Both prerequisites are declared in one create, so they share a timestamp and either may be
  // the one named first; the card names one of them and counts the other.
  const [[lead, named, rest] = []] = find(both)?.lines ?? [];
  assert.equal(lead, 'Waits on ');
  assert.ok(
    ['Collect source archive', 'Normalise author names'].includes(named as string),
    `the card names a prerequisite, not ${String(named)}`,
  );
  assert.equal(rest, ' and 1 more');
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

test('a task that ended with a failed prerequisite still lists it, without the red', async (t) => {
  const f = await fixture(t);
  const source = await f.create('Collect source archive');
  const waiting = await f.create('Rebuild citation index', { dependsOn: [source.id] });
  await f.markFailed(source);
  // The producer ends it, as the red sentence asks, and nobody has a move left.
  await f.markFailed(waiting);
  const panel = await f.panel(waiting);
  assert.deepEqual(panel.header, {
    kind: 'Task',
    title: 'Rebuild citation index',
    says: [{ state: 'failed' }],
  });
  assert.equal(panel.sections[0]?.title, 'Progress');
  const waits = panel.sections.find(({ title }) => title === 'Waits on');
  assert.equal(waits?.attention, undefined);
  assert.deepEqual(waits?.kind === 'links' && waits.rows, [
    {
      to: { key: `work:${source.id}`, route: `/tasks/${source.id}` },
      kind: 'Task',
      name: 'Collect source archive',
      says: [{ state: 'failed' }],
    },
  ]);
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
      started: task.createdAt,
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

test('the sidebar holds the ladder, relations, pinned brief and details, its unit the goal and checks, and names nobody by id', async (t) => {
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
      ['Pinned brief', 'links', 'content'],
      ['Details', 'facts', 'details'],
    ],
  );
  const [progress, waits, unblocks, brief, details] = own;
  assert.ok(progress?.kind === 'ladder');
  assert.equal(progress.graph.state, 'in_progress');
  assert.deepEqual(
    waits?.kind === 'links' && waits.rows.map(({ name, attention }) => [name, !!attention]),
    [['Collect source archive', false]],
  );
  assert.deepEqual(unblocks?.kind === 'links' && unblocks.rows.map(({ to }) => to), [
    { key: `work:${dependent.id}`, route: `/tasks/${dependent.id}` },
  ]);
  // Nothing delivered yet: the unit reads its goal, every check still open, and no history;
  // its one file is the brief it was asked with, made before any thread worked it.
  assert.deepEqual(panel.unit, {
    key: { label: 'Goal', text: 'Finish rebuild citation index so the draft can cite it.' },
    checks: task.checks.map((text) => ({ text })),
    history: [],
    artifacts: [
      {
        id: spec.id,
        title: 'Citation index spec',
        mediaType: spec.mediaType,
        size: spec.size,
        at: spec.createdAt,
        stage: 'in_progress',
      },
    ],
  });
  assert.deepEqual(brief?.kind === 'links' && brief.rows, [
    { to: { route: `/artifacts/${spec.id}` }, name: 'Citation index spec' },
  ]);
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
  ].filter((text) => !/^(work:|\/|merv\/work\/)/.test(text));
  for (const id of [f.producer.caller.actorId, task.id, prerequisite.id, dependent.id, spec.id])
    assert.equal(
      everything.find((text) => text.includes(id)),
      undefined,
      `${id} is printed`,
    );
});

test('a task’s unit reads its delivery once there is one, and tells each round in its history', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  const pending = await f.deliver(task);
  const delivered = (await f.panel(task)).unit!;
  assert.equal(delivered.key?.label, 'Delivery');
  assert.equal(delivered.key?.state, 'in_review');
  assert.match(delivered.key?.artifact?.title ?? '', /^Evidence \d+$/);
  // Until a verdict, each check stands as the delivery claimed it.
  assert.deepEqual(
    delivered.checks?.map(({ met }) => met),
    task.checks.map(() => true),
  );
  assert.deepEqual(delivered.history?.[0], {
    role: 'producer',
    stage: 'in_progress',
    actor: delivered.history?.[0]?.actor,
    at: delivered.history?.[0]?.at,
    said: 'Delivered',
    artifact: delivered.key?.artifact,
    // And beside its report, the records of the commit and the claims it delivered.
    files: delivered.history?.[0]?.files,
  });
  assert.deepEqual(
    delivered.history?.[0]?.files?.map((file) => file.title.split(':')[0]),
    ['Delivered commit', 'Delivery confirmations'],
  );
  assert.equal(delivered.history?.at(-1)?.role, 'reviewer');

  await f.verdict(pending, 'needs_changes');
  const returned = (await f.panel(task)).unit!;
  assert.equal(returned.key?.state, 'needs_changes');
  assert.deepEqual(
    returned.history?.map((entry) => entry.said ?? entry.verdict?.word),
    ['Delivered', 'needs_changes', 'Returned to in progress'],
  );
  const judged = returned.history?.[1];
  assert.equal(judged?.role, 'reviewer');
  assert.equal(judged?.stage, 'in_review');
  // The task's checks and the delivery report's format criterion.
  assert.equal(judged?.verdict?.of, task.checks.length + 1);
});

test('a delivery’s post names every file it handed in, its report first', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  await f.deliver(task, 2);
  const [post] = (await f.panel(task)).unit!.history!;
  assert.match(post!.artifact?.title ?? '', /^Evidence \d+$/);
  const titles = post!.files?.map((file) => file.title) ?? [];
  assert.ok(titles.includes('Table 1') && titles.includes('Table 2'), titles.join(', '));
  assert.ok(!titles.includes(post!.artifact!.title), 'the report is not named twice');
});

test('a task’s record page reads its history alone, never the whole sidebar', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  await f.verdict(await f.deliver(task, 1), 'needs_changes');
  const told = (await f.panel(task)).unit!.history;
  // The record page's poll draws no sidebar of the task's.
  const tasks = f.app.ctx.tasks as { runningPanel: unknown };
  const panel = tasks.runningPanel;
  tasks.runningPanel = () => assert.fail('the record page read the whole sidebar');
  t.after(() => void (tasks.runningPanel = panel));
  const read = await f.tool('ui.read', f.boot.token, { rowId: 'tasks', params: { id: task.id } });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.result.history, told);
  assert.equal(told?.length, 3);
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

test('a task naming a review Reviews does not hold is drawn without it, and the rest of the lane with it', async (t) => {
  const f = await fixture(t);
  const ready = await f.create('Collect source archive');
  const dangling = await f.create('Rebuild citation index');
  await f.deliver(dangling);
  await f.app.ctx.state.transaction(
    async (tx) =>
      await tx.run('UPDATE tasks SET review_id=? WHERE id=?', 'review_gone', dangling.id),
  );
  const answer = await f.board();
  assert.deepEqual(answer.lanes.work.failed, []);
  const find = (task: { id: string }) =>
    answer.lanes.work.nodes.find(({ key }) => key === `work:${task.id}`);
  assert.deepEqual(find(ready)?.lines, [['Ready']]);
  assert.deepEqual(find(dangling)?.lines, [['In review']]);
  assert.equal(find(dangling)?.attention, undefined);
});

test('the board reads what every task waits on, and its review rounds, once for all of them and never what waits on it', async (t) => {
  const f = await fixture(t);
  const source = await f.create('Collect source archive');
  const second = await f.create('Normalise author names');
  const waiting = await f.create('Rebuild citation index', { dependsOn: [source.id] });
  const both = await f.create('Draft section 3.2', { dependsOn: [source.id, second.id] });
  const reviewed = await f.create('Check figure units');
  // Every round the default allows is used.
  for (let round = 0; round < 3; round++)
    await f.verdict(await f.deliver(reviewed), 'needs_changes');
  await f.deliver(reviewed);
  const tasks = [source, second, waiting, both, reviewed];

  // What the board reads for all of them at once is what each one's own read says.
  const workflows = f.app.ctx.workflows;
  await f.app.ctx.state.transaction(async (tx) => {
    const waitsOn = await workflows.prerequisites(
      f.operator,
      tasks.map(({ id }) => id),
      tx,
    );
    for (const task of tasks)
      assert.deepEqual(
        waitsOn.get(task.id),
        (await workflows.prerequisites(f.operator, [task.id], tx)).get(task.id)!,
        task.title,
      );
  });

  const calls: string[] = [];
  const spied = workflows as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['records', 'prerequisites', 'limitStatusOf']) {
    const original = spied[name]!;
    spied[name] = function (this: unknown, ...args: unknown[]) {
      calls.push(name);
      return original.apply(this, args);
    };
    t.after(() => void (spied[name] = original));
  }
  const nodes = await f.app.ctx.tasks.running(f.operator);
  // Rounds used up are Workflows' own mark, never counted again by Tasks.
  assert.deepEqual(calls.sort(), ['prerequisites']);
  assert.equal(nodes.length, tasks.length);
  const answer = await f.board();
  const find = (task: { id: string }) =>
    answer.lanes.work.nodes.find(({ key }) => key === `work:${task.id}`);
  // Both prerequisites are declared in one create, so they share a timestamp and either may be
  // the one named first; the card names one of them and counts the other.
  const [[lead, named, rest] = []] = find(both)?.lines ?? [];
  assert.equal(lead, 'Waits on ');
  assert.ok(
    ['Collect source archive', 'Normalise author names'].includes(named as string),
    `the card names a prerequisite, not ${String(named)}`,
  );
  assert.equal(rest, ' and 1 more');
  assert.deepEqual(find(reviewed)?.attention?.says, [
    'Every round of ',
    { mono: 'review_rounds' },
    ' is used · ',
    { count: 3 },
  ]);
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
      who: 'An operator provides one.',
      to: { route: '/reviews/review_1', text: 'Open the review' },
    },
  );
  // Rounds used up, and waiting suspended for another, are Workflows' mark, not the task's red.
  assert.equal(attention({ state: 'suspended', review: null }), undefined);
  assert.deepEqual(taskNode({ ...task, state: 'suspended', review: null }).lines, [['Suspended']]);
  // An ended task needs nobody, whatever it last stood at.
  assert.equal(attention({ state: 'done' }), undefined);
  assert.deepEqual(taskNode({ ...task, state: 'failed' }).lines, [[], ['Failed']]);
  // A long title is cut to what the page holds, and the card still stands.
  const long = taskNode({ ...task, title: 'x'.repeat(300) }).title;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('the sidebar draws its ladder without running any action’s check', async (t) => {
  const f = await fixture(t);
  const task = await f.create('Rebuild citation index');
  await f.deliver(task);
  const workflows = f.app.ctx.workflows;
  const process = workflows.process;
  const asked: unknown[] = [];
  workflows.process = async (caller, instanceId, options, tx) => {
    asked.push(options);
    return await process.call(workflows, caller, instanceId, options, tx);
  };
  try {
    assert.equal((await f.panel(task)).sections[0]?.kind, 'ladder');
  } finally {
    workflows.process = process;
  }
  assert.deepEqual(asked, [{ checks: false }]);
});
