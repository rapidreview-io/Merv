import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, MervError, type Caller, type SqlValue } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type {
  SandboxRuntimeHandle,
  SandboxRuntimeProfileRef,
  SandboxRuntimes,
} from '@merv/sandboxes';
import { UiRegistry } from '@merv/ui';
import { FleetService, type FleetConfig, type FleetOwner } from '../packages/fleet/src/index.js';
import { fleetUiPlugin } from '../packages/fleet/src/ui.js';
import { countWrites, openState } from './fixtures/state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(ms: number, ok: () => boolean | Promise<boolean>) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    assert.ok(Date.now() < end, `not within ${ms} ms`);
    await sleep(5);
  }
}

class FakeRuntimes implements SandboxRuntimes {
  profileId = 'fixed-profile';
  leaseSeconds = 600;
  large?: SandboxRuntimeProfileRef;
  get profiles() {
    const standard = { key: 'standard', id: this.profileId, leaseSeconds: this.leaseSeconds };
    return this.large ? [standard, this.large] : [standard];
  }
  describe: SandboxRuntimes['describe'] = async () => null;
  /** `${call} ${operation key or sandbox} ${profile}` for each call that names a profile. */
  readonly profiled: string[] = [];
  readonly disconnected = new Set<string>();
  /** The projects whose connections provider calls went through. */
  readonly places = new Set<string>();
  connected(projectId: string) {
    return !this.disconnected.has(projectId);
  }
  readonly byKey = new Map<string, SandboxRuntimeHandle>();
  readonly createKeys: string[] = [];
  readonly launchKeys: string[] = [];
  readonly acknowledgements: string[] = [];
  readonly stopped: string[] = [];
  readonly renewed: string[] = [];
  readonly inspected: string[] = [];
  failCreateOnce = false;
  createError?: Error;
  inspectError?: Error;
  failLaunchOnce = false;
  /** Thrown by the next launch before it delivers anything. */
  refuseLaunch?: Error;
  failAcknowledgeOnce = false;
  heartbeatOnInspect = false;
  holdCreate?: ReturnType<typeof deferred<SandboxRuntimeHandle>>;
  initialState: SandboxRuntimeHandle['state'] = 'ready';
  receiptState: NonNullable<SandboxRuntimeHandle['launch']>['state'] = 'pending';
  private copy(handle: SandboxRuntimeHandle) {
    return structuredClone(handle);
  }
  async provision(projectId: string, operationKey: string, profileId?: string) {
    this.places.add(projectId);
    this.createKeys.push(operationKey);
    this.profiled.push(`provision ${operationKey} ${profileId}`);
    if (this.createError) throw this.createError;
    let handle = this.byKey.get(operationKey);
    if (!handle) {
      handle = {
        sandboxId: `sbx_${this.byKey.size + 1}`,
        state: this.initialState,
        ready: this.initialState === 'ready',
        deleted: false,
        leaseExpiresAt: '2099-01-01T00:00:00Z',
        revision: 1,
        launch: null,
      };
      this.byKey.set(operationKey, handle);
    }
    if (this.holdCreate) return this.copy(await this.holdCreate.promise);
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error('lost create reply');
    }
    return this.copy(handle);
  }
  async inspect(projectId: string, current: SandboxRuntimeHandle) {
    this.places.add(projectId);
    this.inspected.push(current.sandboxId);
    if (this.inspectError) throw this.inspectError;
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live);
    if (this.heartbeatOnInspect) live.revision++;
    // The real consumer cannot discover a launch receipt without its launch ID.
    return { ...this.copy(live), launch: current.launch ? this.copy(live).launch : null };
  }
  async launch(
    projectId: string,
    current: SandboxRuntimeHandle,
    operationKey: string,
    _bootstrap: string,
    profileId?: string,
  ) {
    this.places.add(projectId);
    this.launchKeys.push(operationKey);
    this.profiled.push(`launch ${operationKey} ${profileId}`);
    const refusal = this.refuseLaunch;
    this.refuseLaunch = undefined;
    if (refusal) throw refusal;
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live);
    live.launch ??= {
      sandboxId: live.sandboxId,
      launchId: `rln_${live.sandboxId}`,
      operationKey,
      releaseId: 'fixed-release',
      jobId: `rtj_${live.sandboxId}`,
      state: this.receiptState,
      deliveryState: 'launched',
      expiresAt: '2026-09-22T00:05:00Z',
    };
    if (this.failLaunchOnce) {
      this.failLaunchOnce = false;
      throw new Error('lost launch reply');
    }
    return this.copy(live);
  }
  async stop(projectId: string, current: SandboxRuntimeHandle) {
    this.places.add(projectId);
    this.stopped.push(current.sandboxId);
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live);
    if (live.state !== 'stopped') {
      live.state = 'deleting';
      live.ready = false;
      live.revision++;
    }
    return this.copy(live);
  }
  async acknowledge(projectId: string, current: SandboxRuntimeHandle) {
    this.places.add(projectId);
    assert.equal(current.launch?.deliveryState, 'launched');
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live?.launch);
    this.acknowledgements.push(live.launch.jobId);
    live.launch.state = 'consumed';
    if (this.failAcknowledgeOnce) {
      this.failAcknowledgeOnce = false;
      throw new Error('lost exchange reply');
    }
    return this.copy(live);
  }
  async renew(projectId: string, current: SandboxRuntimeHandle, profileId?: string) {
    this.renewed.push(current.sandboxId);
    this.profiled.push(`renew ${current.sandboxId} ${profileId}`);
    return this.inspect(projectId, current);
  }
  confirmStopped(sandboxId: string) {
    const live = [...this.byKey.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(live);
    live.state = 'stopped';
    live.ready = false;
    live.deleted = true;
    live.revision++;
  }
  leaseSoon(sandboxId: string) {
    const live = [...this.byKey.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(live);
    live.leaseExpiresAt = '2026-09-22T00:00:30Z';
    live.revision++;
  }
}

async function fixture(t: TestContext, limits: FleetConfig = { globalLimit: 2, projectLimit: 1 }) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.bootstrap({ projectName: 'Fleet', actorName: 'Operator' });
  const caller: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  const runtimes = new FakeRuntimes();
  let now = Date.parse('2026-09-22T00:00:00Z');
  let valid = true;
  let observation: 'starting' | 'running' | 'finished' = 'running';
  let bootstrap: (allocation: unknown) => Promise<string> = async () => 'stable-bootstrap';
  const owner: FleetOwner = {
    valid: async () => valid,
    bootstrap: (allocation) => bootstrap(allocation),
    observe: async () => observation,
  };
  const fleet = await createService(
    new FleetService(
      state,
      scope,
      runtimes,
      { enabled: true, allocationTimeoutSeconds: 3600, ...limits },
      () => now,
    ),
  );
  const unregister = fleet.registerOwner('workflow', owner);
  t.after(async () => {
    await fleet.close();
    await state.close();
  });
  return {
    state,
    scope,
    admin,
    caller,
    runtimes,
    fleet,
    owner,
    unregister,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    setValid: (value: boolean) => {
      valid = value;
    },
    setObservation: (value: typeof observation) => {
      observation = value;
    },
    setBootstrap: (value: typeof bootstrap) => {
      bootstrap = value;
    },
  };
}

