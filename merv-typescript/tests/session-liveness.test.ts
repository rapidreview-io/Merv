import {
  createService,
  MervError,
  type Caller,
  type WorkflowPolicy,
  type WorkflowProvidedBlockerInput,
} from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions, type Session, type SessionsConfig } from '@merv/sessions';
import type { StuckReport } from '@merv/contracts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';
import type { ApplicationConfig } from '../src/config.js';
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
  const boot = await scope.bootstrap({ projectName: 'Liveness', actorName: 'Owner' });
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
  const open = async (dispatchSchema?: number) => {
    state.migrate =
      dispatchSchema === undefined
        ? migrate
        : async (component, migrations) =>
            await migrate(
              component,
              component === 'session_dispatch'
                ? migrations.filter((m) => m.version <= dispatchSchema)
                : migrations,
            );
    try {
      return await createService(
        new LeasedSessions(state, scope, workflows, events, {
          clock: () => clock,
          sweepIntervalMs: 60_000,
          ...options.config,
          ...(options.maxLaunchFailures === undefined
            ? {}
            : { maxLaunchFailures: options.maxLaunchFailures }),
        }),
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
    (await sessions.projectStatus(owner)).runners.find((item) => item.runnerId === runnerId)!;
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
      const leased = await sessions.lease(source, input);
      assert.ok(leased.session, leased.reason);
      return {
        id: leased.session.id,
        secret: input.secret,
        worker: await sessions.authenticate(input.secret),
      };
    },
    /** One recorded tool call that leaves the record where it is. */
    async call(worker: Caller, handler: () => void | Promise<void> = () => {}) {
      await sessions.run(await sessions.prepare(worker, 'finish', {}), handler);
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
      const leased = await sessions.lease(source, auto(runnerId));
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
        await sessions.heartbeatRunner(source, presence(id));
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

test('a repeated dispatch decision keeps the moment it began and a new decision restarts it', async (t) => {
  const f = await fixture(t, {});
  await f.sessions.heartbeatRunner(f.source, presence());
  assert.equal((await f.runner()).decisionSince, null, 'a runner that never asked');

  await f.sessions.lease(f.source, auto());
  const began = f.time();
  f.advance(5000);
  await f.sessions.lease(f.source, auto());
  let runner = await f.runner();
  assert.deepEqual(
    [runner.lastDecision, runner.decisionSince, runner.lastDecisionAt],
    ['dispatch_disabled', began, f.time()],
  );

  await f.sessions.setDispatch(f.owner, { enabled: true });
  f.advance(5000);
  await f.sessions.lease(f.source, auto());
  runner = await f.runner();
  assert.deepEqual(
    [runner.lastDecision, runner.decisionSince],
    ['no_candidates', f.time()],
    'a different answer starts its own run',
  );
});

test('a legacy runner whose repository lacks the pinned base counts a launch failure', async (t) => {
  // Legacy workspace policies do not select a driver or require runner capabilities. A
  // runner that lacks the commit counts its failed checkout like any other launch failure.
  const f = await fixture(t, { maxLaunchFailures: 3 });
  await f.sessions.heartbeatRunner(f.source, presence('elsewhere'));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  await f.fail('elsewhere', 'workspace_failed');
  assert.deepEqual(
    (await f.holds()).map((row) => [row.instance_id, row.attempts, row.last_code]),
    [[target.id, 1, 'workspace_failed']],
  );
});

test('a target that keeps failing across runners is held, stops blocking the queue, and one admin go-ahead offers it again', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 3 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.heartbeatRunner(f.source, presence('second'));
  await f.sessions.setDispatch(f.owner, { enabled: true });
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
  assert.deepEqual(await f.sessions.lease(f.source, auto('second')), {
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
  assert.equal((await f.sessions.projectStatus(f.owner)).retriesExhausted, 1);

  // A held target does not stand in front of healthy work queued behind it.
  const healthy = await f.instance();
  const leased = (await f.sessions.lease(f.source, auto())).session!;
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
  const released = await f.sessions.releaseHold(f.owner, input);
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

  // The same request answers the same, and records nothing twice.
  assert.deepEqual(await f.sessions.releaseHold(f.owner, input), released);
  assert.equal((await f.events('session.hold_released')).length, 1);
  await assert.rejects(
    async () => await f.sessions.releaseHold(f.owner, { ...input, reason: 'Another reason' }),
    { code: 'request_conflict', status: 409 },
  );

  const again = (await f.sessions.lease(f.source, auto())).session!;
  assert.equal(again.instanceId, target.id);
});

test('only a project admin who is not a leased worker releases a hold, and only one that is held', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const input = (requestId: string) => ({
    instanceId: target.id,
    expectedRevision: 0,
    reason: 'Fixed',
    requestId,
  });
  await assert.rejects(async () => await f.sessions.releaseHold(f.owner, input('none')), {
    code: 'hold_not_found',
    status: 404,
  });
  await f.fail();
  await assert.rejects(async () => await f.sessions.releaseHold(f.owner, input('early')), {
    code: 'hold_not_held',
    status: 409,
  });
  await f.pastBackoff();
  await f.fail();
  assert.ok((await f.holds())[0].held_at);

  await assert.rejects(async () => await f.sessions.releaseHold(f.source, input('producer')), {
    status: 403,
  });
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
  await assert.rejects(async () => await f.sessions.releaseHold(worker, input('worker')), {
    code: 'forbidden',
    status: 403,
  });
  for (const bad of [
    { ...input('bad'), reason: ' ' },
    { ...input('bad'), expectedRevision: -1 },
    { ...input('bad'), extra: true },
  ])
    await assert.rejects(async () => await f.sessions.releaseHold(f.owner, bad as never), {
      code: 'invalid_release_hold',
    });
  assert.ok((await f.holds())[0].held_at, 'every refusal left the hold in place');
});

test('an offer that cannot be built is counted although its lease rolled back, backs off, and is held', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  f.onBuild(() => {
    throw new MervError('context_too_large', 'Context exceeds the budget', 400);
  });
  await assert.rejects(async () => await f.sessions.lease(f.source, auto()), {
    code: 'context_too_large',
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
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retry_backoff');
  assert.equal((await f.holds())[0].attempts, 1, 'a backed-off target is not rebuilt');

  await f.pastBackoff();
  await assert.rejects(async () => await f.sessions.lease(f.source, auto()), {
    code: 'context_too_large',
  });
  const held = await f.events('session.dispatch_held');
  assert.equal(held.length, 1);
  assert.equal(held[0].actorId, f.source.actorId);
  await f.pastBackoff();
  assert.deepEqual(
    await f.sessions.lease(f.source, auto()),
    { session: null, reason: 'retries_exhausted' },
    'a held target is withheld before its offer is built, so nothing is thrown',
  );
});

test('a refusal of who asked is not counted against the target', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 1 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.instance();
  f.onBuild(() => {
    throw new MervError('forbidden', 'The source may not read this', 403);
  });
  await assert.rejects(async () => await f.sessions.lease(f.source, auto()), { code: 'forbidden' });
  assert.deepEqual(await f.holds(), []);
  f.onBuild();
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'offered');
});

test('an offer no process ever activated counts as a lost launch; an expiry after activation does not', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const lost = async () => {
    const leased = (await f.sessions.lease(f.source, auto())).session!;
    f.advance(300_001);
    await f.sessions.sweep();
    await f.sessions.heartbeatRunner(f.source, presence());
    return leased;
  };
  const first = await lost();
  assert.deepEqual(
    (await f.holds()).map((row) => [row.attempts, row.last_code, row.last_session_id]),
    [[1, 'offer_expired', first.id]],
  );
  await lost();
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retries_exhausted');
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
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  await f.fail();
  await f.pastBackoff();
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retries_exhausted');
  await f.handle.transition(f.source, {
    instanceId: target.id,
    expectedRevision: 0,
    action: 'revise',
    requestId: request(),
  });
  const leased = (await f.sessions.lease(f.source, auto())).session!;
  assert.deepEqual([leased.instanceId, leased.expectedRevision], [target.id, 1]);
  assert.equal((await f.sessions.projectStatus(f.owner)).retriesExhausted, 0);
});

test('the hold tables arrive on a database whose runners already decided, and leave their rows alone', async (t) => {
  const f = await fixture(t, { dispatchSchema: 3 });
  await f.sessions.heartbeatRunner(f.source, presence());
  // The answer this runner was already repeating when the upgrade came.
  const before = f.time();
  await f.state.transaction(async (tx) => {
    await tx.run(
      "UPDATE session_runners SET last_decision='dispatch_disabled',last_decision_at=?",
      before,
    );
  });
  await f.upgrade();
  const runner = await f.runner();
  assert.deepEqual([runner.lastDecision, runner.decisionSince], ['dispatch_disabled', null]);
  assert.deepEqual(await f.holds(), []);
  f.advance(1_000);
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'dispatch_disabled');
  const since = f.time();
  assert.equal((await f.runner()).decisionSince, since, 'the same answer starts counting');
  f.advance(1_000);
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.lease(f.source, auto());
  assert.equal((await f.runner()).decisionSince, since, 'and then keeps its first moment');
});

