import type { WorkflowWorkspacePolicy } from '@merv/contracts';
import {
  createService,
  MervError,
  migrationList,
  type Caller,
  type WorkflowPolicy,
} from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import { ProjectScope } from '@merv/scope';
import { LeasedSessions, type Session, type SessionsConfig } from '@merv/sessions';
import type { StuckReport } from '@merv/sessions/types';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');
const presence = (runnerId = 'machine') => ({
  runnerId,
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
});
const auto = (runnerId = 'machine') => ({
  runnerId,
  requestId: request(),
  secret: secret(),
  platform: { name: 'codex', harness: 'codex' as const, model: 'fixture-model' },
});
interface HoldRow {
  instance_id: string;
  revision: number;
  attempts: number;
  last_code: string;
  last_message: string;
  last_session_id: string | null;
  held_at: string | null;
}

async function fixture(
  t: TestContext,
  options: {
    maxLaunchFailures?: number;
    dispatchSchema?: number;
    config?: SessionsConfig;
    tuning?: Partial<StuckReport['thresholds']>;
    workspace?: WorkflowWorkspacePolicy;
  } = {},
) {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const state = await openState();
  const migrate = state.migrate.bind(state);
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  let buildHook: (() => void) | undefined;
  let leaseRole: 'producer' | 'operator' = 'producer';
  const working = (name: string): NonNullable<WorkflowPolicy['assignments']>[number] => ({
    state: name,
    check: async ({ caller, tx }) => {
      await scope.require(caller, 'write', tx);
    },
    build: () => {
      buildHook?.();
      return {
        role: 'producer',
        label: 'Work',
        brief: 'Frozen brief',
        references: [],
        handoff: { instruction: 'Finish', tools: ['finish'] },
        execution: { readOnly: false, tools: [] },
        context: null,
      };
    },
    execution: {
      ...(options.workspace ? { workspace: options.workspace } : {}),
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
      role: () => leaseRole,
      acquire: ({ leaseId }) => ({ leaseId }),
      check: () => {},
      release: () => {},
    },
  });
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: [
      {
        name: 'finish',
        states: ['working', 'revised'],
        transitions: ['finish', 'revise'],
        tool: 'finish',
        instruction: 'Finish.',
        check: async ({ caller, tx }) => {
          await scope.require(caller, 'write', tx);
        },
      },
    ],
    assignments: [working('working'), working('revised')],
  };
  const definition = {
    name: 'liveness-fixture',
    version: 1,
    initial: 'working',
    states: ['working', 'revised', 'done'],
    terminal: ['done'],
    edges: [
      { from: 'working', action: 'revise', to: 'revised' },
      { from: 'working', action: 'finish', to: 'done' },
      { from: 'revised', action: 'finish', to: 'done' },
    ],
  };
  const handle = await workflows.register(definition, policy);
  const boot = await scope.credentials.bootstrap({ projectName: 'Liveness', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.credentials.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  const open = async (dispatchSchema?: number) => {
    state.migrate =
      dispatchSchema === undefined
        ? migrate
        : async (component, migrations) =>
            await migrate(
              component,
              component === 'session_dispatch'
                ? migrationList(migrations).filter((m) => m.version <= dispatchSchema)
                : migrations,
            );
    try {
      return await createService(
        new LeasedSessions(
          state,
          scope,
          workflows,
          events,
          { clock: () => clock, sweepIntervalMs: 60_000, ...options.config },
          {
            ...options.tuning,
            ...(options.maxLaunchFailures === undefined
              ? {}
              : { maxLaunchFailures: options.maxLaunchFailures }),
          },
        ),
      );
    } finally {
      state.migrate = migrate;
    }
  };
  let sessions = await open(options.dispatchSchema);
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  const runner = async (runnerId = 'machine') =>
    (await sessions.dispatch.projectStatus(owner)).runners.find(
      (item) => item.runnerId === runnerId,
    )!;
  return {
    state,
    scope,
    workflows,
    handle,
    owner,
    source,
    runner,
    get sessions() {
      return sessions;
    },
    instance: async () =>
      await handle.start(source, { workflow: definition.name, requestId: request() }),
    advance: (ms: number) => (clock += ms),
    time: () => new Date(clock).toISOString(),
    /** Workflows stamps a revision with the machine's clock, so waiting is measured from it. */
    wallClock: () => (clock = Date.now()),
    onBuild(hook?: () => void) {
      buildHook = hook;
    },
    leaseRole(role: 'producer' | 'operator') {
      leaseRole = role;
    },
    /** One automatic lease, activated by its worker's first authentication. */
    async active(runnerId = 'machine') {
      const input = auto(runnerId);
      const leased = await sessions.dispatch.lease(source, input);
      assert.ok(leased.session, leased.reason);
      return {
        id: leased.session.id,
        secret: input.secret,
        worker: await sessions.authenticate(input.secret),
      };
    },
    /** One recorded tool call that leaves the record where it is. */
    async call(worker: Caller, handler: () => void | Promise<void> = () => {}) {
      await sessions.invocations.run(
        await sessions.invocations.prepare(worker, 'finish', {}),
        handler,
      );
    },
    stored: async (id: string): Promise<Session> =>
      JSON.parse(
        (await state.read(
          async (sql) =>
            await sql.get<{ session_json: string }>(
              'SELECT session_json FROM worker_sessions WHERE id=?',
              id,
            ),
        ))!.session_json,
      ),
    /** One automatic lease on the runner that the launching machine reports as failed. */
    async fail(
      runnerId = 'machine',
      outcome:
        | 'launch_failed'
        | 'host_failed'
        | 'workspace_failed'
        | 'preparation_deferred' = 'launch_failed',
      deferral?: { cause: string; code: string },
    ) {
      const leased = await sessions.dispatch.lease(source, auto(runnerId));
      assert.ok(leased.session, leased.reason);
      await sessions.release(source, {
        sessionId: leased.session.id,
        runnerId,
        outcome,
        ...(outcome === 'preparation_deferred'
          ? { deferral: deferral ?? { cause: 'store_busy', code: 'code_store_full' } }
          : {}),
      });
      return leased.session;
    },
    /** Past the thirty-second backoff, with every runner still fresh. */
    async pastBackoff(...runnerIds: string[]) {
      clock += 30_001;
      for (const id of runnerIds.length ? runnerIds : ['machine'])
        await sessions.dispatch.heartbeatRunner(source, presence(id));
    },
    async upgrade() {
      await sessions.close();
      sessions = await open();
    },
    holds: async () =>
      await state.read(
        async (sql) =>
          await sql.all<HoldRow>('SELECT * FROM session_dispatch_holds ORDER BY instance_id'),
      ),
    events: async (type: string) =>
      (await state.events(owner.projectId)).filter((event) => event.type === type),
  };
}

test('a target that keeps failing across runners is held, stops blocking the queue, and one admin go-ahead offers it again', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 3 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.heartbeatRunner(f.source, presence('second'));
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  f.advance(1);

  // The count is the project's: two machines failing the same target share it.
  await f.fail('machine');
  const last = await f.fail('second', 'host_failed');
  assert.deepEqual(
    (await f.holds()).map((row) => [row.attempts, row.last_code, row.held_at]),
    [[2, 'host_failed', null]],
  );
  assert.equal((await f.events('session.dispatch_held')).length, 0);
  await f.pastBackoff('machine', 'second');
  const third = await f.fail('machine');
  const [hold] = await f.holds();
  assert.deepEqual(
    [hold.instance_id, hold.revision, hold.attempts, hold.last_session_id, hold.held_at],
    [target.id, 0, 3, third.id, f.time()],
  );
  assert.notEqual(last.id, third.id);

  await f.pastBackoff('machine', 'second');
  assert.deepEqual(await f.sessions.dispatch.lease(f.source, auto('second')), {
    session: null,
    reason: 'retries_exhausted',
  });
  assert.equal((await f.runner('second')).lastDecision, 'retries_exhausted');
  const held = await f.events('session.dispatch_held');
  assert.equal(held.length, 1);
  assert.equal(held[0].actorId, 'system:sessions');
  assert.deepEqual(held[0].data, {
    instanceId: target.id,
    revision: 0,
    attempts: 3,
    lastCode: 'launch_failed',
    lastMessage: 'released',
  });
  assert.equal((await f.sessions.dispatch.projectStatus(f.owner)).retriesExhausted, 1);
  // The hold is a project admin's move on the work it holds, so it reaches Needs you; the
  // producer reads why the work waits, and nothing it should do.
  const gate = await f.workflows.evaluate(f.owner, target.id);
  assert.deepEqual(gate.yours, {
    ask: 'Fix why its launches fail, then release the hold',
    blocker: { provider: 'session-dispatch', key: 'launch' },
  });
  assert.deepEqual(
    gate.providerBlockers.map(({ provider, code, whose, revision }) => [
      provider,
      code,
      whose,
      revision,
    ]),
    [['session-dispatch', 'launch_held', 'admin', 0]],
  );
  assert.equal((await f.workflows.evaluate(f.source, target.id)).yours, undefined);

  // A held target does not stand in front of healthy work queued behind it.
  const healthy = await f.instance();
  const leased = (await f.sessions.dispatch.lease(f.source, auto())).session!;
  assert.equal(leased.instanceId, healthy.id);
  await f.handle.transition(f.source, {
    instanceId: healthy.id,
    expectedRevision: 0,
    action: 'finish',
    requestId: request(),
  });
  await f.sessions.sweep();

  const input = {
    instanceId: target.id,
    expectedRevision: 0,
    reason: 'The workspace disk was full; it is cleared',
    requestId: 'go-ahead',
  };
  const released = await f.sessions.dispatch.releaseHold(f.owner, input);
  assert.deepEqual(
    [released.instanceId, released.revision, released.attempts, released.heldAt],
    [target.id, 0, 0, null],
  );
  assert.equal(released.lastCode, 'launch_failed');
  assert.deepEqual(
    (await f.holds()).map((row) => [row.attempts, row.held_at]),
    [[0, null]],
  );
  const events = await f.events('session.hold_released');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    instanceId: target.id,
    revision: 0,
    attempts: 3,
    lastCode: 'launch_failed',
    reason: input.reason,
  });

  // Released, it asks nothing of anyone.
  assert.deepEqual((await f.workflows.blockers(f.owner, target.id)).length, 0);
  assert.equal((await f.workflows.evaluate(f.owner, target.id)).yours, undefined);

  // The same request answers the same, and records nothing twice.
  assert.deepEqual(await f.sessions.dispatch.releaseHold(f.owner, input), released);
  assert.equal((await f.events('session.hold_released')).length, 1);
  await assert.rejects(
    async () =>
      await f.sessions.dispatch.releaseHold(f.owner, { ...input, reason: 'Another reason' }),
    { code: 'request_conflict', status: 409 },
  );

  const again = (await f.sessions.dispatch.lease(f.source, auto())).session!;
  assert.equal(again.instanceId, target.id);
});