const input = (requestId: string) => ({ requestId, owner: { kind: 'workflow', id: 'work_1' } });

test('concurrent controllers reserve within global and project caps; requests are idempotent', async (t) => {
  const f = await fixture(t);
  f.runtimes.initialState = 'provisioning';
  const same = await Promise.all(
    Array.from({ length: 4 }, () => f.fleet.request(f.caller, input('same'))),
  );
  assert.equal(new Set(same.map((a) => a.id)).size, 1);
  await assert.rejects(
    f.fleet.request(f.caller, {
      requestId: 'same',
      owner: { kind: 'workflow', id: 'different' },
    }),
    { code: 'request_conflict' },
  );
  await f.fleet.request(f.caller, input('second'));
  await f.fleet.request(f.caller, input('third'));
  const second = await createService(
    new FleetService(
      f.state,
      f.scope,
      f.runtimes,
      { enabled: true, globalLimit: 2, projectLimit: 1 },
      () => Date.parse('2026-09-22T00:00:00Z'),
    ),
  );
  second.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'stable-bootstrap',
    observe: async () => 'running',
  });
  await Promise.all([f.fleet.tick(), second.tick()]);
  const allocations = await f.fleet.list(f.caller);
  assert.equal(allocations.filter((a) => a.phase === 'provisioning').length, 1);
  assert.equal(allocations.filter((a) => a.phase === 'queued').length, 2);
  assert.equal(new Set(f.runtimes.createKeys).size, 1);
  await second.close();
});

test('concurrent controllers enforce the global cap across projects', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 2 });
  f.runtimes.initialState = 'provisioning';
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const first = await f.fleet.request(f.caller, input('first-project'));
  const secondAllocation = await f.fleet.request(otherCaller, input('second-project'));
  const second = await createService(
    new FleetService(
      f.state,
      f.scope,
      f.runtimes,
      { enabled: true, globalLimit: 1, projectLimit: 2 },
      () => Date.parse('2026-09-22T00:00:00Z'),
    ),
  );
  second.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'stable-bootstrap',
    observe: async () => 'running',
  });
  await Promise.all([f.fleet.tick(), second.tick()]);
  const phases = [
    (await f.fleet.inspect(f.caller, first.id)).phase,
    (await f.fleet.inspect(otherCaller, secondAllocation.id)).phase,
  ];
  assert.deepEqual(phases.sort(), ['provisioning', 'queued']);
  assert.equal(new Set(f.runtimes.createKeys).size, 1);
  await second.close();
});

test('a project without a sandbox connection never holds the only slot', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  f.runtimes.disconnected.add(f.caller.projectId);
  await assert.rejects(f.fleet.request(f.caller, input('refused')), {
    code: 'sandbox_not_connected',
    status: 403,
  });
  assert.deepEqual(await f.fleet.list(f.caller), []);
  // A connection removed after admission (a restart with new configuration) rents nothing.
  f.runtimes.disconnected.clear();
  const stranded = await f.fleet.request(f.caller, input('stranded'));
  f.runtimes.disconnected.add(f.caller.projectId);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, stranded.id)).phase, 'released');
  assert.deepEqual(f.runtimes.createKeys, []);
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const next = await f.fleet.request(otherCaller, input('next'));
  await f.fleet.tick();
  assert.notEqual((await f.fleet.inspect(otherCaller, next.id)).phase, 'queued');
  assert.equal(f.runtimes.createKeys.length, 1);
});

test('an owner that rents in the host rents there for work in a project without a connection', async (t) => {
  const f = await fixture(t, { globalLimit: 3, projectLimit: 1, hostProjectId: 'host_project' });
  f.runtimes.disconnected.add(f.caller.projectId);
  f.fleet.registerOwner('hosted', { ...f.owner, rentsInHost: true });
  const hosted = (requestId: string) => ({ requestId, owner: { kind: 'hosted', id: 'work_1' } });
  await assert.rejects(f.fleet.request(f.caller, input('own')), { code: 'sandbox_not_connected' });
  const first = await f.fleet.request(f.caller, hosted('first'));
  f.advance(1000);
  const second = await f.fleet.request(f.caller, hosted('second'));
  assert.deepEqual([first.projectId, first.rentedIn], [f.caller.projectId, 'host_project']);
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  // The work project's cap holds the second back, and its machines take none of the host's room.
  assert.deepEqual(
    (await f.fleet.list(f.caller)).map((a) => [a.requestId, a.phase]),
    [
      ['first', 'running'],
      ['second', 'queued'],
    ],
  );
  assert.equal(await f.fleet.free('host_project'), 1);
  // Pi's machine rules still read the project's own connection.
  assert.equal(f.fleet.connected(f.caller.projectId), false);
  assert.equal(await f.fleet.free(f.caller.projectId), 0);
  await f.fleet.cancel(f.caller, second.id);
  f.runtimes.leaseSoon('sbx_1');
  await f.fleet.tick();
  f.setObservation('finished');
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  assert.deepEqual(
    [f.runtimes.acknowledgements, f.runtimes.renewed, f.runtimes.stopped],
    [['rtj_sbx_1'], ['sbx_1'], ['sbx_1']],
  );
  assert.equal((await f.fleet.inspect(f.caller, first.id)).phase, 'released');
  assert.deepEqual([...f.runtimes.places], ['host_project']);
  // An allocation without rentedIn, as every earlier one, rents through its own project.
  f.runtimes.disconnected.clear();
  f.runtimes.places.clear();
  const own = await f.fleet.request(f.caller, input('own'));
  assert.equal('rentedIn' in own, false);
  await f.fleet.tick();
  assert.deepEqual([...f.runtimes.places], [f.caller.projectId]);
});

test('a refused first create frees the only slot; an ambiguous one is retried', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  f.runtimes.createError = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  const refused = await f.fleet.request(f.caller, input('refused'));
  await f.fleet.tick();
  const current = await f.fleet.inspect(f.caller, refused.id);
  assert.deepEqual(
    [current.phase, current.intent, current.error],
    ['released', 'stop', 'runtime_refused'],
  );
  assert.equal(await f.fleet.free(f.caller.projectId), 1);
  // A conflict could hide a machine made by an earlier reply, so it proves nothing.
  f.runtimes.createError = new MervError('sandbox_operation_state', 'Conflict', 409);
  const retried = await f.fleet.request(f.caller, input('retried'));
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, retried.id)).phase, 'uncertain');
});

