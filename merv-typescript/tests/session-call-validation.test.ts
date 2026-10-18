import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Caller, Data, State, Transaction } from '@merv/contracts';
import type { TaskCheckpointInput } from '@merv/tasks/types';
import type { LeasedSessions } from '../packages/sessions/src/index.js';
import { createApp } from './fixtures/app.js';
import { currentTask, currentWork } from './fixtures/current-work.js';

// The owner's decision (2026-10-07): a leased worker's lease is validated once per worker call,
// at its start, by Workflows' lease authority and Sessions' session check. The call carries
// what was validated; only a write re-checks, cheaply and in its own transaction, that the
// lease was neither released nor moved before it commits. And (2026-10-14) an MCP request's
// authentication checks the session but leaves its lease to that one check.

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
      // A domain-events drain may or may not land inside the call (0-6 cursor reads): not counted.
      statements: statements.filter(
        (sql) => !/event_consumers|SELECT[\s\S]*\bFROM events\b/.test(sql),
      ).length,
    };
  };
  return { app, operator, task, lease, work, calls, checks };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The worker's MCP client, over HTTP with its session's bearer. */
async function mcp(t: TestContext, f: Fixture, token: string) {
  const client = new Client({ name: 'call-validation', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${f.app.ctx.api.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** How a lease ends under its worker, and the refusal that brings its next call: prepared in
 *  process (no authentication), and over MCP, where `transport` is its authentication's. */
const ends: [string, (f: Fixture, lease: Fixture['lease']) => Promise<unknown>, string, string][] =
  [
    [
      'its session was released',
      (f, lease) =>
        f.app.ctx.sessions.release(lease.source, {
          sessionId: lease.session.id,
          runnerId: lease.control.runnerId,
        }),
      'session_closed',
      'transport',
    ],
    [
      'its lease row was released',
      (f, lease) =>
        f.app.ctx.state.transaction((tx) =>
          tx.run(
            'UPDATE wf_leases SET released_at=? WHERE id=?',
            new Date().toISOString(),
            lease.session.id,
          ),
        ),
      'stale_lease',
      'stale_lease',
    ],
    [
      'it expired',
      (f, lease) =>
        f.app.ctx.state.transaction((tx) =>
          tx.run(
            `UPDATE worker_sessions SET session_json=(session_json::jsonb || '{"expiresAt":"2000-01-01T00:00:00.000Z"}'::jsonb)::text WHERE id=?`,
            lease.session.id,
          ),
        ),
      'session_closed',
      'transport',
    ],
  ];

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

test('a leased worker’s MCP call checks its lease once: its preparation’s, not its authentication’s', async (t) => {
  const f = await fixture(t);
  const client = await mcp(t, f, f.lease.token);
  for (const [name, args] of [
    ['artifact.read', { artifactId: f.task.briefId }],
    ['task.checkpoint', { notes: 'Over MCP.', requestId: 'mcp' }],
  ] as const) {
    f.checks.mock.resetCalls();
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(f.checks.mock.callCount(), 1, name);
  }
});

test('a leased worker’s tool listing checks its lease once, by its Scope decision, and reads its frozen policy', async (t) => {
  const f = await fixture(t);
  const { invocations } = f.app.ctx.sessions as unknown as LeasedSessions;
  f.checks.mock.resetCalls();
  assert.equal(await invocations.allowsTool(f.lease.worker, 'task.checkpoint'), true);
  assert.equal(await invocations.allowsTool(f.lease.worker, 'session.halt'), false);
  assert.equal(f.checks.mock.callCount(), 0);
  assert.ok((await f.app.ctx.tools.describe(f.lease.worker)).length > 0, 'listed');
  assert.equal(f.checks.mock.callCount(), 1);
});

for (const [name, end, inProcess, overMcp] of ends)
  test(`a leased worker’s next call is refused when ${name}, in process and over MCP`, async (t) => {
    const f = await fixture(t);
    const other = await f.work.lease(
      await currentTask(f.app.ctx, f.operator, {
        title: 'Refuse the call',
        goal: 'Refuse a call whose lease ended.',
        checks: ['The call is refused.'],
        requestId: 'other',
      }),
    );
    const client = await mcp(t, f, other.token);
    for (const lease of [f.lease, other]) await end(f, lease);
    const input = { artifactId: f.task.briefId };
    await assert.rejects(f.app.ctx.tools.invoke('artifact.read', f.lease.worker, input), {
      code: inProcess,
    });
    const refusal = () =>
      client.callTool({ name: 'artifact.read', arguments: input }).then(
        (result) =>
          result.isError
            ? JSON.parse((result.content as { text: string }[])[0]!.text).error.code
            : 'admitted',
        () => 'transport',
      );
    assert.equal(await refusal(), overMcp);
    // Whichever check refused it recorded the closure: the next request's authentication refuses.
    assert.equal(await refusal(), 'transport');
  });

for (const [name, end] of ends)
  test(`a write validated at the call’s start is refused when ${name} before it commits`, async (t) => {
    const f = await fixture(t);
    const { sessions, tasks } = f.app.ctx;
    const invocation = await sessions.invocations.prepare(f.lease.worker, 'task.checkpoint', {
      notes: 'Written after the lease ended.',
      requestId: 'late',
    });
    await assert.rejects(
      sessions.invocations.run(invocation, async (caller, input) => {
        await end(f, f.lease);
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
      await ends[1]![1](f, f.lease); // Its lease row released.
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

test('a wait for compute is refused when its lease row was released before it commits', async (t) => {
  const f = await fixture(t);
  const { sessions } = f.app.ctx;
  sessions.computeWaits.register({
    offers: async () => true,
    states: async ({ targets }) => ({
      targets: targets.map((target) => ({ ...target, status: 'running' as const })),
      idle: [],
    }),
  });
  const input = { jobIds: ['job_a'], reason: 'Waited for after the lease ended?' };
  const invocation = await sessions.invocations.prepare(
    f.lease.worker,
    'session.await_compute',
    input,
  );
  await assert.rejects(
    sessions.invocations.run(invocation, async (caller) => {
      await ends[1]![1](f, f.lease); // Its lease row released.
      const head = await f.app.ctx.state.eventHead();
      await assert.rejects(sessions.computeWaits.await(caller, input), (error: { code?: string }) =>
        ['session_closed', 'session_completed', 'stale_lease'].includes(error.code ?? ''),
      );
      assert.equal(await f.app.ctx.state.eventHead(), head, 'The refused write wrote nothing');
      throw Object.assign(new Error('refused'), { code: 'refused' });
    }),
    { code: 'refused' },
  );
});
