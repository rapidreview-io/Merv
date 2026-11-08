import { createService, MervError, type Caller } from '@merv/contracts';
import type { Fleet, FleetMachine, FleetRuntimeHandle } from '@merv/fleet/types';
import { FleetWorkflowAdapter } from '@merv/fleet/workflow';
import { ProjectScope } from '@merv/scope';
import type { ManagedRunnerInspection, Sessions } from '@merv/sessions/types';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { FleetService, type FleetConfig, type FleetOwner } from '../packages/fleet/src/index.js';
import { deferred } from './fixtures/deferred.js';
import { createKey, profiles } from './fixtures/runtime-records.js';
import { FakeRuntimes as BaseRuntimes } from './fixtures/runtimes.js';
import { openState } from './fixtures/state.js';

class FakeRuntimes extends BaseRuntimes {
  readonly byKey = this.handles;
  readonly createKeys: string[] = [];
  readonly launchKeys = this.launched;
  readonly renewed: string[] = [];
  describe = async (_projectId: string, _key: string): Promise<FleetMachine | null> => null;
  failCreateOnce = false;
  failLaunchOnce = false;
  createError?: Error;
  inspectError?: Error;
  holdCreate?: ReturnType<typeof deferred<FleetRuntimeHandle>>;
  initialState: FleetRuntimeHandle['state'] = 'ready';
  receiptState: NonNullable<FleetRuntimeHandle['launch']>['state'] = 'pending';
  async provision(project: string, key: string) {
    this.createKeys.push(key);
    if (this.createError) throw this.createError;
    this.stuck = this.initialState === 'ready' ? 0 : 1;
    const handle = await super.provision(project, key);
    const live = this.handles.get(key)!;
    live.leaseExpiresAt = handle.leaseExpiresAt = '2026-09-22T00:10:00Z';
    if (this.holdCreate) return structuredClone(await this.holdCreate.promise);
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw new Error('lost create reply');
    }
    return handle;
  }
  async inspect(project: string, handle: FleetRuntimeHandle) {
    if (this.inspectError) throw this.inspectError;
    return super.inspect(project, handle);
  }
  async launch(project: string, handle: FleetRuntimeHandle, key: string) {
    const result = await super.launch(project, handle, key);
    const live = [...this.handles.values()].find((h) => h.sandboxId === handle.sandboxId)!;
    live.launch!.state = result.launch!.state = this.receiptState;
    if (this.failLaunchOnce) {
      this.failLaunchOnce = false;
      throw new Error('lost launch reply');
    }
    return result;
  }
  async renew(project: string, handle: FleetRuntimeHandle) {
    this.renewed.push(handle.sandboxId);
    return this.inspect(project, handle);
  }
  confirmStopped(id: string) {
    this.release(id);
  }
  leaseSoon(id: string) {
    [...this.handles.values()].find((h) => h.sandboxId === id)!.leaseExpiresAt =
      '2026-09-22T00:00:30Z';
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

test('concurrent controllers enforce global and per-project caps with idempotent requests', async (t) => {
  const f = await fixture(t);
  f.runtimes.initialState = 'provisioning';
  const callers = [f.caller];
  for (const name of ['Other', 'Third']) {
    const admin = await f.scope.credentials.bootstrap({ projectName: name, actorName: name });
    callers.push({
      projectId: admin.project.id,
      actorId: admin.actor.id,
      credentialId: admin.credential.id,
    });
  }
  const same = await Promise.all(
    Array.from({ length: 4 }, () => f.fleet.request(f.caller, input('same'))),
  );
  assert.equal(new Set(same.map((a) => a.id)).size, 1);
  await assert.rejects(
    f.fleet.request(f.caller, { ...input('same'), owner: { kind: 'workflow', id: 'different' } }),
    { code: 'request_conflict' },
  );
  for (const caller of callers)
    for (const request of ['one', 'two']) await f.fleet.request(caller, input(request));
  const second = await createService(
    new FleetService(
      f.state,
      f.scope,
      f.runtimes,
      { profiles, globalLimit: 2, projectLimit: 1 },
      f.now,
    ),
  );
  second.registerOwner('workflow', f.owner);
  await Promise.all([f.fleet.tick(), second.tick()]);
  const groups = await Promise.all(callers.map((caller) => f.fleet.list(caller)));
  assert.equal(groups.flat().filter((a) => a.phase === 'provisioning').length, 2);
  for (const group of groups)
    assert.ok(group.filter((a) => a.phase === 'provisioning').length <= 1);
  assert.equal(new Set(f.runtimes.createKeys).size, 2);
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
  await f.fleet.cancel(f.caller, open.id);
  await f.fleet.tick();
  f.runtimes.confirmStopped('sbx_1');
  await f.fleet.tick();
  await assert.rejects(f.ask('a_released'), { code: 'fleet_compute_cap' });
  assert.equal((await f.ask('b_1')).person, 'person_b');
  assert.equal((await f.ask('c_1')).person, undefined);
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

test('an allocation whose machines never become ready fails after three, with runtime_not_ready', async (t) => {
  const f = await fixture(t);
  f.runtimes.initialState = 'provisioning';
  const { id, epoch } = await f.fleet.request(f.caller, input('never-ready'));
  await f.fleet.tick();
  for (const attempt of [1, 2]) {
    f.advance(60_000);
    await f.fleet.tick();
    const retiring = await f.fleet.inspect(f.caller, id);
    assert.equal(retiring.runtime?.sandboxId, `sbx_${attempt}`);
    assert.equal(await f.fleet.free(f.caller.projectId), 0);
    await f.fleet.tick();
    assert.equal(f.runtimes.byKey.size, attempt, 'deleting machine still occupies the slot');
    if (attempt === 1) f.runtimes.confirmStopped(`sbx_${attempt}`);
    else {
      f.runtimes.inspectError = new Error('provider unavailable during deletion');
      f.advance(Date.parse(retiring.releaseBy!) - f.now() - 1);
      await f.fleet.tick();
      assert.equal(await f.fleet.free(f.caller.projectId), 0);
      f.advance(60_000);
    }
    await f.fleet.tick();
    f.runtimes.inspectError = undefined;
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

test('planned deletion waits for durable shutdown acknowledgement and renews the dirty host', async (t) => {
  const f = await fixture(t);
  let acknowledged = false;
  let calls = 0;
  f.owner.prepareStop = async () => {
    calls++;
    return acknowledged;
  };
  const allocation = await f.fleet.request(f.caller, input('durable-stop'));
  await f.fleet.tick();
  await f.fleet.tick();
  await f.fleet.tick();
  const running = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(running.phase, 'running');
  assert.equal(running.shutdownRequired, true);
  await f.fleet.cancel(f.caller, allocation.id);
  f.runtimes.leaseSoon(running.runtime!.sandboxId);
  await f.fleet.tick();
  assert.equal(calls, 1);
  assert.deepEqual(f.runtimes.stopped, []);
  assert.deepEqual(f.runtimes.renewed, [running.runtime!.sandboxId]);
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).releaseBy, undefined);
  // Repeated capture failures retain the machine; no timeout manufactures a receipt.
  f.owner.prepareStop = async () => {
    throw new Error('capture transport unavailable');
  };
  await f.fleet.tick();
  assert.deepEqual(f.runtimes.stopped, []);
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).releaseBy, undefined);
  f.advance(120_000);
  f.owner.prepareStop = async () => acknowledged;
  acknowledged = true;
  await f.fleet.tick();
  const stopping = await f.fleet.inspect(f.caller, allocation.id);
  assert.equal(stopping.shutdownAcknowledged, true);
  assert.deepEqual(f.runtimes.stopped, [running.runtime!.sandboxId]);
});

test('idle completion is fenced against a compute-wake visit admitted after observation', async (t) => {
  const f = await fixture(t, { allocationTimeoutSeconds: 86400 });
  await f.state.transaction((tx) => tx.run('CREATE TABLE resume_race (inspection TEXT NOT NULL)'));
  const oldVisit: ManagedRunnerInspection = {
    runnerId: 'compute-runner',
    enrollmentExpiresAt: new Date(f.now() + 3600_000).toISOString(),
    session: {
      id: 'old',
      instanceId: 'work_1',
      expectedRevision: 2,
      status: 'released',
      closedAt: new Date(f.now() - 300_000).toISOString(),
      outcome: 'awaited_compute',
      releaseAcknowledged: true,
      capturePending: false,
    },
  };
  const save = (inspection: ManagedRunnerInspection) =>
    f.state.transaction(async (tx) => {
      await tx.run('DELETE FROM resume_race');
      await tx.run('INSERT INTO resume_race VALUES(?)', JSON.stringify(inspection));
    });
  await save(oldVisit);
  const sessions = {
    managed: {
      inspect: async (_id: string, _epoch: number, tx?: import('@merv/contracts').Transaction) => {
        assert.ok(tx, 'completion revalidation must use the stop-intent transaction');
        return JSON.parse(
          (await tx.get<{ inspection: string }>('SELECT inspection FROM resume_race'))!.inspection,
        );
      },
    },
  } as unknown as Sessions;
  const adapter = new FleetWorkflowAdapter(
    { allocationSeconds: 86400 } as Fleet,
    sessions,
    f.scope,
    { people: ['*'], baseUrl: 'https://example.invalid', modelApiKeyEnv: 'TEST_UNUSED_KEY' },
    f.now,
    f.state,
  );
  // An unclaimed initial host can still finish; only an admitted visit changes that decision.
  await save({ ...oldVisit, session: null });
  assert.equal(
    await f.state.transaction((tx) =>
      adapter.canFinish(
        { id: 'empty', epoch: 1 } as import('@merv/fleet/types').FleetAllocation,
        tx,
      ),
    ),
    true,
  );
  await save(oldVisit);
  f.owner.canFinish = (a, tx) => adapter.canFinish(a, tx);
  let shutdowns = 0;
  f.owner.prepareStop = async () => {
    shutdowns++;
    return true;
  };
  const allocation = await f.fleet.request(f.caller, input('compute-wake-race'));
  await f.fleet.tick();
  await f.fleet.tick();
  await f.fleet.tick();
  // Completion was observed before dispatch's successor transaction commits.
  f.owner.observe = async () => {
    await save({
      ...oldVisit,
      session: { ...oldVisit.session!, id: 'successor', status: 'offered', closedAt: null },
    });
    return 'finished';
  };
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).intent, 'run');
  assert.equal(shutdowns, 0);
  assert.deepEqual(f.runtimes.stopped, []);
  // Finishing the successor is not enough to reuse the old visit's expired idle timer.
  f.owner.observe = async () => 'finished';
  await save({
    ...oldVisit,
    session: { ...oldVisit.session!, id: 'successor', closedAt: new Date(f.now()).toISOString() },
  });
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).intent, 'run');
  f.advance(300_000);
  await save({ ...oldVisit, session: { ...oldVisit.session!, capturePending: true } });
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).intent, 'run');
  await save(oldVisit);
  await f.fleet.tick();
  assert.equal((await f.fleet.inspect(f.caller, allocation.id)).intent, 'stop');
  assert.equal(shutdowns, 1);
  assert.equal(f.runtimes.stopped.length, 1);
});

