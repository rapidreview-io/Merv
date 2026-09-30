import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, MervError, type Caller, type Transaction } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import type { SandboxRuntimeHandle, SandboxRuntimes } from '@merv/sandboxes';
import { SandboxService } from '@merv/sandboxes';
import {
  FleetService,
  type FleetOwner,
  type FleetAllocation,
} from '../packages/fleet/src/index.js';
import { openState } from './fixtures/state.js';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Calls, provider effects and observations are deliberately independent. */
export class ControlledProvider implements SandboxRuntimes {
  profileId = 'profile_3600';
  leaseSeconds = 3600;
  get profiles() {
    return [{ key: 'standard', id: this.profileId, leaseSeconds: this.leaseSeconds }];
  }
  connected = () => true;
  describe = async () => null;
  now = Date.parse('2026-09-22T00:00:00Z');
  calls: { kind: string; key: string; profile?: string }[] = [];
  machines = new Map<string, SandboxRuntimeHandle>();
  createReply?: (handle: SandboxRuntimeHandle) => Promise<SandboxRuntimeHandle>;
  inspectError?: Error;
  stopError?: Error;
  provision: SandboxRuntimes['provision'] = async (_project, key, profile) => {
    this.calls.push({ kind: 'create', key, profile });
    let handle = this.machines.get(key);
    if (!handle) {
      handle = {
        sandboxId: `sbx_${this.machines.size + 1}`,
        state: 'ready',
        ready: true,
        deleted: false,
        revision: 1,
        launch: null,
        leaseExpiresAt: new Date(this.now + this.leaseSeconds * 1000).toISOString(),
      };
      this.machines.set(key, handle);
    }
    return this.createReply ? this.createReply(structuredClone(handle)) : structuredClone(handle);
  };
  inspect: SandboxRuntimes['inspect'] = async (_project, handle) => {
    if (this.inspectError) throw this.inspectError;
    return structuredClone(
      [...this.machines.values()].find((m) => m.sandboxId === handle.sandboxId)!,
    );
  };
  launch: SandboxRuntimes['launch'] = async (_project, handle, key, _bootstrap, profile) => {
    this.calls.push({ kind: 'launch', key, profile });
    const live = [...this.machines.values()].find((m) => m.sandboxId === handle.sandboxId)!;
    live.launch ??= {
      sandboxId: live.sandboxId,
      launchId: `rln_${live.sandboxId}`,
      operationKey: key,
      releaseId: 'release_1',
      jobId: `job_${live.sandboxId}`,
      state: 'consumed',
      deliveryState: 'launched',
      expiresAt: new Date(this.now + 300_000).toISOString(),
    };
    live.revision++;
    return structuredClone(live);
  };
  stop: SandboxRuntimes['stop'] = async (_project, handle) => {
    this.calls.push({ kind: 'stop', key: handle.sandboxId });
    if (this.stopError) throw this.stopError;
    const live = [...this.machines.values()].find((m) => m.sandboxId === handle.sandboxId)!;
    live.state = 'deleting';
    live.ready = false;
    live.revision++;
    return structuredClone(live);
  };
  acknowledge: SandboxRuntimes['acknowledge'] = async (_project, handle) => structuredClone(handle);
  renewBeforeEffect?: () => Promise<void>;
  renewReply?: (handle: SandboxRuntimeHandle) => Promise<SandboxRuntimeHandle>;
  renew: SandboxRuntimes['renew'] = async (_project, handle, profile) => {
    this.calls.push({ kind: 'renew', key: handle.sandboxId, profile });
    await this.renewBeforeEffect?.();
    const live = [...this.machines.values()].find((m) => m.sandboxId === handle.sandboxId)!;
    // Same-key terminal tombstones are permanent, including for delayed renewals.
    if (!live.deleted) {
      live.leaseExpiresAt = new Date(
        Math.max(Date.parse(live.leaseExpiresAt!), this.now + this.leaseSeconds * 1000),
      ).toISOString();
      live.revision++;
    }
    return this.renewReply ? this.renewReply(structuredClone(live)) : structuredClone(live);
  };
}

export async function fleetFixture(t: TestContext, limits = { globalLimit: 2, projectLimit: 2 }) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Fleet Lean', actorName: 'Operator' });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const provider = new ControlledProvider();
  const owner: FleetOwner = {
    keepsRunning: true,
    valid: async () => true,
    bootstrap: async () => 'stable',
    observe: async () => 'running',
  };
  const services: FleetService[] = [];
  const make = async (
    runtimes: SandboxRuntimes = provider,
    config = limits,
    kind = 'test',
    own = owner,
  ) => {
    const fleet = await createService(
      new FleetService(
        state,
        scope,
        runtimes,
        { enabled: true, allocationTimeoutSeconds: 86400, ...config },
        () => provider.now,
      ),
    );
    fleet.registerOwner(kind, own);
    services.push(fleet);
    return fleet;
  };
  const fleet = await make();
  t.after(async () => {
    for (const f of services) await f.close();
    await state.close();
  });
  const ask = (requestId: string, service = fleet, who = caller) =>
    service.request(who, { requestId, owner: { kind: 'test', id: requestId } });
  const get = (id: string, service = fleet) => service.inspect(caller, id);
  const edit = (id: string, fn: (a: FleetAllocation) => void) =>
    state.transaction(async (tx) => {
      const a = await fleet.inspect(caller, id, tx);
      fn(a);
      await tx.run(
        'UPDATE fleet_allocations SET phase=?,data_json=? WHERE id=?',
        a.phase,
        JSON.stringify(a),
        id,
      );
    });
  return { state, scope, caller, provider, fleet, owner, make, ask, get, edit };
}