test('only a project admin who is not a leased worker releases a hold, and only one that is held', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const input = (requestId: string) => ({
    instanceId: target.id,
    expectedRevision: 0,
    reason: 'Fixed',
    requestId,
  });
  await assert.rejects(async () => await f.sessions.dispatch.releaseHold(f.owner, input('none')), {
    code: 'hold_not_found',
    status: 404,
  });
  await f.fail();
  await assert.rejects(async () => await f.sessions.dispatch.releaseHold(f.owner, input('early')), {
    code: 'hold_not_held',
    status: 409,
  });
  await f.pastBackoff();
  await f.fail();
  assert.ok((await f.holds())[0].held_at);

  await assert.rejects(
    async () => await f.sessions.dispatch.releaseHold(f.source, input('producer')),
    {
      status: 403,
    },
  );
  const other = await f.instance();
  const token = secret();
  await f.sessions.offer(f.source, {
    instanceId: other.id,
    expectedRevision: 0,
    runnerId: 'machine',
    requestId: request(),
    secret: token,
  });
  const worker = await f.sessions.authenticate(token);
  await assert.rejects(async () => await f.sessions.dispatch.releaseHold(worker, input('worker')), {
    code: 'forbidden',
    status: 403,
  });
  for (const bad of [
    { ...input('bad'), reason: ' ' },
    { ...input('bad'), expectedRevision: -1 },
    { ...input('bad'), extra: true },
  ])
    await assert.rejects(async () => await f.sessions.dispatch.releaseHold(f.owner, bad as never), {
      code: 'invalid_release_hold',
    });
  assert.ok((await f.holds())[0].held_at, 'every refusal left the hold in place');
});

