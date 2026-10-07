import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Caller, Data, State, Transaction } from '@merv/contracts';
import type { TaskCheckpointInput } from '@merv/tasks/types';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';

// The owner's decision (2026-10-07): a leased worker's lease is validated once per worker call,
// at its start, by Workflows' lease authority and Sessions' session check. The call carries
// what was validated; only a write re-checks, cheaply and in its own transaction, that the
// lease was neither released nor moved before it commits.

/** The SQL text of every statement `run` issues itself, in order. */
function recorder(state: State) {
  const mine = new AsyncLocalStorage<string[]>();
  const patched = new WeakSet<object>();
  const patch = (tx: Transaction) => {
    if (patched.has(tx)) return;
    patched.add(tx);
    for (const key of ['get', 'all', 'run'] as const) {
      const original = tx[key] as (...args: unknown[]) => unknown;
      Object.assign(tx, {
        [key]: (...args: unknown[]) => {
          mine.getStore()?.push(String(args[0]).replace(/\s+/g, ' '));
          return original.apply(tx, args);
        },
      });
    }
  };
  const target = state as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['transaction', 'read'] as const) {
    const original = target[name]!.bind(state);
    target[name] = (fn: unknown, ...rest: unknown[]) =>
      original(
        async (tx: Transaction) => {
          patch(tx);
          return await (fn as (tx: Transaction) => unknown)(tx);
        },
        ...rest,
      );
  }
  return async (run: () => Promise<unknown>) => {
    const list: string[] = [];
    await mine.run(list, run);
    return list;
  };
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-call-validation-'));
  const app = await createApp({ directory, api: true, port: 0 });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Calls',
    actorName: 'Operator',
  });
  const operator: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const work = currentWork(app.ctx, { directory, source: operator });
  t.after(async () => {
    await work.close();
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = await currentTask(app.ctx, operator, {
    title: 'Count the checks',
    goal: 'Validate a worker’s lease once per call.',
    checks: ['Each call validates its lease once.'],
    requestId: 'create',
  });
  const lease = await work.lease(task);
  await app.ctx.domainEvents.drain();
  const record = recorder(app.ctx.state);
  const checks = t.mock.method(app.ctx.workflows, 'checkLease');
  const calls = async (tool: string, input: Data) => {
    checks.mock.resetCalls();
    const statements = await record(() => app.ctx.tools.invoke(tool, lease.worker, input));
    if (process.env.MERV_CALL_COUNTS) console.log(tool, statements.length);
    return {
      leaseValidations: checks.mock.callCount(),
      sessionReads: statements.filter((sql) => /FROM worker_sessions s\b/.test(sql)).length,
      leaseReads: statements.filter((sql) => /FROM wf_leases\b/.test(sql)).length,
      statements: statements.length,
    };
  };
  return { app, operator, task, lease, work, calls };
}

test('a leased worker’s read validates its lease once, at the start of the call', async (t) => {
  const { task, calls } = await fixture(t);
  // Before: 11 lease validations, 11 session reads, 7 lease reads, 116 statements.
  // After: 1, 1, 1, 27.
  const read = await calls('artifact.read', { artifactId: task.briefId });
  assert.equal(read.leaseValidations, 1, JSON.stringify(read));
  assert.equal(read.sessionReads, 1, JSON.stringify(read));
  assert.equal(read.leaseReads, 1, JSON.stringify(read));
  assert.ok(read.statements <= 30, JSON.stringify(read));
});

test('a leased worker’s write validates its lease once, and re-checks it once where it writes', async (t) => {
  const { calls } = await fixture(t);
  // Before: 7 lease validations, 8 session reads, 4 lease reads, 93–98 statements.
  // After: 1, 2, 2, 48–51: the write transaction's one re-check reads the session and lease rows
  // again, and the task's own lease read in it shares that read.
  const write = await calls('task.checkpoint', { notes: 'Progress so far.', requestId: 'one' });
  assert.equal(write.leaseValidations, 1, JSON.stringify(write));
  assert.equal(write.sessionReads, 2, JSON.stringify(write));
  assert.equal(write.leaseReads, 2, JSON.stringify(write));
  assert.ok(write.statements <= 55, JSON.stringify(write));
});

for (const [name, end] of [
  [
    'its session was released',
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      await f.app.ctx.sessions.release(f.lease.source, {
        sessionId: f.lease.session.id,
        runnerId: f.lease.control.runnerId,
      }),
  ],
  [
    'its lease row was released',
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE wf_leases SET released_at=? WHERE id=?',
            new Date().toISOString(),
            f.lease.session.id,
          ),
      ),
  ],
] as const)
  test(`a write validated at the call’s start is refused when ${name} before it commits`, async (t) => {
    const f = await fixture(t);
    const { sessions, tasks } = f.app.ctx;
    const invocation = await sessions.invocations.prepare(f.lease.worker, 'task.checkpoint', {
      notes: 'Written after the lease ended.',
      requestId: 'late',
    });
    await assert.rejects(
      sessions.invocations.run(invocation, async (caller, input) => {
        await end(f);
        const head = await f.app.ctx.state.eventHead();
        await assert.rejects(
          tasks.checkpoint(caller, input as unknown as TaskCheckpointInput),
          (error: { code?: string }) =>
            ['session_closed', 'session_completed', 'stale_lease'].includes(error.code ?? ''),
        );
        assert.equal(await f.app.ctx.state.eventHead(), head, 'The refused write wrote nothing');
        throw Object.assign(new Error('refused'), { code: 'refused' });
      }),
      { code: 'refused' },
    );
  });

// A write that its domain gates with a read decision (session.ask_owner, session.message.ack)
// is still a write: its transaction re-checks the lease the call validated at its start.
test('a write gated by a read decision is refused when its lease row was released before it commits', async (t) => {
  const f = await fixture(t);
  const { sessions } = f.app.ctx;
  const invocation = await sessions.invocations.prepare(f.lease.worker, 'session.ask_owner', {
    question: 'Asked after the lease ended?',
  });
  await assert.rejects(
    sessions.invocations.run(invocation, async (caller) => {
      await f.app.ctx.state.transaction(
        async (tx) =>
          await tx.run(
            'UPDATE wf_leases SET released_at=? WHERE id=?',
            new Date().toISOString(),
            f.lease.session.id,
          ),
      );
      const head = await f.app.ctx.state.eventHead();
      await assert.rejects(
        sessions.messaging.ask(caller, { question: 'Asked after the lease ended?' }),
        (error: { code?: string }) =>
          ['session_closed', 'session_completed', 'stale_lease'].includes(error.code ?? ''),
      );
      assert.equal(await f.app.ctx.state.eventHead(), head, 'The refused write wrote nothing');
      throw Object.assign(new Error('refused'), { code: 'refused' });
    }),
    { code: 'refused' },
  );
});
