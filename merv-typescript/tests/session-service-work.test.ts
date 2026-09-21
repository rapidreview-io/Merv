import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createService } from '@merv/contracts';
import type { ServiceWorkInput } from '@merv/sessions/types';
import { SqliteState, PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { SessionServiceWork } from '../packages/sessions/src/service-work.js';
import { backends, optional, type Backend } from './fixtures/code-store.js';

async function fixture(t: TestContext, backend: Backend) {
  let time = Date.parse('2026-09-21T00:00:00Z');
  const schema = `service_work_${randomUUID().replaceAll('-', '')}`;
  const state =
    backend === 'sqlite'
      ? new SqliteState(':memory:')
      : await PostgresState.open({ connectionString: process.env.MERV_TEST_POSTGRES_URL!, schema });
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => time,
      sweepIntervalMs: 60_000,
      serviceConcurrency: 1,
    }),
  );
  t.after(async () => {
    await sessions.close();
    await events.close();
    workflows.close();
    await state.close();
    if (backend === 'postgres') {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  const boot = await scope.bootstrap({ projectName: 'Service work', actorName: 'Operator' });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await workflows.register(
    {
      name: 'work',
      version: 1,
      initial: 'ready',
      states: ['ready', 'done'],
      terminal: ['done'],
      edges: [{ from: 'ready', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          states: ['ready'],
          transitions: ['finish'],
          tool: 'finish',
          instruction: 'Finish',
          check: () => {},
        },
      ],
      successStates: ['done'],
    },
  );
  const roots = await Promise.all(
    ['a', 'b'].map((requestId) => workflows.start(caller, { workflow: 'work', requestId })),
  );
  const input: ServiceWorkInput = {
    provider: 'fixture',
    operationId: 'one',
    executionEpoch: 1,
    projectId: caller.projectId,
    sponsors: roots.map((r) => r.id).sort(),
    deadline: new Date(time + 10_000).toISOString(),
  };
  const admit = (value = input) => state.transaction((tx) => sessions.serviceWork.admit(tx, value));
  const settle = (value = input, outcome: 'completed' | 'failed' | 'expired' = 'completed') =>
    state.transaction((tx) => sessions.serviceWork.settle(tx, value, outcome));
  const usage = (instanceId?: string) => sessions.usage(caller, instanceId ? { instanceId } : {});
  await sessions.setDispatch(caller, { enabled: true });
  return {
    state,
    scope,
    workflows,
    sessions,
    caller,
    roots,
    input,
    admit,
    settle,
    usage,
    clock: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

for (const backend of backends) {
  test(
    `${backend}: service reservations and settlements survive every transactional boundary exactly once without Code`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      await assert.rejects(
        f.state.transaction(async (tx) => {
          await f.sessions.serviceWork.admit(tx, f.input);
          throw new Error('crash before commit');
        }),
      );
      assert.equal((await f.admit()).admitted, true);
      const restarted = new SessionServiceWork(f.state, f.scope, f.workflows, f.clock, 1);
      await restarted.initialize();
      assert.deepEqual(
        await f.admit(),
        await f.state.transaction((tx) => restarted.admit(tx, f.input)),
      );
      f.advance(2400);
      await assert.rejects(
        f.state.transaction(async (tx) => {
          await restarted.settle(tx, f.input, 'completed');
          throw new Error('crash before settlement commit');
        }),
      );
      assert.equal((await f.usage()).totals.wallMs, 0);
      await f.settle();
      await f.settle();
      assert.equal((await f.usage()).totals.wallMs, 2400);
      assert.equal((await f.usage()).totals.sessions, 0, 'no fabricated worker session');
      assert.equal((await f.admit()).admitted, true);
      await assert.rejects(
        f.admit({ ...f.input, deadline: new Date(f.clock() + 50_000).toISOString() }),
        { code: 'request_conflict' },
      );
      await assert.rejects(f.settle(f.input, 'failed'), { code: 'request_conflict' });
      for (const sql of [
        'UPDATE session_service_work SET wall_ms=0',
        "UPDATE session_service_work SET sponsors_json='[]'",
        'DELETE FROM session_service_work',
      ])
        await assert.rejects(f.state.transaction((tx) => tx.run(sql)));
    },
  );
  test(
    `${backend}: simultaneous service records share one project cap; expired work releases it and rejects late settlement`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const inputs = [f.input, { ...f.input, operationId: 'two' }];
      const outcomes = await Promise.all(inputs.map(f.admit));
      assert.equal(outcomes.filter((o) => o.admitted).length, 1);
      assert.equal(outcomes.filter((o) => !o.admitted && o.reason === 'capacity_full').length, 1);
      f.advance(11_000);
      const retry = {
        ...f.input,
        executionEpoch: 2,
        deadline: new Date(f.clock() + 10_000).toISOString(),
      };
      assert.equal((await f.admit(retry)).admitted, true);
      await f.settle();
      assert.equal(
        (await f.usage()).totals.wallMs,
        10_000,
        'deadline usage is retained once even when an old completion arrives',
      );
      f.advance(1000);
      await f.settle(retry);
      assert.equal((await f.usage()).totals.wallMs, 11_000);
    },
  );
  test(
    `${backend}: shared wall time is charged once per project and fully to immutable roots; budgets and dispatch refuse without reservations`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const first = { ...f.input, deadline: new Date(f.clock() + 70_000).toISOString() };
      await f.admit(first);
      f.advance(60_000);
      await f.settle(first);
      assert.equal((await f.usage()).totals.wallMs, 60_000);
      for (const root of f.roots) assert.equal((await f.usage(root.id)).totals.wallMs, 60_000);
      await f.sessions.setBudget(f.caller, { instanceId: f.roots[0]!.id, maxWallMinutes: 1 });
      const retry = {
        ...f.input,
        operationId: 'next',
        deadline: new Date(f.clock() + 10_000).toISOString(),
      };
      assert.deepEqual(await f.admit(retry), { admitted: false, reason: 'budget_exceeded' });
      assert.equal(
        (await f.state.read((sql) =>
          sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM session_service_work'),
        ))!.n,
        1,
      );
      await f.sessions.setBudget(f.caller, { instanceId: f.roots[0]!.id, maxWallMinutes: null });
      await f.sessions.setDispatch(f.caller, { enabled: false });
      assert.deepEqual(await f.admit(retry), { admitted: false, reason: 'dispatch_disabled' });
      await f.sessions.setDispatch(f.caller, { enabled: true });
      assert.equal((await f.admit(retry)).admitted, true);
      await f.settle(retry);
    },
  );
  test(
    `${backend}: a sponsor is found through workflow dependencies and remains charged after another root adopts it`,
    optional(backend),
    async (t) => {
      const f = await fixture(t, backend);
      const waiter = await f.workflows.start(f.caller, { workflow: 'work', requestId: 'waiter' });
      const root = await f.workflows.start(f.caller, {
        workflow: 'work',
        requestId: 'root',
        dependsOn: [waiter.id],
      });
      const sponsors = await f.state.transaction((tx) =>
        f.workflows.sponsoringRoots(f.caller.projectId, [waiter.id], tx),
      );
      assert.deepEqual(sponsors, [root.id]);
      const input = { ...f.input, sponsors };
      await f.admit(input);
      f.advance(3000);
      await f.settle(input);
      const later = await f.workflows.start(f.caller, {
        workflow: 'work',
        requestId: 'later',
        dependsOn: [root.id],
      });
      assert.equal((await f.usage(root.id)).totals.wallMs, 3000);
      assert.equal(
        (await f.usage(later.id)).totals.wallMs,
        0,
        'a changed closure cannot adopt old shared charges',
      );
    },
  );
}