test('a refusal of what the runner sent is not counted against any target', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 1 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.instance();
  await f.instance();
  await f.instance();
  const used = (await f.active()).secret;
  await f.sessions.heartbeatRunner(f.source, presence('other'));
  await assert.rejects(
    async () => await f.sessions.lease(f.source, { ...auto('other'), secret: used }),
    { code: 'session_secret_used' },
  );
  assert.deepEqual(await f.holds(), []);
  assert.deepEqual(await f.events('session.dispatch_held'), []);
});

const minute = 60_000;

test('a session that lives without a tool call is reported quiet once by the sweep, and a call clears the mark', async (t) => {
  const f = await fixture(t, {});
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.instance();
  const { id, worker } = await f.active();
  const activatedAt = f.time();

  f.advance(29 * minute);
  await f.sessions.sweep();
  assert.equal((await f.stored(id)).quietSince ?? null, null, 'not yet idle');

  // The runner renews the lease for as long as its process lives; that is not progress.
  await f.sessions.heartbeat(f.source, { sessionId: id, runnerId: 'machine' });
  f.advance(minute);
  await f.sessions.sweep();
  const quietSince = f.time();
  assert.equal((await f.stored(id)).quietSince, quietSince);
  f.advance(5 * minute);
  await f.sessions.sweep();
  assert.equal((await f.stored(id)).quietSince, quietSince, 'one mark for one episode');
  const quiet = await f.events('session.quiet');
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0].actorId, 'system:sessions');
  assert.deepEqual(quiet[0].data, {
    sessionId: id,
    instanceId: (await f.stored(id)).instanceId,
    revision: 0,
    lastActivityAt: activatedAt,
    idleSeconds: 1800,
  });
  let [summary] = (await f.sessions.projectStatus(f.owner)).sessions;
  assert.deepEqual([summary.lastActivityAt, summary.quietSince], [activatedAt, quietSince]);

  await f.call(worker);
  const calledAt = f.time();
  f.advance(minute);
  await f.sessions.sweep();
  assert.equal((await f.stored(id)).quietSince, null, 'a tool call is progress');
  [summary] = (await f.sessions.projectStatus(f.owner)).sessions;
  assert.deepEqual([summary.lastActivityAt, summary.quietSince], [calledAt, null]);

  // Mark only by default: hours of quiet local work are never closed for idleness.
  for (let hour = 0; hour < 5; hour++) {
    f.advance(60 * minute);
    await f.sessions.heartbeat(f.source, { sessionId: id, runnerId: 'machine' });
    await f.sessions.sweep();
  }
  assert.equal((await f.stored(id)).status, 'active');
  assert.equal((await f.events('session.quiet')).length, 2, 'a second episode says so again');
});