test('a stopped create without a machine recovers once, then waits out the lease', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  // A lost reply hid a machine: the last attempt after Stop finds it, and it is deleted.
  f.runtimes.failCreateOnce = true;
  const lost = await f.fleet.request(f.caller, input('lost'));
  await f.fleet.tick();
  await f.fleet.cancel(f.caller, lost.id);
  f.advance(2000);
  await f.fleet.tick();
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, lost.id)).phase, 'released');
  // An ambiguous failure, then refusals: nothing proves no machine, so the slot waits.
  f.runtimes.createError = new MervError('sandbox_unavailable', 'Unreachable', 503);
  const stuck = await f.fleet.request(f.caller, input('stuck'));
  await f.fleet.tick();
  f.runtimes.createError = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  f.advance(2000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, stuck.id)).phase, 'uncertain');
  await f.fleet.cancel(f.caller, stuck.id);
  f.advance(4000);
  await f.fleet.tick();
  const attempts = f.runtimes.createKeys.length;
  f.advance(600_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, stuck.id)).phase, 'releasing');
  f.advance(61_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, stuck.id)).phase, 'released');
  assert.equal(f.runtimes.createKeys.length, attempts, 'nothing is created while waiting');
});

test('a machine the service stops answering for keeps running, then frees its slot', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('unanswered'));
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  f.runtimes.inspectError = new MervError('sandbox_forbidden', 'The grant was revoked', 403);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'running');
  await f.fleet.cancel(f.caller, allocation.id);
  f.advance(2000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'releasing');
  f.advance(661_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'released');
});

test('the machine deadline starts when the allocation leaves the queue', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  const first = await f.fleet.request(f.caller, input('first'));
  f.advance(1000);
  const second = await f.fleet.request(f.caller, input('second'));
  await f.fleet.tick();
  f.advance(2_999_000);
  await f.fleet.cancel(f.caller, first.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  await f.fleet.tick();
  const reserved = await f.fleet.inspect(f.caller, second.id);
  assert.equal(reserved.phase, 'provisioning');
  assert.equal(reserved.deadlineAt, '2026-09-22T01:50:00.000Z');
});

test('a request sets its own machine time, restarted when it leaves the queue', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  const first = await f.fleet.request(f.caller, input('first'));
  f.advance(1000);
  const second = await f.fleet.request(f.caller, { ...input('second'), seconds: 900 });
  assert.equal(second.deadlineAt, '2026-09-22T00:15:01.000Z');
  // The time is part of the request: a replay must repeat it.
  assert.equal(
    (await f.fleet.request(f.caller, { ...input('second'), seconds: 900 })).id,
    second.id,
  );
  await assert.rejects(f.fleet.request(f.caller, { ...input('second'), seconds: 960 }), {
    code: 'request_conflict',
  });
  for (const seconds of [59, 86_401])
    await assert.rejects(f.fleet.request(f.caller, { ...input('other'), seconds }), {
      code: 'invalid_fleet_request',
    });
  // Fleet's own limit, an hour here, still bounds a longer one.
  const long = await f.fleet.request(f.caller, { ...input('long'), seconds: 7200 });
  assert.equal(long.deadlineAt, '2026-09-22T01:00:01.000Z');
  await f.fleet.cancel(f.caller, long.id);
  await f.fleet.tick();
  f.advance(600_000);
  await f.fleet.cancel(f.caller, first.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  await f.fleet.tick();
  const reserved = await f.fleet.inspect(f.caller, second.id);
  assert.equal(reserved.phase, 'provisioning');
  assert.equal(reserved.deadlineAt, '2026-09-22T00:25:01.000Z');
  assert.equal((await f.fleet.inspect(f.caller, first.id)).deadlineAt, '2026-09-22T01:00:01.000Z');
});

test('the Fleet page lists open work and bounded history in plain words', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  const ctx = new Context();
  const ui = new UiRegistry();
  ctx.provide('fleet', f.fleet);
  ctx.provide('ui', ui);
  await ctx.plugin(fleetUiPlugin);
  t.after(() => ctx.fiber.dispose());
  f.fleet.registerOwner('pi-host', f.owner);
  for (const [id, kind] of [
    ['a', 'workflow'],
    ['b', 'pi-host'],
  ]) {
    const owner = { kind, id: 'x' };
    await f.fleet.cancel(f.caller, (await f.fleet.request(f.caller, { requestId: id, owner })).id);
    f.advance(1000);
  }
  f.runtimes.createError = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  await f.fleet.request(f.caller, input('c'));
  await f.fleet.tick();
  f.advance(1000);
  f.runtimes.createError = new MervError('sandbox_unavailable', 'Unreachable', 503);
  const open = await f.fleet.request(f.caller, input('open'));
  await f.fleet.tick();
  const since = (await f.fleet.inspect(f.caller, open.id)).updatedAt;
  for (const seconds of [2, 4, 8, 16]) {
    f.advance(seconds * 1000);
    await f.fleet.tick();
  }
  assert.deepEqual(
    (await f.fleet.list(f.caller, 2)).map((a) => a.requestId),
    ['b', 'c', 'open'],
  );
  const rows = (await ui.read(f.caller, 'fleet')) as Record<string, string | null>[];
  assert.deepEqual(
    rows.map((row) => [row.title, row.status, row.intent]),
    [
      ['Workflow agent', 'stopped', null],
      ['Agent machine', 'stopped', null],
      ['Workflow agent', 'refused', null],
      ['Workflow agent', 'retrying', 'run'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => !!row.attention),
    [false, false, false, true],
  );
  assert.match(rows[3].attention!, /^No machine yet:/);
  assert.equal(rows[3].updatedAt, since, 'retries do not reset the standing clock');
});

test('lost create and launch replies retry stable keys and consumed bootstrap remains live', async (t) => {
  const f = await fixture(t);
  f.runtimes.failCreateOnce = true;
  f.runtimes.failLaunchOnce = true;
  f.runtimes.receiptState = 'consumed';
  const allocation = await f.fleet.request(f.caller, input('lost'));
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'uncertain');
  f.advance(2000);
  await f.fleet.tick();
  assert.equal(new Set(f.runtimes.createKeys).size, 1);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'uncertain');
  f.advance(2000);
  await f.fleet.tick();
  assert.equal(new Set(f.runtimes.launchKeys).size, 1);
  assert.equal(f.runtimes.launchKeys.length, 2);
  await f.fleet.tick();
  const active = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(active.phase, 'running');
  assert.equal(active.runtime?.launch?.state, 'consumed');
  assert.deepEqual(f.runtimes.stopped, []);
});

test('exchange waits for owner proof, retries lost reply, and precedes stop', async (t) => {
  const f = await fixture(t);
  f.setObservation('starting');
  const allocation = await f.fleet.request(f.caller, input('exchange'));
  await f.fleet.tick();
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'starting');
  assert.deepEqual(f.runtimes.acknowledgements, []);
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.acknowledgements, []);
  f.runtimes.failAcknowledgeOnce = true;
  f.setObservation('running');
  await f.fleet.tick();
  // One failed call within the lease neither changes the phase nor fences the worker.
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'starting');
  assert.equal(await f.state.transaction((tx) => f.fleet.admits(allocation.id, 1, tx)), true);
  assert.deepEqual(f.runtimes.stopped, []);
  f.advance(2000);
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.acknowledgements, ['rtj_sbx_1']);
  assert.deepEqual(f.runtimes.stopped, []);
  f.setObservation('finished');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).runtime?.launch?.state, 'consumed');
});

