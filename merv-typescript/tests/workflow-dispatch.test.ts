import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import {
  check,
  createService,
  effectiveWorkspace,
  type Caller,
  type Data,
  type Transaction,
  type WorkflowDefinition,
  type WorkflowExecutionPolicy,
  type WorkflowPolicy,
} from '@merv/contracts';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { executionFingerprint, validateExecution } from '@merv/workflows/execution-policy';
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
  const boot = await scope.credentials.bootstrap({ projectName: 'Dispatch', actorName: 'Owner' });
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
    driver: 'code.v2',
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
  const reader = await f.scope.credentials.issueActor(f.source, { name: 'Reader', role: 'reader' });
  const readerCaller: Caller = {
    ...f.source,
    actorId: reader.actor.id,
    credentialId: reader.credential.id,
  };
  assert.deepEqual(await f.workflows.dispatchCandidates(readerCaller), []);
  const producer = await f.scope.credentials.issueActor(f.source, {
    name: 'Producer',
    role: 'producer',
  });
  const producerCaller: Caller = {
    ...f.source,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  assert.equal((await f.workflows.dispatchCandidates(producerCaller))[0].instanceId, instance.id);
  const foreign = await f.scope.credentials.bootstrap({
    projectName: 'Foreign',
    actorName: 'Other owner',
  });
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
  // In the caller's transaction the revocation lands, and the closing decision refuses it.
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx)),
    { code: 'forbidden' },
  );
  // On its own, discovery is a read: State refuses the write itself.
  await assert.rejects(async () => await f.workflows.dispatchCandidates(f.source), {
    code: 'invalid_workflow_policy',
  });
  await assert.doesNotReject(
    async () => await f.scope.require(f.source, 'read'),
    'Failed discovery rolls back callback writes',
  );
});

test('a dispatch callback that moves the instance fails the scan, excluded or refused', async (t) => {
  const f = await fixture(t);
  const move = async (tx: Transaction, id: string) =>
    await tx.run(`UPDATE wf_instances SET data_json='{"moved":true}' WHERE id=?`, id);
  const excluding = f.rules({ readOnly: false, tools: [] });
  excluding.assignments![0].lease!.role = () => 'producer';
  excluding.assignments![0].lease!.excludes = async ({ snapshot, tx }) => {
    await move(tx, snapshot.id);
    return true;
  };
  const first = await f.workflows.register(definition('moved-by-excludes'), excluding);
  const excluded = await first.start(f.source, {
    workflow: 'moved-by-excludes',
    requestId: 'excluded',
  });
  // In the caller's transaction the write lands, and the recheck after every row refuses it;
  // on its own, discovery is a read and State refuses the write itself.
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx, 'w')),
    { code: 'invalid_workflow_policy', status: 500 },
  );
  await assert.rejects(f.workflows.dispatchCandidates(f.source, undefined, 'w'), {
    code: 'invalid_workflow_policy',
    status: 500,
  });
  // Without a worker nothing is excluded, so the callback never runs.
  assert.deepEqual(
    (await f.workflows.dispatchCandidates(f.source)).map((item) => item.instanceId),
    [excluded.id],
  );
  first.dispose();
  // A refusal still skips the row, but not a write made before it.
  const refusing = f.rules({ readOnly: false, tools: [] });
  refusing.assignments![0].lease!.role = async ({ snapshot, tx }): Promise<'producer'> => {
    await move(tx, snapshot.id);
    check(false, 'not_ready', 'Inputs are not ready', 409);
    return 'producer';
  };
  const second = await f.workflows.register(definition('moved-then-refused'), refusing);
  await second.start(f.source, { workflow: 'moved-then-refused', requestId: 'refused' });
  await assert.rejects(
    f.state.transaction(async (tx) => await f.workflows.dispatchCandidates(f.source, tx)),
    { code: 'invalid_workflow_policy', status: 500 },
  );
  await assert.rejects(f.workflows.dispatchCandidates(f.source), {
    code: 'invalid_workflow_policy',
    status: 500,
  });
  const stored = await f.state.read(
    async (sql) =>
      await sql.all<{ data_json: string }>(
        'SELECT data_json FROM wf_instances WHERE workflow IN (?,?)',
        'moved-by-excludes',
        'moved-then-refused',
      ),
  );
  assert.ok(
    stored.every((row) => !row.data_json.includes('moved')),
    'failed scans roll back',
  );
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
    perBase: false,
    retain: true,
    advancesCentral: false,
    driver: 'code.v2',
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
    { ...workspace, advancesCentral: undefined },
    ...['.', '..', '../work', 'a/b', 'a\\b', '-option', '/absolute', 'a\u0000b'].map(
      (namespace) => ({
        mode: 'ephemeral',
        namespace,
        base: 'reference:code',
        retain: false,
        driver: 'code.v2',
      }),
    ),
    ...[
      'upstream',
      'reference:',
      'reference:../code',
      'reference:constructor',
      'reference:__proto__',
      // The central base went with the runners' own repositories.
      'central',
    ].map((base) => ({
      mode: 'ephemeral',
      namespace: 'review',
      base,
      retain: false,
      driver: 'code.v2',
    })),
    { mode: 'ephemeral', namespace: 'review', base: 'reference:code', retain: 'false' },
    {
      mode: 'ephemeral',
      namespace: 'review',
      base: 'reference:code',
      retain: false,
      driver: 'code.v2',
      advancesCentral: true,
    },
    // Every checkout names the driver that prepares it, and none is per base or advances central.
    { mode: 'ephemeral', namespace: 'review', base: 'reference:code', retain: false },
    { ...workspace, driver: undefined },
    { ...workspace, perBase: true },
    { ...workspace, advancesCentral: true },
  ];
  for (const value of invalid)
    assert.throws(
      () => validateExecution({ ...oldManifest, workspace: value } as WorkflowExecutionPolicy),
      { code: 'invalid_workflow_policy' },
    );
  assert.equal(validateExecution({ ...explicit, readOnly: true }).readOnly, true);
});

test('a lease whose receipt its offer accepted is released', async (t) => {
  const f = await fixture(t);
  const execution = { readOnly: false, tools: [] };
  const policy = f.rules(execution);
  const released: string[] = [];
  policy.assignments![0]!.lease!.release = ({ reason }) => {
    released.push(reason);
  };
  const handle = await f.workflows.register(definition('receipts'), policy);
  const started = await handle.start(f.source, { workflow: 'receipts', requestId: 'start' });
  const lease = {
    leaseId: 'lease',
    instanceId: started.id,
    expectedRevision: started.revision,
    projectId: f.source.projectId,
    actorId: f.source.actorId,
    workflow: 'receipts',
    version: 1,
    state: 'work',
    policyHash: executionFingerprint(validateExecution(execution)),
    registrationId: 'registration',
    // Within the offer's 256,000 characters, while the whole lease is past them.
    receipt: { blob: 'x'.repeat(255_900) },
  };
  await f.workflows.releaseLease(lease, { reason: 'Finished' });
  assert.deepEqual(released, ['Finished']);
  await assert.rejects(
    f.workflows.releaseLease(
      { ...lease, receipt: { blob: 'x'.repeat(256_000) } },
      { reason: 'Finished' },
    ),
    { code: 'invalid_workflow_policy' },
  );
  await assert.rejects(
    f.workflows.releaseLease({ ...lease, receipt: { at: new Date() } as never }, { reason: 'x' }),
    { code: 'invalid_lease', status: 400 },
  );
  assert.deepEqual(released, ['Finished']);
});
