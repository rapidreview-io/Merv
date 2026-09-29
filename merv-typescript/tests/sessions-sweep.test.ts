/**
 * The sweep decides each subject on a snapshot of its own and records it in a writer only when
 * it has something to record. A light pass looks only at sessions whose deadline passed or
 * whose record moved; a full pass, every 30 s, re-checks every live session.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createService, type Caller, type State, type WorkflowPolicy } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');
const definition = {
  name: 'sweep',
  version: 1,
  initial: 'working',
  states: ['working', 'revised', 'done'],
  terminal: ['done'],
  edges: [
    { from: 'working', action: 'revise', to: 'revised' },
    { from: 'working', action: 'finish', to: 'done' },
  ],
};

async function fixture(t: TestContext, sweepIntervalMs = 60_000) {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const state = await openState();
  let writers = 0;
  const transaction: State['transaction'] = async (fn) => {
    if (!state.readScope && !state.ambient) writers++;
    return await state.transaction(fn);
  };
  const tracked = new Proxy(state, {
    get(target, key) {
      if (key === 'transaction') return transaction;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as State;
  const scope = await createService(new ProjectScope(tracked, () => clock));
  const workflows = await createService(new WorkflowsService(tracked, scope));
  const events = await createService(new DurableEvents(state));
  // Leases whose domain release runs a statement that fails, aborting its writer.
  const failing = new Set<string>();
  const producer: WorkflowPolicy['actions'][number]['check'] = async ({ caller, tx }) => {
    await scope.require(caller, 'write', tx);
  };
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'move',
        states: ['working'],
        transitions: ['finish', 'revise'],
        tool: 'move',
        instruction: 'Move the record.',
        check: producer,
      },
    ],
    assignments: [
      {
        state: 'working',
        check: producer,
        build: () => ({
          role: 'producer',
          label: 'Work',
          brief: 'Work.',
          references: [],
          handoff: { instruction: 'Finish', tools: [] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: { readOnly: false, tools: [] },
        lease: {
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: async ({ lease, tx }) => {
            if (failing.has((lease as { leaseId: string }).leaseId))
              await tx.run('INSERT INTO no_such_table VALUES (1)');
          },
        },
      },
    ],
  };
  const handle = await workflows.register(definition, policy);
  const boot = await scope.bootstrap({ projectName: 'Sweep', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  const opened: LeasedSessions[] = [];
  /** A Sessions process on this state; one closes before the next boots. */
  const open = async () => {
    opened.push(
      await createService(
        new LeasedSessions(tracked, scope, workflows, events, {
          clock: () => clock,
          sweepIntervalMs,
        }),
      ),
    );
    return opened.at(-1)!;
  };
  const sessions = await open();
  t.after(async () => {
    for (const each of opened) await each.close();
    await events.close();
    workflows.close();
    await state.close();
  });
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk: string, ...rest: never[]) => {
    if (String(chunk).includes('sessions.sweep_failed')) logged.push(String(chunk));
    return write(chunk, ...rest);
  });
  return {
    state,
    scope,
    sessions,
    open,
    handle,
    owner,
    source,
    failing,
    logged,
    async offer() {
      const target = await handle.start(source, { workflow: 'sweep', requestId: request() });
      const session = await sessions.offer(source, {
        instanceId: target.id,
        expectedRevision: 0,
        runnerId: 'runner',
        requestId: request(),
        secret: secret(),
      });
      return { session, target };
    },
    async status(id: string) {
      return (await state.read(
        async (sql) =>
          await sql.get<{ status: string }>('SELECT status FROM worker_sessions WHERE id=?', id),
      ))!.status;
    },
    pass: (full: boolean) =>
      (sessions as unknown as { pass(full: boolean): Promise<void> }).pass(full),
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    /** Writer transactions since the last call. */
    writers() {
      const counted = writers;
      writers = 0;
      return counted;
    },
  };
}

test('a close that fails holds back only its own session, retried by each full pass', async (t) => {
  const f = await fixture(t);
  const failed = await f.offer(),
    healthy = await f.offer();
  f.failing.add(failed.session.id);
  f.advance(300_001);
  await f.pass(false);
  assert.equal(await f.status(healthy.session.id), 'expired');
  assert.equal(await f.status(failed.session.id), 'offered');
  assert.equal(f.logged.length, 1);
  assert.deepEqual(JSON.parse(f.logged[0]!), {
    event: 'sessions.sweep_failed',
    subject: failed.session.id,
    code: 'transaction_aborted',
  });
  f.writers();
  await f.pass(false);
  assert.equal(f.writers(), 0, 'a light pass leaves a failing session to the next full pass');
  // Nor does it hold back the next offer, whose own light pass skips it too.
  await f.offer();
  f.writers();
  await f.pass(true);
  assert.equal(f.writers(), 1, 'the full pass retries it');
  assert.equal(await f.status(failed.session.id), 'offered');
  assert.equal(f.logged.length, 2, 'logged again once per full pass');
  f.failing.clear();
  await f.pass(true);
  assert.equal(await f.status(failed.session.id), 'expired');
});

test('a record moved by another hand is recorded by the next light pass alone', async (t) => {
  const f = await fixture(t);
  const moved = await f.offer(),
    kept = await f.offer();
  await f.handle.transition(f.owner, {
    instanceId: moved.target.id,
    expectedRevision: 0,
    action: 'revise',
    requestId: request(),
  });
  f.writers();
  await f.pass(false);
  assert.equal(f.writers(), 1);
  assert.equal(await f.status(moved.session.id), 'expired');
  assert.equal(await f.status(kept.session.id), 'offered');
});

test('a revoked source is recorded by the next full pass, not by a light one', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer();
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await f.pass(false);
  assert.equal(await f.status(session.id), 'offered');
  await f.pass(true);
  assert.equal(await f.status(session.id), 'expired');
});

test('the timer’s pass is full once 30 seconds have passed since the last', async (t) => {
  const f = await fixture(t, 100);
  const { session } = await f.offer();
  await f.sessions.sweep();
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  f.advance(30_000);
  for (let tries = 0; (await f.status(session.id)) === 'offered'; tries++) {
    assert.ok(tries < 100, 'the timer records the closure');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await f.status(session.id), 'expired');
});

test('boot interrupts only calls older than any client waits; close only its own', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer();
  const at = (ago: number) => new Date(f.now() - ago).toISOString();
  await f.state.transaction(async (tx) => {
    for (const [id, startedAt] of [
      ['lost', at(180_001)],
      ['elsewhere', at(60_000)],
    ])
      await tx.run(
        "INSERT INTO session_tool_calls(id,execution_id,tool,status,started_at,input_tokens) VALUES(?,?,'finish','running',?,0)",
        id,
        session.id,
        startedAt,
      );
  });
  const calls = async () =>
    await f.state.read(
      async (sql) =>
        await sql.all<{ id: string; status: string }>(
          'SELECT id,status FROM session_tool_calls ORDER BY id',
        ),
    );
  await f.sessions.close();
  assert.deepEqual(
    (await calls()).map((call) => call.status),
    ['running', 'running'],
    'a closing process interrupts only its own calls',
  );
  await f.open();
  assert.deepEqual(await calls(), [
    { id: 'elsewhere', status: 'running' },
    { id: 'lost', status: 'interrupted' },
  ]);
});