test('an offer that cannot be built is counted although its lease rolled back, backs off, and is held', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  f.onBuild(() => {
    throw new MervError('context_too_large', 'Context exceeds the budget', 400);
  });
  assert.deepEqual(await f.sessions.dispatch.lease(f.source, auto()), {
    session: null,
    reason: 'retry_backoff',
  });
  assert.deepEqual(
    (await f.holds()).map((row) => [
      row.instance_id,
      row.attempts,
      row.last_code,
      row.last_message,
      row.last_session_id,
      row.held_at,
    ]),
    [[target.id, 1, 'context_too_large', 'Context exceeds the budget', null, null]],
  );
  // No session closed, so the backoff is the hold's own.
  assert.equal((await f.sessions.dispatch.lease(f.source, auto())).reason, 'retry_backoff');
  assert.equal((await f.holds())[0].attempts, 1, 'a backed-off target is not rebuilt');

  await f.pastBackoff();
  // The second failure holds the target, and the answer is that recorded decision.
  assert.deepEqual(await f.sessions.dispatch.lease(f.source, auto()), {
    session: null,
    reason: 'retries_exhausted',
  });
  const held = await f.events('session.dispatch_held');
  assert.equal(held.length, 1);
  assert.equal(held[0].actorId, f.source.actorId);
  await f.pastBackoff();
  assert.deepEqual(
    await f.sessions.dispatch.lease(f.source, auto()),
    { session: null, reason: 'retries_exhausted' },
    'a held target is withheld before its offer is built, so nothing is thrown',
  );
});

