import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '@merv/contracts';
import type {
  Caller,
  Data,
  Task,
  TaskCheckpointInput,
  TaskContext,
  TaskDelivery,
  WorkflowDefinition,
  WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { Session } from '@merv/sessions/types';
import { WorkflowsService } from '@merv/workflows';
import { createApp } from './fixtures/app.js';
import { openState } from './fixtures/state.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-leases-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Leased work', actorName: 'Owner' });
  const authenticated = await app.ctx.scope.authenticate(boot.token);
  const source: Caller = {
    actorId: authenticated.id,
    projectId: authenticated.projectId,
    credentialId: authenticated.credential.id,
  };
  const task = await app.ctx.tasks.create(source, {
    title: 'Verify',
    goal: 'Verify a result.',
    checks: ['The result is 42.'],
    requestId: 'create',
  });
  let sequence = 0;
  const offer = async (target: Task = task) => {
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    const session = await app.ctx.sessions.offer(source, {
      instanceId: target.id,
      expectedRevision: target.workflow.revision,
      runnerId: 'test',
      requestId: `offer-${++sequence}`,
      secret,
    });
    return { secret, session };
  };
  async function run<T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    const invocation = await app.ctx.sessions.prepare(caller, tool, input);
    return await app.ctx.sessions.run(invocation, handler);
  }
  const release = async (session: Session) => {
    await app.ctx.sessions.release(source, { sessionId: session.id, runnerId: 'test' });
    await app.ctx.domainEvents.drain();
  };
  const deliver = async (caller: Caller) => {
    const artifact = await run(
      caller,
      'artifact.create',
      { title: 'Output', content: 'The result is 42.' },
      async (worker, input) =>
        await app.ctx.artifacts.create(
          worker,
          input as unknown as { title: string; content: string },
        ),
    );
    const delivered = await run(
      caller,
      'task.submit_delivery',
      { ...confirmedDelivery({ artifactIds: [artifact.id], requestId: `delivery-${++sequence}` }) },
      async (worker, input) =>
        await app.ctx.tasks.submitDelivery(worker, input as unknown as TaskDelivery),
    );
    return { artifact, delivered };
  };
  return { app, source, task, offer, run, release, deliver };
}

test('lease offer reserves ownership and freezes context atomically; first activation is metadata only', async (t) => {
  const f = await fixture(t);
  const { artifacts, workflows, state } = f.app.ctx;
  const offerLease = workflows.offerLease.bind(workflows);
  t.mock.method(workflows, 'offerLease', async (...args: Parameters<typeof offerLease>) => {
    const source = structuredClone(args[0]),
      worker = structuredClone(args[1]);
    const offering = offerLease(source, worker, args[2], args[3]);
    source.actorId = 'replacement-source';
    worker.actorId = 'replacement-worker';
    return await offering;
  });
  const before = await state.read(async (sql) => ({
    actors: await sql.all('SELECT id FROM actors'),
    events: await state.eventHead(),
    leases: await sql.all('SELECT id FROM task_leases'),
  }));
  const read = artifacts.read;
  artifacts.read = () => {
    throw new Error('Injected context projection failure');
  };
  await assert.rejects(async () => await f.offer(), /Injected context projection failure/);
  assert.deepEqual(
    await state.read(async (sql) => ({
      actors: await sql.all('SELECT id FROM actors'),
      events: await state.eventHead(),
      leases: await sql.all('SELECT id FROM task_leases'),
    })),
    before,
  );
  artifacts.read = read;
  const offered = await f.offer();
  assert.equal(offered.session.assignment.actorId, offered.session.actorId);
  assert.equal(offered.session.lease.actorId, offered.session.actorId);
  assert.equal(offered.session.assignment.workStart, null);
  assert.deepEqual(await workflows.workStarts(f.source, f.task.id), []);
  const assignment = workflows.assignment;
  artifacts.read = () => {
    throw new Error('Activation must not read bytes');
  };
  workflows.assignment = () => {
    throw new Error('Activation must not render assignment');
  };
  const first = await f.app.ctx.sessions.authenticate(offered.secret);
  assert.deepEqual(await f.app.ctx.sessions.authenticate(offered.secret), first);
  assert.equal((await workflows.workStarts(f.source, f.task.id)).length, 1);
  artifacts.read = read;
  workflows.assignment = assignment;
});

