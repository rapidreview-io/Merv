import type { Caller, Data } from '@merv/contracts';

import type { Session } from '@merv/sessions/types';

import type { Task, TaskCheckpointInput, TaskContext, TaskDelivery } from '@merv/tasks/types';

import assert from 'node:assert/strict';

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';

import { confirmedDelivery } from './fixtures/task-evidence.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-workflow-leases-'));
  const app = await createApp({ directory, api: false });
  let closeWork = async () => {};
  t.after(async () => {
    await closeWork();
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
  closeWork = () => work.close();
  const held = new Map<string, Awaited<ReturnType<typeof work.attach>>>();
  t.after(() => {
    for (const lease of held.values()) lease.driver?.dispose();
  });
  await app.ctx.sessions.dispatch.heartbeatRunner(source, {
    runnerId: 'test',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
    capacity: 4,
    capabilities: ['code.v2', 'code.git.1'],
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
      await work.commit(lease);
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
  assert.ok(offered.session.assignment.context!.prompt.includes(predecessor.id));
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
  assert.ok(context.prompt.includes(predecessor.id));
  const recovered = await f.run(
    worker,
    'artifact.read',
    { artifactId: predecessor.id },
    (caller, input) => artifacts.read(caller, String(input.artifactId)),
  );
  assert.equal(recovered.content, 'PRE_OFFER_EVIDENCE_42');
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
  assert.ok(fresh.prompt.includes(output.id));
  await f.release(offered.session);
  const successor = await f.offer();
  assert.ok((successor.session.execution.references.artifacts as string[]).includes(output.id));
  assert.ok(successor.session.assignment.context!.prompt.includes(output.id));
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