test('finished without a running observation stops without claiming successful exchange', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('finished-before-ready'));
  await f.fleet.tick();
  await f.fleet.tick();
  f.setObservation('finished');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.acknowledgements, []);
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'releasing');
});

test('owner observation failure never acknowledges a launch receipt', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('observe-failure'));
  await f.fleet.tick();
  await f.fleet.tick();
  f.setObservation('starting');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.acknowledgements, []);
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'starting');
});

test('cancellation during create retains capacity until provider reports stopped', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  f.runtimes.initialState = 'provisioning';
  const allocation = await f.fleet.request(f.caller, input('cancel-create'));
  const created = deferred<SandboxRuntimeHandle>();
  f.runtimes.holdCreate = created;
  const ticking = f.fleet.tick();
  while (f.runtimes.createKeys.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await f.fleet.cancel(f.caller, allocation.id);
  created.resolve(f.runtimes.byKey.values().next().value!);
  await ticking;
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).intent, 'stop');
  await f.fleet.request(f.caller, input('waiting'));
  f.runtimes.holdCreate = undefined;
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'releasing');
  assert.equal((await f.fleet.list(f.caller)).filter((a) => a.phase === 'queued').length, 1);
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'released');
  await f.fleet.tick();
  assert.equal(f.runtimes.byKey.size, 2);
});

test('source revocation and missing owner stop a live allocation', async (t) => {
  const f = await fixture(t);
  const producer = await f.scope.issueActor(f.caller, { name: 'Producer', role: 'producer' });
  const caller: Caller = {
    projectId: f.caller.projectId,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  const revoked = await f.fleet.request(caller, input('revoked'));
  await f.fleet.tick();
  await f.fleet.tick();
  await f.scope.revokeCredential(f.caller, producer.credential.id);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, revoked.id)).intent, 'stop');
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  const missing = await f.fleet.request(f.caller, input('missing-owner'));
  await f.fleet.tick();
  f.unregister();
  f.advance(300_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, missing.id)).intent, 'stop');
  assert.ok(f.runtimes.stopped.includes('sbx_2'));
});

test('active unchanged observations perform no writes; admission requires launch', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('stable'));
  await f.fleet.tick();
  const beforeLaunch = await f.state.transaction((tx) => f.fleet.admits(allocation.id, 1, tx));
  assert.equal(beforeLaunch, false);
  await f.fleet.tick();
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'running');
  assert.equal(await f.state.transaction((tx) => f.fleet.admits(allocation.id, 1, tx)), true);
  const writes = countWrites(f.state);
  const before = writes();
  f.runtimes.heartbeatOnInspect = true;
  await f.fleet.tick();
  await f.fleet.tick();
  assert.equal(writes(), before);
});

test('profile change never reprovisions a new image and frees an uncertain create after its lease', async (t) => {
  const f = await fixture(t);
  f.runtimes.failCreateOnce = true;
  const allocation = await f.fleet.request(f.caller, input('profile-change'));
  await f.fleet.tick();
  f.runtimes.profileId = 'new-profile';
  f.advance(2000);
  await f.fleet.tick();
  const current = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(current.intent, 'stop');
  assert.notEqual(current.phase, 'released');
  f.advance(661_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'released');
  assert.equal(f.runtimes.createKeys.length, 1);
});

test('each machine is rented, launched and renewed under its own profile', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  f.runtimes.large = { key: 'large', id: 'large-profile', leaseSeconds: 900 };
  const standard = await f.fleet.request(f.caller, input('standard'));
  const large = await f.fleet.request(f.caller, { ...input('large'), profile: 'large' });
  assert.deepEqual([standard.profileId, large.profileId], ['fixed-profile', 'large-profile']);
  // The profile is part of the request: the same id cannot name another machine.
  await assert.rejects(f.fleet.request(f.caller, input('large')), { code: 'request_conflict' });
  await assert.rejects(f.fleet.request(f.caller, { ...input('huge'), profile: 'huge' }), {
    code: 'fleet_profile_unavailable',
  });
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  const machine = async (id: string) => (await f.fleet.inspect(f.caller, id)).runtime!.sandboxId;
  for (const id of [standard.id, large.id]) f.runtimes.leaseSoon(await machine(id));
  await f.fleet.tick();
  assert.deepEqual(
    f.runtimes.profiled.sort(),
    [
      `launch ${large.id}:launch large-profile`,
      `launch ${standard.id}:launch fixed-profile`,
      `provision ${large.id}:create large-profile`,
      `provision ${standard.id}:create fixed-profile`,
      `renew ${await machine(large.id)} large-profile`,
      `renew ${await machine(standard.id)} fixed-profile`,
    ].sort(),
  );
});

test('dropping a profile from configuration stops only its machines', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  f.runtimes.large = { key: 'large', id: 'large-profile', leaseSeconds: 900 };
  const standard = await f.fleet.request(f.caller, input('standard'));
  const large = await f.fleet.request(f.caller, { ...input('large'), profile: 'large' });
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  const admits = (id: string) => f.state.transaction((tx) => f.fleet.admits(id, 1, tx));
  assert.deepEqual([await admits(standard.id), await admits(large.id)], [true, true]);
  f.runtimes.large = undefined;
  assert.deepEqual([await admits(standard.id), await admits(large.id)], [true, false]);
  await f.fleet.tick();
  const [kept, dropped] = await Promise.all(
    [standard.id, large.id].map((id) => f.fleet.inspect(f.caller, id)),
  );
  assert.deepEqual([kept.phase, kept.intent], ['running', 'run']);
  assert.equal(dropped.intent, 'stop');
  assert.deepEqual(f.runtimes.stopped, [dropped.runtime!.sandboxId]);
});

test('a project named in projectLimits has its own cap, and free() counts what waits', async (t) => {
  const f = await fixture(t);
  f.runtimes.initialState = 'provisioning';
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const host = await createService(
    new FleetService(f.state, f.scope, f.runtimes, {
      enabled: true,
      globalLimit: 4,
      projectLimit: 1,
      projectLimits: { [f.caller.projectId]: 3 },
    }),
  );
  host.registerOwner('workflow', f.owner);
  const free = async () => [await host.free(f.caller.projectId), await host.free(other.project.id)];
  assert.deepEqual(await free(), [3, 1]);
  for (const id of ['a', 'b', 'c', 'd']) await host.request(f.caller, input(id));
  // Queued work is served first: all four count against both rooms.
  assert.deepEqual(await free(), [0, 0]);
  assert.equal(await f.state.transaction((tx) => host.free(f.caller.projectId, tx)), 0);
  await host.tick();
  const phases = (await host.list(f.caller)).map((a) => a.phase);
  assert.deepEqual(phases, ['provisioning', 'provisioning', 'provisioning', 'queued']);
  await host.cancel(f.caller, (await host.list(f.caller)).at(-1)!.id);
  assert.deepEqual(await free(), [0, 1]);
  const machine = { key: 'standard', vcpu: 0.5, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.074016 };
  f.runtimes.describe = async (_projectId, key) => (key === 'standard' ? machine : null);
  assert.deepEqual(await host.describe(f.caller.projectId, 'standard'), machine);
  // A project that cannot rent has no room and no machines.
  f.runtimes.disconnected.add(f.caller.projectId);
  assert.equal(await host.free(f.caller.projectId), 0);
  assert.equal(await host.describe(f.caller.projectId, 'standard'), null);
  await host.close();
});