test('lease authority retains its source and worker during pending checks', async (t) => {
  const f = await fixture(t);
  const { workflows, sessions } = f.app.ctx;
  await t.test('role', async () => {
    const caller = { ...f.source };
    const resolving = workflows.leaseRole(caller, { instanceId: f.task.id, expectedRevision: 0 });
    caller.actorId = 'replacement';
    assert.equal(await resolving, 'producer');
  });
  const offered = await f.offer();
  const worker = await sessions.authenticate(offered.secret);
  for (const method of ['checkLease', 'activateLease', 'authorizeLeaseDispatch'] as const) {
    await t.test(method, async () => {
      const caller = structuredClone(worker);
      const checking =
        method === 'authorizeLeaseDispatch'
          ? workflows.authorizeLeaseDispatch(
              caller,
              offered.session.lease,
              offered.session.execution,
              {
                tool: 'workflow.status_and_next',
                input: {},
                read: true,
              },
            )
          : workflows[method](caller, offered.session.lease);
      caller.actorId = 'replacement';
      caller.session!.id = 'replacement-lease';
      await checking;
    });
  }
});

test('frozen checkpoint inputs remain readable; later source attachments cannot expand session context or reads', async (t) => {
  const f = await fixture(t);
  const { tasks, artifacts, sessions, workflows } = f.app.ctx;
  const predecessor = await artifacts.create(f.source, {
    title: 'Predecessor receipt',
    content: 'PRE_OFFER_EVIDENCE_42',
  });
  await tasks.checkpoint(f.source, {
    taskId: f.task.id,
    expectedRevision: 0,
    purpose: 'work',
    notes: 'Useful continuity',
    artifactIds: [predecessor.id],
    requestId: 'before',
  });
  const offered = await f.offer();
  const worker = await sessions.authenticate(offered.secret);
  assert.ok((offered.session.execution.references.artifacts as string[]).includes(predecessor.id));
  assert.match(offered.session.assignment.context!.prompt, /PRE_OFFER_EVIDENCE_42/);
  const late = await artifacts.create(f.source, {
    title: 'Late unrelated input',
    content: 'LATE_FOREIGN_BYTES_9981',
  });
  await tasks.checkpoint(f.source, {
    taskId: f.task.id,
    expectedRevision: 0,
    purpose: 'work',
    notes: 'Late foreign checkpoint',
    artifactIds: [late.id],
    requestId: 'late',
  });
  await assert.rejects(
    async () => await sessions.prepare(worker, 'artifact.read', { artifactId: late.id }),
    {
      code: 'execution_arguments_forbidden',
    },
  );
  const context = await f.run(
    worker,
    'task.context',
    { requestId: 'context' },
    async (caller, input) => await tasks.context(caller, input as unknown as TaskContext),
  );
  assert.match(context.prompt, /PRE_OFFER_EVIDENCE_42/);
  assert.doesNotMatch(context.prompt, /LATE_FOREIGN_BYTES_9981|Late foreign checkpoint/);
  assert.doesNotMatch(
    (await workflows.assignment(worker, f.task.id)).context!.prompt,
    /LATE_FOREIGN_BYTES_9981|Late foreign checkpoint/,
  );
  const output = await f.run(
    worker,
    'artifact.create',
    { title: 'Fresh output', content: 'LEASE_OUTPUT_371' },
    async (caller, input) =>
      await artifacts.create(caller, input as unknown as { title: string; content: string }),
  );
  assert.equal(
    (await sessions.prepare(worker, 'artifact.read', { artifactId: output.id })).input.artifactId,
    output.id,
  );
  await f.run(
    worker,
    'task.checkpoint',
    { notes: 'Worker evidence', artifactIds: [output.id], requestId: 'worker-checkpoint' },
    async (caller, input) =>
      await tasks.checkpoint(caller, input as unknown as TaskCheckpointInput),
  );
  const fresh = await f.run(
    worker,
    'task.context',
    { requestId: 'fresh-context' },
    async (caller, input) => await tasks.context(caller, input as unknown as TaskContext),
  );
  assert.match(fresh.prompt, /LEASE_OUTPUT_371/);
  await f.release(offered.session);
  const successor = await f.offer();
  assert.ok((successor.session.execution.references.artifacts as string[]).includes(output.id));
  assert.match(successor.session.assignment.context!.prompt, /LEASE_OUTPUT_371/);
});

