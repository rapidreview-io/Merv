import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createService,
  type Caller,
  type DelegationSource,
  type Transaction,
  type WorkflowPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { FleetService } from '@merv/fleet';
import type { SandboxRuntimes } from '@merv/sandboxes';
import type { Fleet, FleetAllocation, FleetOwner } from '@merv/fleet/types';
import type {
  Sessions,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from '@merv/sessions/types';
import {
  FleetWorkflowAdapter,
  hostedCodexCapabilities,
  hostedCodexPlatform,
} from '../packages/fleet/src/workflow.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Fleet workflow', actorName: 'Owner' });
  const caller: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const source = await scope.delegationSource(caller);
  const sourceEnv = `MERV_WORKFLOW_SOURCE_${randomUUID().replaceAll('-', '')}`;
  const modelEnv = `MERV_WORKFLOW_MODEL_${randomUUID().replaceAll('-', '')}`;
  process.env[sourceEnv] = boot.token;
  process.env[modelEnv] = `sk-test-${randomBytes(32).toString('hex')}`;
  let now = Date.parse('2026-09-22T00:00:00Z');
  let owner: FleetOwner | undefined, validator: ManagedRunnerValidator | undefined;
  let candidates: { instanceId: string; expectedRevision: number }[] = [];
  const inspections = new Map<string, ManagedRunnerInspection>();
  const allocations: FleetAllocation[] = [];
  const fakeFleet = {
    registerOwner(kind: string, value: FleetOwner) {
      assert.equal(kind, 'workflow');
      owner = value;
      return () => {
        if (owner === value) owner = undefined;
      };
    },
    async request(
      _caller: Caller,
      input: { requestId: string; owner: { kind: string; id: string } },
    ) {
      const prior = allocations.find((a) => a.requestId === input.requestId);
      if (prior) return prior;
      const a: FleetAllocation = {
        id: `flt_${allocations.length + 1}`,
        projectId: boot.project.id,
        source,
        owner: input.owner,
        requestId: input.requestId,
        profileId: 'image-profile',
        epoch: 1,
        phase: 'queued',
        intent: 'run',
        runtime: null,
        createAttempted: false,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 3_600_000).toISOString(),
        retryAt: null,
        failures: 0,
        error: null,
      };
      allocations.push(a);
      return a;
    },
    async inspect(_caller: Caller, id: string) {
      const a = allocations.find((item) => item.id === id);
      assert.ok(a);
      return a;
    },
    async list() {
      return allocations;
    },
    async cancel(_caller: Caller, id: string) {
      const a = allocations.find((item) => item.id === id)!;
      a.intent = 'stop';
      a.phase = 'released';
      return a;
    },
    async admits() {
      return true;
    },
  } as unknown as Fleet;
  const ensureInputs: unknown[] = [];
  const fakeSessions = {
    registerManagedValidator(value: ManagedRunnerValidator) {
      validator = value;
      return () => {
        if (validator === value) validator = undefined;
      };
    },
    async ensureManagedEnrollment(input: unknown) {
      ensureInputs.push(input);
      return { enrollmentToken: `me_${'a'.repeat(64)}` };
    },
    async inspectManaged(id: string) {
      return inspections.get(id) ?? null;
    },
    async dispatchDemand(_caller: Caller, input: unknown) {
      assert.deepEqual(input, {
        platform: hostedCodexPlatform,
        capabilities: [...hostedCodexCapabilities],
      });
      return { candidates };
    },
  } as unknown as Sessions;
  const adapter = new FleetWorkflowAdapter(
    fakeFleet,
    fakeSessions,
    scope,
    {
      enabled: true,
      projectId: boot.project.id,
      sourceCredentialEnv: sourceEnv,
      modelApiKeyEnv: modelEnv,
      baseUrl: 'https://merv.example.test',
      maxAgents: 1,
      pollIntervalMs: 60_000,
    },
    () => now,
  );
  await adapter.start();
  t.after(async () => {
    await adapter.close();
    await state.close();
    delete process.env[sourceEnv];
    delete process.env[modelEnv];
  });
  return {
    state,
    source,
    caller,
    adapter,
    allocations,
    inspections,
    ensureInputs,
    owner: () => owner!,
    validator: () => validator!,
    demand: (value: typeof candidates) => {
      candidates = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    modelApiKey: process.env[modelEnv]!,
    sourceToken: boot.token,
  };
}

