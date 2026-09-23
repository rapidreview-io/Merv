import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  check,
  effectiveWorkspace,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
  type WorkflowWorkspacePolicy,
} from '@merv/contracts';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { executionFingerprint, validateExecution } from '@merv/workflows/execution';
import { createApp } from './fixtures/app.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { countWrites, openState } from './fixtures/state.js';

const definition = (name: string, version = 1): WorkflowDefinition => ({
  name,
  version,
  initial: 'work',
  states: ['work', 'done'],
  terminal: ['done'],
  edges: [{ from: 'work', action: 'finish', to: 'done' }],
});
const poison = (): never => {
  throw new Error('Discovery must not render, resolve inputs, reserve, or evaluate exit actions');
};
async function fixture(t: TestContext) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.bootstrap({ projectName: 'Dispatch', actorName: 'Owner' });
  const source: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  let exitsAllowed = true;
  const rules = (
    execution: WorkflowExecutionPolicy,
    sourceCheck?: (tx: Transaction) => void | Promise<void>,
  ): WorkflowPolicy => ({
    successStates: ['done'],
    describe: poison,
    actions: [
      {
        name: 'finish',
        tool: 'finish',
        states: ['work'],
        transitions: ['finish'],
        instruction: 'Finish',
        check: () => {
          if (!exitsAllowed) poison();
        },
      },
    ],
    assignments: [
      {
        state: 'work',
        requiresDependencies: true,
        check: poison,
        build: poison,
        references: poison,
        execution,
        lease: {
          label: ({ snapshot }) => String(snapshot.data.title || snapshot.workflow),
          role: async ({ caller, snapshot, tx }) => {
            await scope.require(caller, execution.readOnly ? 'review' : 'write', tx);
            check(snapshot.data.allowed !== false, 'not_ready', 'Inputs are not ready', 409);
            await sourceCheck?.(tx);
            return execution.readOnly ? 'reviewer' : 'producer';
          },
          acquire: poison,
          check: poison,
          outputs: poison,
          release: poison,
        },
      },
    ],
  });
  let sequence = 0;
  const register = async (name: string, readOnly = false, workspace?: WorkflowWorkspacePolicy) => {
    const policy = rules({ readOnly, tools: [], ...(workspace ? { workspace } : {}) });
    const handle = await workflows.register(definition(name), policy);
    const start = async (data: Data = {}, dependsOn?: string[]) =>
      await handle.start(source, {
        workflow: name,
        requestId: `start-${++sequence}`,
        data,
        ...(dependsOn ? { dependsOn } : {}),
      });
    return { handle, policy, start };
  };
  return {
    state,
    scope,
    workflows,
    source,
    rules,
    register,
    forbidExits: () => {
      exitsAllowed = false;
    },
  };
}

test('dispatch discovers only metadata and prioritizes read-only candidates without changing durable state', async (t) => {
  const f = await fixture(t);
  const work = await f.register('work');
  const review = await f.register('verify', true, {
    mode: 'ephemeral',
    namespace: 'reviews',
    base: 'reference:code',
    retain: false,
  });
  const one = await work.start({ title: 'First work' });
  const two = await work.start({ title: 'Second work' });
  const verifier = await review.start({ title: 'Independent verification' });
  f.forbidExits();
  // INSERT/UPDATE/DELETE statements issued through the state, rolled back or not.
  const writes = countWrites(f.state);
  const before = writes();
  const head = await f.state.eventHead();
  const candidates = await f.workflows.dispatchCandidates(f.source);
  const workOrder = await f.state.read(async (sql) =>
    (
      await sql.all<{ id: string }>(
        'SELECT id FROM wf_instances WHERE workflow=? ORDER BY created_at,id',
        'work',
      )
    ).map((row) => row.id),
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.instanceId),
    [verifier.id, ...workOrder],
  );
  assert.equal(candidates[0].label, 'Independent verification');
  assert.equal(candidates[0].role, 'reviewer');
  assert.deepEqual(candidates[0].workspace, review.policy.assignments![0].execution!.workspace);
  assert.deepEqual(candidates[1].workspace, { mode: 'none' });
  assert.equal(candidates[1].expectedRevision, 0);
  assert.equal(candidates[1].projectId, f.source.projectId);
  assert.deepEqual(new Set(workOrder), new Set([one.id, two.id]));
  assert.equal(await f.state.eventHead(), head);
  assert.equal(writes(), before);
  candidates[0].workspace = { mode: 'none' };
  assert.equal((await f.workflows.dispatchCandidates(f.source))[0].workspace.mode, 'ephemeral');
});