test('a server fault is logged and passed over for the backoff, never held, and only by its owner', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 1 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.heartbeatRunner(f.owner, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  await f.instance();
  let builds = 0;
  f.onBuild(() => {
    builds++;
    throw new TypeError('Cannot read the recipe');
  });
  const logged: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array, ...rest: never[]) => {
    if (String(chunk).includes('dispatch.offer_failed')) logged.push(String(chunk));
    else return write(chunk, ...rest);
    return true;
  });
  // Every poll is answered with the decision; the target is built once in the backoff.
  for (let poll = 0; poll < 5; poll++)
    assert.deepEqual(await f.sessions.dispatch.lease(f.source, auto()), {
      session: null,
      reason: 'retry_backoff',
    });
  assert.equal(builds, 1);
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]!).status, 500);
  assert.deepEqual(await f.holds(), []);
  assert.deepEqual(await f.events('session.dispatch_held'), []);
  // Another owner's runner is not passed over by it.
  f.onBuild();
  assert.ok((await f.sessions.dispatch.lease(f.owner, auto())).session);
});

test('an offer no process ever activated counts as a lost launch; an expiry after activation does not', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const lost = async () => {
    const leased = (await f.sessions.dispatch.lease(f.source, auto())).session!;
    f.advance(300_001);
    await f.sessions.sweep();
    await f.sessions.dispatch.heartbeatRunner(f.source, presence());
    return leased;
  };
  const first = await lost();
  assert.deepEqual(
    (await f.holds()).map((row) => [row.attempts, row.last_code, row.last_session_id]),
    [[1, 'offer_expired', first.id]],
  );
  await lost();
  assert.equal((await f.sessions.dispatch.lease(f.source, auto())).reason, 'retries_exhausted');
  assert.equal((await f.events('session.dispatch_held')).length, 1);

  const token = secret();
  const honest = await f.instance();
  await f.sessions.offer(f.source, {
    instanceId: honest.id,
    expectedRevision: 0,
    runnerId: 'machine',
    requestId: request(),
    secret: token,
  });
  await f.sessions.authenticate(token);
  f.advance(14_400_001);
  await f.sessions.sweep();
  assert.deepEqual(
    (await f.holds()).map((row) => row.instance_id),
    [target.id],
    'long honest work also ends in an expiry',
  );
});

test('a hold names one revision: the record that moves is offered again', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 1 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  await f.fail();
  await f.pastBackoff();
  assert.equal((await f.sessions.dispatch.lease(f.source, auto())).reason, 'retries_exhausted');
  assert.equal((await f.workflows.blockers(f.owner, target.id))[0]?.code, 'launch_held');
  await f.handle.transition(f.source, {
    instanceId: target.id,
    expectedRevision: 0,
    action: 'revise',
    requestId: request(),
  });
  // What the hold said was about the revision it names, so it is no longer read.
  assert.deepEqual(await f.workflows.blockers(f.owner, target.id), []);
  assert.equal((await f.workflows.evaluate(f.owner, target.id)).yours, undefined);
  const leased = (await f.sessions.dispatch.lease(f.source, auto())).session!;
  assert.deepEqual([leased.instanceId, leased.expectedRevision], [target.id, 1]);
  assert.equal((await f.sessions.dispatch.projectStatus(f.owner)).retriesExhausted, 0);
});