test('independent workers share one source while review snapshots retain input and actual output authorship', async (t) => {
  const f = await fixture(t);
  const work = await f.offer();
  const producer = await f.app.ctx.sessions.authenticate(work.secret);
  const { artifact, delivered } = await f.deliver(producer);
  const review = await f.app.ctx.reviews.get(f.source, delivered.reviewId!);
  assert.equal(review.producerId, producer.actorId);
  assert.equal(review.administrativeActorId, f.source.actorId);
  assert.deepEqual(review.pinnedInputIds, [f.task.briefId]);
  assert.ok(review.artifactIds.includes(artifact.id));
  const offered = await f.offer(delivered);
  assert.notEqual(offered.session.actorId, producer.actorId);
  assert.equal(offered.session.source.actorId, work.session.source.actorId);
  assert.equal(
    offered.session.execution.references.claimId,
    (await f.app.ctx.reviews.get(f.source, review.id)).claimId,
  );
  const reviewer = await f.app.ctx.sessions.authenticate(offered.secret);
  const claim = await f.app.ctx.reviews.get(reviewer, review.id);
  assert.equal(claim.reviewerId, reviewer.actorId);
  await assert.rejects(
    async () => await f.app.ctx.reviews.checkSubmit(producer, review.id),
    /session|Session|authority|permission/i,
  );
  await f.release(offered.session);
  assert.equal((await f.app.ctx.reviews.get(f.source, review.id)).status, 'requested');
  const next = await f.offer(delivered);
  const current = await f.app.ctx.reviews.get(f.source, review.id);
  assert.notEqual(current.claimId, claim.claimId);
  await f.app.ctx.workflows.releaseLease(offered.session.lease, { reason: 'Delayed old cleanup' });
  assert.equal((await f.app.ctx.reviews.get(f.source, review.id)).claimId, current.claimId);
  assert.equal(current.reviewerId, next.session.actorId);
});

test('lease generations survive provider reload but old invocations and released worker receipts stay fenced', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  const worker = await f.app.ctx.sessions.authenticate(offered.secret);
  const invocation = await f.app.ctx.sessions.prepare(worker, 'task.get', {});
  const oldGeneration = offered.session.execution.registrationId;
  await f.app.setEnabled('tasks', false);
  await f.app.setEnabled('tasks', true);
  const live = await f.app.ctx.workflows.checkLease(worker, offered.session.lease);
  assert.notEqual(live.registrationId, oldGeneration);
  await assert.rejects(
    f.app.ctx.sessions.run(
      invocation,
      async (caller, input) => await f.app.ctx.tasks.get(caller, input.taskId as string),
    ),
    { code: 'execution_replaced' },
  );
  assert.equal(
    (
      await f.run(
        worker,
        'task.get',
        {},
        async (caller, input) => await f.app.ctx.tasks.get(caller, input.taskId as string),
      )
    ).id,
    f.task.id,
  );
  await f.release(offered.session);
  await assert.rejects(
    async () => await f.app.ctx.workflows.checkLease(worker, offered.session.lease),
  );
  const successor = await f.offer();
  assert.notEqual(successor.session.actorId, offered.session.actorId);
});

test('logical task owner can reissue worker delivery while preserving immutable review input/output provenance', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  const worker = await f.app.ctx.sessions.authenticate(offered.secret);
  const { artifact, delivered } = await f.deliver(worker);
  const original = await f.app.ctx.reviews.get(f.source, delivered.reviewId!);
  const reissued = await f.app.ctx.tasks.reissueReview(f.source, {
    taskId: delivered.id,
    expectedRevision: delivered.workflow.revision,
    reason: 'Use another reviewer.',
    requestId: 'reissue',
  });
  const replacement = await f.app.ctx.reviews.get(f.source, reissued.reviewId!);
  assert.equal(replacement.producerId, worker.actorId);
  assert.equal(replacement.administrativeActorId, f.source.actorId);
  assert.deepEqual(replacement.pinnedInputIds, original.pinnedInputIds);
  assert.deepEqual(replacement.artifactIds, original.artifactIds);
  const foreign = await f.app.ctx.scope.issueActor(f.source, {
    role: 'producer',
    name: 'Foreign producer',
  });
  const foreignCaller: Caller = {
    actorId: foreign.actor.id,
    projectId: f.source.projectId,
    credentialId: foreign.credential.id,
  };
  await assert.rejects(
    async () =>
      await f.app.ctx.reviews.reissue(foreignCaller, {
        reviewId: replacement.id,
        subjectRevision: replacement.subjectRevision + 1,
        requestId: 'steal',
      }),
    { code: 'forbidden' },
  );
  const own = await f.app.ctx.artifacts.create(foreignCaller, {
    title: 'Own',
    content: 'Own output.',
  });
  await assert.rejects(
    async () =>
      await f.app.ctx.reviews.request(foreignCaller, {
        subjectId: 'unrelated',
        subjectRevision: 0,
        producerId: foreignCaller.actorId,
        artifactIds: [own.id, artifact.id],
        criteria: ['Check'],
        requestId: 'false-authorship',
      }),
    { code: 'forbidden' },
  );
  await assert.rejects(
    async () =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run('UPDATE reviews SET pinned_input_ids=? WHERE id=?', '[]', original.id),
      ),
    { code: 'state_constraint' },
  );
});