for (const known of [true, false])
  test(`persisted ${known ? 'known' : 'lost-create'} lease survives a shorter restart profile`, async (t) => {
    const f = await fleetFixture(t, { globalLimit: 1, projectLimit: 1 });
    if (!known)
      f.provider.createReply = async () => {
        throw new Error('lost reply after effect');
      };
    const a = await f.ask('old');
    await f.fleet.tick();
    await f.fleet.close();
    f.provider.profileId = 'profile_60';
    f.provider.leaseSeconds = 60;
    f.provider.inspectError = new Error('provider unavailable');
    const restart = await f.make();
    await restart.cancel(f.caller, a.id);
    f.provider.now += 2000;
    await restart.tick();
    f.provider.now += 121_000;
    await restart.tick();
    assert.notEqual((await f.get(a.id, restart)).phase, 'released', 'old machine can still exist');
    assert.equal(await restart.free(f.caller.projectId), 0);
    f.provider.now += 3_600_000;
    await restart.tick();
    assert.equal((await f.get(a.id, restart)).phase, 'releasing');
    // Restore the exact profile/connection; recovery must use the old key, never a replacement.
    f.provider.profileId = a.profileId;
    f.provider.inspectError = undefined;
    f.provider.createReply = undefined;
    const live = f.provider.machines.get(`${a.id}:create`)!;
    Object.assign(live, {
      state: 'stopped',
      ready: false,
      deleted: true,
      revision: live.revision + 1,
    });
    f.provider.now += 61_000;
    await restart.tick();
    assert.equal((await f.get(a.id, restart)).phase, 'released');
  });

test('recorded provider expiry dominates the requested lease, including offset timestamps', async (t) => {
  const f = await fleetFixture(t);
  const a = await f.ask('long-observation');
  f.provider.createReply = async (handle) => ({
    ...handle,
    leaseExpiresAt: '2026-09-21T23:00:00-03:00',
  });
  await f.fleet.tick();
  f.provider.inspectError = new Error('unreachable');
  await f.fleet.cancel(f.caller, a.id);
  await f.fleet.tick();
  f.provider.now += 3_661_000;
  await f.fleet.tick();
  assert.notEqual((await f.get(a.id)).phase, 'released');
});

test('legacy unknown lease evidence cannot acquire a timeout from replacement configuration', async (t) => {
  const f = await fleetFixture(t);
  f.provider.createReply = async () => {
    throw new Error('lost reply');
  };
  const a = await f.ask('legacy');
  await f.fleet.tick();
  await f.edit(a.id, (a) => {
    delete (a as any).leaseSeconds;
  });
  f.provider.profileId = 'replacement';
  f.provider.leaseSeconds = 60;
  await f.fleet.cancel(f.caller, a.id);
  f.provider.now += 2000;
  await f.fleet.tick();
  f.provider.now += 1_000_000;
  await f.fleet.tick();
  assert.equal((await f.get(a.id)).phase, 'releasing');
  assert.equal((await f.get(a.id)).releaseBy, undefined);
});

for (const status of [408, 409, 429])
  for (const body of ['not json', '{}', '{"error":{"code":"BAD"}}']) {
    test(`HTTP ${status} with ${body} stays ambiguous through Sandboxes into Fleet`, async (t) => {
      const f = await fleetFixture(t);
      const urlEnv = 'MERV_FLEET_LEAN_URL',
        tokenEnv = 'MERV_FLEET_LEAN_TOKEN';
      process.env[urlEnv] = 'https://sandbox.invalid';
      process.env[tokenEnv] = 'sbxt_lean_fixture';
      t.after(() => {
        delete process.env[urlEnv];
        delete process.env[tokenEnv];
      });
      t.mock.method(globalThis, 'fetch', async (url: URL) =>
        url.pathname === '/v1/auth/me'
          ? Response.json({ role: 'consumer', namespace: 'lean' })
          : new Response(body, { status }),
      );
      const sandbox = new SandboxService({
        urlEnv,
        connections: [{ projectId: f.caller.projectId, namespace: 'lean', tokenEnv }],
        runtimes: [
          {
            key: 'standard',
            provider: 'provider',
            offerId: 'offer',
            releaseId: `rt1_${'a'.repeat(64)}`,
            leaseSeconds: 3600,
          },
        ],
      });
      t.after(() => sandbox.close());
      const fleet = await f.make(sandbox.runtimes!);
      const a = await f.ask('ambiguous', fleet);
      await fleet.tick();
      assert.deepEqual(
        [(await f.get(a.id)).phase, (await f.get(a.id)).error],
        ['uncertain', 'runtime_unavailable'],
      );
    });
  }

test('concurrent first-refusal cannot retire a second controller create in flight', async (t) => {
  const f = await fleetFixture(t);
  const first = deferred<SandboxRuntimeHandle>(),
    second = deferred<SandboxRuntimeHandle>();
  const entered = [deferred<void>(), deferred<void>()];
  let n = 0;
  const provision = f.provider.provision;
  f.provider.provision = async (...args) => {
    const i = n++;
    // Only the second invocation creates a machine; the first refusal really has no effect.
    if (i === 1) await provision(...args);
    entered[i]!.resolve();
    return [first, second][i]!.promise;
  };
  const other = await f.make();
  const a = await f.ask('race');
  const one = f.fleet.tick();
  await entered[0]!.promise;
  const two = other.tick();
  await entered[1]!.promise;
  // Model an explicit no-effect rejection of one invocation, while the other can succeed.
  first.reject(new MervError('sandbox_forbidden', 'No effect for this call', 403));
  await one;
  const beforeSecondReply = await f.get(a.id);
  second.resolve(structuredClone(f.provider.machines.get(`${a.id}:create`)!));
  await two;
  assert.notEqual(beforeSecondReply.phase, 'released');
  assert.equal((await f.get(a.id)).runtime?.sandboxId, 'sbx_1');
});