/** A fixture whose owner names the person each request is for: `a_1` is for `person_a`. */
async function capped(t: TestContext, limits: FleetConfig = {}) {
  const f = await fixture(t, { globalLimit: 5, projectLimit: 5, dailyUsdPerPerson: 2, ...limits });
  f.unregister();
  f.fleet.registerOwner('workflow', {
    ...f.owner,
    payer: async (_source, ownerId) => (ownerId.startsWith('c_') ? null : `person_${ownerId[0]}`),
  });
  const price = (maxHourlyUsd: number | null) => {
    f.runtimes.describe = async (_projectId, key) =>
      maxHourlyUsd === null ? null : { key, vcpu: 1, memoryGiB: 4, diskGB: 8, maxHourlyUsd };
  };
  const ask = (id: string) =>
    f.fleet.request(f.caller, { requestId: id, owner: { kind: 'workflow', id } });
  const get = (id: string) => f.fleet.inspect(f.caller, id);
  return { ...f, price, ask, get };
}

test('a person’s machines stop renting once today’s compute is spent; another person’s still rent', async (t) => {
  const f = await capped(t);
  // One dollar an hour for each machine.
  f.price(1);
  const first = await f.ask('a_1');
  assert.equal(first.person, 'person_a');
  await f.fleet.tick();
  assert.equal((await f.get(first.id)).usdPerHour, 1);
  f.advance(2 * 3_600_000);
  await assert.rejects(f.ask('a_2'), { code: 'fleet_compute_cap', status: 429 });
  // Released, the machine's hours still count: a new request for the same person is refused.
  await f.fleet.cancel(f.caller, first.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  assert.equal((await f.get(first.id)).phase, 'released');
  await assert.rejects(f.ask('a_3'), { code: 'fleet_compute_cap', status: 429 });
  assert.equal((await f.ask('b_1')).person, 'person_b');
  // An owner that names nobody is not counted, nor held back.
  assert.equal((await f.ask('c_1')).person, undefined);
});

test('today’s compute counts open machines to now at the price they were reserved at, and never a request without a machine', async (t) => {
  const f = await capped(t);
  f.price(1);
  // Refused before any machine existed: its time costs nothing.
  f.runtimes.createError = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  const refused = await f.ask('a_1');
  await f.fleet.tick();
  const { error, usdPerHour } = await f.get(refused.id);
  assert.deepEqual([error, usdPerHour], ['runtime_refused', 1]);
  f.runtimes.createError = undefined;
  const open = await f.ask('a_2');
  await f.fleet.tick();
  assert.ok((await f.get(open.id)).runtime);
  // A later price is not what the machine was rented at.
  f.price(100);
  f.advance(90 * 60_000);
  const queued = await f.ask('a_3');
  f.advance(30 * 60_000);
  // Two hours of the open machine; the queued request has no machine yet.
  assert.equal((await f.get(queued.id)).phase, 'queued');
  await assert.rejects(f.ask('a_4'), { code: 'fleet_compute_cap' });
  // A new UTC day starts from nothing, though the machine is still open.
  f.advance(22 * 3_600_000);
  assert.equal((await f.ask('a_5')).person, 'person_a');
});

test('a capped request waits for its offer’s price, then is refused ten minutes after Fleet could first read it', async (t) => {
  const f = await capped(t);
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  const unpriced = () => lines.filter((line) => line.includes('fleet.unpriced'));
  f.price(null);
  const waiting = await f.ask('a_1');
  await f.fleet.tick();
  assert.equal((await f.get(waiting.id)).phase, 'queued');
  assert.deepEqual(f.runtimes.createKeys, []);
  // An offer that lists its price admits the request at that price.
  f.price(0.5);
  await f.fleet.tick();
  const admitted = await f.get(waiting.id);
  assert.deepEqual([admitted.phase, admitted.usdPerHour], ['provisioning', 0.5]);
  assert.deepEqual(f.runtimes.createKeys, [`${waiting.id}:create`]);
  // One that never does is refused once ten minutes have passed, and said so once.
  f.price(null);
  const refused = await f.ask('a_2');
  f.advance(599_999);
  await f.fleet.tick();
  assert.equal((await f.get(refused.id)).phase, 'queued');
  f.advance(1);
  await f.fleet.tick();
  await f.fleet.tick();
  const current = await f.get(refused.id);
  assert.deepEqual(
    [current.phase, current.intent, current.error, current.runtime],
    ['released', 'stop', 'runtime_refused', null],
  );
  assert.deepEqual(
    unpriced().map((line) => JSON.parse(line)),
    [{ event: 'fleet.unpriced', allocation: refused.id, code: 'fleet_unpriced' }],
  );
  // After a restart the ten minutes start again: the first options read may not have finished.
  const late = await f.ask('a_3');
  let now = Date.parse(late.createdAt) + 900_000;
  const successor = await createService(
    new FleetService(
      f.state,
      f.scope,
      f.runtimes,
      { enabled: true, dailyUsdPerPerson: 2 },
      () => now,
    ),
  );
  successor.registerOwner('workflow', { ...f.owner, payer: async () => 'person_a' });
  await successor.tick();
  assert.equal((await f.get(late.id)).phase, 'queued');
  now += 600_000;
  await successor.tick();
  assert.equal((await f.get(late.id)).error, 'runtime_refused');
  assert.equal(unpriced().length, 2);
  await successor.close();
});

test('a request priced after it waited, then refused before any machine, costs nothing', async (t) => {
  const f = await capped(t, { globalLimit: 1 });
  f.price(3);
  const occupant = await f.ask('c_1');
  await f.fleet.tick();
  const waited = await f.ask('a_1');
  f.advance(50 * 60_000);
  await f.fleet.cancel(f.caller, occupant.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  f.runtimes.createError = new MervError('sandbox_forbidden', 'The grant has expired', 403);
  await f.fleet.tick();
  await f.fleet.tick();
  const refused = await f.get(waited.id);
  assert.deepEqual(
    [refused.phase, refused.error, refused.runtime, refused.usdPerHour],
    ['released', 'runtime_refused', null, 3],
  );
  // Fifty minutes from its request at $3 an hour would be over the cap, had it had a machine.
  assert.equal((await f.ask('a_2')).person, 'person_a');
});

test('an unpriced request waits without taking the writer lock, and is refused on time while the queue is full', async (t) => {
  const f = await capped(t, { globalLimit: 1 });
  f.price(null);
  const waiting = await f.ask('a_1');
  const transactions = t.mock.method(f.state, 'transaction');
  await f.fleet.tick();
  assert.equal(transactions.mock.callCount(), 0, 'nothing to admit, nothing to write');
  transactions.mock.restore();
  // Every slot taken, the unpriced request is still refused ten minutes on.
  const occupant = await f.ask('c_1');
  await f.fleet.tick();
  assert.equal((await f.get(occupant.id)).phase, 'provisioning');
  f.advance(600_000);
  await f.fleet.tick();
  const refused = await f.get(waiting.id);
  assert.deepEqual([refused.phase, refused.error], ['released', 'runtime_refused']);
});

test('a capped request whose place loses its connection is refused at once, not after the unpriced wait', async (t) => {
  const f = await capped(t);
  const lines: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  f.price(1);
  const stranded = await f.ask('a_1');
  f.runtimes.disconnected.add(f.caller.projectId);
  await f.fleet.tick();
  const current = await f.get(stranded.id);
  assert.deepEqual(
    [current.phase, current.error, current.createAttempted, current.usdPerHour],
    ['released', 'runtime_refused', false, undefined],
  );
  assert.deepEqual(f.runtimes.createKeys, []);
  assert.deepEqual(
    lines.filter((line) => line.includes('fleet.unpriced')),
    [],
    'a lost connection is not a missing price',
  );
});

test('prices are read once per place and profile each pass, outside any transaction, and never by a request', async (t) => {
  const f = await capped(t);
  f.runtimes.large = { key: 'large', id: 'large-profile', leaseSeconds: 600 };
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  const otherCaller: Caller = {
    projectId: other.project.id,
    actorId: other.actor.id,
    credentialId: other.credential.id,
  };
  const reads: string[] = [];
  f.runtimes.describe = async (projectId, key) => {
    assert.equal(f.state.ambient, undefined, 'no price is read inside a transaction');
    reads.push(`${projectId === f.caller.projectId ? 'own' : 'other'} ${key}`);
    return { key, vcpu: 1, memoryGiB: 4, diskGB: 8, maxHourlyUsd: 0.1 };
  };
  const ask = (
    caller: Caller,
    id: string,
    profile?: string,
    tx?: Parameters<typeof f.fleet.request>[2],
  ) => f.fleet.request(caller, { requestId: id, owner: { kind: 'workflow', id }, profile }, tx);
  await ask(f.caller, 'a_1');
  await ask(f.caller, 'a_2');
  await ask(f.caller, 'b_1', 'large');
  await f.state.transaction((tx) => ask(f.caller, 'b_2', 'large', tx));
  await ask(otherCaller, 'a_3');
  assert.deepEqual(reads, [], 'a request reads no price');
  await f.fleet.tick();
  assert.deepEqual(reads.toSorted(), ['other standard', 'own large', 'own standard']);
  assert.deepEqual(
    (await f.fleet.list(f.caller)).map((a) => [a.phase, a.usdPerHour]),
    Array.from({ length: 4 }, () => ['provisioning', 0.1]),
  );
});

test('a storage cap refusal is a wallet refusal', async (t) => {
  const f = await fixture(t);
  f.runtimes.createError = new MervError('sandbox_storage_cap_exceeded', 'Storage is full', 403);
  const refused = await f.fleet.request(f.caller, input('storage'));
  await f.fleet.tick();
  const current = await f.fleet.inspect(f.caller, refused.id);
  assert.deepEqual([current.phase, current.error], ['released', 'wallet_refused']);
});

test('the reads every pass makes walk their indexes, not the whole history', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 1, dailyUsdPerPerson: 20 });
  f.fleet.registerOwner('paid', { ...f.owner, payer: async () => 'person_7' });
  const template = await f.fleet.request(f.caller, input('template'));
  const plans = await f.state.transaction(async (tx) => {
    await tx.run('SET LOCAL enable_seqscan = off');
    // 5,000 rows of history, one in a hundred still open, over fifty people and about 100 days.
    await tx.run(
      `INSERT INTO fleet_allocations(id,project_id,source_hash,request_id,input_hash,phase,created_at,data_json)
       SELECT 'flt_seed_' || n, project_id, source_hash, 'seed_' || n, input_hash, row.phase, row.created_at,
         (data_json::jsonb || jsonb_build_object('id', 'flt_seed_' || n, 'phase', row.phase,
           'createdAt', row.created_at, 'person', 'person_' || n % 50,
           'owner', jsonb_build_object('kind', 'workflow', 'id', 'work_' || n)))::text
       FROM fleet_allocations, generate_series(1, 5000) AS n,
         LATERAL (SELECT CASE WHEN n % 100 = 0 THEN 'queued' ELSE 'released' END AS phase,
           to_char(timestamp '2026-06-01' + n * interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             AS created_at) AS row
       WHERE id=?`,
      template.id,
    );
    const count = await tx.get<{ n: number }>('SELECT count(*)::int AS n FROM fleet_allocations');
    assert.equal(count?.n, 5001);
    const all = t.mock.method(tx, 'all');
    const explain = async (sql: string, ...params: SqlValue[]) =>
      (await tx.all<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, ...params))
        .map((row) => row['QUERY PLAN'])
        .join('\n');
    /** EXPLAIN the one statement `read` sends, exactly as Fleet sends it. */
    const plan = async (read: () => Promise<unknown>) => {
      all.mock.resetCalls();
      await read();
      assert.equal(all.mock.callCount(), 1);
      const [sql, ...params] = all.mock.calls[0]!.arguments;
      return explain(sql, ...params);
    };
    return {
      open: await plan(() => f.fleet.free(f.caller.projectId, tx)),
      owned: await plan(() => f.fleet.listOwned(f.owner, ['work_7', 'work_4200'])),
      // The spend cap's read of one person's recent rentals.
      person: await plan(() =>
        f.fleet.request(f.caller, { requestId: 'paid', owner: { kind: 'paid', id: 'x' } }, tx),
      ),
    };
  });
  // Which scan the planner picks depends on its estimates; that it can use the index at all
  // depends only on the query text matching the index, which is what this guards.
  assert.match(plans.open, /fleet_allocations_open\b/, plans.open);
  assert.match(plans.owned, /fleet_allocations_open\b/, plans.owned);
  assert.match(plans.owned, /fleet_allocations_owner\b/, plans.owned);
  assert.match(plans.person, /Index Cond: .*'person'.*created_at >=/, plans.person);
  assert.match(plans.person, /fleet_allocations_person\b/, plans.person);
});