test('a non-Task program can reserve, activate and release through generic hooks without rendering at authentication', async (t) => {
  const f = await fixture(t);
  const { workflows, state, scope, sessions } = f.app.ctx;
  await state.transaction(
    async (tx) =>
      await tx.run(
        'CREATE TABLE custom_assignments(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0)',
      ),
  );
  let buildCount = 0;
  const registration = await workflows.register(
    {
      name: 'custom-lease',
      version: 1,
      initial: 'open',
      states: ['open', 'done'],
      terminal: ['done'],
      edges: [{ from: 'open', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          states: ['open'],
          transitions: ['finish'],
          tool: 'custom.finish',
          instruction: 'Finish.',
          check() {
            throw new Error('No exit checks at activation');
          },
        },
      ],
      assignments: [
        {
          state: 'open',
          async check({ caller, tx }) {
            await scope.require(caller, 'write', tx);
          },
          execution: {
            readOnly: false,
            tools: [
              {
                name: 'custom.work',
                alternatives: [{ instanceId: { kind: 'target', field: 'instanceId' } }],
              },
            ],
          },
          build() {
            buildCount++;
            return {
              role: 'producer',
              label: 'Custom work',
              brief: 'Work.',
              references: [],
              handoff: { instruction: 'Finish.', tools: [] },
              execution: { readOnly: false, tools: [] },
              context: null,
            };
          },
          lease: {
            async role({ caller, tx }) {
              await scope.require(caller, 'write', tx);
              return 'producer' as const;
            },
            async acquire({ caller, leaseId, tx }) {
              await tx.run(
                'INSERT INTO custom_assignments(id,actor_id) VALUES(?,?)',
                leaseId,
                caller.actorId,
              );
              return { id: leaseId };
            },
            async check({ caller, tx }, receipt) {
              assert.equal(receipt.id, caller.session!.id);
              assert.ok(
                await tx.get(
                  'SELECT id FROM custom_assignments WHERE id=? AND actor_id=? AND released=0',
                  receipt.id as string,
                  caller.actorId,
                ),
              );
            },
            async release({ lease, tx }) {
              await tx.run(
                'UPDATE custom_assignments SET released=1 WHERE id=? AND actor_id=?',
                lease.leaseId,
                lease.actorId,
              );
            },
          },
        },
      ],
    },
  );
  const instance = await registration.start(f.source, {
    workflow: 'custom-lease',
    requestId: 'custom',
  });
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const offered = await sessions.offer(f.source, {
    instanceId: instance.id,
    expectedRevision: 0,
    runnerId: 'test',
    requestId: 'custom-offer',
    secret,
  });
  assert.equal(buildCount, 1);
  const worker = await sessions.authenticate(secret);
  const work = await sessions.prepare(worker, 'custom.work', {});
  assert.equal(work.input.instanceId, instance.id);
  assert.equal(buildCount, 1);
  assert.equal((await workflows.workStarts(f.source, instance.id)).length, 1);
  await f.release(offered);
  assert.equal(
    (await state.read(
      async (sql) =>
        await sql.get<{ released: number }>(
          'SELECT released FROM custom_assignments WHERE id=?',
          offered.id,
        ),
    ))!.released,
    1,
  );
});

