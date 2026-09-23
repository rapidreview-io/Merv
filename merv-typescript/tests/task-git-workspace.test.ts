import { createService } from '@merv/contracts';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import type {
  Caller,
  Data,
  SessionWorkspace,
  Task,
  TaskDelivery,
  TaskReview,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { DiskBlobs } from '@merv/blobs';
import { ArtifactStore } from '@merv/artifacts';
import { WorkflowsService } from '@merv/workflows';
import { ReviewService } from '@merv/reviews';
import { RecipeContextBuilder } from '@merv/context-builder';
import { TaskService } from '@merv/tasks';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CodeService } from '@merv/code-research/service';
import { boundProject } from './fixtures/code-binding.js';
import { confirmedDelivery, reviewedFindings } from './fixtures/task-evidence.js';
import { openState } from './fixtures/state.js';

const oid = (char: string) => char.repeat(40);

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-git-'));
  const state = await openState(directory);
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
  const code = await createService(new CodeService(state, scope, sessions, artifacts, workflows));
  const unbindCode = tasks.bindCode(code);
  const boot = await scope.bootstrap({ projectName: 'Git tasks', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  // Main is where every lease below attaches unless it names another base.
  await boundProject(state, source.projectId, oid('a'));
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
  /** A leased reviewer; the runner attaches its read-only checkout at the frozen reference. */
  const leaseReview = async (task: Task) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await sessions.offer(reviewer, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId: 'task-git-test',
      requestId: request(),
      secret,
    });
    const control = { sessionId: session.id, runnerId: 'task-git-test', hostRef: 'review-launch' };
    const checkout = (baseOid: string): SessionWorkspace => ({
      repositoryId: 'runner-private-repository',
      workspaceId: `task-reviews-${session.id}`,
      mode: 'ephemeral',
      branch: null,
      baseOid,
      headOid: baseOid,
      stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    });
    return { session, control, checkout, worker: await sessions.authenticate(secret) };
  };
  const verdict = async (caller: Caller, task: Task, value: 'pass' | 'needs_changes') => {
    const review = await reviews.get(caller, task.reviewId!);
    const input = {
      ...reviewedFindings(review),
      reviewId: review.id,
      claimId: review.claimId!,
      verdict: value,
      notes: 'Checked out the delivered commit and ran the harness.',
      expectedRevision: task.workflow.revision,
      requestId: request(),
    } as Data;
    return caller.session
      ? await run(
          caller,
          'review.submit',
          input,
          async (worker, bound) => await tasks.submitReview(worker, bound as unknown as TaskReview),
        )
      : await tasks.submitReview(caller, input as unknown as TaskReview);
  };
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
  const release = async (sessionId: string, caller = source) => {
    await sessions.release(caller, { sessionId, runnerId: 'task-git-test' });
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
    leaseReview,
    verdict,
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
  for (const state of ['in_progress', 'in_review'])
    assert.equal(Object.hasOwn(declared[`2/${state}`]!, 'workspace'), false);
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

test('A delivered commit is pinned for review as a rendered record, alone or beside files', async (t) => {
  const f = await fixture(t);
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
});

test('A Git task passes only from the leased review pinned to its delivered commit, which later work builds on', async (t) => {
  const f = await fixture(t);
  const task = await f.create({ workspace: 'git' });
  const based = await f.create({ workspace: 'git', baseTaskId: task.id, dependsOn: [task.id] });
  const relations = await f.workflows.dependencies(f.source, based.id);
  assert.deepEqual(
    relations.dependencies.map((dependency) => dependency.id),
    [task.id],
  );
  // Until the base is accepted the dependent work is not assignable at all.
  await assert.rejects(async () => await f.lease(based), { code: 'dependencies_pending' });

  const held = await f.lease(task);
  const commandId = await f.commit(held);
  await f.receipt(held, commandId);
  const delivered = await f.deliver(held, { artifactIds: [], commandId, confirmations: met() });
  await f.release(held.session.id);
  assert.ok(
    delivered.guidance.references.some(
      (reference) =>
        reference.id === delivered.deliveryCodeArtifactId && reference.label === 'Delivered commit',
    ),
  );

  // A reissue advances the task's revision without a new delivery; the commit stays reviewable.
  const reissued = await f.tasks.reissueReview(f.source, {
    taskId: task.id,
    expectedRevision: delivered.workflow.revision,
    reason: 'The first request named the wrong reviewer pool.',
    requestId: f.request(),
  });
  assert.equal(reissued.workflow.revision, delivered.workflow.revision + 1);
  assert.deepEqual(reissued.deliveryCode, delivered.deliveryCode);

  // Reviews admits an interactive claim without asking Tasks, so the guidance warns beforehand.
  const guidance = await f.workflows.evaluate(f.reviewer, task.id);
  assert.match(
    guidance.actions.find((action) => action.action === 'start_review')!.instruction,
    /only a leased review worker.*task\.reissue_review/,
  );
  assert.match(
    (await f.workflows.assignment(f.reviewer, task.id)).brief,
    /only a leased review worker.*task\.reissue_review/,
  );
  // An interactive reviewer has no checkout: it may return the task but never pass it, and its
  // claim shuts every leased reviewer out.
  const claimed = await f.reviews.start(f.reviewer, reissued.reviewId!);
  await assert.rejects(async () => await f.leaseReview(reissued), { code: 'review_unavailable' });
  assert.ok(claimed.artifactIds.includes(delivered.deliveryCodeArtifactId!));
  await assert.rejects(async () => await f.verdict(f.reviewer, reissued, 'pass'), {
    code: 'task_commit_unfetched',
  });
  assert.deepEqual(
    (
      await f.workflows.evaluate(f.reviewer, task.id, {
        action: 'submit_review',
        input: {
          ...reviewedFindings(claimed),
          reviewId: claimed.id,
          claimId: claimed.claimId!,
          verdict: 'pass',
          notes: 'Looks right.',
        },
      })
    ).blockers.map((blocker) => blocker.code),
    ['task_commit_unfetched'],
  );
  const returned = await f.verdict(f.reviewer, reissued, 'needs_changes');
  assert.equal(returned.workflow.state, 'in_progress');

  const successor = await f.lease(returned);
  const next = await f.commit(successor, oid('b'));
  await f.receipt(successor, next, oid('d'));
  const again = await f.deliver(successor, {
    artifactIds: [],
    commandId: next,
    confirmations: met(),
  });
  await f.release(successor.session.id);

  // The leased reviewer's frozen reference is the new head, and no other base attaches.
  const review = await f.leaseReview(again);
  assert.equal(review.session.execution.references.code, oid('d'));
  assert.equal(review.session.execution.policy.readOnly, true);
  assert.match(review.session.assignment.brief, /pinned to the exact delivered commit/);
  await assert.rejects(
    async () =>
      await f.sessions.attach(f.reviewer, {
        ...review.control,
        workspace: review.checkout(oid('b')),
      }),
    { code: 'workspace_base_conflict' },
  );
  // Holding the lease is not enough: until its runner attaches the checkout at the delivered
  // commit, nothing shows this reviewer could have fetched what it would accept.
  await assert.rejects(async () => await f.verdict(review.worker, again, 'pass'), {
    code: 'task_commit_unfetched',
  });
  await f.sessions.attach(f.reviewer, { ...review.control, workspace: review.checkout(oid('d')) });

  // Without Code the stored record still reads, but no verdict and no assignment is admitted.
  f.unbindCode();
  const unloaded = await f.tasks.get(f.source, task.id);
  assert.deepEqual(unloaded.deliveryCode, again.deliveryCode);
  await assert.rejects(async () => await f.verdict(review.worker, again, 'pass'), {
    code: 'code_unavailable',
  });
  const rebind = f.tasks.bindCode(f.code);
  t.after(rebind);

  // A returned round accepted nothing; only the pass does.
  assert.equal(await f.tasks.codeUnit(f.source, task.id), null);
  const done = await f.verdict(review.worker, again, 'pass');
  assert.equal(done.workflow.state, 'done');

  // The pass recorded the exact reviewed commit, written in the review's own transaction by a
  // leased reviewer whose record had just ended.
  const pinned = await f.reviews.get(f.source, again.reviewId!);
  const accepted = (await f.code.unit(f.source, task.id)).acceptance!;
  assert.deepEqual(
    { ...accepted, hash: '', acceptedAt: '' },
    {
      unitId: task.id,
      hash: '',
      acceptedAt: '',
      terminalRevision: done.workflow.revision,
      submissionRef: pinned.snapshotHash,
      reviewRef: pinned.id,
      acceptedBy: review.worker.actorId,
      reference: oid('d'),
      reviewAttached: true,
      storage: 'legacy-local',
    },
  );
  assert.equal((await f.code.unit(f.source, task.id)).base, null);
  // A scratch task passed by hand records that it succeeded without code.
  const scratch = await f.create();
  const note = await f.artifacts.create(f.source, { title: 'Note', content: 'Evidence.' });
  const handed = await f.tasks.submitDelivery(f.source, {
    ...confirmedDelivery({ taskId: scratch.id, artifactIds: [note.id] }),
    expectedRevision: 0,
    requestId: f.request(),
  });
  await f.reviews.start(f.reviewer, handed.reviewId!);
  const finished = await f.verdict(f.reviewer, handed, 'pass');
  const plain = (await f.code.unit(f.source, scratch.id)).acceptance!;
  assert.deepEqual(
    [plain.reference, plain.reviewAttached, plain.storage, plain.acceptedBy],
    [null, null, 'none', f.reviewer.actorId],
  );

  const accept = async (input: Data) =>
    await f.state.transaction(
      async (tx) =>
        await f.code.acceptUnit(
          f.reviewer,
          input as unknown as Parameters<typeof f.code.acceptUnit>[1],
          tx,
        ),
    );
  const same = {
    unitId: scratch.id,
    terminalRevision: finished.workflow.revision,
    submissionRef: plain.submissionRef,
    reviewRef: plain.reviewRef,
    codeRef: null,
    reviewSessionId: null,
  };
  assert.deepEqual(await accept(same), plain, 'an equal acceptance replays');
  await assert.rejects(async () => await accept({ ...same, reviewRef: 'another-review' }), {
    code: 'code_acceptance_conflict',
  });
  // Neither a revision the unit did not succeed at, nor work that has not succeeded, nor
  // another unit's commit can be accepted, whoever asks.
  for (const refused of [
    { ...same, terminalRevision: finished.workflow.revision - 1 },
    { ...same, unitId: based.id, terminalRevision: 0 },
    { ...same, codeRef: again.deliveryCode!.ref },
  ])
    await assert.rejects(async () => await accept(refused), {
      code: 'code_acceptance_unverifiable',
    });
  assert.deepEqual((await f.code.unit(f.source, task.id)).acceptance, accepted);
  const status = await f.code.status(f.source);
  assert.equal(status.project!.main.oid, oid('a'));
  // The task with an explicit base is version 4, which Code hears of only when it is accepted.
  assert.deepEqual(status.units.map((unit) => unit.unitId).sort(), [task.id, scratch.id].sort());
  await f.release(review.session.id, f.reviewer);

  // The accepted commit is the frozen base of the task created on it.
  const dependent = await f.lease(await f.tasks.get(f.source, based.id), oid('d'));
  assert.equal(dependent.session.execution.references.base, oid('d'));
  assert.equal(
    (dependent.session.execution.policy.workspace as { base: string }).base,
    'reference:base',
  );
  const other = await f.create({ workspace: 'git', baseTaskId: task.id, dependsOn: [task.id] });
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const offered = await f.sessions.offer(f.source, {
    instanceId: other.id,
    expectedRevision: other.workflow.revision,
    runnerId: 'task-git-test',
    requestId: f.request(),
    secret,
  });
  await assert.rejects(
    async () =>
      await f.sessions.attach(f.source, {
        sessionId: offered.id,
        runnerId: 'task-git-test',
        hostRef: 'launch',
        workspace: { ...dependent.workspace, workspaceId: `tasks-${other.id}`, baseOid: oid('a') },
      }),
    { code: 'workspace_base_conflict' },
  );
});

test('An unhosted Git task runs on the central-base version and records its legacy acceptance', async (t) => {
  const f = await fixture(t);
  const task = await f.create({ workspace: 'git' });
  assert.equal(task.workflow.version, 3);
  assert.equal(task.workspace, 'git');
  assert.equal(
    await f.tasks.codeUnit(f.source, task.id),
    null,
    'Code is told of no base to derive',
  );

  const held = await f.lease(task);
  assert.equal((held.session.execution.policy.workspace as { base: string }).base, 'central');
  assert.equal(Object.hasOwn(held.session.execution.references, 'base'), false);
  const commandId = await f.commit(held);
  await f.receipt(held, commandId);
  const delivered = await f.deliver(held, { artifactIds: [], commandId, confirmations: met() });
  await f.release(held.session.id);
  const review = await f.leaseReview(delivered);
  assert.equal(review.session.execution.references.code, oid('b'));
  await f.sessions.attach(f.reviewer, { ...review.control, workspace: review.checkout(oid('b')) });
  const done = await f.verdict(review.worker, delivered, 'pass');
  assert.equal(done.workflow.state, 'done');
  await f.release(review.session.id, f.reviewer);

  // The pass is recorded like any other, and no base was ever pinned for the old version.
  const unit = await f.code.unit(f.source, task.id);
  assert.equal(unit.version, 3);
  assert.equal(unit.base, null);
  assert.deepEqual(
    [
      unit.acceptance!.reference,
      unit.acceptance!.reviewAttached,
      unit.acceptance!.storage,
      unit.acceptance!.terminalRevision,
    ],
    [oid('b'), true, 'legacy-local', done.workflow.revision],
  );
  const next = await f.create({ workspace: 'git', dependsOn: [task.id] });
  assert.equal(next.workflow.version, 3);
  assert.equal((await f.lease(next)).session.execution.references.base, undefined);
});

test('A project imported into Code while a Git task is under way lets that task finish as it began, and only new work names Code’s driver', async (t) => {
  const f = await fixture(t);
  const task = await f.create({ workspace: 'git' });
  assert.equal(task.workflow.version, 3);
  const held = await f.lease(task);
  // The import: a fact of the database alone, which never turns false again.
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET store_json=? WHERE project_id=?',
      JSON.stringify({ format: 1, objectFormat: 'sha1', rootOid: oid('a') }),
      f.source.projectId,
    );
  });

  // The runner that keeps this task's history still completes its commit and its acceptance.
  const commandId = await f.commit(held);
  await f.receipt(held, commandId, oid('d'));
  const delivered = await f.deliver(held, { artifactIds: [], commandId, confirmations: met() });
  await f.release(held.session.id);
  const review = await f.leaseReview(delivered);
  await f.sessions.attach(f.reviewer, { ...review.control, workspace: review.checkout(oid('d')) });
  assert.equal((await f.verdict(review.worker, delivered, 'pass')).workflow.state, 'done');
  const unit = await f.code.unit(f.source, task.id);
  assert.deepEqual(
    [unit.acceptance!.storage, unit.acceptance!.receipt, unit.generation, unit.writerState],
    ['legacy-local', undefined, 0, 'idle'],
  );

  // New Git work lives in Code; work that names a base task is still the explicit legacy form.
  const hosted = await f.create({ workspace: 'git' });
  assert.equal(hosted.workflow.version, 5);
  const based = await f.create({ workspace: 'git', baseTaskId: task.id, dependsOn: [task.id] });
  assert.equal(based.workflow.version, 4);
  assert.equal((await f.create()).workflow.version, 2);
  // Main is named but Code does not hold it, so the hosted task is blocked, never launched.
  await assert.rejects(async () => await f.lease(hosted), { code: 'code_base_pending' });
  await f.state.transaction(async (tx) => {
    await tx.run(
      'UPDATE code_projects SET main_json=? WHERE project_id=?',
      JSON.stringify({ oid: oid('a'), operationId: 'cop_fixture', stored: true }),
      f.source.projectId,
    );
  });
  const execution = await f.workflows.execution(f.source, {
    instanceId: hosted.id,
    expectedRevision: hosted.workflow.revision,
  });
  assert.deepEqual(
    execution.policy.workspace?.mode === 'persistent' && execution.policy.workspace.driver,
    'code.v2',
  );
  assert.ok(execution.policy.tools.some((tool) => tool.name === 'code.commit'));
});