test('a tool call that hangs counts from its start, so it does not hide the silence', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.instance();
  const { id, worker } = await f.active();
  let finish!: () => void;
  const hung = f.call(worker, () => new Promise<void>((resolve) => (finish = resolve)));
  while (!finish) await new Promise((resolve) => setImmediate(resolve));

  f.advance(10 * minute);
  await f.sessions.sweep();
  assert.equal((await f.stored(id)).quietSince ?? null, null, 'a call that began recently');
  f.advance(20 * minute);
  await f.sessions.sweep();
  assert.equal((await f.stored(id)).quietSince, f.time());
  finish();
  await hung;
});

test('hours without a Merv call never close a session or count against its target', async (t) => {
  const f = await fixture(t, {
    config: { idleNoticeSeconds: 600 },
  });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
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
  assert.ok(kept.quietSince, 'the silence is observed');
  assert.equal((await f.events('session.quiet')).length, 1, 'and said once');
  assert.deepEqual(await f.holds(), [], 'silence is not a failed attempt');
});

test('no read marks or closes an idle session, yet the stuck report already names it', async (t) => {
  const f = await fixture(t, { config: { idleNoticeSeconds: 600 } });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.instance();
  const { id, worker } = await f.active();
  const activatedAt = f.time();
  f.advance(30 * minute);

  await f.sessions.describe(worker);
  await f.sessions.projectStatus(f.owner);
  const report = await f.sessions.stuck(f.owner);
  const stored = await f.stored(id);
  assert.deepEqual([stored.status, stored.quietSince ?? null], ['active', null]);
  assert.equal((await f.events('session.quiet')).length, 0);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.sessionId, item.since, item.forSeconds, item.code]),
    [['session_idle', id, activatedAt, 1800, 'idle']],
  );
  assert.match(report.items[0].why, /not evidence the work is stuck/);
  assert.match(report.items[0].next, /POST \/sessions\/halt/);
  await assert.rejects(async () => await f.sessions.stuck(worker), {
    code: 'forbidden',
    status: 403,
  });
});