for (const legacy of [false, true])
  test(`a restarted Fleet retains a safe lease bound after profile change (legacy=${legacy})`, async (t) => {
    const f = await fixture(t);
    f.owner.keepsRunning = true;
    f.unregister();
    f.fleet.registerOwner('workflow', f.owner);
    const allocation = await f.fleet.request(f.caller, input('original-lease'));
    await f.fleet.tick();
    await f.fleet.tick();
    await f.fleet.tick();
    await f.fleet.close();
    if (legacy)
      await f.state.transaction((tx) =>
        tx.run(
          "UPDATE fleet_allocations SET data_json=(data_json::jsonb-'leaseSeconds')::text WHERE id=?",
          allocation.id,
        ),
      );
    const successor = await createService(
      new FleetService(
        f.state,
        f.scope,
        f.runtimes,
        {
          profiles: profiles.map((profile) => ({ ...profile, leaseSeconds: 60 })),
          globalLimit: 2,
          projectLimit: 1,
        },
        f.now,
      ),
    );
    successor.registerOwner('workflow', f.owner);
    f.runtimes.inspectError = new Error('provider unavailable');
    await successor.tick();
    const stopping = await successor.inspect(f.caller, allocation.id);
    assert.equal(stopping.leaseSeconds, legacy ? undefined : 600);
    const bound = (legacy ? 86_400 : 600) * 1000 + 60_000;
    assert.equal(Date.parse(stopping.releaseBy!) - f.now(), bound);
    f.advance(121_000);
    await successor.tick();
    assert.equal(await successor.free(f.caller.projectId), 0);
    f.advance(bound - 120_000);
    await successor.tick();
    assert.equal((await successor.inspect(f.caller, allocation.id)).phase, 'released');
    await successor.close();
  });

test('source credential revocation stops a live allocation', async (t) => {
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
});
