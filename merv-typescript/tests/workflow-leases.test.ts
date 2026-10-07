import type { Task, TaskCheckpointInput, TaskContext, TaskDelivery } from '@merv/tasks/types';
import { currentTask, currentWork } from './fixtures/current-work.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService } from '@merv/contracts';
import { admitDispatch } from '@merv/workflows/execution';
import { insertLease } from '@merv/workflows/lease-rows';
import type {
  Caller,
  Data,
  SessionToolPolicy,
  Transaction,
  WorkflowDefinition,
  WorkflowExecution,
  WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { Session } from '@merv/sessions/types';
import { WorkflowsService } from '@merv/workflows';
import { createApp } from './fixtures/app.js';
import { openState } from './fixtures/state.js';
import type { PostgresState } from '@merv/state';
import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-leases-'));
  const app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Leased work',
    actorName: 'Owner',
  });
  const authenticated = await app.ctx.scope.authenticate(boot.token);
  const source: Caller = {
    actorId: authenticated.id,
    projectId: authenticated.projectId,
    credentialId: authenticated.credential.id,
  };
  const task = await currentTask(app.ctx, source, {
    title: 'Verify',
    goal: 'Verify a result.',
    checks: ['The result is 42.'],
    requestId: 'create',
  });
  const work = currentWork(app.ctx, { directory: join(directory, 'work'), source });
  const held = new Map<string, Awaited<ReturnType<typeof work.attach>>>();
  t.after(() => {
    for (const lease of held.values()) lease.driver?.dispose();
  });
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'test',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2'],
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
    held.set(session.id, await work.attach(session));
    return { secret, session };
  };
  async function run<T>(
    caller: Caller,
    tool: string,
    input: Data,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T> {
    if (tool === 'task.submit_delivery') {
      const session = await app.ctx.sessions.get(source, caller.session!.id);
      let lease = held.get(session.id);
      if (!lease) {
        lease = await work.attach(session);
        held.set(session.id, lease);
      }
      lease.worker = caller;
      input = { ...input, commandId: await work.commit(lease) };
    }
    const invocation = await app.ctx.sessions.invocations.prepare(caller, tool, input);
    return await app.ctx.sessions.invocations.run(invocation, handler);
  }
  /** The machine's side of a close: its final capture, handed to Code Work. */
  const settle = async (session: Session) => {
    const lease = held.get(session.id);
    if (lease) {
      await work.release(lease);
      held.delete(session.id);
    }
  };
  const release = async (session: Session, settled = true) => {
    await app.ctx.sessions.release(source, { sessionId: session.id, runnerId: 'test' });
    await app.ctx.domainEvents.drain();
    if (settled) await settle(session);
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
    const lease = held.get(caller.session!.id);
    if (lease) {
      await work.release(lease);
      held.delete(caller.session!.id);
    }
    return { artifact, delivered };
  };
  return { app, source, task, offer, run, release, settle, deliver };
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
    leases: await sql.all('SELECT id FROM wf_leases'),
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
      leases: await sql.all('SELECT id FROM wf_leases'),
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
  for (const method of ['checkLease', 'activateLease', 'checkLease with its execution'] as const) {
    await t.test(method, async () => {
      const caller = structuredClone(worker);
      const checking =
        method === 'checkLease with its execution'
          ? workflows.checkLease(
              caller,
              offered.session.lease,
              undefined,
              offered.session.execution,
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
    async () =>
      await sessions.invocations.prepare(worker, 'artifact.read', { artifactId: late.id }),
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
    (await sessions.invocations.prepare(worker, 'artifact.read', { artifactId: output.id })).input
      .artifactId,
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
  const invocation = await f.app.ctx.sessions.invocations.prepare(worker, 'task.get', {});
  const oldGeneration = offered.session.execution.registrationId;
  await f.app.setEnabled('tasks', false);
  await f.app.setEnabled('tasks', true);
  const live = await f.app.ctx.workflows.checkLease(worker, offered.session.lease);
  assert.notEqual(live.registrationId, oldGeneration);
  // The execution frozen under the old generation still grants its references.
  assert.ok(
    (
      await f.app.ctx.workflows.checkLease(
        worker,
        offered.session.lease,
        undefined,
        offered.session.execution,
      )
    ).references,
  );
  await assert.rejects(
    f.app.ctx.sessions.invocations.run(
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

test('Reviews releases the lease of a closed session, whether or not its owner is loaded', async (t) => {
  const f = await fixture(t);
  const { state, domainEvents } = f.app.ctx;
  const released = async (id: string) =>
    (await state.read(
      async (sql) =>
        await sql.get<{ released_at: string | null }>(
          'SELECT released_at FROM wf_leases WHERE id=?',
          id,
        ),
    ))!.released_at;
  const consumer = async () => {
    const status = (await domainEvents.status()).find(
      (consumer) => consumer.id === 'reviews.lease-release.v1',
    )!;
    return {
      active: status.active,
      error: status.error,
      caughtUp: status.cursor === (await state.eventHead()),
    };
  };
  const caughtUp = { active: true, error: null, caughtUp: true };

  await t.test('a close while the workflow is disabled releases its lease', async () => {
    const offered = await f.offer();
    await f.app.setEnabled('tasks', false);
    await f.release(offered.session);
    await domainEvents.drain();
    assert.ok(await released(offered.session.id));
    assert.deepEqual(await consumer(), caughtUp);
    await f.app.setEnabled('tasks', true);
  });

  // Code Work requires Reviews, so the machine hands its final capture over once both are back.
  await t.test('without Reviews, closing does not stall Sessions', async () => {
    const offered = await f.offer();
    await f.app.setEnabled('reviews', false);
    await f.release(offered.session, false);
    assert.equal(await released(offered.session.id), null);
    assert.equal((await consumer()).active, false);
    await f.app.setEnabled('reviews', true);
    await f.settle(offered.session);
    await domainEvents.drain();
    assert.ok(await released(offered.session.id));
    assert.deepEqual(await consumer(), caughtUp);
  });

  await t.test('a close logged before the consumer existed is released', async () => {
    const offered = await f.offer();
    await f.app.setEnabled('reviews', false);
    await f.release(offered.session, false);
    await state.transaction(
      async (tx) => await tx.run("DELETE FROM event_consumers WHERE id='reviews.lease-release.v1'"),
    );
    await f.app.setEnabled('reviews', true);
    await f.settle(offered.session);
    await domainEvents.drain();
    assert.ok(await released(offered.session.id));
  });

  await t.test('a second release and a close without a lease row change nothing', async () => {
    const offered = await f.offer();
    await f.release(offered.session);
    const first = await released(offered.session.id);
    assert.ok(first);
    await state.transaction(async (tx) => {
      await state.appendEvent(tx, {
        projectId: f.source.projectId,
        actorId: 'system:sessions',
        type: 'session.closed',
        subjectId: 'no-such-lease',
        data: { reason: 'closed' },
      });
    });
    await f.app.setEnabled('reviews', false);
    await state.transaction(
      async (tx) =>
        await tx.run("UPDATE event_consumers SET cursor=0 WHERE id='reviews.lease-release.v1'"),
    );
    const head = await state.eventHead();
    await f.app.setEnabled('reviews', true);
    await domainEvents.drain();
    assert.equal(await released(offered.session.id), first);
    assert.equal(await state.eventHead(), head);
    assert.deepEqual(await consumer(), caughtUp);
  });
});

test('a closed session releases an Experiments or Reflections lease the same way', async (t) => {
  const f = await fixture(t);
  const { state, domainEvents } = f.app.ctx;
  for (const workflow of ['experiment', 'reflection']) {
    const id = `lease-${workflow}`;
    await state.transaction(async (tx) => {
      await insertLease(tx, {
        id,
        projectId: f.source.projectId,
        snapshot: { id: workflow, revision: 1, workflow, state: 'planned' },
        actorId: `worker-${workflow}`,
        sourceActorId: 'source',
        reviewId: null,
        claimId: null,
        receipt: {},
        details: {},
      });
      await state.appendEvent(tx, {
        projectId: f.source.projectId,
        actorId: 'system:sessions',
        type: 'session.closed',
        subjectId: id,
        data: { reason: 'closed' },
      });
    });
    await domainEvents.drain();
    const released = await state.read(
      async (sql) =>
        await sql.get<{ released_at: string | null }>(
          'SELECT released_at FROM wf_leases WHERE id=?',
          id,
        ),
    );
    assert.ok(released!.released_at, workflow);
    const status = (await domainEvents.status()).find(
      (status) => status.id === 'reviews.lease-release.v1',
    )!;
    assert.deepEqual(
      [status.active, status.error, status.cursor],
      [true, null, await state.eventHead()],
      workflow,
    );
  }
});

test('a leased status_and_next admission stays within a statement budget', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  const worker = await f.app.ctx.sessions.authenticate(offered.secret);
  await f.app.ctx.domainEvents.drain();
  // Lease steps, and the execution references a step would derive: the offer froze those.
  const engine = f.app.ctx.workflows as unknown as Record<
    'leaseStep' | 'executionOf',
    (...args: unknown[]) => unknown
  >;
  const measured = new AsyncLocalStorage<boolean>();
  let leaseSteps = 0,
    references = 0;
  const leaseStep = engine.leaseStep.bind(engine);
  const executionOf = engine.executionOf.bind(engine);
  t.mock.method(engine, 'leaseStep', (...args: unknown[]) => {
    if (measured.getStore()) leaseSteps++;
    return leaseStep(...args);
  });
  t.mock.method(engine, 'executionOf', (...args: unknown[]) => {
    if (measured.getStore()) references++;
    return executionOf(...args);
  });
  // Statements issued through the state's transactions, snapshot children included.
  const state = f.app.ctx.state as PostgresState;
  let statements = 0;
  const count = () => {
    if (measured.getStore()) statements++;
  };
  const transaction = state.transaction.bind(state);
  t.mock.method(state, 'transaction', ((fn: (tx: Transaction) => unknown) =>
    transaction((tx) => {
      // Mutate in place: assertTransaction() compares the transaction object's identity.
      const { run, get, all } = tx;
      Object.assign(tx, {
        run: (sql: string, ...p: never[]) => (count(), run(sql, ...p)),
        get: (sql: string, ...p: never[]) => (count(), get(sql, ...p)),
        all: (sql: string, ...p: never[]) => (count(), all(sql, ...p)),
      });
      return fn(tx);
    })) as typeof state.transaction);
  // As the tool registry calls it, which marks a read tool.
  const policy: SessionToolPolicy = f.app.ctx.sessions.invocations;
  // Background reconciliation can issue transactions while admission is awaiting PostgreSQL.
  // Count only this invocation's async chain, not the application's unrelated consumers.
  const invocation = await measured.run(true, () =>
    policy.prepare(worker, 'workflow.status_and_next', { instanceId: f.task.id }, true),
  );
  assert.equal(invocation.tool, 'workflow.status_and_next');
  // The admission's lease check runs inside the session's own frame, so every Scope check it
  // makes for the worker resolves from that frame instead of re-reading the session row
  // (about 400 statements unframed, 127 framed with a second lease step, 70 now).
  assert.ok(statements > 0 && statements <= 100, `${statements} statements for one leased read`);
  // One validation per call (owner, 2026-10-07): the session's Scope check is made under its
  // frame, so the admission's lease step is the only one.
  assert.equal(leaseSteps, 1);
  assert.equal(references, 0);
});

test('a worker delivery pins its review input and output provenance, which no other producer can claim', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  const worker = await f.app.ctx.sessions.authenticate(offered.secret);
  const { artifact, delivered } = await f.deliver(worker);
  const original = await f.app.ctx.reviews.get(f.source, delivered.reviewId!);
  assert.equal(original.producerId, worker.actorId);
  assert.equal(original.administrativeActorId, f.source.actorId);
  const foreign = await f.app.ctx.scope.credentials.issueActor(f.source, {
    role: 'producer',
    name: 'Foreign producer',
  });
  const foreignCaller: Caller = {
    actorId: foreign.actor.id,
    projectId: f.source.projectId,
    credentialId: foreign.credential.id,
  };
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
  const work = await sessions.invocations.prepare(worker, 'custom.work', {});
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
  const controls: { outputs: () => Record<string, string[]> | void } = { outputs: () => {} };
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  t.after(async () => {
    workflows.close();
    await state.close();
  });
  const boot = await scope.credentials.bootstrap({
    projectName: 'Lease inputs',
    actorName: 'Owner',
  });
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
          outputs: () => controls.outputs() ?? {},
        },
      },
    ],
  };
  const handle = await workflows.register(definition, policy);
  const instance = await handle.start(caller, { workflow: definition.name, requestId: 'start' });
  const target = { instanceId: instance.id, expectedRevision: instance.revision };
  return { state, scope, workflows, caller, instance, target, controls };
}

test('lease lifecycle calls act on a snapshot of their inputs', async (t) => {
  const f = await engineFixture(t);
  assert.ok(await f.workflows.assignment(f.caller, f.instance.id));
  assert.equal((await f.workflows.dispatchCandidates(f.caller))[0]!.instanceId, f.instance.id);
  const roleTarget = { ...f.target };
  const selectingRole = f.workflows.leaseRole(f.caller, roleTarget);
  roleTarget.expectedRevision = 99;
  assert.equal(await selectingRole, 'producer');
  const source = await f.scope.delegationSource(f.caller);
  f.scope.registerSessionAuthority({ require: async () => ({ source }) });
  const actor = await f.state.transaction(
    async (tx) =>
      await f.scope.createSessionActor(
        source,
        {
          threadId: 'lease-test',
          role: 'producer',
          name: 'Worker',
        },
        tx,
      ),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: 'lease-test', threadId: 'lease-test' },
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
  // The frozen execution is read as it was called with, whatever changes while the check runs.
  const frozen = structuredClone(offered.execution);
  f.controls.outputs = () => {
    frozen.policy.tools.push({ name: 'undeclared.write', alternatives: [{}] });
    frozen.references.artifacts = ['live-artifact'];
  };
  assert.deepEqual(
    (await f.workflows.checkLease(worker, offered.lease, undefined, frozen)).references,
    { artifacts: ['own-artifact'] },
  );
  f.controls.outputs = () => {};
  const release = { reason: 'Completed' };
  const releasing = f.workflows.releaseLease(offered.lease, release);
  release.reason = '';
  await releasing;
});

test('a lease check with its frozen execution grants the frozen references and declared outputs', async (t) => {
  const f = await engineFixture(t);
  const source = await f.scope.delegationSource(f.caller);
  f.scope.registerSessionAuthority({ require: async () => ({ source }) });
  const actor = await f.state.transaction(
    async (tx) =>
      await f.scope.createSessionActor(
        source,
        { threadId: 'lease-test', role: 'producer', name: 'Worker' },
        tx,
      ),
  );
  const worker: Caller = {
    projectId: actor.projectId,
    actorId: actor.id,
    session: { id: 'lease-test', threadId: 'lease-test' },
  };
  const { lease, execution } = await f.workflows.offerLease(f.caller, worker, {
    ...f.target,
    leaseId: 'lease-test',
  });
  const granted = async (frozen: WorkflowExecution = execution) =>
    (await f.workflows.checkLease(worker, lease, undefined, frozen)).references;
  // Without the execution there is nothing to grant.
  assert.deepEqual(await f.workflows.checkLease(worker, lease), {
    registrationId: execution.registrationId,
  });
  const references = await granted();
  assert.deepEqual(references, { artifacts: ['own-artifact'] });
  const admit = (input: Data) =>
    admitDispatch({ ...execution, references: references! }, 'artifact.read', input);
  assert.equal(admit({ artifactId: 'own-artifact' }).input.artifactId, 'own-artifact');
  assert.throws(() => admit({ artifactId: 'live-artifact' }), {
    code: 'execution_arguments_forbidden',
  });
  // The lease's outputs extend the declared arrays, and only those.
  f.controls.outputs = () => ({ artifacts: ['authored'] });
  assert.deepEqual(await granted(), { artifacts: ['authored', 'own-artifact'] });
  f.controls.outputs = () => ({ reviews: ['authored'] });
  await assert.rejects(granted(), { code: 'invalid_workflow_policy', status: 500 });
  f.controls.outputs = () => {};
  // The frozen policy is fenced by its content, whatever hash it names.
  const tampered = structuredClone(execution);
  tampered.policy.tools.push({ name: 'undeclared.write', alternatives: [{}] });
  await assert.rejects(granted(tampered), { code: 'execution_changed', status: 409 });
  await assert.rejects(granted({ ...execution, revision: execution.revision + 1 }), {
    code: 'execution_changed',
  });
  // The offer's generation is not fenced here: a reload keeps the lease, and Sessions fences
  // each invocation by the generation this check returns.
  assert.deepEqual(await granted({ ...execution, registrationId: 'reloaded' }), references);
});