test('workflow adapter covers demand with one pending slot and retries a released generation', async (t) => {
  const f = await fixture(t);
  f.demand([
    { instanceId: 'task_a', expectedRevision: 2 },
    { instanceId: 'task_b', expectedRevision: 0 },
  ]);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 1);
  assert.deepEqual(f.allocations[0]?.owner, { kind: 'workflow', id: 'task_a:2' });
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 1);
  f.allocations[0]!.phase = 'released';
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2);
  assert.equal(f.allocations[1]?.owner.id, 'task_a:2');
  assert.notEqual(f.allocations[0]?.requestId, f.allocations[1]?.requestId);
  f.demand([{ instanceId: 'task_b', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  assert.equal(f.allocations[1]?.intent, 'stop');
  await f.adapter.reconcile();
  assert.equal(f.allocations[2]?.owner.id, 'task_b:0');
});

test('bootstrap carries only the managed enrollment and model key, with fixed profile and current identity', async (t) => {
  const f = await fixture(t);
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  const allocation = f.allocations[0]!;
  const first = await f.owner().bootstrap(allocation);
  assert.equal(await f.owner().bootstrap(allocation), first);
  assert.deepEqual(JSON.parse(first), {
    baseUrl: 'https://merv.example.test',
    projectId: f.caller.projectId,
    enrollmentToken: `me_${'a'.repeat(64)}`,
    modelApiKey: f.modelApiKey,
  });
  assert.equal(first.includes(f.sourceToken), false);
  assert.deepEqual(f.ensureInputs[0], {
    allocationId: allocation.id,
    epoch: 1,
    source: f.source,
    runtimeProfileId: 'image-profile',
    platform: hostedCodexPlatform,
    capabilities: ['code.v2'],
    expiresAt: allocation.deadlineAt,
  });
  const binding = {
    allocationId: allocation.id,
    epoch: 1,
    source: f.source,
    runtimeProfileId: 'image-profile',
    platform: hostedCodexPlatform,
    capabilities: ['code.v2'],
    expiresAt: allocation.deadlineAt,
  };
  assert.equal(await f.state.transaction((tx) => f.validator().current(binding, tx)), true);
  assert.equal(
    await f.state.transaction((tx) =>
      f.validator().current({ ...binding, runtimeProfileId: 'wrong' }, tx),
    ),
    false,
  );
  assert.equal(
    await f.state.transaction((tx) =>
      f
        .validator()
        .current({ ...binding, platform: { ...hostedCodexPlatform, model: 'wrong' } }, tx),
    ),
    false,
  );
  assert.equal(
    await f.state.transaction((tx) => f.validator().current({ ...binding, capabilities: [] }, tx)),
    false,
  );
  allocation.phase = 'released';
  assert.equal(await f.state.transaction((tx) => f.validator().current(binding, tx)), false);
  allocation.phase = 'queued';
  assert.equal(await f.state.transaction((tx) => f.validator().admits(allocation.id, 1, tx)), true);
});

test('owner waits for closed-session capture and gives an empty launched runner bounded grace', async (t) => {
  const f = await fixture(t);
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  const allocation = f.allocations[0]!;
  assert.equal(await f.owner().observe(allocation), 'starting');
  f.inspections.set(allocation.id, { runnerId: 'managed-machine', session: null });
  assert.equal(await f.owner().observe(allocation), 'running');
  f.inspections.set(allocation.id, {
    runnerId: 'managed-machine',
    session: {
      id: 'session_a',
      instanceId: 'task_a',
      expectedRevision: 0,
      status: 'released',
      closedAt: new Date().toISOString(),
      outcome: 'completed',
      releaseAcknowledged: false,
      capturePending: true,
    },
  });
  assert.equal(await f.owner().observe(allocation), 'running');
  f.inspections.get(allocation.id)!.session!.capturePending = false;
  assert.equal(await f.owner().observe(allocation), 'running');
  f.inspections.get(allocation.id)!.session!.releaseAcknowledged = true;
  assert.equal(await f.owner().observe(allocation), 'finished');
  f.inspections.set(allocation.id, { runnerId: 'managed-machine', session: null });
  f.demand([]);
  f.advance(30_001);
  assert.equal(await f.owner().observe(allocation), 'finished');
});

test('real Fleet and Sessions run one managed assignment through provider stop', async (t) => {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const secretEnv = `MERV_WORKFLOW_HMAC_${randomUUID().replaceAll('-', '')}`;
  const sourceEnv = `MERV_WORKFLOW_ACTOR_${randomUUID().replaceAll('-', '')}`;
  const modelEnv = `MERV_WORKFLOW_KEY_${randomUUID().replaceAll('-', '')}`;
  process.env[secretEnv] = randomBytes(48).toString('hex');
  process.env[modelEnv] = 'test-model-key';
  const boot = await scope.bootstrap({ projectName: 'Real workflow bridge', actorName: 'Owner' });
  process.env[sourceEnv] = boot.token;
  const caller: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const policy: WorkflowPolicy = {
    successStates: ['done'],
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
          label: 'Hosted work',
          brief: 'Finish.',
          references: [],
          handoff: { instruction: 'Finish.', tools: ['finish'] },
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
          role: () => 'producer',
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const workflow = await workflows.register(
    {
      name: 'hosted-bridge',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    policy,
  );
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      managedSecretEnv: secretEnv,
      sweepIntervalMs: 60_000,
    }),
  );
  let providerStopped = false;
  let bootstrapBytes: string | null = null;
  const runtimeHandle = {
    sandboxId: 'sbx_workflow',
    state: 'ready' as const,
    ready: true,
    deleted: false,
    leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revision: 1,
    launch: null as any,
  };
  const runtimes: SandboxRuntimes = {
    profileId: 'real-fixed-profile',
    async provision() {
      return structuredClone(runtimeHandle);
    },
    async inspect() {
      return structuredClone(runtimeHandle);
    },
    async launch(_projectId, _handle, _key, bootstrap) {
      bootstrapBytes = bootstrap;
      runtimeHandle.launch = {
        sandboxId: runtimeHandle.sandboxId,
        launchId: 'launch_workflow',
        operationKey: 'launch-key',
        releaseId: 'release_workflow',
        jobId: 'job_workflow',
        state: 'pending',
        deliveryState: 'launched',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      runtimeHandle.revision++;
      return structuredClone(runtimeHandle);
    },
    async stop() {
      providerStopped = true;
      Object.assign(runtimeHandle, {
        state: 'stopped',
        ready: false,
        deleted: true,
        revision: runtimeHandle.revision + 1,
      });
      return structuredClone(runtimeHandle);
    },
    async renew() {
      return structuredClone(runtimeHandle);
    },
  };
  const fleet = await createService(
    new FleetService(state, scope, runtimes, { enabled: true, pollIntervalMs: 60_000 }),
  );
  const adapter = new FleetWorkflowAdapter(fleet, sessions, scope, {
    enabled: true,
    projectId: boot.project.id,
    sourceCredentialEnv: sourceEnv,
    modelApiKeyEnv: modelEnv,
    baseUrl: 'https://merv.example.test',
    pollIntervalMs: 60_000,
  });
  t.after(async () => {
    await adapter.close();
    await fleet.close();
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
    delete process.env[secretEnv];
    delete process.env[sourceEnv];
    delete process.env[modelEnv];
  });
  await sessions.setDispatch(caller, { enabled: true });
  const target = await workflow.start(caller, {
    workflow: 'hosted-bridge',
    requestId: 'hosted-target',
  });
  await adapter.start();
  const allocations = await fleet.list(caller);
  assert.equal(allocations.length, 1);
  const allocation = allocations[0]!;
  assert.deepEqual(allocation.owner, { kind: 'workflow', id: `${target.id}:0` });
  await fleet.tick(); // Reserve and provision.
  await fleet.tick(); // Inspect the ready runtime and launch with stable enrollment.
  const launchedBootstrap = String(bootstrapBytes);
  assert.notEqual(launchedBootstrap, 'null');
  const bootstrap = JSON.parse(launchedBootstrap);
  assert.match(bootstrap.enrollmentToken, /^me_[0-9a-f]{64}$/);
  assert.equal(bootstrap.modelApiKey, 'test-model-key');
  assert.equal(launchedBootstrap.includes(boot.token), false);
  assert.deepEqual(await sessions.inspectManaged(allocation.id, allocation.epoch), {
    runnerId: null,
    session: null,
  });
  const enrolled = await sessions.enrollManaged(bootstrap.enrollmentToken, {});
  const managed = await sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocation.id}`;
  await sessions.heartbeatRunner(managed, {
    runnerId,
    machine: { hostname: 'hosted', system: 'Linux', architecture: 'x64' },
    platforms: [hostedCodexPlatform],
    capabilities: [...hostedCodexCapabilities],
    capacity: 1,
  });
  const leased = await sessions.lease(managed, {
    runnerId,
    requestId: 'claim-hosted',
    secret: `ms_${randomBytes(32).toString('base64url')}`,
    platform: {
      name: hostedCodexPlatform.name,
      harness: 'codex',
      model: hostedCodexPlatform.model,
    },
  });
  assert.ok(leased.session, leased.reason);
  assert.equal(leased.session.instanceId, target.id);
  await sessions.release(managed, { sessionId: leased.session.id, runnerId });
  assert.equal(
    (await sessions.inspectManaged(allocation.id, 1))?.session?.releaseAcknowledged,
    true,
  );
  await fleet.tick(); // Observe the completed owner and stop its runtime.
  assert.equal(providerStopped, true);
  assert.equal((await fleet.inspect(caller, allocation.id)).phase, 'released');
});
