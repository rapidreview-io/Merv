import { createService, type Caller, type WorkflowPolicy } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');
const presence = {
  runnerId: 'machine',
  machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
  platforms: [
    {
      name: 'codex',
      harness: 'codex' as const,
      model: 'fixture-model',
      enabled: true,
      parallelism: 4,
    },
  ],
  capacity: 1,
};
const auto = () => ({
  runnerId: 'machine',
  requestId: request(),
  secret: secret(),
  platform: { name: 'codex', harness: 'codex' as const, model: 'fixture-model' },
});
const backends = [
  { name: 'sqlite', postgres: false, skip: false as boolean | string },
  {
    name: 'postgres',
    postgres: true,
    skip: process.env.MERV_TEST_POSTGRES_URL ? false : 'MERV_TEST_POSTGRES_URL is not set',
  },
];

async function fixture(t: TestContext, postgres = false, maxLaunchFailures?: number) {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const schema = `merv_usage_${randomUUID().replaceAll('-', '')}`;
  const state = postgres
    ? await PostgresState.open({ connectionString: process.env.MERV_TEST_POSTGRES_URL!, schema })
    : new SqliteState(':memory:');
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  /** Instances a policy names as children of another, without a dependency edge. */
  const fanOut = new Map<string, string[]>();
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    children: ({ instanceId }) => fanOut.get(instanceId) ?? [],
    actions: [
      {
        name: 'finish',
        states: ['working'],
        transitions: ['finish'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
        build: () => ({
          role: 'producer',
          label: 'Work',
          brief: 'Frozen brief',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: false,
          tools: [
            {
              name: 'finish',
              alternatives: [
                {
                  instanceId: { kind: 'target', field: 'instanceId' },
                  expectedRevision: { kind: 'target', field: 'revision' },
                },
              ],
            },
          ],
        },
        lease: {
          role: () => 'producer' as const,
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const definition = {
    name: 'usage-fixture',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  const handle = await workflows.register(definition, policy);
  const boot = await scope.bootstrap({ projectName: 'Usage', actorName: 'Owner' });
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
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => clock,
      sweepIntervalMs: 60_000,
      ...(maxLaunchFailures === undefined ? {} : { maxLaunchFailures }),
    }),
  );
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
    if (postgres) {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
  });
  const instance = async (dependsOn?: string[]) =>
    await handle.start(source, {
      workflow: definition.name,
      requestId: request(),
      ...(dependsOn ? { dependsOn } : {}),
    });
  const offer = async (instanceId: string) => {
    const token = secret();
    const session = await sessions.offer(source, {
      instanceId,
      expectedRevision: 0,
      runnerId: 'machine',
      requestId: request(),
      secret: token,
    });
    return { token, session };
  };
  /** One closed session on the instance that was active for `ms` of lease wall-clock. */
  const spend = async (instanceId: string, ms: number) => {
    const { token, session } = await offer(instanceId);
    await sessions.authenticate(token);
    clock += ms;
    return await sessions.release(source, { sessionId: session.id, runnerId: 'machine' });
  };
  return {
    state,
    scope,
    workflows,
    sessions,
    handle,
    owner,
    source,
    fanOut,
    instance,
    offer,
    spend,
    advance: (ms: number) => (clock += ms),
    events: async (type: string) =>
      (await state.events(owner.projectId)).filter((event) => event.type === type),
    usageRow: async (sessionId: string) =>
      await state.read(
        async (sql) =>
          await sql.get<Record<string, unknown>>(
            'SELECT * FROM session_usage WHERE session_id=?',
            sessionId,
          ),
      ),
  };
}

for (const backend of backends)
  test(
    `[${backend.name}] a close writes one usage row, a report lands once, and the row is then sealed`,
    { skip: backend.skip },
    async (t) => {
      const f = await fixture(t, backend.postgres);
      const idle = await f.offer((await f.instance()).id);
      await f.sessions.release(f.source, { sessionId: idle.session.id, runnerId: 'machine' });
      const never = (await f.usageRow(idle.session.id))!;
      assert.equal(Number(never.wall_ms), 0, 'A session that was never activated cost no time');
      assert.equal(never.started_at, null);

      const target = await f.instance();
      const { token, session } = await f.offer(target.id);
      const worker = await f.sessions.authenticate(token);
      f.advance(90_000);
      const prepared = await f.sessions.prepare(worker, 'finish', {});
      await f.sessions.run(
        prepared,
        async (caller) =>
          await f.handle.transition(caller, {
            instanceId: target.id,
            expectedRevision: 0,
            action: 'finish',
            requestId: 'finish',
          }),
      );
      // The handoff closed the session; the runner's report arrives afterwards, on release.
      const usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0.0421, model: 'reported' };
      const released = await f.sessions.release(f.source, {
        sessionId: session.id,
        runnerId: 'machine',
        usage,
      });
      assert.equal(released.outcome, 'completed');
      const row = (await f.usageRow(session.id))!;
      assert.equal(
        Number(row.wall_ms),
        Date.parse(released.closedAt!) - Date.parse(released.activatedAt!),
      );
      assert.equal(Number(row.wall_ms), 90_000);
      assert.deepEqual(
        [row.workflow, row.state, row.role, row.outcome, Number(row.revision)],
        ['usage-fixture', 'working', 'producer', 'completed', 0],
      );
      assert.deepEqual(
        [Number(row.input_tokens), Number(row.output_tokens), Number(row.cost_micros)],
        [1200, 300, 42_100],
      );
      assert.equal(row.reported_model, 'reported');

      await f.sessions.release(f.source, {
        sessionId: session.id,
        runnerId: 'machine',
        usage: { inputTokens: 9, outputTokens: 9 },
      });
      assert.equal(Number((await f.usageRow(session.id))!.input_tokens), 1200);
      const reported = await f.events('session.usage_reported');
      assert.equal(reported.length, 1);
      assert.equal(reported[0]!.actorId, 'system:sessions');
      await assert.rejects(
        async () =>
          await f.sessions.release(f.source, {
            sessionId: session.id,
            runnerId: 'machine',
            usage: { inputTokens: -1, outputTokens: 0 },
          }),
        { code: 'invalid_usage' },
      );

      for (const sql of [
        'UPDATE session_usage SET wall_ms=1 WHERE session_id=?',
        "UPDATE session_usage SET model='other' WHERE session_id=?",
        'DELETE FROM session_usage WHERE session_id=?',
      ])
        await assert.rejects(
          async () => await f.state.transaction(async (tx) => await tx.run(sql, idle.session.id)),
          sql,
        );
      await assert.rejects(
        async () =>
          await f.state.transaction(
            async (tx) =>
              await tx.run(
                'UPDATE session_usage SET input_tokens=1 WHERE session_id=?',
                session.id,
              ),
          ),
        'A reported row accepts no further update',
      );
    },
  );

for (const backend of backends)
  test(
    `[${backend.name}] usage rolls up over a dependency closure and the children a policy names`,
    { skip: backend.skip },
    async (t) => {
      const f = await fixture(t, backend.postgres);
      const first = await f.instance(),
        second = await f.instance(),
        lens = await f.instance(),
        apart = await f.instance();
      const parent = await f.instance([first.id, second.id]);
      f.fanOut.set(second.id, [lens.id]);
      await f.spend(first.id, 1000);
      await f.spend(second.id, 2000);
      await f.spend(lens.id, 4000);
      await f.spend(apart.id, 8000);
      const closed = await f.spend(parent.id, 16_000);
      await f.sessions.release(f.source, {
        sessionId: closed.id,
        runnerId: 'machine',
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
      });

      const cycle = await f.sessions.usage(f.owner, { instanceId: parent.id });
      assert.deepEqual(cycle.scope, {
        kind: 'instance',
        instanceId: parent.id,
        includeDependencies: true,
        instanceCount: 4,
      });
      assert.equal(cycle.totals.wallMs, 23_000);
      assert.equal(cycle.totals.sessions, 4);
      assert.equal(cycle.totals.reportedSessions, 1, 'Only one runner reported');
      assert.deepEqual(
        [cycle.totals.inputTokens, cycle.totals.outputTokens, cycle.totals.costMicros],
        [10, 5, 1_000_000],
      );
      assert.equal(cycle.byInstance[0]!.instanceId, parent.id);
      assert.deepEqual(
        cycle.byWorkflow.map((item) => [item.workflow, item.wallMs]),
        [['usage-fixture', 23_000]],
      );
      assert.equal(cycle.accounting.tokens, 'runner_reported');
      assert.match(cycle.accounting.method, /not verified/);
      assert.ok(cycle.accounting.since);

      const alone = await f.sessions.usage(f.owner, {
        instanceId: parent.id,
        includeDependencies: false,
      });
      assert.equal(alone.totals.wallMs, 16_000);
      assert.equal(alone.scope.kind === 'instance' && alone.scope.instanceCount, 1);
      const project = await f.sessions.usage(f.owner);
      assert.equal(project.totals.wallMs, 31_000);
      assert.equal(project.totals.sessions, 5);

      // A leased worker may read it: a lens has to be able to say what a cycle cost.
      const { token } = await f.offer((await f.instance()).id);
      const worker = await f.sessions.authenticate(token);
      const seen = await f.sessions.usage(worker, { instanceId: parent.id });
      assert.equal(seen.totals.wallMs, 23_000);
      assert.equal((await f.sessions.usage(worker)).liveSessions, 1);
      await assert.rejects(
        async () => await f.sessions.usage(f.owner, { includeDependencies: false }),
        { code: 'invalid_usage_query' },
      );
    },
  );

test('a budget is set by an admin who is not a leased worker, and setting it again records nothing', async (t) => {
  const f = await fixture(t);
  const { token } = await f.offer((await f.instance()).id);
  const worker = await f.sessions.authenticate(token);
  await assert.rejects(async () => await f.sessions.setBudget(worker, { maxWallMinutes: 1 }), {
    status: 403,
  });
  await assert.rejects(async () => await f.sessions.setBudget(f.source, { maxWallMinutes: 1 }), {
    status: 403,
  });
  await assert.rejects(async () => await f.sessions.setBudget(f.owner, {}), {
    code: 'invalid_budget',
  });
  await assert.rejects(async () => await f.sessions.setBudget(f.owner, { maxTokens: null }), {
    code: 'budget_not_found',
  });
  await assert.rejects(
    async () => await f.sessions.setBudget(f.owner, { instanceId: 'missing', maxTokens: 5 }),
    { status: 404 },
  );
  const set = await f.sessions.setBudget(f.owner, { maxWallMinutes: 2, maxCostUsd: 1.5 });
  assert.deepEqual(
    [set.kind, set.scopeId, set.maxWallMs, set.maxCostMicros, set.maxTokens, set.exceeded],
    ['project', f.owner.projectId, 120_000, 1_500_000, null, []],
  );
  f.advance(1000);
  const again = await f.sessions.setBudget(f.owner, { maxWallMinutes: 2 });
  assert.equal(again.updatedAt, set.updatedAt);
  assert.equal((await f.events('session.budget_changed')).length, 1);
  const cleared = await f.sessions.setBudget(f.owner, { maxCostUsd: null });
  assert.deepEqual([cleared.maxWallMs, cleared.maxCostMicros], [120_000, null]);
  assert.equal((await f.events('session.budget_changed')).length, 2);
});

for (const backend of backends)
  test(
    `[${backend.name}] a reached project budget pauses automatic offers, stops nothing, and lifts when raised`,
    { skip: backend.skip },
    async (t) => {
      const f = await fixture(t, backend.postgres);
      await f.sessions.heartbeatRunner(f.source, { ...presence, capacity: 4 });
      await f.sessions.setDispatch(f.owner, { enabled: true });
      await f.sessions.setBudget(f.owner, { maxWallMinutes: 1 });
      await f.instance();
      await f.instance();
      const running = (await f.sessions.lease(f.source, auto())).session!;
      await f.spend((await f.instance()).id, 60_000);
      await f.sessions.heartbeatRunner(f.source, { ...presence, capacity: 4 });

      assert.equal((await f.sessions.lease(f.source, auto())).reason, 'budget_exceeded');
      assert.equal((await f.sessions.lease(f.source, auto())).reason, 'budget_exceeded');
      const status = await f.sessions.projectStatus(f.owner);
      assert.deepEqual(status.budgets[0]!.exceeded, ['wall']);
      assert.equal(status.budgets[0]!.used.wallMs, 60_000);
      assert.equal(status.runners[0]!.lastDecision, 'budget_exceeded');
      assert.equal(
        (await f.sessions.get(f.source, running.id)).status,
        'offered',
        'A budget never closes a session that already exists',
      );
      const read = await f.sessions.usage(f.owner);
      assert.deepEqual(read.budgets[0]!.exceeded, ['wall']);

      await f.sessions.setBudget(f.owner, { maxWallMinutes: 5 });
      assert.equal((await f.sessions.lease(f.source, auto())).reason, 'offered');
    },
  );

test('an instance budget withholds only the work inside its closure', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.source, { ...presence, capacity: 4 });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const child = await f.instance();
  const cycle = await f.instance([child.id]);
  await f.sessions.setBudget(f.owner, { instanceId: cycle.id, maxTokens: 100 });
  const spent = await f.spend(child.id, 1000);
  await f.sessions.release(f.source, {
    sessionId: spent.id,
    runnerId: 'machine',
    usage: { inputTokens: 60, outputTokens: 40 },
  });
  assert.equal(
    (await f.sessions.lease(f.source, auto())).reason,
    'budget_exceeded',
    'Everything left in the queue is inside the spent closure',
  );
  assert.equal((await f.sessions.projectStatus(f.owner)).queueTotal, 0);
  const other = await f.instance();
  const leased = await f.sessions.lease(f.source, auto());
  assert.equal(leased.session?.instanceId, other.id);
  const read = await f.sessions.usage(f.owner, { instanceId: cycle.id });
  assert.deepEqual(
    read.budgets.map((budget) => [budget.kind, budget.exceeded, budget.used.tokens]),
    [['instance', ['tokens'], 100]],
  );
});