test('the idle, quiet-ready and refusal thresholds are bounded', async (t) => {
  for (const config of [
    { idleNoticeSeconds: 59 },
    { quietReadySeconds: 59 },
    { refusalSeconds: 29 },
    { refusalSeconds: 1.5 },
  ])
    await assert.rejects(async () => await fixture(t, { config }), {
      code: 'invalid_sessions_config',
    });
});

test('the stuck report names a switched-off dispatch, a missing runner and a runner that keeps refusing', async (t) => {
  const f = await fixture(t);
  const registered = await f.sessions.heartbeatRunner(f.source, presence());
  const kinds = async () => (await f.sessions.stuck(f.owner)).items.map((item) => item.kind);
  assert.deepEqual(await kinds(), [], 'nothing queued, nothing stuck');

  const target = await f.instance();
  const switchedOff = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    switchedOff.items.map((item) => [item.kind, item.code, item.since]),
    [['dispatch_disabled', 'dispatch_disabled', switchedOff.observedAt]],
  );
  assert.deepEqual(switchedOff.thresholds, {
    idleNoticeSeconds: 1800,
    maxLaunchFailures: 5,
    quietReadySeconds: 21_600,
    refusalSeconds: 300,
  });

  await f.sessions.setDispatch(f.owner, { enabled: true });
  assert.deepEqual(await kinds(), []);
  f.advance(46_000);
  const unattended = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    unattended.items.map((item) => [item.kind, item.since, item.forSeconds]),
    [['no_live_runner', registered.lastSeenAt, 46]],
  );

  // Published settings the runner never acknowledges: every lease answers settings_pending.
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setRunnerSettings(f.owner, {
    runnerId: registered.id,
    settings: { platforms: [{ name: 'codex', enabled: true, parallelism: 1 }] },
  });
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'settings_pending');
  const since = f.time();
  f.advance(299_000);
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.lease(f.source, auto());
  assert.deepEqual(await kinds(), [], 'a refusal younger than refusalSeconds');
  f.advance(1000);
  await f.sessions.heartbeatRunner(f.source, presence());
  const refusing = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    refusing.items.map((item) => [item.kind, item.code, item.runnerRef, item.since]),
    [['runner_refusing', 'settings_pending', registered.id, since]],
  );
  assert.match(refusing.items[0].why, /version 0 .* version 1/);

  // A refusing runner with nothing to run is not stuck work.
  const { id } = await (async () => {
    const token = secret();
    return await f.sessions.offer(f.source, {
      instanceId: target.id,
      expectedRevision: 0,
      runnerId: 'machine',
      requestId: request(),
      secret: token,
    });
  })();
  assert.ok(id);
  assert.deepEqual(await kinds(), []);
});

