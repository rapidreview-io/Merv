import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import { createService, MervError, type Caller } from '@merv/contracts';
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

test('missing owner releases an untouched allocation without renting a machine', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('unowned'));
  assert.equal(allocation.createAttempted, false);
  f.unregister();
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