test('workflow idle-read counterexample: a lease committed before retirement must keep its machine', async (t) => {
  const { FleetWorkflowAdapter } = await import('../packages/fleet/src/workflow.js');
  const f = await fleetFixture(t);
  let leased = false;
  const sessions = {
    inspectManaged: async (_id: string, _epoch: number, tx?: Transaction) => {
      if (tx) f.state.assertTransaction(tx);
      return leased
        ? { session: { status: 'active', releaseAcknowledged: false, capturePending: false } }
        : null;
    },
    dispatchDemand: async () => ({ candidates: [] }),
  } as unknown as import('@merv/sessions').Sessions;
  const adapter = new FleetWorkflowAdapter(
    f.fleet,
    sessions,
    f.scope,
    {},
    () => f.provider.now,
    f.state,
  );
  const reached = deferred<void>(),
    resume = deferred<void>();
  // Keep the real workflow observation, pausing exactly between its final read and Fleet's writer.
  adapter.bootstrap = async () => 'stable';
  adapter.valid = async () => true;
  const observe = adapter.observe.bind(adapter);
  adapter.observe = async (a) => {
    const result = await observe(a);
    if (result === 'finished') {
      reached.resolve();
      await resume.promise;
    }
    return result;
  };
  const fleet = await f.make(f.provider, { globalLimit: 2, projectLimit: 2 }, 'workflow', adapter);
  const a = await fleet.request(f.caller, {
    requestId: 'idle-race',
    owner: { kind: 'workflow', id: 'target' },
  });
  await fleet.tick();
  await fleet.tick();
  // The claim must also keep the lease alive when retirement is vetoed. The next
  // normal poll is too late if this pass skips renewal.
  f.provider.now += 3_599_000;
  let renewals = 0;
  f.provider.renew = async (_project, handle) => {
    renewals++;
    const live = [...f.provider.machines.values()].find((m) => m.sandboxId === handle.sandboxId)!;
    live.leaseExpiresAt = new Date(f.provider.now + 3_600_000).toISOString();
    live.revision++;
    return structuredClone(live);
  };
  const pending = fleet.tick();
  await reached.promise;
  let admission = false;
  await f.state.transaction(async (tx) => {
    admission = await fleet.admits(a.id, a.epoch, tx);
    if (admission) leased = true;
  });
  resume.resolve();
  await pending;
  assert.equal(admission, true, 'a real Fleet admission can commit in the observe/stop interval');
  assert.equal(
    (await f.get(a.id, fleet)).intent,
    'run',
    'retirement must recheck the session in its writer',
  );
  assert.equal(renewals, 1, 'vetoed retirement must renew before the provider lease expires');
});

