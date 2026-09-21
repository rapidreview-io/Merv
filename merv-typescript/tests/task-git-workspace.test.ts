import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import type { Caller, Data, SessionWorkspace, Task, TaskDelivery } from '@merv/contracts';
import { PostgresState, SqliteState } from '@merv/state';
import { Pool } from 'pg';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code/service';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';

const oid = (char: string) => char.repeat(40);

async function fixture(t: TestContext, postgres = false) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-git-'));
  const connectionString = process.env.MERV_TEST_POSTGRES_URL!,
    schema = `task_git_${randomUUID().replaceAll('-', '')}`;
  const state = postgres
    ? await PostgresState.open({ connectionString, schema })
    : new SqliteState(join(directory, 'state.sqlite'));
  const scope = await createService(new ProjectScope(state));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const workflows = await createService(new WorkflowsService(state, scope));
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const builder = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, builder),
  );
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, { sweepIntervalMs: 60_000 }),
  );
  const code = await createService(new CodeService(state, scope, sessions, artifacts));
  const unbindCode = tasks.bindCode(code);
  const boot = await scope.bootstrap({ projectName: 'Git tasks', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(source, { name: 'reviewer', role: 'reviewer' });
  const reviewer: Caller = {
    projectId: source.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  let sequence = 0;
  const request = () => `request-${++sequence}`;
  const create = async (extra: Data = {}) =>
    await tasks.create(source, {
      title: `Harness ${++sequence}`,
      goal: 'Build the evaluation harness as a repository.',
      checks: ['The harness runs end to end'],
      requestId: request(),
      ...extra,
    } as Parameters<typeof tasks.create>[1]);
  const run = async <T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (worker: Caller, bound: Data) => T | Promise<T>,
  ) => sessions.run(await sessions.prepare(caller, tool, input), handler);
  /** A leased producer attached to its private checkout, as the runner leaves it at launch. */
  const lease = async (task: Task, baseOid = oid('a')) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(source, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId: 'task-git-test',
      requestId: request(),
      secret,
    });
    const control = { sessionId: session.id, runnerId: 'task-git-test', hostRef: 'launch' };
    const workspace: SessionWorkspace = {
      repositoryId: 'runner-private-repository',
      workspaceId: `tasks-${task.id}`,
      mode: 'persistent',
      branch: 'merv/task',
      baseOid,
      headOid: baseOid,
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    };
    await sessions.attach(source, { ...control, workspace });
    return { session, control, workspace, worker: await sessions.authenticate(secret) };
  };
  type Lease = Awaited<ReturnType<typeof lease>>;
  const commit = async (held: Lease, expectedHead = held.workspace.baseOid) =>
    (
      await run(
        held.worker,
        'code.commit',
        { expectedHead, message: 'Record the harness', requestId: request() },
        async (caller, input) =>
          await code.commit(
            caller,
            input as unknown as { expectedHead: string; message: string; requestId: string },
          ),
      )
    ).command.id;
  /** The runner's side of a commit: it takes the queued command and answers with a receipt. */
  const receipt = async (held: Lease, commandId: string, headOid = oid('b')) => {
    const command = (await code.nextCommand(source, held.control))!;
    assert.equal(command.id, commandId);
    await code.completeCommand(source, {
      ...held.control,
      commandId,
      receipt: {
        commandId,
        repositoryId: held.workspace.repositoryId,
        workspaceId: held.workspace.workspaceId,
        baseOid: held.workspace.baseOid,
        parentOid: command.expectedHead,
        headOid,
        treeOid: oid('c'),
        stats: { commitCount: 1, filesChanged: 3, insertions: 40, deletions: 0 },
      },
    });
  };
  const deliver = async (held: Lease, input: Data) =>
    await run(
      held.worker,
      'task.submit_delivery',
      { requestId: request(), ...input },
      async (caller, bound) => await tasks.submitDelivery(caller, bound as unknown as TaskDelivery),
    );
  const release = async (sessionId: string) => {
    await sessions.release(source, { sessionId, runnerId: 'task-git-test' });
    await events.drain();
  };
  t.after(async () => {
    unbindCode();
    code.close();
    await sessions.close();
    tasks.dispose();
    await events.close();
    reviews.close();
    workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
    if (postgres) {
      const pool = new Pool({ connectionString });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  return {
    state,
    artifacts,
    workflows,
    reviews,
    tasks,
    sessions,
    code,
    source,
    reviewer,
    request,
    create,
    run,
    lease,
    commit,
    receipt,
    deliver,
    release,
    unbindCode,
  };
}

const met = (evidenceIds: string[] = []) => [
  { checkNumber: 1, status: 'met' as const, evidenceIds, notes: 'Ran the harness on the fixture.' },
];

test('A task’s workflow version carries its Git workspace and the scratch versions declare none', async (t) => {
  const f = await fixture(t);
  const policy = async (task: Task) =>
    (
      await f.workflows.execution(f.source, {
        instanceId: task.id,
        expectedRevision: task.workflow.revision,
      })
    ).policy;
  const scratchInput = {
    title: 'Scratch',
    goal: 'Write a note.',
    checks: ['The note exists'],
    requestId: f.request(),
  };
  const scratch = await f.tasks.create(f.source, scratchInput);
  assert.equal(scratch.workflow.version, 2);
  assert.equal(Object.hasOwn(scratch, 'workspace'), false);
  assert.equal(Object.hasOwn(scratch.workflow.data, 'workspace'), false);
  assert.equal((await policy(scratch)).workspace, undefined);
  assert.equal(
    (await policy(scratch)).tools.some((tool) => tool.name.startsWith('code.')),
    false,
  );
  assert.deepEqual(
    await f.tasks.create(f.source, scratchInput),
    scratch,
    'A replay of an earlier create has not acquired a workspace field',
  );
  assert.deepEqual(scratch.guidance.actions[0]!.requiredInput, ['artifactIds', 'confirmations']);

  const gitInput = {
    title: 'Harness',
    goal: 'Build the harness.',
    checks: ['It runs'],
    workspace: 'git' as const,
    requestId: f.request(),
  };
  const git = await f.tasks.create(f.source, gitInput);
  assert.equal(git.workflow.version, 3);
  assert.equal(git.workspace, 'git');
  assert.deepEqual(await f.tasks.create(f.source, gitInput), git);
  await assert.rejects(
    async () => await f.tasks.create(f.source, { ...gitInput, workspace: 'none' }),
    { code: 'request_conflict' },
  );
  assert.deepEqual(git.guidance.actions[0]!.requiredInput, [
    'artifactIds',
    'commandId',
    'confirmations',
  ]);
  const brief = await f.artifacts.read(f.source, git.briefId);
  assert.match(brief.content, /code\.commit/);
  assert.doesNotMatch((await f.artifacts.read(f.source, scratch.briefId)).content, /code\.commit/);
  const work = await policy(git);
  assert.deepEqual(work.workspace, {
    mode: 'persistent',
    namespace: 'tasks',
    base: 'central',
    perBase: false,
    retain: true,
    advancesCentral: false,
  });
  assert.equal(work.readOnly, false);
  for (const name of ['code.commit', 'code.operation'])
    assert.ok(work.tools.some((tool) => tool.name === name));
  const assignment = await f.workflows.assignment(f.source, git.id);
  assert.match(assignment.brief, /This is a Git task/);

  await assert.rejects(async () => await f.create({ baseTaskId: git.id, dependsOn: [git.id] }), {
    code: 'invalid_workspace',
  });
  await assert.rejects(async () => await f.create({ workspace: 'git', baseTaskId: git.id }), {
    code: 'invalid_workspace_base',
  });
  await assert.rejects(
    async () =>
      await f.create({ workspace: 'git', baseTaskId: scratch.id, dependsOn: [scratch.id] }),
    { code: 'invalid_workspace_base' },
  );
  await assert.rejects(
    async () => await f.create({ workspace: 'git', baseTaskId: 'missing', dependsOn: [git.id] }),
    { code: 'invalid_workspace_base' },
  );
  const based = await f.create({ workspace: 'git', baseTaskId: git.id, dependsOn: [git.id] });
  assert.equal(based.workflow.version, 4);
  assert.equal(based.baseTaskId, git.id);
  assert.equal(based.workflow.version, (await f.tasks.get(f.source, based.id)).workflow.version);
  const stored = await f.workflows.get(f.source, based.id);
  assert.equal(stored.data.workspace, 'git');
  assert.equal(stored.data.baseTaskId, git.id);

  // The policies are registered per version, so a Git version's review is a pinned checkout.
  const policies = await f.state.read(
    async (sql) =>
      await sql.all<{ version: number; state: string; manifest_json: string }>(
        "SELECT version,state,manifest_json FROM wf_execution_policies WHERE workflow='task' ORDER BY version,state",
      ),
  );
  const declared = Object.fromEntries(
    policies.map((row) => [`${row.version}/${row.state}`, JSON.parse(row.manifest_json) as Data]),
  );
  for (const version of [1, 2])
    for (const state of ['in_progress', 'in_review'])
      assert.equal(Object.hasOwn(declared[`${version}/${state}`]!, 'workspace'), false);
  assert.equal((declared['4/in_progress']!.workspace as Data).base, 'reference:base');
  for (const version of [3, 4]) {
    const review = declared[`${version}/in_review`]!;
    assert.equal(review.readOnly, true);
    assert.deepEqual(review.workspace, {
      mode: 'ephemeral',
      namespace: 'task-reviews',
      base: 'reference:code',
      retain: false,
    });
    assert.equal(
      (review.tools as { name: string }[]).some((tool) => tool.name.startsWith('code.')),
      false,
    );
  }
});

test('A Git task delivers only its own worker’s receipted commit, and a scratch task none', async (t) => {
  const f = await fixture(t);
  const scratch = await f.create();
  const note = await f.artifacts.create(f.source, { title: 'Note', content: 'Evidence.' });
  await assert.rejects(
    async () =>
      await f.tasks.submitDelivery(f.source, {
        ...confirmedDelivery({ taskId: scratch.id, artifactIds: [note.id] }),
        commandId: 'command-1',
        expectedRevision: 0,
        requestId: f.request(),
      }),
    { code: 'task_commit_required' },
  );
  await assert.rejects(
    async () =>
      await f.tasks.submitDelivery(f.source, {
        taskId: scratch.id,
        artifactIds: [],
        confirmations: met(),
        expectedRevision: 0,
        requestId: f.request(),
      }),
    { code: 'invalid_delivery' },
  );

  const task = await f.create({ workspace: 'git' });
  const preflight = async (caller: Caller, input: Data) =>
    (
      await f.workflows.evaluate(caller, task.id, {
        action: 'submit_delivery',
        input: { taskId: task.id, expectedRevision: 0, ...input },
      })
    ).blockers.map((blocker) => blocker.code);
  // An interactive producer holds no checkout and so has no commit of its own to deliver.
  await assert.rejects(
    async () =>
      await f.tasks.submitDelivery(f.source, {
        ...confirmedDelivery({ taskId: task.id, artifactIds: [note.id] }),
        commandId: 'command-1',
        expectedRevision: 0,
        requestId: f.request(),
      }),
    { code: 'task_commit_required' },
  );
  assert.deepEqual(await preflight(f.source, { artifactIds: [], confirmations: met() }), [
    'task_commit_required',
  ]);

  const other = await f.create({ workspace: 'git' });
  const elsewhere = await f.lease(other);
  const foreign = await f.commit(elsewhere);
  await f.receipt(elsewhere, foreign);

  const held = await f.lease(task);
  await assert.rejects(
    async () => await f.deliver(held, { artifactIds: [], confirmations: met() }),
    { code: 'task_commit_required' },
  );
  await assert.rejects(
    async () =>
      await f.deliver(held, { artifactIds: [], commandId: foreign, confirmations: met() }),
    { code: 'task_commit_provenance' },
  );
  const commandId = await f.commit(held);
  await assert.rejects(
    async () => await f.deliver(held, { artifactIds: [], commandId, confirmations: met() }),
    { code: 'task_commit_pending' },
  );
  assert.deepEqual(
    await preflight(held.worker, { artifactIds: [], commandId, confirmations: met() }),
    ['task_commit_pending'],
  );
  await f.code.nextCommand(f.source, held.control);
  await f.code.completeCommand(f.source, {
    ...held.control,
    commandId,
    error: 'index_locked',
  });
  await assert.rejects(
    async () => await f.deliver(held, { artifactIds: [], commandId, confirmations: met() }),
    { code: 'task_commit_failed' },
  );

  // A successor may not deliver the commit its predecessor made: it commits again itself.
  const second = await f.commit(held);
  await f.receipt(held, second);
  await f.release(held.session.id);
  const successor = await f.lease(task);
  await assert.rejects(
    async () =>
      await f.deliver(successor, { artifactIds: [], commandId: second, confirmations: met() }),
    { code: 'task_commit_provenance' },
  );

  // Without Code a Git task cannot move, while its record and every scratch task still read.
  f.unbindCode();
  await assert.rejects(async () => await f.create({ workspace: 'git' }), {
    code: 'code_unavailable',
  });
  assert.equal((await f.tasks.get(f.source, task.id)).workspace, 'git');
  assert.equal((await f.create()).workflow.version, 2);
});

// The delivery queries are built in one place for both backends, and an empty list or a
// history match reads differently on each, so the whole round runs on both.
for (const postgres of [false, true])
  test(
    `A delivered commit is pinned for review as a rendered record, alone or beside files (${postgres ? 'PostgreSQL' : 'SQLite'})`,
    { skip: postgres && !process.env.MERV_TEST_POSTGRES_URL },
    async (t) => await pinnedDelivery(t, postgres),
  );

async function pinnedDelivery(t: TestContext, postgres: boolean) {
  const f = await fixture(t, postgres);
  const task = await f.create({ workspace: 'git' });
  const held = await f.lease(task);
  const commandId = await f.commit(held);
  await f.receipt(held, commandId);
  const input = { artifactIds: [], commandId, confirmations: met(), requestId: f.request() };
  const delivered = await f.deliver(held, input);
  assert.equal(delivered.workflow.state, 'in_review');
  assert.deepEqual(delivered.deliveryCode, {
    ref: { kind: 'code-commit', commandId },
    sessionId: held.session.id,
    revision: 0,
    headOid: oid('b'),
    treeOid: oid('c'),
  });
  assert.deepEqual(delivered.deliveryIds, [
    delivered.deliveryCodeArtifactId,
    delivered.deliveryAssessmentId,
  ]);
  assert.equal(Object.hasOwn(delivered.workflow.data, 'deliveryCode'), false);
  // A met claim that cited nothing is recorded against the commit record, a real artifact.
  assert.deepEqual(delivered.deliveryConfirmations[0]!.evidenceIds, [
    delivered.deliveryCodeArtifactId,
  ]);
  const record = await f.artifacts.read(f.source, delivered.deliveryCodeArtifactId!);
  assert.match(record.content, new RegExp(`Commit: ${oid('b')}`));
  assert.match(record.content, new RegExp(`Code operation: ${commandId}`));
  const review = await f.reviews.get(f.source, delivered.reviewId!);
  assert.deepEqual(review.artifactIds, [task.briefId, ...delivered.deliveryIds]);

  // Returned for changes, the successor re-enters the checkout and delivers a commit of its own,
  // with a file beside it; neither rendered record of the first round may come back as evidence.
  await f.release(held.session.id);
  const claimed = await f.reviews.start(f.reviewer, review.id);
  const returned = await f.tasks.submitReview(f.reviewer, {
    ...reviewedFindings(claimed),
    reviewId: claimed.id,
    claimId: claimed.claimId!,
    verdict: 'needs_changes',
    notes: 'The harness skips the last fixture; include it.',
    expectedRevision: delivered.workflow.revision,
    requestId: f.request(),
  } as Parameters<typeof f.tasks.submitReview>[1]);
  assert.equal(returned.workflow.state, 'in_progress');
  const successor = await f.lease(returned, oid('a'));
  const next = await f.commit(successor, oid('b'));
  await f.receipt(successor, next, oid('d'));
  await assert.rejects(
    async () =>
      await f.deliver(successor, {
        artifactIds: [delivered.deliveryCodeArtifactId!],
        commandId: next,
        confirmations: met(),
      }),
    { code: 'invalid_delivery' },
  );
  const log = await f.run(
    successor.worker,
    'artifact.create',
    { title: 'Run log', content: 'All fixtures pass.' },
    async (caller, bound) =>
      await f.artifacts.create(caller, bound as unknown as { title: string; content: string }),
  );
  const again = await f.deliver(successor, {
    artifactIds: [log.id],
    commandId: next,
    confirmations: met([log.id]),
  });
  assert.equal(again.deliveryCode!.headOid, oid('d'));
  assert.equal(again.deliveryCode!.revision, returned.workflow.revision);
  assert.deepEqual(again.deliveryIds, [
    log.id,
    again.deliveryCodeArtifactId,
    again.deliveryAssessmentId,
  ]);
  assert.notEqual(again.deliveryCodeArtifactId, delivered.deliveryCodeArtifactId);
  assert.deepEqual(again.deliveryConfirmations[0]!.evidenceIds, [log.id]);
  assert.deepEqual((await f.reviews.get(f.source, again.reviewId!)).artifactIds, [
    task.briefId,
    ...again.deliveryIds,
  ]);
}