test('a ready step nobody takes is quiet, an operator step included, and a failing target is reported once', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 2, config: { quietReadySeconds: 600 } });
  f.wallClock();
  await f.sessions.heartbeatRunner(f.source, presence());
  const target = await f.instance();
  const waitingSince = target.updatedAt;
  f.advance(11 * minute);
  await f.sessions.heartbeatRunner(f.source, presence());
  assert.deepEqual(
    (await f.sessions.stuck(f.owner)).items.map((item) => item.kind),
    ['dispatch_disabled'],
    'with dispatch off, one item says why everything waits',
  );

  await f.sessions.setDispatch(f.owner, { enabled: true });
  let report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.instanceId, item.code, item.since]),
    [['ready_quiet', target.id, 'queued', waitingSince]],
  );

  f.leaseRole('operator');
  report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.code]),
    [['ready_quiet', 'awaiting_operator']],
  );
  f.leaseRole('producer');

  await f.fail();
  report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.code, item.attempts]),
    [['dispatch_failing', 'launch_failed', 1]],
    'the failing item replaces the quiet one',
  );
  assert.equal(report.total, 0, 'a target still being retried needs nobody yet');
  await f.pastBackoff();
  await f.fail();
  report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.instanceId, item.expectedRevision, item.attempts]),
    [['dispatch_held', target.id, 0, 2]],
  );
  assert.match(report.items[0].next, /session\.release_hold/);
  const status = await f.sessions.projectStatus(f.owner);
  assert.deepEqual(status.stuck, { total: report.total, counts: report.counts });
  assert.deepEqual([status.stuck.total, status.stuck.counts.dispatch_held], [1, 1]);

  // A hold names one revision: the record moves and nothing is stuck any more.
  await f.handle.transition(f.source, {
    instanceId: target.id,
    expectedRevision: 0,
    action: 'revise',
    requestId: request(),
  });
  assert.deepEqual(
    (await f.sessions.stuck(f.owner)).items.map((item) => [item.kind, item.expectedRevision]),
    [['ready_quiet', 1]],
    'the new revision only waits, as old as the machine clock that stamped it',
  );
});

for (const code of ['code_base_pending', 'code_merge_required', 'code_dependencies_changed'])
  test(`a base that turns ${code} at the offer is not counted against the target`, async (t) => {
    const f = await fixture(t, { maxLaunchFailures: 1 });
    await f.sessions.heartbeatRunner(f.source, presence());
    await f.sessions.setDispatch(f.owner, { enabled: true });
    await f.instance();
    f.onBuild(() => {
      throw new MervError(code, 'The base cannot be pinned yet', 409);
    });
    // With nothing else leasable the runner is told why; the target itself is left alone.
    await assert.rejects(async () => await f.sessions.lease(f.source, auto()), { code });
    assert.deepEqual(await f.holds(), []);
    assert.deepEqual(await f.events('session.dispatch_held'), []);
    f.onBuild();
    assert.equal((await f.sessions.lease(f.source, auto())).reason, 'offered');
  });

test('work another plugin published a blocker for is named in the stuck report until it clears', async (t) => {
  const f = await fixture(t, { config: { quietReadySeconds: 600 } });
  f.wallClock();
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const publish = async (blockers: WorkflowProvidedBlockerInput[]) =>
    await f.state.transaction(
      async (tx) =>
        await f.workflows.replaceBlockers(
          { projectId: f.owner.projectId, instanceId: target.id, provider: 'probe', blockers },
          tx,
        ),
    );
  await publish([
    {
      key: 'merge',
      code: 'code_merge_required',
      message: 'Two accepted commits must be combined.',
      status: 409,
      next: 'Recreate the work on one of them.',
    },
  ]);
  const report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.instanceId, item.code, item.why, item.next]),
    [
      [
        'work_blocked',
        target.id,
        'code_merge_required',
        'Two accepted commits must be combined.',
        'Recreate the work on one of them.',
      ],
    ],
  );
  assert.equal(report.items[0].since, (await f.workflows.blockers(f.owner))[0].since);
  assert.deepEqual([report.total, report.counts.work_blocked], [1, 1]);
  const status = await f.sessions.projectStatus(f.owner);
  assert.deepEqual(status.stuck, { total: 1, counts: report.counts });
  await publish([]);
  assert.deepEqual((await f.sessions.stuck(f.owner)).counts.work_blocked, 0);
});