test('missing owner releases an untouched allocation without renting a machine', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('unowned'));
  assert.equal(allocation.createAttempted, false);
  f.unregister();
  // After a restart, owners have five minutes to register before anything of theirs is judged.
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'queued');
  f.advance(300_000);
  await f.fleet.tick();
  const current = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(current.phase, 'released');
  assert.deepEqual(f.runtimes.createKeys, []);
});

test('cancellation during slow bootstrap prevents a later launch', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('slow-bootstrap'));
  await f.fleet.tick();
  const gate = deferred<string>();
  let entered = false;
  f.setBootstrap(async () => {
    entered = true;
    return gate.promise;
  });
  const ticking = f.fleet.tick();
  while (!entered) await new Promise((resolve) => setImmediate(resolve));
  await f.fleet.cancel(f.caller, allocation.id);
  gate.resolve('stable-bootstrap');
  await ticking;
  assert.deepEqual(f.runtimes.launchKeys, []);
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
});

test('closing leaves a kept owner’s launched machine running and stops the rest; a successor takes it back', async (t) => {
  const f = await fixture(t, { globalLimit: 3, projectLimit: 3 });
  f.unregister();
  const kept: FleetOwner = { ...f.owner, keepsRunning: true };
  f.fleet.registerOwner('workflow', kept);
  f.fleet.registerOwner('pi-host', f.owner);
  const work = await f.fleet.request(f.caller, input('kept'));
  const chat = await f.fleet.request(f.caller, {
    requestId: 'chat',
    owner: { kind: 'pi-host', id: 'host_1' },
  });
  for (let i = 0; i < 3; i++) await f.fleet.tick();
  const machine = async (id: string) => (await f.fleet.inspect(f.caller, id)).runtime!.sandboxId;
  const [kept1, chat1] = [await machine(work.id), await machine(chat.id)];
  await f.fleet.close();
  assert.deepEqual(f.runtimes.stopped, [chat1], 'only the chat machine ends with the process');
  assert.equal((await f.fleet.inspect(f.caller, work.id)).intent, 'run');
  const restart = async () =>
    await createService(
      new FleetService(f.state, f.scope, f.runtimes, { enabled: true }, () =>
        Date.parse('2026-09-22T00:00:00Z'),
      ),
    );
  // A Fleet that closes before the owner registers again never fences what it did not own.
  await (await restart()).close();
  const successor = await restart();
  // Before its owner registers again the kept machine is watched, never stopped.
  await successor.tick();
  assert.equal((await successor.inspect(f.caller, work.id)).intent, 'run');
  assert.ok(!f.runtimes.stopped.includes(kept1));
  successor.registerOwner('workflow', kept);
  f.runtimes.leaseSoon(kept1);
  await successor.tick();
  assert.ok(f.runtimes.renewed.includes(kept1), 'the restarted Fleet renews the kept machine');
  assert.equal((await successor.inspect(f.caller, work.id)).intent, 'run');
  await successor.close();
});

