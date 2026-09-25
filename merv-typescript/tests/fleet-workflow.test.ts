import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createService,
  digest,
  MervError,
  sourceCaller,
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
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import type { SandboxRuntimes, SandboxRuntimeHandle } from '@merv/sandboxes';
import type { Fleet, FleetAllocation, FleetOwner } from '@merv/fleet/types';
import type {
  Sessions,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from '@merv/sessions/types';
import {
  FleetWorkflowAdapter,
  type FleetWorkflowConfig,
  hostedCodexCapabilities,
  hostedCodexPlatform,
} from '../packages/fleet/src/workflow.js';
import { openState } from './fixtures/state.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';

const enrollmentExpiresAt = '2026-09-22T00:15:00.000Z';
const issuer = 'https://identity.example/auth/v1';
type Target = { instanceId: string; expectedRevision: number };
const targets = (prefix: string, count: number): Target[] =>
  Array.from({ length: count }, (_, i) => ({ instanceId: `${prefix}_${i}`, expectedRevision: 0 }));

async function fixture(t: TestContext, config: FleetWorkflowConfig = {}) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const founder = await login('founder');
  /** What Sessions serves: each project whose admin chose Fleet, as that admin. */
  const served: { projectId: string; source: DelegationSource }[] = [];
  const project = async (person = founder, name = 'Fleet workflow') => {
    const { id } = await scope.createProject(person, { name, requestId: randomUUID() });
    const caller = await scope.caller(person, id);
    const source = await scope.delegationSource(caller);
    served.push({ projectId: id, source });
    return { id, caller, source };
  };
  const main = await project();
  const modelEnv = `MERV_WORKFLOW_MODEL_${randomUUID().replaceAll('-', '')}`;
  process.env[modelEnv] = `sk-test-${randomBytes(32).toString('hex')}`;
  let now = Date.parse('2026-09-22T00:00:00Z');
  let owner: FleetOwner | undefined, validator: ManagedRunnerValidator | undefined;
  const demands = new Map<string, Target[] | Error>();
  const refused = new Set<string>();
  const requests: string[] = [];
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
      caller: Caller,
      input: { requestId: string; owner: { kind: string; id: string } },
    ) {
      requests.push(caller.projectId);
      if (refused.has(caller.projectId))
        throw new MervError('sandbox_not_connected', 'Hosted agents are not set up', 403);
      const source = await scope.delegationSource(caller);
      const prior = allocations.find(
        (a) =>
          a.projectId === caller.projectId &&
          digest(a.source) === digest(source) &&
          a.requestId === input.requestId,
      );
      if (prior) return prior;
      const a: FleetAllocation = {
        id: `flt_${allocations.length + 1}`,
        projectId: caller.projectId,
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
    async inspectOwned(_owner: FleetOwner, id: string) {
      const a = allocations.find((item) => item.id === id);
      assert.ok(a);
      return a;
    },
    async listOwned(_owner: FleetOwner, wanted: string[]) {
      return allocations.filter((a) => a.phase !== 'released' || wanted.includes(a.owner.id));
    },
    async cancelOwned(_owner: FleetOwner, id: string) {
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
    async servedSources() {
      return structuredClone(served);
    },
    async dispatchDemand(caller: Caller, input: unknown) {
      assert.deepEqual(input, {
        platform: hostedCodexPlatform,
        capabilities: [...hostedCodexCapabilities],
      });
      await scope.require(caller, 'read');
      const demand =
        demands.get(caller.service ? `review:${caller.projectId}` : caller.projectId) ?? [];
      if (demand instanceof Error) throw demand;
      return { candidates: demand };
    },
  } as unknown as Sessions;
  const makeAdapter = (extra: FleetWorkflowConfig) =>
    new FleetWorkflowAdapter(
      fakeFleet,
      fakeSessions,
      scope,
      {
        enabled: true,
        people: [`${issuer} founder`],
        modelApiKeyEnv: modelEnv,
        baseUrl: 'https://merv.example.test',
        maxAgents: 1,
        pollIntervalMs: 60_000,
        ...extra,
      },
      () => now,
    );
  let adapter = makeAdapter(config);
  await adapter.start();
  t.after(async () => {
    await adapter.close();
    await state.close();
    delete process.env[modelEnv];
  });
  return {
    state,
    scope,
    founder,
    login,
    project,
    served,
    source: main.source,
    caller: main.caller,
    get adapter() {
      return adapter;
    },
    restart: async (extra = config) => {
      await adapter.close();
      adapter = makeAdapter(extra);
      await adapter.start();
    },
    allocations,
    open: () =>
      allocations.filter((a) => a.phase !== 'released').map((a) => [a.projectId, a.owner.id]),
    inspections,
    ensureInputs,
    owner: () => owner!,
    validator: () => validator!,
    serves: (projectId: string) => validator!.serves!(projectId),
    demand: (value: Target[] | Error, projectId = main.id) => {
      demands.set(projectId, value);
    },
    refuse: (projectId: string) => refused.add(projectId),
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    modelEnv,
    modelApiKey: process.env[modelEnv]!,
  };
}

test('workflow adapter covers demand with one pending slot and retries a claimed generation', async (t) => {
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
  f.allocations[0]!.createAttempted = true;
  f.inspections.set(f.allocations[0]!.id, {
    runnerId: 'managed-machine',
    enrollmentExpiresAt,
    session: {
      id: 'session_a',
      instanceId: 'task_a',
      expectedRevision: 2,
      status: 'released',
      closedAt: new Date().toISOString(),
      outcome: 'completed',
      releaseAcknowledged: true,
      capturePending: false,
    },
  });
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2);
  assert.equal(f.allocations[1]?.owner.id, 'task_a:2');
  assert.notEqual(f.allocations[0]?.requestId, f.allocations[1]?.requestId);
  // A create whose reply was lost has launched nothing, so an unwanted one is cancelled too.
  f.allocations[1]!.phase = 'uncertain';
  f.allocations[1]!.createAttempted = true;
  f.demand([{ instanceId: 'task_b', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  assert.equal(f.allocations[1]?.intent, 'stop');
  await f.adapter.reconcile();
  assert.equal(f.allocations[2]?.owner.id, 'task_b:0');
});

test('workflow bounds created but unclaimed retries across restart without blocking new revisions', async (t) => {
  const f = await fixture(t);
  f.demand([{ instanceId: 'task_a', expectedRevision: 2 }]);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 1);
  // Cancellation before any provider create does not spend a retry.
  f.allocations[0]!.phase = 'released';
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2);

  const first = f.allocations[1]!;
  first.createAttempted = true;
  first.phase = 'released';
  first.updatedAt = new Date(Date.parse(first.createdAt)).toISOString();
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2, 'a failed create cannot rent again immediately');
  f.advance(60_000);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 3, 'one cooled-down retry is allowed');

  const second = f.allocations[2]!;
  second.createAttempted = true;
  second.phase = 'released';
  second.updatedAt = new Date(Date.parse(second.createdAt)).toISOString();
  f.advance(60_000);
  await f.restart();
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 3, 'two unclaimed attempts exhaust this task revision');

  f.demand([{ instanceId: 'task_a', expectedRevision: 3 }]);
  await f.adapter.reconcile();
  assert.equal(f.allocations[3]?.owner.id, 'task_a:3');
  f.allocations[3]!.phase = 'released';
  f.demand([{ instanceId: 'task_b', expectedRevision: 2 }]);
  await f.adapter.reconcile();
  assert.equal(f.allocations[4]?.owner.id, 'task_b:2');
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

