import { createService, MervError, type Caller } from '@merv/contracts';
import type { FleetMachine, FleetRuntimeHandle } from '@merv/fleet/types';
import { ProjectScope } from '@merv/scope';
import type { RuntimeLauncher } from '@sandboxes/runtimes/launcher';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { FleetService, type FleetConfig, type FleetOwner } from '../packages/fleet/src/index.js';
import { deferred } from './fixtures/deferred.js';
import { createKey, link, offer, profiles, receipt, sandbox } from './fixtures/runtime-records.js';
import { openState } from './fixtures/state.js';

class FakeRuntimes {
  describe: (projectId: string, key: string) => Promise<FleetMachine | null> = async () => null;
  /** `${call} ${operation key or sandbox} ${release id, or lease seconds for renew}` */
  readonly profiled: string[] = [];
  readonly disconnected = new Set<string>();
  /** The projects whose connections provider calls went through. */
  readonly places = new Set<string>();
  async linked(projectId: string) {
    return this.disconnected.has(projectId) ? null : link(projectId);
  }
  runtimes = ({ projectId }: Caller): RuntimeLauncher => {
    return {
      describe: async (_provider, offerId) => offer(await this.describe(projectId, offerId)),
      provision: async (input) =>
        sandbox(await this.provision(projectId, input.operationKey, input.releaseId)),
      inspect: async (id, launchId) => {
        const handle = await this.inspect(projectId, {
          sandboxId: id,
          launch: launchId ? this.find(id).launch : null,
        } as FleetRuntimeHandle);
        return { sandbox: sandbox(handle), launch: handle.launch && receipt(handle.launch) };
      },
      launch: async (id, input) =>
        receipt(
          (
            await this.launch(
              projectId,
              this.find(id),
              input.operation_key,
              input.bootstrap.getSecretValue(),
              input.release_id,
            )
          ).launch!,
        ),
      acknowledge: async (id, launchId, jobId) => {
        assert.equal(this.find(id).launch?.launchId, launchId);
        assert.equal(this.find(id).launch?.jobId, jobId);
        return receipt((await this.acknowledge(projectId, this.find(id))).launch!);
      },
      stop: async (id) => sandbox(await this.stop(projectId, this.find(id))),
      renew: async (id, seconds) =>
        sandbox(await this.renew(projectId, this.find(id), String(seconds))),
    };
  };
  private find(id: string) {
    return [...this.byKey.values()].find((item) => item.sandboxId === id)!;
  }
  readonly byKey = new Map<string, FleetRuntimeHandle>();
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
  holdCreate?: ReturnType<typeof deferred<FleetRuntimeHandle>>;
  initialState: FleetRuntimeHandle['state'] = 'ready';
  receiptState: NonNullable<FleetRuntimeHandle['launch']>['state'] = 'pending';
  private copy(handle: FleetRuntimeHandle) {
    return structuredClone(handle);
  }
  async provision(projectId: string, operationKey: string, releaseId?: string) {
    this.places.add(projectId);
    this.createKeys.push(operationKey);
    this.profiled.push(`provision ${operationKey} ${releaseId}`);
    if (this.createError) throw this.createError;
    let handle = this.byKey.get(operationKey);
    if (!handle) {
      handle = {
        sandboxId: `sbx_${this.byKey.size + 1}`,
        state: this.initialState,
        ready: this.initialState === 'ready',
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
  async inspect(projectId: string, current: FleetRuntimeHandle) {
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
    current: FleetRuntimeHandle,
    operationKey: string,
    _bootstrap: string,
    releaseId?: string,
  ) {
    this.places.add(projectId);
    this.launchKeys.push(operationKey);
    this.profiled.push(`launch ${operationKey} ${releaseId}`);
    const refusal = this.refuseLaunch;
    this.refuseLaunch = undefined;
    if (refusal) throw refusal;
    const live = [...this.byKey.values()].find((item) => item.sandboxId === current.sandboxId);
    assert.ok(live);
    live.launch ??= {
      launchId: `rln_${live.sandboxId}`,
      jobId: `rtj_${live.sandboxId}`,
      state: this.receiptState,
      deliveryState: 'launched',
    };
    if (this.failLaunchOnce) {
      this.failLaunchOnce = false;
      throw new Error('lost launch reply');
    }
    return this.copy(live);
  }
  async stop(projectId: string, current: FleetRuntimeHandle) {
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
  async acknowledge(projectId: string, current: FleetRuntimeHandle) {
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
  async renew(projectId: string, current: FleetRuntimeHandle, seconds?: string) {
    this.renewed.push(current.sandboxId);
    this.profiled.push(`renew ${current.sandboxId} ${seconds}`);
    return this.inspect(projectId, current);
  }
  confirmStopped(sandboxId: string) {
    const live = [...this.byKey.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(live);
    live.state = 'stopped';
    live.ready = false;
    live.revision++;
  }
  leaseSoon(sandboxId: string) {
    const live = [...this.byKey.values()].find((item) => item.sandboxId === sandboxId);
    assert.ok(live);
    live.leaseExpiresAt = '2026-09-22T00:00:30Z';
    live.revision++;
  }
}

async function fixture(
  t: TestContext,
  limits: Partial<FleetConfig> = { globalLimit: 2, projectLimit: 1 },
) {
  const state = await openState(':memory:');
  const scope = await createService(new ProjectScope(state));
  const admin = await scope.credentials.bootstrap({ projectName: 'Fleet', actorName: 'Operator' });
  const caller: Caller = {
    projectId: admin.project.id,
    actorId: admin.actor.id,
    credentialId: admin.credential.id,
  };
  if (limits.hostProjectId)
    await state.transaction((tx) =>
      tx.run(
        'INSERT INTO projects(id,name,created_at) VALUES(?,?,?)',
        limits.hostProjectId!,
        'Host',
        new Date().toISOString(),
      ),
    );
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
      { profiles, allocationTimeoutSeconds: 3600, ...limits },
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
    now: () => now,
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
      { profiles, globalLimit: 2, projectLimit: 1 },
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
  const other = await f.scope.credentials.bootstrap({
    projectName: 'Other',
    actorName: 'Other operator',
  });
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
      { profiles, globalLimit: 1, projectLimit: 2 },
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

test('a stopping machine is stopped once and frees its slot at releaseBy, even while still deleting', async (t) => {
  const f = await fixture(t, { globalLimit: 2, projectLimit: 2 });
  const cancelled = await f.fleet.request(f.caller, input('cancelled'));
  const deleting = await f.fleet.request(f.caller, input('deleting'));
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  const machine = async (id: string) => (await f.fleet.inspect(f.caller, id)).runtime!.sandboxId;
  const [stopped, gone] = [await machine(cancelled.id), await machine(deleting.id)];
  await f.fleet.cancel(f.caller, cancelled.id);
  // The provider itself begins deleting the other machine: it is watched, never stopped.
  const live = [...f.runtimes.byKey.values()].find((item) => item.sandboxId === gone)!;
  Object.assign(live, { state: 'deleting', ready: false, revision: live.revision + 1 });
  for (const _ of [1, 2, 3, 4]) await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, [stopped]);
  const phases = async () =>
    await Promise.all(
      [cancelled.id, deleting.id].map(async (id) => (await f.fleet.inspect(f.caller, id)).phase),
    );
  assert.deepEqual(await phases(), ['releasing', 'releasing']);
  // The lease is ten minutes; a minute more covers a reply in flight.
  assert.equal(
    (await f.fleet.inspect(f.caller, cancelled.id)).releaseBy,
    '2026-09-22T00:11:00.000Z',
  );
  f.advance(659_999);
  await f.fleet.tick();
  assert.deepEqual(await phases(), ['releasing', 'releasing']);
  f.advance(1);
  await f.fleet.tick();
  assert.deepEqual(await phases(), ['released', 'released']);
  assert.deepEqual(f.runtimes.stopped, [stopped]);
  assert.equal(await f.fleet.free(f.caller.projectId), 2);
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

test('cancellation during create retains capacity until provider reports stopped', async (t) => {
  const f = await fixture(t, { globalLimit: 1, projectLimit: 1 });
  f.runtimes.initialState = 'provisioning';
  const allocation = await f.fleet.request(f.caller, input('cancel-create'));
  const created = deferred<FleetRuntimeHandle>();
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
  const producer = await f.scope.credentials.issueActor(f.caller, {
    name: 'Producer',
    role: 'producer',
  });
  const caller: Caller = {
    projectId: f.caller.projectId,
    actorId: producer.actor.id,
    credentialId: producer.credential.id,
  };
  const revoked = await f.fleet.request(caller, input('revoked'));
  await f.fleet.tick();
  await f.fleet.tick();
  await f.scope.credentials.revokeCredential(f.caller, producer.credential.id);
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

/** A fixture whose owner names the person each request is for: `a_1` is for `person_a`. */
async function capped(t: TestContext, limits: Partial<FleetConfig> = {}) {
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

test('a request queued before its person’s compute was spent is refused, not admitted, once it is', async (t) => {
  const f = await capped(t, { projectLimit: 1 });
  f.price(3);
  const first = await f.ask('a_1');
  await f.fleet.tick();
  const queued = await f.ask('a_2');
  await f.fleet.tick();
  assert.equal((await f.get(queued.id)).phase, 'queued');
  // Fifty minutes at $3 an hour is past the $2 cap; the slot frees only afterwards.
  f.advance(50 * 60_000);
  await f.fleet.cancel(f.caller, first.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  await f.fleet.tick();
  const refused = await f.get(queued.id);
  assert.deepEqual(
    [refused.phase, refused.intent, refused.error, refused.runtime],
    ['released', 'stop', 'person_capped', null],
  );
  assert.deepEqual(f.runtimes.createKeys, [createKey(f.caller.projectId, `${first.id}:create`)]);
  // Another person's request takes the slot.
  const other = await f.ask('b_1');
  await f.fleet.tick();
  assert.equal((await f.get(other.id)).phase, 'provisioning');
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
  // An owner that meters model tokens answers for each person asked, over the window asked.
  const asked: string[] = [];
  f.fleet.registerOwner('meter', {
    ...f.owner,
    modelTokens: async (person, _sql, from, to) => {
      asked.push(`${person} ${from} ${to}`);
      return { used: person === 'person_a' ? 7 : 0, limit: 9, own: false };
    },
  });
  assert.deepEqual(
    await f.fleet.peopleUsage(['person_a', 'person_z'], '2026-09-22', '2026-09-23'),
    [
      { usd: { used: 2, limit: 2, own: false }, tokens: { used: 7, limit: 9, own: false } },
      { usd: { used: 0, limit: 2, own: false }, tokens: { used: 0, limit: 9, own: false } },
    ],
  );
  assert.deepEqual(asked, ['person_a 2026-09-22 2026-09-23', 'person_z 2026-09-22 2026-09-23']);
  await assert.rejects(f.ask('a_4'), { code: 'fleet_compute_cap' });
  // A new UTC day starts from nothing, though the machine is still open.
  f.advance(22 * 3_600_000);
  assert.equal((await f.ask('a_5')).person, 'person_a');
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
  const draining = await f.fleet.request(f.caller, input('draining'));
  const chat = await f.fleet.request(f.caller, {
    requestId: 'chat',
    owner: { kind: 'pi-host', id: 'host_1' },
  });
  for (let i = 0; i < 3; i++) await f.fleet.tick();
  const machine = async (id: string) => (await f.fleet.inspect(f.caller, id)).runtime!.sandboxId;
  const [kept1, chat1] = [await machine(work.id), await machine(chat.id)];
  // A kept machine asked to finish its step keeps finishing it across a restart.
  await f.fleet.drain(f.caller, draining.id);
  await f.fleet.close();
  assert.deepEqual(f.runtimes.stopped, [chat1], 'only the chat machine ends with the process');
  assert.equal((await f.fleet.inspect(f.caller, work.id)).intent, 'run');
  assert.equal((await f.fleet.inspect(f.caller, draining.id)).intent, 'drain');
  const restart = async () =>
    await createService(
      new FleetService(f.state, f.scope, f.runtimes, { profiles }, () =>
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

test('a create whose reply was lost before closing is recovered by the successor, not while closing', async (t) => {
  const f = await fixture(t);
  f.runtimes.failCreateOnce = true;
  const { id } = await f.fleet.request(f.caller, input('lost'));
  await f.fleet.tick();
  await f.fleet.close();
  const closed = await f.fleet.inspect(f.caller, id);
  assert.deepEqual(
    [closed.intent, closed.runtime, closed.releaseBy, f.runtimes.createKeys],
    ['stop', null, undefined, [createKey(f.caller.projectId, `${id}:create`)]],
  );
  const successor = await createService(
    new FleetService(f.state, f.scope, f.runtimes, { profiles }, () =>
      Date.parse('2026-09-22T00:00:00Z'),
    ),
  );
  await successor.tick();
  assert.deepEqual(f.runtimes.createKeys, [
    createKey(f.caller.projectId, `${id}:create`),
    createKey(f.caller.projectId, `${id}:create`),
  ]);
  await successor.tick();
  assert.deepEqual(f.runtimes.stopped, ['sbx_1']);
  await successor.close();
});

test('failed protected runtime stops independently of pending owner capture and release acknowledgement', async (t) => {
  const f = await fixture(t);
  const allocation = await f.fleet.request(f.caller, input('cleanup-failed'));
  for (const _ of [1, 2, 3]) await f.fleet.tick();
  const live = f.runtimes.byKey.values().next().value!;
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'running');
  // Runtime inspection reports the failed supervisor; owner still owes all cleanup receipts.
  f.owner.observe = async () => assert.fail('failed runtime must not wait for owner settlement');
  Object.assign(live, { state: 'failed', ready: false, revision: live.revision + 1 });
  await f.fleet.tick();
  const stopping = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(stopping.intent, 'stop');
  assert.equal(stopping.phase, 'releasing');
  assert.equal(
    await f.state.transaction((tx) => f.fleet.admits(allocation.id, allocation.epoch, tx)),
    false,
  );
  assert.deepEqual(f.runtimes.stopped, [live.sandboxId]);
  f.runtimes.confirmStopped(live.sandboxId);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).phase, 'released');
});

test('an allocation whose machines never become ready fails after three, with runtime_not_ready', async (t) => {
  const f = await fixture(t);
  f.runtimes.initialState = 'provisioning';
  const { id, epoch } = await f.fleet.request(f.caller, input('never-ready'));
  await f.fleet.tick();
  for (const _ of [1, 2]) {
    f.advance(60_000);
    await f.fleet.tick();
    f.advance(60_000);
    await f.fleet.tick();
  }
  f.advance(60_000);
  await f.fleet.tick();
  const failed = await f.fleet.inspect(f.caller, id);
  assert.deepEqual(f.runtimes.createKeys, [
    createKey(f.caller.projectId, `${id}:create`),
    createKey(f.caller.projectId, `${id}:create:2`),
    createKey(f.caller.projectId, `${id}:create:3`),
  ]);
  assert.deepEqual(f.runtimes.stopped, ['sbx_1', 'sbx_2', 'sbx_3']);
  assert.deepEqual(
    [failed.intent, failed.phase, failed.error, failed.runtime?.sandboxId],
    ['stop', 'releasing', 'runtime_not_ready', 'sbx_3'],
  );
  assert.equal(await f.state.transaction((tx) => f.fleet.admits(id, epoch, tx)), false);
  // A stop that fails afterwards does not hide why it stopped.
  f.runtimes.inspectError = new Error('service down');
  f.advance(1000);
  await f.fleet.tick();
  f.runtimes.inspectError = undefined;
  assert.equal((await f.fleet.inspect(f.caller, id)).error, 'runtime_not_ready');
  f.runtimes.confirmStopped('sbx_3');
  f.advance(60_000);
  await f.fleet.tick();
  const released = await f.fleet.inspect(f.caller, id);
  assert.deepEqual([released.phase, released.error], ['released', 'runtime_not_ready']);
});