test('closing leaves a kept owner’s queued and booting work to the successor, which waits for the owner', async (t) => {
  const f = await fixture(t, { globalLimit: 3, projectLimit: 3 });
  f.unregister();
  const kept: FleetOwner = { ...f.owner, keepsRunning: true };
  f.fleet.registerOwner('workflow', kept);
  f.runtimes.failCreateOnce = true;
  const lost = await f.fleet.request(f.caller, input('lost'));
  await f.fleet.tick();
  const booting = await f.fleet.request(f.caller, input('booting'));
  await f.fleet.tick();
  const queued = await f.fleet.request(f.caller, input('queued'));
  await f.fleet.close();
  const phases = async () =>
    await Promise.all(
      [lost.id, booting.id, queued.id].map(async (id) => {
        const { phase, intent } = await f.fleet.inspect(f.caller, id);
        return `${phase} ${intent}`;
      }),
    );
  const closed = ['uncertain run', 'provisioning run', 'queued run'];
  assert.deepEqual(await phases(), closed, 'closing admits, creates and stops nothing kept');
  assert.deepEqual([f.runtimes.createKeys.length, f.runtimes.launchKeys], [2, []]);
  const successor = await createService(
    new FleetService(f.state, f.scope, f.runtimes, { enabled: true }, () =>
      Date.parse('2026-09-22T00:00:10Z'),
    ),
  );
  await successor.tick();
  assert.deepEqual(await phases(), closed, 'nothing moves before the owner registers again');
  assert.deepEqual([f.runtimes.createKeys.length, f.runtimes.launchKeys], [2, []]);
  successor.registerOwner('workflow', kept);
  await successor.tick();
  assert.deepEqual(await phases(), ['provisioning run', 'starting run', 'provisioning run']);
  assert.deepEqual(f.runtimes.launchKeys, [`${booting.id}:launch`]);
  assert.equal(f.runtimes.createKeys.filter((key) => key === `${lost.id}:create`).length, 2);
  await successor.close();
});

test('a create whose reply was lost before closing is recovered by the successor, not while closing', async (t) => {
  const f = await fixture(t);
  f.runtimes.failCreateOnce = true;
  const { id } = await f.fleet.request(f.caller, input('lost'));
  await f.fleet.tick();
  await f.fleet.close();
  const closed = await f.fleet.inspect(f.caller, id);
  assert.deepEqual(
    [closed.intent, closed.runtime, closed.releaseBy, f.runtimes.createKeys],
    ['stop', null, undefined, [`${id}:create`]],
  );
  const successor = await createService(
    new FleetService(f.state, f.scope, f.runtimes, { enabled: true }, () =>
      Date.parse('2026-09-22T00:00:00Z'),
    ),
  );
  await successor.tick();
  assert.deepEqual(f.runtimes.createKeys, [`${id}:create`, `${id}:create`]);
  await successor.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  await successor.close();
});

test('a machine without a registered owner is watched, not stopped, until the owner grace ends', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  const gone = await f.fleet.request(f.caller, input('gone'));
  const idle = await f.fleet.request(f.caller, {
    requestId: 'idle',
    owner: { kind: 'workflow', id: 'work_2' },
  });
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  const machine = async (id: string) => (await f.fleet.inspect(f.caller, id)).runtime!.sandboxId;
  const [deleted, live] = [await machine(gone.id), await machine(idle.id)];
  f.unregister();
  f.runtimes.confirmStopped(deleted);
  f.runtimes.leaseSoon(live);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, gone.id)).phase, 'released');
  const waiting = await f.fleet.inspect(f.caller, idle.id);
  assert.deepEqual([waiting.phase, waiting.intent], ['running', 'run']);
  assert.deepEqual([f.runtimes.stopped, f.runtimes.renewed], [[], []]);
  f.advance(300_000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, idle.id)).intent, 'stop');
  assert.deepEqual(f.runtimes.stopped, [live]);
});