test('launches that keep failing on one revision stop being offered until dispatch is switched off and on', async (t) => {
  const f = await fixture(t, false, 2);
  await f.sessions.heartbeatRunner(f.source, presence);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  f.advance(1);
  const fail = async () => {
    const leased = (await f.sessions.lease(f.source, auto())).session!;
    assert.equal(leased.instanceId, target.id);
    await f.sessions.release(f.source, {
      sessionId: leased.id,
      runnerId: 'machine',
      outcome: 'launch_failed',
    });
  };
  await fail();
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retry_backoff');
  f.advance(30_001);
  await fail();
  f.advance(30_001);
  await f.sessions.heartbeatRunner(f.source, presence);
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retries_exhausted');
  const status = await f.sessions.projectStatus(f.owner);
  assert.deepEqual([status.retriesExhausted, status.queueTotal], [1, 0]);

  // Other work is still offered, and names no withheld cause while it is.
  const other = await f.instance();
  const leased = (await f.sessions.lease(f.source, auto())).session!;
  assert.equal(leased.instanceId, other.id);
  await f.sessions.release(f.source, { sessionId: leased.id, runnerId: 'machine' });
  await f.sessions.halt(f.owner, {});

  f.advance(1000);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  assert.equal((await f.sessions.projectStatus(f.owner)).retriesExhausted, 0);
});

test('sessions refuses a launch-failure cap outside 1–100', async (t) => {
  await assert.rejects(async () => await fixture(t, false, 0), { code: 'invalid_sessions_config' });
});