type ModelCommand = Record<string, unknown>;
const modelDir = fileURLToPath(new URL('../verification/lean/', import.meta.url));
const leanOnPath = spawnSync('lean', ['--version'], { encoding: 'utf8' }).status === 0;
function modelAvailable(name: string) {
  return existsSync(resolve(modelDir, `.lake/build/bin/${name}`)) || leanOnPath;
}
function modelRun(
  name: 'fleet_model' | 'fleet_workflow_model' | 'fleet_lease_model' | 'fleet_release_model',
  commands: ModelCommand[],
  global = 2,
  project = 2,
  extra: Record<string, unknown> = {},
): any[] {
  const binary = resolve(modelDir, `.lake/build/bin/${name}`);
  const compiled = existsSync(binary);
  const source = {
    fleet_model: 'FleetMain.lean',
    fleet_workflow_model: 'FleetWorkflowMain.lean',
    fleet_lease_model: 'FleetLeaseMain.lean',
    fleet_release_model: 'FleetReleaseMain.lean',
  }[name];
  const result = spawnSync(compiled ? binary : 'lean', compiled ? [] : ['--run', source], {
    cwd: modelDir,
    encoding: 'utf8',
    input: JSON.stringify({ commands, global, project, ...extra }),
    env: { ...process.env, LEAN_PATH: `${modelDir}:${resolve(modelDir, '.lake/build/lib/lean')}` },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).observations;
}
const leanOptions = (name: string) => ({
  skip:
    !modelAvailable(name) && process.env.MERV_REQUIRE_LEAN !== '1'
      ? 'Build Fleet Lean models'
      : undefined,
});

/** Compare a finite projection of the real ledger/provider, not a second TS transition model. */
function releaseConformance(
  f: Awaited<ReturnType<typeof fleetFixture>>,
  allocation: FleetAllocation,
) {
  const origin = f.provider.now;
  const commands: ModelCommand[] = [];
  const checkpoints: { label: string; index: number; value: Record<string, unknown> }[] = [];
  const add = (...next: ModelCommand[]) => commands.push(...next);
  const clock = () => add({ kind: 'clock', now: f.provider.now - origin });
  const expiry = (handle: SandboxRuntimeHandle) =>
    add({ kind: 'observeExpiry', expires: Date.parse(handle.leaseExpiresAt!) - origin });
  const checkpoint = async (label: string, counters: Record<string, number> = {}) => {
    const a = await f.get(allocation.id);
    const machine = f.provider.machines.get(`${allocation.id}:create`);
    assert.equal(a.profileId, allocation.profileId, label);
    assert.equal(a.epoch, allocation.epoch, label);
    if (a.runtime) assert.equal(a.runtime.sandboxId, machine?.sandboxId, label);
    checkpoints.push({
      label,
      index: commands.length - 1,
      value: {
        key: 1,
        profile: 1,
        originalLease: a.leaseSeconds! * 1000,
        held: a.phase !== 'queued' && a.phase !== 'released',
        released: a.phase === 'released',
        cancelled: a.intent === 'stop',
        attempts: a.createAttempts ?? 0,
        knownHandle: a.runtime !== null,
        terminalSeen: a.runtime?.deleted === true,
        provider: !machine ? 'absent' : machine.deleted ? 'stopped' : 'live',
        now: f.provider.now - origin,
        observedExpiry: a.leaseExpiresAt ? Date.parse(a.leaseExpiresAt) - origin : 0,
        providerExpiry: machine?.leaseExpiresAt ? Date.parse(machine.leaseExpiresAt) - origin : 0,
        ...counters,
      },
    });
  };
  const run = (oldTimeout = false) =>
    modelRun('fleet_release_model', commands, 1, 1, {
      originalLease: allocation.leaseSeconds! * 1000,
      oldTimeout,
    });
  const compare = (expected: ReturnType<typeof run>, rows = checkpoints) => {
    for (const { label, index, value } of rows) {
      const model = expected[index];
      assert.ok(model, `missing model checkpoint: ${label}`);
      assert.deepEqual(
        value,
        Object.fromEntries(Object.keys(value).map((key) => [key, model[key]])),
        label,
      );
    }
  };
  clock();
  return { add, clock, expiry, checkpoint, checkpoints, run, compare };
}

for (const delay of [121_000, 7 * 86_400_000, 90 * 86_400_000])
  test(
    `FleetRelease real-service conformance: create delayed ${delay}ms through cancellation and restart`,
    leanOptions('fleet_release_model'),
    async (t) => {
      const f = await fleetFixture(t, { globalLimit: 1, projectLimit: 1 });
      f.provider.leaseSeconds = 60;
      const old = await f.ask('paused-create');
      const trace = releaseConformance(f, old);
      const queued = deferred<void>(),
        sent = deferred<void>(),
        effected = deferred<void>();
      const send = deferred<void>(),
        effect = deferred<void>(),
        reply = deferred<void>();
      const replayQueued = deferred<void>(),
        replay = deferred<void>();
      const operations: ('queued' | 'sent' | 'created' | 'refused')[] = [];
      const checkpoint = (label: string) =>
        trace.checkpoint(label, {
          queued: operations.filter((s) => s === 'queued').length,
          inFlight: operations.filter((s) => s === 'sent').length,
          created: operations.filter((s) => s === 'created').length,
          refused: operations.filter((s) => s === 'refused').length,
        });
      let holdRecovery = false;
      const provision = f.provider.provision;
      f.provider.provision = async (...args) => {
        if (args[1] !== `${old.id}:create`) return provision(...args);
        assert.equal(args[0], f.caller.projectId);
        assert.equal(args[2], old.profileId);
        const i = operations.length;
        operations.push('queued');
        // Fleet has committed createAttempts before entering the adapter. Pausing here
        // models a command recorded by the controller but not yet sent to the provider.
        trace.add({ kind: 'queueCreate', key: 1, profile: 1, connected: true });
        if (i === 0) {
          queued.resolve();
          await send.promise;
        } else if (holdRecovery) {
          replayQueued.resolve();
          await replay.promise;
        }
        operations[i] = 'sent';
        trace.add({ kind: 'sendCreate' });
        if (i === 0) {
          sent.resolve();
          await effect.promise;
        } else if (!holdRecovery) {
          // This fixture knows the dispatched recovery failed before materializing.
          // Fleet only sees an ambiguous 503: settle the model's inFlight command
          // with refuseEffect, then lose that definitive information (no receiveRefusal).
          operations[i] = 'refused';
          trace.add({ kind: 'refuseEffect' }, { kind: 'lostReply' });
          throw new MervError('sandbox_unavailable', 'Recovery failed before its effect', 503);
        }
        const handle = await provision(...args);
        operations[i] = 'created';
        trace.add({ kind: 'createEffect' });
        if (i === 0) {
          effected.resolve();
          await reply.promise;
        }
        trace.add({ kind: 'receiveHandle' });
        trace.expiry(handle);
        return handle;
      };
      const other = await f.make();
      const delayed = f.fleet.tick();
      let lateReplay: Promise<void> | undefined;
      try {
        await queued.promise;
        await checkpoint('durable first attempt, no send or provider effect');
        await other.cancel(f.caller, old.id);
        trace.add({ kind: 'cancel' });
        await checkpoint('cancellation leaves queued command held');
        for (let recovery = 0; recovery < 3; recovery++) {
          f.provider.now += 61_000;
          trace.clock();
          await other.tick();
          await checkpoint(`failed recovery ${recovery + 1} remains held`);
        }
        assert.equal(operations.filter((s) => s === 'refused').length, 3);
        await other.close();
        const restarted = await f.make();
        trace.add({ kind: 'restart', replacementProfile: 1, replacementLease: 60_000 });
        await f.edit(old.id, (a) => {
          a.releaseBy = new Date(f.provider.now + 120_000).toISOString();
        });
        f.provider.now += delay;
        trace.clock();
        const successor = await f.ask('replacement', restarted);
        await restarted.tick();
        trace.add({ kind: 'release' });
        await checkpoint('restart ignores expired legacy releaseBy after another failed recovery');
        assert.equal((await f.get(old.id)).releaseBy, undefined);
        assert.equal((await f.get(successor.id)).phase, 'queued');
        assert.equal(await restarted.free(f.caller.projectId), 0);
        assert.equal(f.provider.machines.size, 0);

        // Leave a second real controller's same-key command pending across terminal release.
        holdRecovery = true;
        f.provider.now += 61_000;
        trace.clock();
        lateReplay = restarted.tick();
        await replayQueued.promise;
        await checkpoint('two recorded commands remain queued');
        send.resolve();
        await sent.promise;
        await checkpoint('initial command sent, effect still delayed');
        effect.resolve();
        await effected.promise;
        await checkpoint('arbitrarily late create effect, reply still delayed');
        const liveBeforeReply = trace.checkpoints.at(-1)!;
        assert.equal(liveBeforeReply.value.provider, 'live');
        assert.equal(liveBeforeReply.value.held, true);
        assert.equal(liveBeforeReply.value.knownHandle, false);
        reply.resolve();
        await delayed;
        await checkpoint('late handle persisted under stop intent');

        const cleanup = await f.make();
        const stop = f.provider.stop;
        f.provider.stop = async (...args) => {
          if (args[1].sandboxId === (await f.get(old.id)).runtime?.sandboxId)
            trace.add({ kind: 'queueStop' });
          return stop(...args);
        };
        await cleanup.tick();
        await checkpoint('DELETE accepted but deleting is not terminal');
        assert.equal((await f.get(successor.id)).phase, 'queued');
        const live = f.provider.machines.get(`${old.id}:create`)!;
        assert.equal(live.state, 'deleting');
        Object.assign(live, {
          state: 'stopped',
          ready: false,
          deleted: true,
          revision: live.revision + 1,
        });
        trace.add({ kind: 'stopEffect' });
        await checkpoint('physical terminal evidence not yet observed by Fleet');
        await cleanup.tick();
        trace.add({ kind: 'observeTerminal' }, { kind: 'release' });
        await checkpoint('terminal observation releases reservation');
        assert.equal((await f.get(old.id)).phase, 'released');
        await cleanup.tick();
        assert.equal((await f.get(successor.id)).phase, 'provisioning');
        assert.equal([...f.provider.machines.values()].filter((m) => !m.deleted).length, 1);
        replay.resolve();
        await lateReplay;
        await checkpoint('already queued same-key create returns permanent terminal tombstone');
        assert.equal(f.provider.machines.get(`${old.id}:create`), live);
        assert.equal(live.deleted, true);
        assert.equal([...f.provider.machines.values()].filter((m) => !m.deleted).length, 1);
        assert.equal((await f.get(old.id)).intent, 'stop');
        trace.compare(trace.run());

        // Replay identical real-service commands under the historical rule. It releases
        // before the late effect, creating live+unheld. The same comparator must reject it.
        const oldRule = trace.run(true);
        assert.equal(oldRule[liveBeforeReply.index].provider, 'live');
        assert.equal(oldRule[liveBeforeReply.index].held, false);
        assert.throws(() => trace.compare(oldRule, [liveBeforeReply]), assert.AssertionError);
      } finally {
        send.resolve();
        effect.resolve();
        reply.resolve();
        replay.resolve();
        await Promise.all([delayed, lateReplay]);
      }
    },
  );

test(
  'FleetRelease real-service conformance: delayed renewal extends a cancelled machine while its slot stays held',
  leanOptions('fleet_release_model'),
  async (t) => {
    const f = await fleetFixture(t, { globalLimit: 1, projectLimit: 1 });
    const a = await f.ask('delayed-renew');
    const trace = releaseConformance(f, a);
    await f.fleet.tick();
    trace.add(
      { kind: 'queueCreate', key: 1, profile: 1, connected: true },
      { kind: 'sendCreate' },
      { kind: 'createEffect' },
      { kind: 'receiveHandle' },
    );
    const live = f.provider.machines.get(`${a.id}:create`)!;
    trace.expiry(live);
    await f.fleet.tick();
    await f.fleet.tick();
    await trace.checkpoint('running with original provider lease');
    const originalExpiry = Date.parse(live.leaseExpiresAt!);
    f.provider.now = originalExpiry - 1_000;
    trace.clock();
    const entered = deferred<void>(),
      resume = deferred<void>();
    const effected = deferred<void>(),
      reply = deferred<void>();
    f.provider.renewBeforeEffect = async () => {
      trace.add({ kind: 'queueRenew' });
      entered.resolve();
      await resume.promise;
    };
    f.provider.renewReply = async (handle) => {
      trace.add({ kind: 'renewEffect' });
      effected.resolve();
      await reply.promise;
      trace.expiry(handle);
      return handle;
    };
    const pending = f.fleet.tick();
    try {
      await entered.promise;
      await trace.checkpoint('due renewal dispatched, paused before provider effect');
      const other = await f.make();
      await other.cancel(f.caller, a.id);
      trace.add({ kind: 'cancel' });
      f.provider.stopError = new MervError('sandbox_unavailable', 'Stop outcome uncertain', 503);
      const stop = f.provider.stop;
      f.provider.stop = async (...args) => {
        trace.add({ kind: 'queueStop' });
        return stop(...args);
      };
      await other.tick();
      assert.equal(f.provider.calls.filter((c) => c.kind === 'stop').length, 1);
      assert.equal((await f.get(a.id)).error, 'runtime_unavailable');
      await f.edit(a.id, (current) => {
        current.releaseBy = new Date(originalExpiry + 60_000).toISOString();
      });
      f.provider.now += 30 * 86_400_000;
      trace.clock();
      const successor = await f.ask('after-renew', other);
      await other.tick();
      trace.add({ kind: 'release' });
      await trace.checkpoint('uncertain stop remains held far beyond all old deadlines');
      assert.equal((await f.get(a.id)).releaseBy, undefined);
      assert.equal((await f.get(successor.id)).phase, 'queued');
      assert.equal(await other.free(f.caller.projectId), 0);
      assert.equal(Date.parse(live.leaseExpiresAt!), originalExpiry);
      resume.resolve();
      await effected.promise;
      await trace.checkpoint('delayed renewal actually extends provider lease before reply');
      assert.equal(Date.parse(live.leaseExpiresAt!), f.provider.now + 3_600_000);
      reply.resolve();
      await pending;
      await trace.checkpoint('renewal reply records expiry without reviving run intent');
      assert.equal((await f.get(a.id)).intent, 'stop');
      assert.equal((await f.get(a.id)).phase, 'releasing');
      assert.equal((await f.get(successor.id)).phase, 'queued');
      const leaseAfterRenew = live.leaseExpiresAt;
      f.provider.stopError = undefined;
      await other.tick();
      await trace.checkpoint('successful stop request still waits for terminal evidence');
      assert.equal(live.state, 'deleting');
      assert.equal((await f.get(successor.id)).phase, 'queued');
      Object.assign(live, {
        state: 'stopped',
        ready: false,
        deleted: true,
        revision: live.revision + 1,
      });
      trace.add({ kind: 'providerTerminal' });
      await trace.checkpoint('provider terminal before controller observation');
      await other.tick();
      trace.add({ kind: 'observeTerminal' }, { kind: 'release' });
      await trace.checkpoint('terminal evidence finally releases renewed allocation');
      await other.tick();
      assert.equal((await f.get(successor.id)).phase, 'provisioning');
      assert.equal(live.leaseExpiresAt, leaseAfterRenew);
      assert.equal(f.provider.calls.filter((c) => c.kind === 'renew').length, 1);
      trace.compare(trace.run());
    } finally {
      resume.resolve();
      reply.resolve();
      await pending;
    }
  },
);

for (const [globalLimit, projectLimit] of [
  [1, 1],
  [3, 1],
  [3, 2],
  [5, 3],
]) {
  test(
    `real Fleet matches Lean ledger with global ${globalLimit}, project ${projectLimit}, delayed effects and lower restart limits`,
    leanOptions('fleet_model'),
    async (t) => {
      assert.ok(modelAvailable('fleet_model'));
      const f = await fleetFixture(t, { globalLimit: globalLimit!, projectLimit: projectLimit! });
      const other = await f.scope.bootstrap({ projectName: 'Second', actorName: 'Second' });
      const caller2: Caller = {
        projectId: other.project.id,
        actorId: other.actor.id,
        credentialId: other.credential.id,
      };
      const commands: ModelCommand[] = [],
        observations: { index: number; value: unknown }[] = [];
      const rows: { allocation: FleetAllocation; caller: Caller; project: number }[] = [];
      const add = (command: ModelCommand) => commands.push(command);
      let fleet = f.fleet;
      const snapshot = async () => {
        const current = await Promise.all(
          rows.map(async ({ allocation, caller, project }, i) => {
            const a = await fleet.inspect(caller, allocation.id);
            assert.equal(a.profileId, allocation.profileId);
            assert.equal(a.epoch, allocation.epoch);
            assert.equal(a.projectId, allocation.projectId);
            assert.equal(a.requestId, allocation.requestId);
            const admitted = await f.state.transaction((tx) => fleet.admits(a.id, a.epoch, tx));
            assert.equal(
              await f.state.transaction((tx) => fleet.admits(a.id, a.epoch + 1, tx)),
              false,
            );
            return {
              id: i + 1,
              project,
              profile: 1,
              epoch: a.epoch,
              occupied: a.phase !== 'queued' && a.phase !== 'released',
              released: a.phase === 'released',
              intent: a.intent,
              machine: Number(a.runtime?.sandboxId.split('_')[1] ?? 0),
              launch: a.runtime?.launch ? Number(a.runtime.sandboxId.split('_')[1]) : 0,
              admits: admitted,
            };
          }),
        );
        observations.push({
          index: commands.length - 1,
          value: { held: current.filter((a) => a.occupied).length, rows: current },
        });
      };
      for (let i = 0; i < 6; i++) {
        const caller = i % 2 ? caller2 : f.caller;
        const a = await f.ask(`request_${i}`, fleet, caller);
        rows.push({ allocation: a, caller, project: (i % 2) + 1 });
        add({
          kind: 'request',
          id: i + 1,
          project: (i % 2) + 1,
          profile: 1,
          epoch: 1,
          lease: 3600,
        });
        f.provider.now++;
      }
      await snapshot();
      const hold = deferred<void>(),
        entered = deferred<void>();
      const expected = Math.min(globalLimit!, 2 * projectLimit!);
      let calls = 0;
      f.provider.createReply = async (handle) => {
        if (++calls === expected) entered.resolve();
        await hold.promise;
        return handle;
      };
      const pending = fleet.tick();
      await entered.promise;
      const created = f.provider.calls.filter((c) => c.kind === 'create');
      for (const call of created) {
        const i = rows.findIndex(({ allocation }) => `${allocation.id}:create` === call.key) + 1;
        assert.ok(i > 0);
        assert.equal(call.profile, 'profile_3600');
        add({ kind: 'reserve', id: i });
        add({ kind: 'dispatch', id: i, ticket: i, effect: 'create' });
      }
      await snapshot();
      hold.resolve();
      await pending;
      for (const call of created) {
        const i = rows.findIndex(({ allocation }) => `${allocation.id}:create` === call.key) + 1;
        const machine = Number(f.provider.machines.get(call.key)!.sandboxId.split('_')[1]);
        add({ kind: 'reply', ticket: i, reply: 'created', machine, expires: 0 });
      }
      await snapshot();
      await fleet.tick();
      for (const call of f.provider.calls.filter((c) => c.kind === 'launch')) {
        const i = rows.findIndex(({ allocation }) => `${allocation.id}:launch` === call.key) + 1;
        const machine = Number(
          (
            await fleet.inspect(rows[i - 1]!.caller, rows[i - 1]!.allocation.id)
          ).runtime!.sandboxId.split('_')[1],
        );
        assert.equal(call.profile, 'profile_3600');
        add({ kind: 'dispatch', id: i, ticket: 100 + i, effect: 'launch' });
        add({
          kind: 'reply',
          ticket: 100 + i,
          reply: 'launched',
          machine,
          launch: machine,
          expires: 0,
        });
      }
      await snapshot();
      await fleet.tick();
      for (const call of created)
        add({
          kind: 'running',
          id: rows.findIndex(({ allocation }) => `${allocation.id}:create` === call.key) + 1,
        });
      await snapshot();
      await fleet.close();
      fleet = await f.make(f.provider, { globalLimit: 1, projectLimit: 1 });
      add({ kind: 'limits', global: 1, project: 1 });
      add({ kind: 'restart' });
      await fleet.tick();
      await snapshot();
      // Reductions do not pretend old holds fit the new cap; they block new reservations.
      assert.equal(f.provider.calls.filter((c) => c.kind === 'create').length, expected);
      const firstCall = created[0]!;
      const first = rows.findIndex(({ allocation }) => `${allocation.id}:create` === firstCall.key);
      await fleet.cancel(rows[first]!.caller, rows[first]!.allocation.id);
      add({ kind: 'stop', id: first + 1 });
      await snapshot();
      const live = f.provider.machines.get(firstCall.key)!;
      live.deleted = true;
      live.state = 'stopped';
      live.ready = false;
      live.revision++;
      await fleet.tick();
      add({ kind: 'terminal', id: first + 1 });
      await snapshot();
      const expectedObservations = modelRun('fleet_model', commands, globalLimit, projectLimit);
      for (const observation of observations)
        assert.deepEqual(
          observation.value,
          expectedObservations[observation.index],
          `after ${JSON.stringify(commands[observation.index])}`,
        );
      // Negative control: the comparison must reject a trace that drops an in-flight hold.
      const reserved = observations.find((o: any) => o.value.held > 0)!;
      const corrupted = structuredClone(reserved.value) as { held: number };
      corrupted.held--;
      assert.throws(
        () => assert.deepEqual(corrupted, expectedObservations[reserved.index]),
        assert.AssertionError,
      );
    },
  );
}

test(
  'negative control: a real Fleet with an enlarged reservation cap disagrees with Lean',
  leanOptions('fleet_model'),
  async (t) => {
    const f = await fleetFixture(t, { globalLimit: 2, projectLimit: 2 });
    const commands: ModelCommand[] = [];
    for (let id = 1; id <= 2; id++) {
      await f.ask(`cap_mutant_${id}`);
      f.provider.now++;
      commands.push({ kind: 'request', id, project: 1, profile: 1, epoch: 1, lease: 3600 });
    }
    await f.fleet.tick();
    commands.push({ kind: 'reserve', id: 1 }, { kind: 'reserve', id: 2 });
    const model = modelRun('fleet_model', commands, 1, 1).at(-1);
    const actual = (await f.fleet.list(f.caller)).filter(
      (a) => a.phase !== 'queued' && a.phase !== 'released',
    ).length;
    assert.equal(actual, 2);
    assert.equal(model.held, 1);
    assert.throws(() => assert.equal(actual, model.held), assert.AssertionError);
  },
);

test(
  'workflow retirement adapter matches Lean across claim races, capture and acknowledgement',
  leanOptions('fleet_workflow_model'),
  async (t) => {
    const { FleetWorkflowAdapter } = await import('../packages/fleet/src/workflow.js');
    const f = await fleetFixture(t);
    let session: any = null;
    const adapter = new FleetWorkflowAdapter(
      f.fleet,
      {
        inspectManaged: async () => ({ session }),
        dispatchDemand: async () => ({ candidates: [] }),
      } as unknown as import('@merv/sessions').Sessions,
      f.scope,
      {},
      () => f.provider.now,
      f.state,
    );
    const a = await f.ask('retirement');
    const commands: ModelCommand[] = [],
      actual: boolean[] = [];
    const record = async (c: ModelCommand) => {
      commands.push(c);
      actual.push(await f.state.transaction((tx) => adapter.canRetire(a, tx)));
    };
    await record({ kind: 'observeIdle' });
    session = { status: 'active', releaseAcknowledged: false, capturePending: false };
    await record({ kind: 'claim', epoch: 1 });
    await record({ kind: 'retire' });
    session = {
      status: 'released',
      releaseAcknowledged: false,
      capturePending: true,
      closedAt: new Date(f.provider.now).toISOString(),
    };
    await record({ kind: 'close', capturePending: true, acknowledged: false });
    session.releaseAcknowledged = true;
    await record({ kind: 'acknowledge' });
    session.capturePending = false;
    await record({ kind: 'retain' });
    const expected = modelRun('fleet_workflow_model', commands);
    assert.deepEqual(
      actual,
      expected.map((row) => row.canRetire),
    );
    assert.equal(expected[2].stopped, false, 'a stale idle observation cannot stop active work');
    // The old unconditional stop after the idle read is an intentional negative control.
    assert.throws(() => assert.equal(true, expected[2].stopped), assert.AssertionError);
  },
);

test('a stopped allocation retains an in-flight create reply without authorizing launch', async (t) => {
  const f = await fleetFixture(t);
  const entered = deferred<void>(),
    reply = deferred<SandboxRuntimeHandle>();
  f.provider.createReply = async () => {
    entered.resolve();
    return reply.promise;
  };
  const a = await f.ask('stop-during-create');
  const pending = f.fleet.tick();
  await entered.promise;
  await f.fleet.cancel(f.caller, a.id);
  reply.resolve(structuredClone(f.provider.machines.get(`${a.id}:create`)!));
  await pending;
  await f.fleet.tick();
  const current = await f.get(a.id);
  assert.equal(current.intent, 'stop');
  assert.equal(current.phase, 'releasing');
  assert.equal(
    f.provider.calls.some((c) => c.kind === 'launch'),
    false,
  );
  assert.equal(await f.state.transaction((tx) => f.fleet.admits(a.id, a.epoch, tx)), false);
});

test('legacy known handles wait for terminal evidence and stale releaseBy cannot bypass it', async (t) => {
  const f = await fleetFixture(t);
  const a = await f.ask('legacy-known');
  await f.fleet.tick();
  await f.fleet.cancel(f.caller, a.id);
  await f.edit(a.id, (a) => {
    delete a.leaseSeconds;
    a.releaseBy = new Date(f.provider.now - 1).toISOString();
  });
  await f.fleet.tick();
  f.provider.now += 4_000_000;
  await f.fleet.tick();
  assert.equal((await f.get(a.id)).phase, 'releasing');
  const live = f.provider.machines.get(`${a.id}:create`)!;
  live.deleted = true;
  live.state = 'stopped';
  live.ready = false;
  live.revision++;
  await f.fleet.tick();
  assert.equal((await f.get(a.id)).phase, 'released');
});

test('later short observations cannot erase a longer lease already persisted', async (t) => {
  const f = await fleetFixture(t);
  const a = await f.ask('lease-highwater');
  const expires = new Date(f.provider.now + 7_200_000).toISOString();
  f.provider.createReply = async (handle) => ({ ...handle, leaseExpiresAt: expires });
  await f.fleet.tick();
  await f.fleet.tick();
  assert.equal((await f.get(a.id)).leaseExpiresAt, expires);
  await f.fleet.cancel(f.caller, a.id);
  await f.fleet.tick();
  f.provider.now += 3_661_000;
  await f.fleet.tick();
  assert.notEqual((await f.get(a.id)).phase, 'released');
});

test('a provider cannot replace a pinned launch receipt identity', async (t) => {
  const f = await fleetFixture(t);
  const a = await f.ask('identity');
  await f.fleet.tick();
  await f.fleet.tick();
  const prior = (await f.get(a.id)).runtime!.launch!;
  const live = f.provider.machines.get(`${a.id}:create`)!;
  live.launch = { ...prior, launchId: 'rln_other', jobId: 'job_other' };
  live.revision++;
  await f.fleet.tick();
  const current = await f.get(a.id);
  assert.equal(current.runtime!.launch!.launchId, prior.launchId);
  assert.equal(current.runtime!.launch!.jobId, prior.jobId);
  assert.equal(current.error, 'runtime_unavailable');
});

for (const known of [true, false])
  test(
    `real ${known ? 'known' : 'lost'} lease evidence matches Lean after restart`,
    leanOptions('fleet_lease_model'),
    async (t) => {
      const f = await fleetFixture(t);
      const origin = f.provider.now;
      if (!known)
        f.provider.createReply = async () => {
          throw new Error('lost create after effect');
        };
      const a = await f.ask('lease-differential');
      await f.fleet.tick();
      await f.fleet.close();
      f.provider.profileId = 'replacement_60';
      f.provider.leaseSeconds = 60;
      f.provider.inspectError = new Error('unavailable');
      const restart = await f.make();
      await restart.cancel(f.caller, a.id);
      f.provider.now += 2000;
      await restart.tick();
      const commands: ModelCommand[] = [];
      if (known) commands.push({ kind: 'observe', expires: 3_600_000 });
      commands.push({ kind: 'restart', replacementLease: 60_000 }, { kind: 'stop', now: 2000 });
      const rows: { index: number; value: unknown }[] = [];
      const snapshot = async () => {
        const current = await f.get(a.id, restart);
        rows.push({
          index: commands.length - 1,
          value: {
            released: current.phase === 'released',
            releaseBy: current.releaseBy ? Date.parse(current.releaseBy) - origin : null,
            originalLease: current.leaseSeconds! * 1000,
            observedExpiry: current.leaseExpiresAt
              ? Date.parse(current.leaseExpiresAt) - origin
              : 0,
          },
        });
      };
      await snapshot();
      for (const now of [123_000, 3_700_000]) {
        f.provider.now = origin + now;
        await restart.tick();
        commands.push({ kind: 'reap', now });
        await snapshot();
      }
      // Positive recovery: reconnect the original profile and observe its retained terminal row.
      f.provider.profileId = a.profileId;
      f.provider.createReply = undefined;
      f.provider.inspectError = undefined;
      const live = f.provider.machines.get(`${a.id}:create`)!;
      Object.assign(live, {
        state: 'stopped',
        ready: false,
        deleted: true,
        revision: live.revision + 1,
      });
      f.provider.now += 61_000;
      await restart.tick();
      commands.push({ kind: 'observe', expires: 3_600_000 }, { kind: 'terminal' });
      await snapshot();
      const expected = modelRun('fleet_lease_model', commands, 2, 2, { originalLease: 3_600_000 });
      for (const { index, value } of rows) assert.deepEqual(value, expected[index]);
      const bad = modelRun('fleet_lease_model', commands, 2, 2, { originalLease: 60_000 });
      assert.throws(
        () => assert.deepEqual(rows[0]!.value, bad[rows[0]!.index]),
        assert.AssertionError,
        'negative control: replacing original lease evidence must be detected',
      );
    },
  );

test(
  'project override reservations match arbitrary per-project Lean caps',
  leanOptions('fleet_model'),
  async (t) => {
    const f = await fleetFixture(t, { globalLimit: 4, projectLimit: 1 });
    const other = await f.scope.bootstrap({ projectName: 'Override', actorName: 'Override' });
    const caller: Caller = {
      projectId: other.project.id,
      actorId: other.actor.id,
      credentialId: other.credential.id,
    };
    await f.fleet.close();
    const config = { globalLimit: 4, projectLimit: 1, projectLimits: { [caller.projectId]: 3 } };
    const fleet = await f.make(f.provider, config);
    const commands: ModelCommand[] = [];
    for (let i = 0; i < 6; i++) {
      const project = (i % 2) + 1;
      await f.ask(`override_${i}`, fleet, project === 1 ? f.caller : caller);
      f.provider.now++;
      commands.push({ kind: 'request', id: i + 1, project, profile: 1, epoch: 1, lease: 3600 });
    }
    await fleet.tick();
    for (let id = 1; id <= 6; id++) commands.push({ kind: 'reserve', id });
    const expected = modelRun('fleet_model', commands, 4, 1, {
      projectLimits: [{ project: 2, limit: 3 }],
    }).at(-1);
    const actual = [...(await fleet.list(f.caller)), ...(await fleet.list(caller))];
    assert.equal(actual.filter((a) => a.phase === 'provisioning').length, expected.held);
    assert.equal(expected.rows.filter((a: any) => a.project === 1 && a.occupied).length, 1);
    assert.equal(expected.rows.filter((a: any) => a.project === 2 && a.occupied).length, 3);
  },
);