test('drain waits for owner completion and close leaves pending delete for a successor', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('drain'));
  await f.fleet.tick();
  await f.fleet.tick();
  await f.fleet.tick();
  const draining = await f.fleet.drain(f.caller, allocation.id);
  assert.equal(draining.intent, 'drain');
  assert.equal(await f.state.transaction((tx) => f.fleet.admits(allocation.id, 1, tx)), false);
  f.runtimes.leaseSoon('sbx_1');
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, []);
  assert.deepEqual(f.runtimes.renewed, ['sbx_1']);
  f.setObservation('finished');
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'releasing');
  await f.fleet.close();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'releasing');
  f.runtimes.confirmStopped('sbx_1');
  const successor = await createService(
    new FleetService(f.state, f.scope, f.runtimes, { enabled: true }, () =>
      Date.parse('2026-09-22T00:00:00Z'),
    ),
  );
  successor.registerOwner('workflow', {
    valid: async () => true,
    bootstrap: async () => 'stable-bootstrap',
    observe: async () => 'running',
  });
  await successor.tick();
  assert.equal((await successor.inspect(f.caller, allocation.id)).phase, 'released');
  await successor.close();
});

test('a started Fleet acts on a request at once, watches start-up often, then slows', async (t) => {
  // A one-second interval checks start-up every 200 ms; the fake clock never moves.
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2, pollIntervalMs: 1000 });
  f.fleet.registerOwner('steady', {
    valid: async () => true,
    bootstrap: async () => 'stable-bootstrap',
    observe: async () => 'running',
  });
  await f.fleet.request(f.caller, { requestId: 'steady', owner: { kind: 'steady', id: 'x' } });
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  let reads = 0;
  const read = f.state.read.bind(f.state);
  f.state.read = ((fn) => (reads++, read(fn))) as typeof f.state.read;
  const inspected = (id: string) => f.runtimes.inspected.filter((item) => item === id).length;
  f.setObservation('starting');
  f.fleet.start();
  const allocation = await f.fleet.request(f.caller, input('kicked'));
  await within(300, () => f.runtimes.createKeys.length === 2);
  const phase = async () => (await f.fleet.inspect(f.caller, allocation.id)).phase;
  await within(1000, async () => (await phase()) === 'starting');
  const [running, starting] = [inspected('sbx_1'), inspected('sbx_2')];
  await sleep(700);
  assert.ok(inspected('sbx_2') - starting >= 2, 'start-up is checked more often than the interval');
  assert.ok(inspected('sbx_1') - running <= 1, 'a running machine waits for the interval');
  f.setObservation('running');
  await within(1000, async () => (await phase()) === 'running');
  await sleep(450);
  const before = reads;
  await sleep(800);
  // Each pass reads the allocations twice: once all are running, only the interval passes.
  assert.ok(reads - before <= 2, 'Fleet slows down once nothing is starting or stopping');
});

test('a kick from inside a transaction runs outside it', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 1, pollIntervalMs: 60_000 });
  f.setObservation('starting');
  const { id } = await f.fleet.request(f.caller, input('starting'));
  await f.fleet.tick();
  f.fleet.kick();
  await sleep(50);
  assert.deepEqual(f.runtimes.launchKeys, [], 'an unstarted Fleet does nothing on its own');
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, id)).phase, 'starting');
  f.fleet.start();
  f.setObservation('finished');
  await f.state.transaction(async () => f.fleet.kick());
  await within(300, () => f.runtimes.stopped.includes('sbx_1'));
});

test('a request made inside a transaction gets its machine once that commits', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2, pollIntervalMs: 60_000 });
  f.fleet.start();
  await f.fleet.request(f.caller, input('before-first-pass'));
  await sleep(100);
  assert.deepEqual(f.runtimes.createKeys, [], 'kicks wait for the first full pass');
  await f.fleet.tick();
  await f.state.transaction(async (tx) => {
    await f.fleet.request(f.caller, input('in-transaction'), tx);
    await sleep(50);
  });
  await within(300, () => f.runtimes.createKeys.length === 2);
});

test('a request committed while a pass is in flight is acted on right after it, not an interval later', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2, pollIntervalMs: 60_000 });
  f.fleet.start();
  await f.fleet.tick();
  const hold = deferred<SandboxRuntimeHandle>();
  f.runtimes.holdCreate = hold;
  await f.fleet.request(f.caller, input('first'));
  // The pass this request kicked read the allocations and now waits on its create.
  await within(300, () => f.runtimes.createKeys.length === 1);
  await f.fleet.request(f.caller, input('second'));
  await sleep(50);
  f.runtimes.holdCreate = undefined;
  hold.resolve(f.runtimes.byKey.values().next().value!);
  await within(300, () => f.runtimes.createKeys.length === 2);
});

for (const how of ['cancel', 'cancelOwned'] as const)
  test(`${how} stops a running machine at once`, async (t) => {
    const f = await fixture(t, { globalLimit: 2, projectLimit: 1, pollIntervalMs: 60_000 });
    const { id } = await f.fleet.request(f.caller, input(how));
    for (const _ of [1, 2, 3]) await f.fleet.tick();
    f.fleet.start();
    await (how === 'cancel' ? f.fleet.cancel(f.caller, id) : f.fleet.cancelOwned(f.owner, id));
    await within(300, () => f.runtimes.stopped.includes('sbx_1'));
  });

test('a new machine whose container still boots stays starting while its launch is retried each second', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  const { id } = await f.fleet.request(f.caller, input('booting'));
  await f.fleet.tick();
  // Sandboxes answers 503 {"error":{"code":"provider_unavailable",…}} until Cloudflare lists the
  // new container as running; the client names that code sandbox_provider_unavailable.
  f.runtimes.refuseLaunch = new MervError(
    'sandbox_provider_unavailable',
    'Protected runtime launch was refused',
    503,
  );
  await f.fleet.tick();
  const booting = await f.fleet.inspect(f.caller, id);
  assert.deepEqual([booting.phase, booting.failures], ['provisioning', 0]);
  f.advance(1000);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, id)).phase, 'starting');
  const phases = await f.state.read((sql) =>
    sql.all<{ phase: string }>(
      "SELECT data_json::jsonb->>'phase' AS phase FROM events WHERE type='fleet.changed' AND subject_id=? ORDER BY id",
      id,
    ),
  );
  assert.deepEqual(
    phases.map(({ phase }) => phase),
    ['provisioning', 'starting'],
  );
});

test('a new machine whose launch is refused is retried after a second; an older one backs off', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  const launches = (id: string) => f.runtimes.launchKeys.filter((key) => key.startsWith(id)).length;
  const fresh = await f.fleet.request(f.caller, input('fresh'));
  await f.fleet.tick();
  f.runtimes.failLaunchOnce = true;
  await f.fleet.tick();
  const refused = await f.fleet.inspect(f.caller, fresh.id);
  assert.deepEqual([refused.phase, refused.failures], ['uncertain', 0]);
  f.advance(1000);
  await f.fleet.tick();
  assert.equal(launches(fresh.id), 2);
  assert.equal((await f.fleet.inspect(f.caller, fresh.id)).phase, 'starting');
  const old = await f.fleet.request(f.caller, input('old'));
  await f.fleet.tick();
  f.advance(61_000);
  f.runtimes.failLaunchOnce = true;
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, old.id)).failures, 1);
  f.advance(1000);
  await f.fleet.tick();
  assert.equal(launches(old.id), 1);
  f.advance(1000);
  await f.fleet.tick();
  assert.equal(launches(old.id), 2);
});