test('the assembled application offers the stuck report as a read tool and the go-ahead as an admin tool, neither to a leased worker', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-stuck-tools-'));
  const env = `MERV_STUCK_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = 'synthetic-stuck-tools-signing-secret-at-least-32-bytes';
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as ApplicationConfig;
  // The shipped composition, which is what registers these tools; the page shell serves no assets here.
  config.plugins = config.plugins.filter((entry) => entry.id !== 'ui-web');
  config.plugins.find((entry) => entry.id === 'identity')!.config = {
    supabaseUrl: 'https://stuck.example.test',
    mode: 'hs256',
    secretEnv: env,
  };
  const app = await createApp({ directory, config, port: 0 });
  t.after(async () => {
    await app.stop();
    delete process.env[env];
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Stuck', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const listed = (await app.ctx.tools.list()).filter((tool) => tool.name.startsWith('session.'));
  assert.deepEqual(
    listed.map((tool) => [tool.name, 'readOnly' in tool && tool.readOnly === true]),
    [
      ['session.release_hold', false],
      ['session.stuck', true],
    ],
  );
  const task = await app.ctx.tasks.create(owner, {
    title: 'Waiting',
    goal: 'Wait for a runner.',
    checks: ['It waited.'],
    requestId: 'waiting',
  });
  // A read tool runs on a read snapshot, so a report that wrote anything would fail here.
  const report = (await app.ctx.tools.call('session.stuck', owner, {})) as StuckReport;
  assert.deepEqual(
    report.items.map((item) => item.kind),
    ['dispatch_disabled'],
  );
  assert.equal(report.total, 1);
  // The home read trims the sessions row to its facts; the stuck counts are one of them.
  const home = (await app.ctx.tools.call('ui.home', owner, {})) as {
    sessions: { stuck: Pick<StuckReport, 'total' | 'counts'>; sessions?: unknown };
  };
  assert.deepEqual(home.sessions.stuck, { total: 1, counts: report.counts });
  assert.equal(home.sessions.sessions, undefined);
  const release = {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    reason: 'Nothing to release',
    requestId: 'release',
  };
  await assert.rejects(
    async () => await app.ctx.tools.call('session.release_hold', owner, release),
    { code: 'hold_not_found', status: 404 },
  );
  await assert.rejects(
    async () => await app.ctx.tools.call('session.release_hold', owner, { ...release, extra: 1 }),
    (error: MervError) => error.status === 400,
  );

  const token = secret();
  await app.ctx.sessions.offer(owner, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    runnerId: 'machine',
    requestId: 'offer',
    secret: token,
  });
  const worker = await app.ctx.sessions.authenticate(token);
  for (const [tool, input] of [
    ['session.stuck', {}],
    ['session.release_hold', release],
  ] as const)
    await assert.rejects(
      async () => await app.ctx.tools.call(tool, worker, input),
      (error: MervError) => error.status === 403,
    );
});

test('a preparation nobody could make is deferred: it names its cause, never counts, and is offered again after the backoff', async (t) => {
  const f = await fixture(t, { maxLaunchFailures: 3 });
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();

  // The cause is what keeps a deferral out of the counters, so it is named or refused.
  const leased = await f.sessions.lease(f.source, auto());
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
  assert.equal((await f.sessions.lease(f.source, auto())).reason, 'retry_backoff');
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

test('a run of deferred preparations is shown as work nobody could take, with its cause', async (t) => {
  const f = await fixture(t, { config: { quietReadySeconds: 600 } });
  f.wallClock();
  await f.sessions.heartbeatRunner(f.source, presence());
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.instance();
  const kinds = async () => (await f.sessions.stuck(f.owner)).items.map((item) => item.kind);

  await f.fail('machine', 'preparation_deferred');
  await f.pastBackoff();
  await f.fail('machine', 'preparation_deferred');
  f.advance(11 * minute);
  await f.sessions.heartbeatRunner(f.source, presence());
  assert.deepEqual(await kinds(), ['ready_quiet'], 'two are not yet a run');

  await f.fail('machine', 'preparation_deferred', {
    cause: 'code_unavailable',
    code: 'code_unavailable',
  });
  const report = await f.sessions.stuck(f.owner);
  assert.deepEqual(
    report.items.map((item) => [item.kind, item.instanceId, item.code, item.attempts]),
    [['work_deferred', target.id, 'code_unavailable', 3]],
    'the deferred item replaces the quiet one',
  );
  assert.equal(report.total, 1, 'nothing counts it, so only this report asks for someone');
  assert.match(report.items[0].why, /could not prepare its checkout/);
  assert.match(report.items[0].next, /code\.status/);
});