test('owner waits for closed-session capture and retires a runner that never claims', async (t) => {
  const f = await fixture(t);
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  const allocation = f.allocations[0]!;
  assert.equal(await f.owner().observe(allocation), 'starting');
  f.inspections.set(allocation.id, {
    runnerId: 'managed-machine',
    enrollmentExpiresAt,
    session: null,
  });
  assert.equal(await f.owner().observe(allocation), 'running');
  f.inspections.set(allocation.id, {
    runnerId: 'managed-machine',
    enrollmentExpiresAt,
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
  f.inspections.set(allocation.id, {
    runnerId: 'managed-machine',
    enrollmentExpiresAt,
    session: null,
  });
  f.demand([]);
  f.advance(30_001);
  assert.equal(await f.owner().observe(allocation), 'finished');
  // Demand returns, but a one-assignment runner that has not claimed by now never will.
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  assert.equal(await f.owner().observe(allocation), 'running');
  f.advance(900_000 - 30_001);
  assert.equal(await f.owner().observe(allocation), 'finished');
});

test('a missing model key serves nothing, and the adapter still starts', async (t) => {
  const f = await fixture(t);
  delete process.env[f.modelEnv];
  await f.restart();
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await assert.rejects(f.adapter.reconcile(), { code: 'fleet_workflow_secret' });
  assert.deepEqual([f.allocations.length, f.serves(f.caller.projectId)], [0, false]);
  process.env[f.modelEnv] = f.modelApiKey;
  await f.adapter.reconcile();
  assert.deepEqual([f.allocations.length, f.serves(f.caller.projectId)], [1, true]);
});

test('a new director lets in-flight work finish under its own source, and directs what follows', async (t) => {
  const f = await fixture(t, { people: [`${issuer} founder`, `${issuer} colleague`] });
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  const allocation = f.allocations[0]!;
  allocation.phase = 'running';
  const binding = {
    allocationId: allocation.id,
    epoch: 1,
    source: f.source,
    runtimeProfileId: 'image-profile',
    platform: hostedCodexPlatform,
    capabilities: ['code.v2'],
    expiresAt: allocation.deadlineAt,
  };
  // Another admin chooses Fleet here, and becomes the director.
  await f.scope.addMember(f.founder, f.caller.projectId, {
    subject: 'colleague',
    role: 'operator',
  });
  const colleague = await f.scope.caller(await f.login('colleague'), f.caller.projectId);
  f.served[0]!.source = await f.scope.delegationSource(colleague);
  await f.restart();
  assert.equal(await f.state.transaction((tx) => f.owner().valid(allocation, tx)), true);
  assert.equal(await f.state.transaction((tx) => f.validator().current(binding, tx)), true);
  assert.equal(f.allocations.length, 1, 'the in-flight allocation still covers its target');
  allocation.phase = 'released';
  await f.adapter.reconcile();
  assert.deepEqual(f.allocations[1]?.source, f.served[0]!.source);
});

test('Fleet serves each project whose admin chose it, as that admin, within the total and per-person caps', async (t) => {
  const f = await fixture(t, {
    people: [`${issuer} founder`, `${issuer} colleague`],
    maxAgents: 5,
    maxAgentsPerPerson: 3,
  });
  const second = await f.project(f.founder, 'Second');
  const theirs = await f.project(await f.login('colleague'), 'Colleague');
  const outsider = await f.project(await f.login('stranger'), 'Stranger');
  // A machine actor is no sign-in identity: it is served only when everyone is.
  const machine = await f.scope.bootstrap({ projectName: 'Machine', actorName: 'Machine' });
  f.served.push({
    projectId: machine.project.id,
    source: await f.scope.delegationSource({
      actorId: machine.actor.id,
      projectId: machine.project.id,
      credentialId: machine.credential.id,
    }),
  });
  f.demand(targets('first', 2));
  f.demand(targets('second', 2), second.id);
  f.demand(targets('theirs', 3), theirs.id);
  f.demand(targets('outsider', 1), outsider.id);
  f.demand(targets('machine', 1), machine.project.id);
  await f.adapter.reconcile();
  // The founder's two projects share three machines; the colleague has the other two of five.
  const first = f.caller.projectId;
  assert.deepEqual(f.open(), [
    [first, 'first_0:0'],
    [first, 'first_1:0'],
    [second.id, 'second_0:0'],
    [theirs.id, 'theirs_0:0'],
    [theirs.id, 'theirs_1:0'],
  ]);
  for (const a of f.allocations)
    assert.deepEqual(a.source, f.served.find((row) => row.projectId === a.projectId)!.source);
  assert.deepEqual([first, second.id, theirs.id, outsider.id, machine.project.id].map(f.serves), [
    true,
    true,
    true,
    false,
    false,
  ]);

  // Halted, the first project is no longer served: its launched machine runs on and still
  // counts, its unlaunched one is cancelled, and the room goes to the founder's other project.
  Object.assign(f.allocations[0]!, {
    phase: 'starting',
    runtime: { launch: { deliveryState: 'launched' } },
  });
  f.served.shift();
  await f.adapter.reconcile();
  assert.deepEqual(
    f.allocations.slice(0, 2).map((a) => [a.intent, a.phase]),
    [
      ['run', 'starting'],
      ['stop', 'released'],
    ],
  );
  await f.adapter.reconcile();
  assert.deepEqual(f.open(), [
    [first, 'first_0:0'],
    [second.id, 'second_0:0'],
    [theirs.id, 'theirs_0:0'],
    [theirs.id, 'theirs_1:0'],
    [second.id, 'second_1:0'],
  ]);

  await f.restart({ people: ['*'], maxAgents: 10, maxAgentsPerPerson: 3 });
  await f.adapter.reconcile();
  assert.deepEqual(f.open().slice(5), [
    [theirs.id, 'theirs_2:0'],
    [outsider.id, 'outsider_0:0'],
    [machine.project.id, 'machine_0:0'],
  ]);
  assert.deepEqual([outsider.id, machine.project.id].map(f.serves), [true, true]);
});

test('a director who can no longer write directs nothing, and a failing project leaves the others served', async (t) => {
  const f = await fixture(t, {
    people: [`${issuer} founder`, `${issuer} colleague`],
    maxAgents: 5,
  });
  await f.scope.addMember(f.founder, f.caller.projectId, {
    subject: 'colleague',
    role: 'operator',
  });
  const colleague = await f.scope.caller(await f.login('colleague'), f.caller.projectId);
  f.served[0]!.source = await f.scope.delegationSource(colleague);
  const failing = await f.project(f.founder, 'Failing');
  const unconnected = await f.project(f.founder, 'Unconnected');
  const healthy = await f.project(f.founder, 'Healthy');
  f.demand(targets('first', 1));
  f.demand(new Error('demand unavailable'), failing.id);
  f.demand(targets('unconnected', 2), unconnected.id);
  f.refuse(unconnected.id);
  f.demand(targets('healthy', 1), healthy.id);
  await f.adapter.reconcile();
  assert.deepEqual(f.open(), [
    [f.caller.projectId, 'first_0:0'],
    [healthy.id, 'healthy_0:0'],
  ]);
  assert.deepEqual([f.caller.projectId, failing.id, unconnected.id, healthy.id].map(f.serves), [
    true,
    false,
    false,
    true,
  ]);
  assert.equal(f.requests.filter((id) => id === unconnected.id).length, 1, 'refused once');
  await f.scope.changeMemberRole(f.founder, f.caller.projectId, {
    subject: 'colleague',
    role: 'reader',
  });
  await f.adapter.reconcile();
  assert.deepEqual([f.allocations[0]!.intent, f.allocations[0]!.phase], ['stop', 'released']);
  assert.equal(f.serves(f.caller.projectId), false);
});

test('the review director takes only what the admin’s own hand may not, within that admin’s machines', async (t) => {
  const f = await fixture(t, { maxAgents: 5, maxAgentsPerPerson: 2 });
  f.demand(targets('shared', 1));
  f.demand([...targets('shared', 1), ...targets('review', 3)], `review:${f.caller.projectId}`);
  await f.adapter.reconcile();
  await f.adapter.reconcile();
  assert.deepEqual(
    f.allocations.map((a) => [a.owner.id, a.source.kind]),
    [
      ['shared_0:0', 'human'],
      ['review_0:0', 'service'],
    ],
  );
});

/** Real Scope, Workflows, Sessions and Fleet; only the sandbox provider is a test double. */
async function hosted(t: TestContext, workers: number, lostLaunch = false) {
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const directory = mkdtempSync(join(tmpdir(), 'merv-fleet-workflow-'));
  const artifacts = await createService(
    new ArtifactStore(state, scope, new DiskBlobs(join(directory, 'blobs'))),
  );
  const reviews = await createService(new ReviewService(state, scope, artifacts));
  const context = await createService(new RecipeContextBuilder(state, scope, artifacts));
  const tasks = await createService(
    new TaskService(state, scope, artifacts, workflows, reviews, context),
  );
  const events = await createService(new DurableEvents(state));
  const secretEnv = `MERV_WORKFLOW_HMAC_${randomUUID().replaceAll('-', '')}`;
  const modelEnv = `MERV_WORKFLOW_KEY_${randomUUID().replaceAll('-', '')}`;
  process.env[secretEnv] = randomBytes(48).toString('hex');
  process.env[modelEnv] = 'test-model-key';
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({
      issuer,
      subject,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const founder = await login('founder');
  const project = async (name: string) =>
    await scope.caller(founder, (await scope.createProject(founder, { name, requestId: name })).id);
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
  let now = Date.now();
  let lostReply = false;
  const stopped = new Set<string>();
  const bootstraps = new Map<string, string>();
  const runtimeHandles = new Map<string, SandboxRuntimeHandle>();
  const creates = new Map<string, SandboxRuntimeHandle>();
  const launches = new Map<string, number>();
  const runtimes: SandboxRuntimes = {
    profiles: [{ key: 'standard', id: 'real-fixed-profile', leaseSeconds: 600 }],
    describe: async () => null,
    connected: () => true,
    async provision(_projectId, operationKey) {
      let handle = creates.get(operationKey);
      if (!handle) {
        handle = {
          sandboxId: `sbx_workflow_${creates.size + 1}`,
          state: 'ready',
          ready: true,
          deleted: false,
          leaseExpiresAt: new Date(now + 3_600_000).toISOString(),
          revision: 1,
          launch: null,
        };
        creates.set(operationKey, handle);
        runtimeHandles.set(handle.sandboxId, handle);
      }
      return structuredClone(handle);
    },
    async inspect(_projectId, handle) {
      return structuredClone(runtimeHandles.get(handle.sandboxId)!);
    },
    async launch(_projectId, handle, operationKey, bootstrap) {
      const runtimeHandle = runtimeHandles.get(handle.sandboxId)!;
      bootstraps.set(handle.sandboxId, bootstrap);
      launches.set(handle.sandboxId, (launches.get(handle.sandboxId) ?? 0) + 1);
      runtimeHandle.launch = {
        sandboxId: runtimeHandle.sandboxId,
        launchId: `launch_${handle.sandboxId}`,
        operationKey,
        releaseId: 'release_workflow',
        jobId: 'job_workflow',
        state: 'pending',
        deliveryState: 'launched',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      runtimeHandle.revision++;
      if (lostLaunch && !lostReply) {
        lostReply = true;
        throw new Error('injected lost provider launch response');
      }
      return structuredClone(runtimeHandle);
    },
    async acknowledge(_projectId, handle) {
      const runtimeHandle = runtimeHandles.get(handle.sandboxId)!;
      if (!runtimeHandle.launch || runtimeHandle.launch.deliveryState !== 'launched')
        throw new Error('runtime exchange requires a launched receipt');
      runtimeHandle.launch.state = 'consumed';
      return structuredClone(runtimeHandle);
    },
    async stop(_projectId, handle) {
      const runtimeHandle = runtimeHandles.get(handle.sandboxId)!;
      stopped.add(handle.sandboxId);
      Object.assign(runtimeHandle, {
        state: 'stopped',
        ready: false,
        deleted: true,
        revision: runtimeHandle.revision + 1,
      });
      return structuredClone(runtimeHandle);
    },
    async renew(_projectId, handle) {
      return structuredClone(runtimeHandles.get(handle.sandboxId)!);
    },
  };
  const fleet = await createService(
    new FleetService(
      state,
      scope,
      runtimes,
      { enabled: true, globalLimit: workers, projectLimit: workers, pollIntervalMs: 60_000 },
      () => now,
    ),
  );
  const adapter = new FleetWorkflowAdapter(fleet, sessions, scope, {
    enabled: true,
    people: [`${issuer} founder`, `${issuer} colleague`],
    modelApiKeyEnv: modelEnv,
    baseUrl: 'https://merv.example.test',
    pollIntervalMs: 60_000,
    maxAgents: workers,
    maxAgentsPerPerson: workers,
  });
  t.after(async () => {
    await adapter.close();
    await fleet.close();
    await sessions.close();
    await events.close();
    tasks.dispose();
    await workflows.close();
    await state.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env[secretEnv];
    delete process.env[modelEnv];
  });
  return {
    scope,
    founder,
    login,
    project,
    sessions,
    fleet,
    adapter,
    artifacts,
    reviews,
    tasks,
    start: (caller: Caller, requestId = randomUUID()) =>
      workflow.start(caller, { workflow: 'hosted-bridge', requestId }),
    stopped,
    bootstraps,
    creates,
    launches,
    lostReply: () => lostReply,
    advance: (ms: number) => (now += ms),
  };
}

const heartbeat = (runnerId: string) => ({
  runnerId,
  machine: { hostname: runnerId, system: 'Linux', architecture: 'x64' },
  platforms: [hostedCodexPlatform],
  capabilities: [...hostedCodexCapabilities],
  capacity: 1,
});
const claim = (runnerId: string) => ({
  runnerId,
  requestId: `claim-${runnerId}`,
  secret: `ms_${randomBytes(32).toString('base64url')}`,
  platform: {
    name: hostedCodexPlatform.name,
    harness: 'codex' as const,
    model: hostedCodexPlatform.model,
  },
});

/** Two projects whose founder chose Fleet; the first also has an external runner's work. */
async function managedFleetScenario(t: TestContext, workerCount: number) {
  const h = await hosted(t, workerCount, workerCount === 3);
  const { sessions, fleet, adapter } = h;
  const first = await h.project('Real workflow bridge');
  const second = await h.project('Second bridge');
  const issued = await h.scope.issueActor(first, { name: 'External', role: 'producer' });
  const caller: Caller = {
    actorId: issued.actor.id,
    projectId: first.projectId,
    credentialId: issued.credential.id,
  };
  await sessions.setDispatch(first, { enabled: true });
  await sessions.setDispatch(second, { enabled: true });
  const targets = [
    ...(await Promise.all(Array.from({ length: workerCount }, () => h.start(first)))),
    await h.start(second),
  ];
  // An ordinary runner claims through the existing path before Fleet reads demand.
  await sessions.heartbeatRunner(caller, heartbeat('external'));
  const externalClaim = claim('external');
  const external = await sessions.lease(caller, externalClaim);
  assert.ok(external.session, external.reason);
  await sessions.authenticate(externalClaim.secret);
  await adapter.start();
  const open = () => fleet.listOwned(adapter, []);
  const allocations = await open();
  assert.equal(allocations.length, workerCount);
  const remaining = targets.filter((target) => target.id !== external.session!.instanceId);
  assert.deepEqual(
    new Set(allocations.map((a) => a.owner.id)),
    new Set(remaining.map((target) => `${target.id}:0`)),
  );
  // Each machine acts as the founder in the project it works for.
  for (const a of allocations)
    assert.deepEqual(
      [a.source.kind, a.source.projectId, 'subject' in a.source && a.source.subject],
      ['human', a.projectId, 'founder'],
    );
  await fleet.tick(); // Reserve and provision.
  await fleet.tick(); // Inspect the ready runtime and launch with stable enrollment.
  if (workerCount === 3) {
    assert.equal(h.lostReply(), true);
    assert.equal((await open()).filter((a) => a.phase === 'uncertain').length, 1);
    h.advance(3000);
    await fleet.tick(); // Recover the same launched runtime after the response loss.
  }
  assert.equal(h.creates.size, workerCount);
  assert.equal(h.bootstraps.size, workerCount);
  assert.deepEqual([...h.launches.values()], Array(workerCount).fill(1));
  const workers = await Promise.all(
    allocations.map(async (allocation) => {
      const current = await fleet.inspectOwned(adapter, allocation.id);
      const bootstrap = JSON.parse(h.bootstraps.get(current.runtime!.sandboxId)!);
      assert.match(bootstrap.enrollmentToken, /^me_[0-9a-f]{64}$/);
      assert.deepEqual(
        [bootstrap.projectId, bootstrap.modelApiKey],
        [allocation.projectId, 'test-model-key'],
      );
      const unclaimed = await sessions.inspectManaged(allocation.id, allocation.epoch);
      assert.equal(unclaimed?.runnerId, null);
      assert.equal(unclaimed?.session, null);
      const enrolled = await sessions.enrollManaged(bootstrap.enrollmentToken, {
        workerNonce: randomBytes(32).toString('hex'),
      });
      const managed = await sessions.authenticateManaged(enrolled.controlToken);
      const runnerId = `managed-${allocation.id}`;
      await sessions.heartbeatRunner(managed, heartbeat(runnerId));
      const managedClaim = claim(runnerId);
      const leased = await sessions.lease(managed, managedClaim);
      assert.ok(leased.session, leased.reason);
      await sessions.authenticate(managedClaim.secret);
      return { allocation, managed, runnerId, session: leased.session };
    }),
  );
  assert.deepEqual(
    new Set(workers.map((worker) => worker.session.instanceId)),
    new Set(remaining.map((target) => target.id)),
  );
  await adapter.reconcile();
  assert.equal((await open()).length, workerCount);
  await Promise.all(
    workers.map(async ({ allocation, managed, runnerId, session }) => {
      await sessions.release(managed, { sessionId: session.id, runnerId });
      assert.equal(
        (await sessions.inspectManaged(allocation.id, 1))?.session?.releaseAcknowledged,
        true,
      );
    }),
  );
  await fleet.tick(); // Observe the completed owner and stop its runtime.
  assert.equal(h.stopped.size, workerCount);
  assert.deepEqual(await open(), []);
  const stillExternal = await sessions.heartbeat(caller, {
    sessionId: external.session.id,
    runnerId: 'external',
  });
  assert.equal(stillExternal.id, external.session.id);
  await sessions.release(caller, { sessionId: external.session.id, runnerId: 'external' });
}

for (const workerCount of [1, 3]) {
  test(`real Fleet runs ${workerCount} managed assignments in two projects alongside an external runner`, (t) =>
    managedFleetScenario(t, workerCount));
}

test('real Fleet stops the machine of a director who may no longer write, and the stuck report says so', async (t) => {
  const h = await hosted(t, 1);
  const founder = await h.project('Demoted');
  await h.scope.addMember(h.founder, founder.projectId, { subject: 'colleague', role: 'operator' });
  const colleague = await h.scope.caller(await h.login('colleague'), founder.projectId);
  await h.sessions.setDispatch(colleague, { enabled: true });
  await h.start(founder);
  await h.adapter.start();
  const [allocation] = await h.fleet.listOwned(h.adapter, []);
  assert.equal(
    allocation && 'subject' in allocation.source && allocation.source.subject,
    'colleague',
  );
  await h.fleet.tick(); // Reserve and provision.
  await h.fleet.tick(); // Launch.
  const kinds = async () => (await h.sessions.stuck(founder)).items.map((item) => item.kind);
  assert.deepEqual(await kinds(), [], 'Fleet serves the work, so no runner is missing');
  await h.scope.changeMemberRole(h.founder, founder.projectId, {
    subject: 'colleague',
    role: 'reader',
  });
  await h.fleet.tick();
  assert.equal(h.stopped.size, 1);
  await h.adapter.reconcile();
  assert.deepEqual(await kinds(), ['no_live_runner']);
});

test('a target that returns after more than 200 released allocations gets a new machine', async (t) => {
  const h = await hosted(t, 1);
  const caller = await h.project('History');
  const target = await h.start(caller);
  await h.adapter.start();
  const owner = { kind: 'workflow', id: `${target.id}:0` };
  const requestId = (generation: number) => `wf:${digest({ id: owner.id, generation })}`;
  for (let generation = 0; generation <= 200; generation++)
    await h.fleet.cancelOwned(
      h.adapter,
      (await h.fleet.request(caller, { requestId: requestId(generation), owner })).id,
    );
  await h.sessions.setDispatch(caller, { enabled: true });
  await h.adapter.reconcile();
  assert.deepEqual(
    (await h.fleet.listOwned(h.adapter, [])).map((a) => a.requestId),
    [requestId(201)],
  );
});

type Hosted = Awaited<ReturnType<typeof hosted>>;
/** A task someone delivered at the desk, awaiting its review. */
async function delivered(h: Hosted, by: Caller, requestId: string) {
  const task = await h.tasks.create(by, {
    title: requestId,
    goal: 'Verify addition.',
    checks: ['Two plus three equals five.'],
    requestId,
  });
  const proof = await h.artifacts.create(by, { title: 'Proof', content: 'Observed 2 + 3 = 5.' });
  return await h.tasks.submitDelivery(
    by,
    confirmedDelivery({
      taskId: task.id,
      expectedRevision: task.workflow.revision,
      artifactIds: [proof.id],
      requestId: `${requestId}-delivery`,
    }),
  );
}
/** The hosted runner on a launched allocation's machine enrolls, registers and leases once. */
async function boot(h: Hosted, allocation: FleetAllocation) {
  const current = await h.fleet.inspectOwned(h.adapter, allocation.id);
  const { enrollmentToken } = JSON.parse(h.bootstraps.get(current.runtime!.sandboxId)!);
  const enrolled = await h.sessions.enrollManaged(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const managed = await h.sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocation.id}`;
  await h.sessions.heartbeatRunner(managed, heartbeat(runnerId));
  const request = claim(runnerId);
  const { session } = await h.sessions.lease(managed, request);
  assert.ok(session);
  return { runnerId, session, secret: request.secret };
}

test('Fleet’s review director reviews what the admin, or Pi as them, delivered at the desk, and produces nothing', async (t) => {
  const h = await hosted(t, 2);
  const caller = await h.project('Reviewed');
  await h.sessions.setDispatch(caller, { enabled: true });
  // Pi acts with exactly its person's source, so its delivery is the founder's own.
  const source = await h.scope.delegationSource(caller);
  h.scope.registerConversationAuthority({ require: async () => source });
  const pi: Caller = {
    ...caller,
    human: undefined,
    conversation: { id: 'conversation', epoch: 1, commandId: 'command', runtimeId: 'runtime' },
  };
  const review = await delivered(h, pi, 'pi');
  const producing = await h.tasks.create(caller, {
    title: 'Producing',
    goal: 'Add.',
    checks: ['It adds.'],
    requestId: 'producing',
  });
  await h.adapter.start();
  const allocations = await h.fleet.listOwned(h.adapter, []);
  const by = (kind: string) => allocations.find((a) => a.source.kind === kind)!;
  // The founder's hand takes the producing step; a fresh agent the founder vouches for reviews.
  assert.deepEqual(
    [by('human').owner.id, by('service').owner.id],
    [`${producing.id}:${producing.workflow.revision}`, `${review.id}:${review.workflow.revision}`],
  );
  assert.deepEqual(by('service').source, {
    actorId: by('service').source.actorId,
    projectId: caller.projectId,
    kind: 'service',
    vouchedBy: source,
  });
  await h.fleet.tick(); // Reserve and provision.
  await h.fleet.tick(); // Launch.
  const machine = await boot(h, by('service'));
  assert.deepEqual([machine.session.instanceId, machine.session.role], [review.id, 'reviewer']);
  const claimed = await h.reviews.get(caller, review.reviewId!);
  assert.deepEqual([claimed.status, claimed.reviewerId], ['started', machine.session.actorId]);
  // Even named, a producing step is not its to lease.
  await assert.rejects(
    h.sessions.offer(sourceCaller(by('service').source), {
      instanceId: producing.id,
      expectedRevision: producing.workflow.revision,
      runnerId: machine.runnerId,
      requestId: 'produce',
      secret: `ms_${randomBytes(32).toString('base64url')}`,
    }),
    { code: 'forbidden' },
  );
  // Nor does Fleet rent the workflow's machines to anyone who may not direct its work.
  const reader = await h.scope.issueActor(caller, { name: 'Reader', role: 'reader' });
  await assert.rejects(
    h.fleet.request(
      { projectId: caller.projectId, actorId: reader.actor.id, credentialId: reader.credential.id },
      { requestId: 'reader', owner: { kind: 'workflow', id: `${producing.id}:0` } },
    ),
    { code: 'fleet_owner_denied' },
  );
});

test('Fleet’s review director and its machine stop when the admin who vouched for it may no longer write', async (t) => {
  const h = await hosted(t, 1);
  const founder = await h.project('Vouched');
  await h.scope.addMember(h.founder, founder.projectId, { subject: 'colleague', role: 'operator' });
  const colleague = await h.scope.caller(await h.login('colleague'), founder.projectId);
  await h.sessions.setDispatch(colleague, { enabled: true });
  await delivered(h, colleague, 'colleague');
  await h.adapter.start();
  const [allocation] = await h.fleet.listOwned(h.adapter, []);
  assert.equal(allocation?.source.kind, 'service');
  await h.fleet.tick(); // Reserve and provision.
  await h.fleet.tick(); // Launch.
  const machine = await boot(h, allocation);
  await h.sessions.authenticate(machine.secret);
  await h.scope.changeMemberRole(h.founder, founder.projectId, {
    subject: 'colleague',
    role: 'reader',
  });
  // A demoted member no longer holds the membership the voucher named.
  await assert.rejects(h.scope.requireDelegation(allocation.source, 'review'), {
    code: 'membership_required',
  });
  // Its worker is refused, or its session already closed for that reason.
  await assert.rejects(h.sessions.authenticate(machine.secret), (error: MervError) =>
    /membership/.test(`${error.code} ${error.message}`),
  );
  await h.fleet.tick();
  assert.equal(h.stopped.size, 1);
});