test('domain readiness, prerequisites, terminal states and program withdrawal govern discovery', async (t) => {
  const f = await fixture(t);
  const work = await f.register('dependent-work');
  const prerequisite = await work.start({ title: 'Prerequisite' });
  const dependent = await work.start({ title: 'Dependent' }, [prerequisite.id]);
  const denied = await work.start({ title: 'Missing metadata', allowed: false });
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.source)).map((item) => item.instanceId),
    [prerequisite.id],
  );
  await work.handle.transition(f.source, {
    instanceId: prerequisite.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'finish',
  });
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.source)).map((item) => item.instanceId),
    [dependent.id],
  );
  assert.notEqual(dependent.id, denied.id);
  work.handle.dispose();
  assert.deepEqual(await f.workflows.dispatchCandidates(f.source), []);
  const assignmentOnly = f.rules({ readOnly: false, tools: [] });
  delete assignmentOnly.assignments![0].lease;
  delete assignmentOnly.assignments![0].execution;
  delete assignmentOnly.assignments![0].references;
  const handle = await f.workflows.register(definition('interactive-only'), assignmentOnly);
  await handle.start(f.source, { workflow: 'interactive-only', requestId: 'interactive' });
  assert.deepEqual(await f.workflows.dispatchCandidates(f.source), []);
});