const minute = 60_000;

/** The session's line in `GET /sessions/status`. */
const summaryOf = async (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  (await f.sessions.dispatch.projectStatus(f.owner)).sessions.find((session) => session.id === id)!;

test('hours without a Merv call never close a session or count against its target', async (t) => {
  const f = await fixture(t, {
    tuning: { idleNoticeSeconds: 600 },
  });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  await f.instance();
  const { id } = await f.active();
  // A long local job: the runner keeps the lease, the worker says nothing for six hours.
  for (let step = 0; step < 36; step++) {
    f.advance(10 * minute);
    await f.sessions.heartbeat(f.source, { sessionId: id, runnerId: 'machine' });
    await f.sessions.sweep();
  }
  const kept = await f.stored(id);
  assert.deepEqual([kept.status, kept.outcome ?? null], ['active', null]);
  assert.ok((await summaryOf(f, id)).quietSince, 'the silence is observed');
  assert.deepEqual(await f.holds(), [], 'silence is not a failed attempt');
});

test('a preparation nobody could make is deferred: it names its cause, never counts, and is offered again after the backoff', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 3 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();

  // The cause is what keeps a deferral out of the counters, so it is named or refused.
  const leased = await f.sessions.dispatch.lease(f.source, auto());
  assert.ok(leased.session, leased.reason);
  const control = { sessionId: leased.session.id, runnerId: 'machine' };
  await assert.rejects(
    async () => await f.sessions.release(f.source, { ...control, outcome: 'preparation_deferred' }),
    { code: 'invalid_deferral' },
  );
  await assert.rejects(
    async () =>
      await f.sessions.release(f.source, {
        ...control,
        outcome: 'workspace_failed',
        deferral: { cause: 'store_busy', code: 'code_store_full' },
      }),
    { code: 'invalid_deferral' },
  );
  const deferred = await f.sessions.release(f.source, {
    ...control,
    outcome: 'preparation_deferred',
    deferral: { cause: 'store_busy', code: 'code_store_full' },
  });
  assert.deepEqual(
    [deferred.outcome, deferred.deferral],
    ['preparation_deferred', { cause: 'store_busy', code: 'code_store_full' }],
  );
  assert.deepEqual(
    (await f.events('session.closed')).at(-1)!.data.deferral,
    { cause: 'store_busy', code: 'code_store_full' },
    'the durable event carries the cause too',
  );

  // The same target is not offered again inside the backoff, and is after it.
  assert.equal((await f.sessions.dispatch.lease(f.source, auto())).reason, 'retry_backoff');
  for (let attempt = 0; attempt < 9; attempt++) {
    await f.pastBackoff();
    await f.fail('machine', 'preparation_deferred');
  }
  assert.deepEqual(await f.holds(), [], 'ten deferred closes hold nothing');

  // The same target failing once counts, which is the difference.
  await f.pastBackoff();
  await f.fail('machine', 'workspace_failed');
  assert.deepEqual(
    (await f.holds()).map((row) => [row.instance_id, row.attempts, row.last_code]),
    [[target.id, 1, 'workspace_failed']],
  );
});

test('switching dispatch off and on withdraws every hold’s blocker, and a boot withdraws one left behind', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 1 });
  await f.sessions.dispatch.heartbeatRunner(f.source, presence());
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  await f.fail();
  await f.pastBackoff();
  assert.equal((await f.sessions.dispatch.lease(f.source, auto())).reason, 'retries_exhausted');
  const codes = async () =>
    (await f.workflows.blockers(f.owner, target.id)).map((blocker) => blocker.code);
  assert.deepEqual(await codes(), ['launch_held']);
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  assert.deepEqual(await codes(), []);
  assert.equal((await f.workflows.evaluate(f.owner, target.id)).yours, undefined);

  // A reset made before this fix left its blocker: the next boot withdraws it.
  await f.fail();
  await f.pastBackoff();
  assert.deepEqual(await codes(), ['launch_held']);
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE project_id=?',
        f.owner.projectId,
      ),
  );
  await f.upgrade();
  assert.deepEqual(await codes(), []);
});