/** The engine alone, with one program whose lease hooks the test controls. */
async function engineFixture(t: TestContext) {
  const state = await openState(':memory:');
  const controls = { outputs: () => {} };
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.bootstrap({ projectName: 'Lease inputs', actorName: 'Owner' });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const definition: WorkflowDefinition = {
    name: 'lease-input-test',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const policy: WorkflowPolicy = {
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'test.finish',
        instruction: 'Finish.',
        check: async () => {},
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: async () => ({
          role: 'producer',
          label: 'Read evidence',
          brief: 'Inspect available evidence.',
          references: [],
          handoff: { instruction: 'Finish.', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        references: () => ({ artifacts: ['own-artifact'] }),
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'artifact.read',
              alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
            },
          ],
        },
        lease: {
          role: async (): Promise<'operator' | 'producer' | 'reviewer' | 'reader'> => 'producer',
          acquire: async ({ leaseId }) => ({ leaseId }),
          check: async (context, receipt) => {
            assert.equal(receipt.leaseId, context.caller.session!.id);
          },
          release: async () => {},
          outputs: () => {
            controls.outputs();
            return {};
          },
        },
      },
    ],
  };
  const handle = await workflows.register(definition, policy);
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  const target = { instanceId: instance.id, expectedRevision: instance.revision };
  // The execution is read for the target as it was called with, whatever the caller changes
  // while the read is still running.
  const requestedTarget = { ...target };
  const pendingExecution = workflows.execution(caller, requestedTarget);
  requestedTarget.expectedRevision = 99;
  const execution = await pendingExecution;
  return { state, scope, workflows, caller, instance, target, execution, controls };
}

test('dispatch authorization acts on a snapshot of its request', async (t) => {
  const f = await engineFixture(t);
  const request = {
    ...f.target,
    registrationId: f.execution.registrationId,
    policyHash: f.execution.policyHash,
    tool: 'artifact.read',
    input: { artifactId: 'own-artifact' },
    read: false,
  };
  const dispatching = f.workflows.authorizeDispatch(f.caller, request);
  request.tool = 'undeclared.write';
  request.read = true;
  request.input.artifactId = 'changed';
  assert.deepEqual(await dispatching, {
    tool: 'artifact.read',
    input: { artifactId: 'own-artifact' },
  });
});

test('lease lifecycle calls act on a snapshot of their inputs and admit only declared reads', async (t) => {
  const f = await engineFixture(t);
  assert.ok(await f.workflows.assignment(f.caller, f.instance.id));
  assert.equal((await f.workflows.dispatchCandidates(f.caller))[0]!.instanceId, f.instance.id);
  const roleTarget = { ...f.target };
  const selectingRole = f.workflows.leaseRole(f.caller, roleTarget);
  roleTarget.expectedRevision = 99;
  assert.equal(await selectingRole, 'producer');
  const source = await f.scope.delegationSource(f.caller);
  f.scope.registerSessionAuthority({ require: async () => source });
  const actor = await f.state.transaction(
    async (tx) =>
      await f.scope.createSessionActor(
        source,
        {
          sessionId: 'lease-test',
          role: 'producer',
          name: 'Worker',
        },
        tx,
      ),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: 'lease-test' },
  };
  const offerTarget = { ...f.target, leaseId: 'lease-test' };
  const offering = f.workflows.offerLease(f.caller, worker, offerTarget);
  offerTarget.leaseId = 'changed';
  offerTarget.instanceId = 'changed';
  const offered = await offering;
  const checkedLease = structuredClone(offered.lease);
  const checking = f.workflows.checkLease(worker, checkedLease);
  checkedLease.actorId = 'changed';
  checkedLease.receipt.leaseId = 'changed';
  assert.ok(await checking);
  const activatedLease = structuredClone(offered.lease);
  const activating = f.workflows.activateLease(worker, activatedLease);
  activatedLease.instanceId = 'changed';
  assert.ok(await activating);
  assert.equal(
    (
      await f.workflows.authorizeLeaseDispatch(worker, offered.lease, offered.execution, {
        tool: 'artifact.read',
        input: { artifactId: 'own-artifact' },
      })
    ).input.artifactId,
    'own-artifact',
  );
  await assert.rejects(
    async () =>
      await f.workflows.authorizeLeaseDispatch(worker, offered.lease, offered.execution, {
        tool: 'artifact.read',
        input: { artifactId: 'live-artifact' },
      }),
    { code: 'execution_arguments_forbidden' },
  );
  for (const change of ['policy', 'read classification']) {
    const frozen = structuredClone(offered.execution);
    const request = { tool: 'undeclared.write', input: {}, read: false };
    f.controls.outputs = () => {
      if (change === 'policy') frozen.policy.tools.push({ name: request.tool, alternatives: [{}] });
      else request.read = true;
    };
    await assert.rejects(
      () => f.workflows.authorizeLeaseDispatch(worker, offered.lease, frozen, request),
      { code: 'execution_tool_forbidden' },
    );
  }
  const release = { reason: 'Completed' };
  const releasing = f.workflows.releaseLease(offered.lease, release);
  release.reason = '';
  await releasing;
});