test('discovery uses the real source authority and transaction; revoked or cross-project callers cannot enumerate', async (t) => {
  const f = await fixture(t);
  const work = await f.register('scoped-work');
  const instance = await work.start();
  const reader = await f.scope.issueActor(f.source, { name: 'Reader', role: 'reader' });
  const readerCaller: Caller = {
    ...f.source,
    actorId: reader.actor.id,
    credentialId: reader.credential.id,
  };
  assert.deepEqual(await f.workflows.dispatchCandidates(readerCaller), []);
  const producer = await f.scope.issueActor(f.source, { name: 'Producer', role: 'producer' });
  const producerCaller: Caller = {
    ...f.source,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  assert.equal((await f.workflows.dispatchCandidates(producerCaller))[0].instanceId, instance.id);
  const foreign = await f.scope.bootstrap({ projectName: 'Foreign', actorName: 'Other owner' });
  const foreignCaller: Caller = { actorId: foreign.actor.id, projectId: foreign.project.id };
  assert.deepEqual(await f.workflows.dispatchCandidates(foreignCaller), []);
  const pendingCaller = { ...foreignCaller };
  const discovering = f.workflows.dispatchCandidates(pendingCaller);
  Object.assign(pendingCaller, f.source);
  assert.deepEqual(await discovering, []);
  await assert.rejects(
    async () =>
      await f.workflows.dispatchCandidates({ ...producerCaller, projectId: foreign.project.id }),
    { code: 'forbidden' },
  );
  await f.state.transaction(async (tx) => {
    await tx.run('UPDATE actors SET active=0 WHERE id=?', producer.actor.id);
    await assert.rejects(async () => await f.workflows.dispatchCandidates(producerCaller, tx), {
      code: 'forbidden',
    });
  });
  await assert.rejects(async () => await f.workflows.dispatchCandidates(producerCaller), {
    code: 'forbidden',
  });
  const malicious = f.rules({ readOnly: false, tools: [] }, async (tx) => {
    await tx.run('UPDATE actors SET active=0 WHERE id=?', f.source.actorId);
  });
  const handle = await f.workflows.register(definition('caller-revoked-mid-scan'), malicious);
  await handle.start(f.source, { workflow: 'caller-revoked-mid-scan', requestId: 'mid-scan' });
  await assert.rejects(async () => await f.workflows.dispatchCandidates(f.source), {
    code: 'forbidden',
  });
  await assert.doesNotReject(
    async () => await f.scope.require(f.source, 'read'),
    'Failed discovery rolls back callback writes',
  );
});

test('invalid metadata callbacks fail visibly; asynchronous labels read metadata in the transaction', async (t) => {
  const f = await fixture(t);
  const broken = f.rules({ readOnly: false, tools: [] });
  broken.assignments![0].lease!.label = () => '';
  const handle = await f.workflows.register(definition('invalid-label'), broken);
  await handle.start(f.source, { workflow: 'invalid-label', requestId: 'invalid-label' });
  await assert.rejects(async () => await f.workflows.dispatchCandidates(f.source), {
    code: 'invalid_workflow_policy',
  });
  handle.dispose();
  const throwing = f.rules({ readOnly: false, tools: [] }, () => {
    throw new Error('Broken metadata provider');
  });
  const other = await f.workflows.register(definition('broken-provider'), throwing);
  await other.start(f.source, { workflow: 'broken-provider', requestId: 'broken-provider' });
  await assert.rejects(
    async () => await f.workflows.dispatchCandidates(f.source),
    /Broken metadata provider/,
  );
  other.dispose();
  const asynchronous = f.rules({ readOnly: false, tools: [] });
  asynchronous.assignments![0].lease!.label = async ({ snapshot, tx }) => {
    const row = await tx.get<{ workflow: string }>(
      'SELECT workflow FROM wf_instances WHERE id=?',
      snapshot.id,
    );
    return `Async ${row!.workflow}`;
  };
  const asyncHandle = await f.workflows.register(definition('async-label'), asynchronous);
  await asyncHandle.start(f.source, { workflow: 'async-label', requestId: 'async-label' });
  assert.equal((await f.workflows.dispatchCandidates(f.source))[0].label, 'Async async-label');
});

test('workspace declarations are strict, immutable and version-pinned while absent old policies stay unchanged', async (t) => {
  const f = await fixture(t);
  const oldManifest = { readOnly: false, tools: [] };
  const oldHash = executionFingerprint(oldManifest);
  assert.deepEqual(validateExecution(oldManifest), oldManifest);
  assert.deepEqual(effectiveWorkspace(oldManifest), { mode: 'none' });
  const first = await f.workflows.register(definition('workspace-policy'), f.rules(oldManifest));
  await first.start(f.source, { workflow: 'workspace-policy', requestId: 'workspace' });
  assert.equal((await f.workflows.dispatchCandidates(f.source))[0].policyHash, oldHash);
  first.dispose();
  const restarted = await createService(new WorkflowsService(f.state, f.scope));
  t.after(() => restarted.close());
  await assert.rejects(
    async () =>
      await restarted.register(
        definition('workspace-policy'),
        f.rules({
          ...oldManifest,
          workspace: { mode: 'none' },
        }),
      ),
    { code: 'workflow_version_conflict' },
  );
  const replay = await restarted.register(definition('workspace-policy'), f.rules(oldManifest));
  assert.equal((await restarted.dispatchCandidates(f.source))[0].policyHash, oldHash);
  replay.dispose();
  const workspace: WorkflowWorkspacePolicy = {
    mode: 'persistent',
    namespace: 'consolidations',
    base: 'reference:code',
    perBase: true,
    retain: true,
    advancesCentral: true,
  };
  const explicit = { ...oldManifest, workspace };
  const versionTwo = await restarted.register(definition('workspace-policy', 2), f.rules(explicit));
  await versionTwo.start(f.source, {
    workflow: 'workspace-policy',
    version: 2,
    requestId: 'workspace-v2',
  });
  workspace.namespace = 'mutated';
  const next = (await restarted.dispatchCandidates(f.source))[0];
  assert.equal(next.version, 2);
  assert.equal(next.workspace.mode === 'persistent' && next.workspace.namespace, 'consolidations');
  assert.notEqual(next.policyHash, oldHash);
  const invalid = [
    { mode: 'none', namespace: 'hidden' },
    { mode: 'unknown' },
    { mode: 'persistent', namespace: 'work', base: 'central', perBase: false, retain: true },
    ...['.', '..', '../work', 'a/b', 'a\\b', '-option', '/absolute', 'a\u0000b'].map(
      (namespace) => ({
        mode: 'ephemeral',
        namespace,
        base: 'central',
        retain: false,
      }),
    ),
    ...[
      'upstream',
      'reference:',
      'reference:../code',
      'reference:constructor',
      'reference:__proto__',
    ].map((base) => ({
      mode: 'ephemeral',
      namespace: 'review',
      base,
      retain: false,
    })),
    { mode: 'ephemeral', namespace: 'review', base: 'central', retain: 'false' },
    {
      mode: 'ephemeral',
      namespace: 'review',
      base: 'central',
      retain: false,
      advancesCentral: true,
    },
  ];
  for (const value of invalid)
    assert.throws(
      () => validateExecution({ ...oldManifest, workspace: value } as WorkflowExecutionPolicy),
      { code: 'invalid_workflow_policy' },
    );
  assert.throws(() => validateExecution({ ...explicit, readOnly: true }), {
    code: 'invalid_workflow_policy',
  });
});

test('Tasks contribute source-aware queue labels and recipe availability without reading artifacts or rendering guidance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-dispatch-tasks-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Task dispatch', actorName: 'Owner' });
  const source: Caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const producerActor = await app.ctx.scope.issueActor(source, {
    name: 'Producer',
    role: 'producer',
  });
  const producer: Caller = { ...source, actorId: producerActor.actor.id };
  const reviewerActor = await app.ctx.scope.issueActor(source, {
    name: 'Reviewer',
    role: 'reviewer',
  });
  const reviewer: Caller = { ...source, actorId: reviewerActor.actor.id };
  const task = await app.ctx.tasks.create(producer, {
    title: 'Produce evidence',
    goal: 'Verify.',
    checks: ['Verified.'],
    requestId: 'create',
  });
  const type = {
    name: 'dispatch.custom',
    version: 1,
    kind: 'work' as const,
    recipe: {
      instructions: 'Work.',
      maxChars: 48000,
      outputInstructions: 'Deliver.',
      sections: [
        { key: 'task', title: 'Task', required: true },
        { key: 'brief', title: 'Brief', required: true },
      ],
    },
  };
  const disposeType = await app.ctx.tasks.registerType(type);
  const custom = await app.ctx.tasks.create(producer, {
    title: 'Unavailable recipe',
    goal: 'Verify.',
    checks: ['Verified.'],
    type: type.name,
    requestId: 'custom',
  });
  disposeType();
  const artifact = await app.ctx.artifacts.create(producer, {
    title: 'Evidence',
    content: 'Verified.',
  });
  const pending = await app.ctx.tasks.submitDelivery(
    producer,
    confirmedDelivery({
      taskId: task.id,
      expectedRevision: 0,
      artifactIds: [artifact.id],
      requestId: 'deliver',
    }),
  );
  t.mock.method(app.ctx.artifacts, 'read', poison);
  t.mock.method(app.ctx.workflows, 'evaluate', poison);
  t.mock.method(app.ctx.workflows, 'assignment', poison);
  const candidates = await app.ctx.workflows.dispatchCandidates(source);
  assert.deepEqual(
    candidates.map((candidate) => candidate.instanceId),
    [task.id],
  );
  assert.equal(candidates[0].label, 'Produce evidence');
  assert.equal(candidates[0].role, 'reviewer');
  assert.equal(candidates[0].expectedRevision, pending.workflow.revision);
  assert.equal(candidates[0].readOnly, true);
  assert.deepEqual(candidates[0].workspace, { mode: 'none' });
  assert.notEqual(task.id, custom.id);
  assert.deepEqual(await app.ctx.workflows.dispatchCandidates(producer), []);
  assert.deepEqual(
    (await app.ctx.workflows.dispatchCandidates(reviewer)).map((candidate) => candidate.instanceId),
    [task.id],
  );
  await app.ctx.reviews.start(reviewer, pending.reviewId!);
  assert.deepEqual(await app.ctx.workflows.dispatchCandidates(source), []);
});
