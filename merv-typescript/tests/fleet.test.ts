import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createService, type Caller } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
import { FleetService, type FleetOwner } from '../packages/fleet/src/index.js';
import { countWrites, openState } from './fixtures/state.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class FakeRuntimes implements SandboxRuntimes {
  profileId = 'fixed-profile';
  readonly byKey = new Map<string, SandboxRuntimeHandle>();
  readonly createKeys: string[] = [];
  readonly launchKeys: string[] = [];
  readonly acknowledgements: string[] = [];
  readonly stopped: string[] = [];
  readonly renewed: string[] = [];
  failCreateOnce = false;
  failLaunchOnce = false;
  failAcknowledgeOnce = false;
  heartbeatOnInspect = false;
  holdCreate?: ReturnType<typeof deferred<SandboxRuntimeHandle>>;
  initialState: SandboxRuntimeHandle['state'] = 'ready';
  receiptState: NonNullable<SandboxRuntimeHandle['launch']>['state'] = 'pending';
  private copy(handle: SandboxRuntimeHandle) {
    return structuredClone(handle);
  }
  async provision(_projectId: string, operationKey: string) {
    this.createKeys.push(operationKey);
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
  async inspect(_projectId: string, current: SandboxRuntimeHandle) {
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live);
    if (this.heartbeatOnInspect) live.revision++;
    // The real consumer cannot discover a launch receipt without its launch ID.
    return { ...this.copy(live), launch: current.launch ? this.copy(live).launch : null };
  }
  async launch(
    _projectId: string,
    current: SandboxRuntimeHandle,
    operationKey: string,
    _bootstrap: string,
  ) {
    this.launchKeys.push(operationKey);
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
  async stop(_projectId: string, current: SandboxRuntimeHandle) {
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
  async acknowledge(_projectId: string, current: SandboxRuntimeHandle) {
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
  async renew(_projectId: string, current: SandboxRuntimeHandle) {
    this.renewed.push(current.sandboxId);
    return this.inspect(_projectId, current);
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

async function fixture(t: TestContext, limits = { globalLimit: 2, projectLimit: 1 }) {
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
    new FleetService(state, scope, runtimes, { enabled: true, ...limits }, () => now),
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
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'uncertain');
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

test('profile change leaves an uncertain create occupied and never reprovisions a new image', async (t) => {
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
  assert.equal(f.runtimes.createKeys.length, 1);
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
