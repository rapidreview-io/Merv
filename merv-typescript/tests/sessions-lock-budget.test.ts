/**
 * How often Sessions takes the schema's writer lock, and how often it asks a domain whether a
 * lease still holds, per operation. A writer is any `state.transaction` call made outside a
 * read snapshot and outside another transaction; a failed attempt counts too. Durable events'
 * own deliveries run on the uncounted state, so the numbers are Sessions' alone.
 *
 * Each bound is the measured cost: an idle poll, an unchanged presence, a healthy sweep and a
 * worker's calls on a live session are answered from read snapshots and take no writer.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createService, type Caller, type State, type WorkflowPolicy } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { FleetService } from '@merv/fleet';
import type { SandboxRuntimes, SandboxRuntimeHandle } from '@merv/sandboxes';
import {
  FleetWorkflowAdapter,
  hostedCodexCapabilities,
  hostedCodexPlatform,
} from '../packages/fleet/src/workflow.js';
import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const request = () => randomBytes(10).toString('hex');

/** `state` with its writer transactions counted, and a WorkflowsService whose lease checks are. */
async function counted(t: TestContext, clock?: () => number) {
  const state = await openState();
  let writers = 0,
    checks = 0;
  const transaction: State['transaction'] = async (fn) => {
    if (!state.readScope && !state.ambient) writers++;
    return await state.transaction(fn);
  };
  const tracked = new Proxy(state, {
    get(target, key) {
      if (key === 'transaction') return transaction;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as State;
  const scope = await createService(new ProjectScope(tracked, clock));
  const workflows = await createService(new WorkflowsService(tracked, scope));
  const checkLease = workflows.checkLease.bind(workflows);
  workflows.checkLease = (async (...args: Parameters<typeof checkLease>) => {
    checks++;
    return await checkLease(...args);
  }) as typeof checkLease;
  const events = await createService(new DurableEvents(state));
  // Closed last in, first out: what is built on this state closes before it.
  const disposers: (() => unknown)[] = [
    () => state.close(),
    () => workflows.close(),
    () => events.close(),
  ];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose();
  });
  return {
    state,
    tracked,
    scope,
    workflows,
    events,
    disposers,
    /** The operation costs at most `ceiling`; earlier events are delivered first, uncounted. */
    async atMost(
      ceiling: { writers: number; checks: number },
      operation: () => Promise<unknown>,
      what: string,
    ) {
      await events.drain();
      writers = checks = 0;
      await operation();
      const cost = { writers, checks };
      assert.ok(
        cost.writers <= ceiling.writers && cost.checks <= ceiling.checks,
        `${what}: ${JSON.stringify(cost)} exceeds ${JSON.stringify(ceiling)}`,
      );
    },
  };
}

const lease: NonNullable<WorkflowPolicy['assignments']>[number]['lease'] = {
  role: () => 'producer',
  acquire: ({ leaseId }) => ({ leaseId }),
  check: () => {},
  release: () => {},
};
const finish = {
  name: 'finish',
  alternatives: [
    {
      instanceId: { kind: 'target' as const, field: 'instanceId' as const },
      expectedRevision: { kind: 'target' as const, field: 'revision' as const },
    },
  ],
};
const definition = (name: string) => ({
  name,
  version: 1,
  initial: 'working',
  states: ['working', 'done'],
  terminal: ['done'],
  edges: [{ from: 'working', action: 'finish', to: 'done' }],
});
const policy = (scope: ProjectScope): WorkflowPolicy => ({
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
        label: 'Work',
        brief: 'Finish.',
        references: [],
        handoff: { instruction: 'Finish', tools: ['finish'] },
        execution: { readOnly: false, tools: [] },
        context: null,
      }),
      execution: { readOnly: false, tools: [finish] },
      lease,
    },
  ],
});

/** A project whose producer's runner leases through Sessions. */
async function sourced(t: TestContext) {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const f = await counted(t, () => clock);
  const handle = await f.workflows.register(definition('budget'), policy(f.scope));
  const boot = await f.scope.bootstrap({ projectName: 'Budget', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await f.scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  const sessions = await createService(
    new LeasedSessions(f.tracked, f.scope, f.workflows, f.events, {
      clock: () => clock,
      sweepIntervalMs: 60_000,
    }),
  );
  f.disposers.push(() => sessions.close());
  const presence = {
    runnerId: 'machine',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [
      { name: 'codex', harness: 'codex' as const, model: 'm', enabled: true, parallelism: 2 },
    ],
    capacity: 2,
  };
  await sessions.heartbeatRunner(source, presence);
  await sessions.setDispatch(owner, { enabled: true });
  const auto = () => ({
    runnerId: 'machine',
    requestId: request(),
    secret: secret(),
    platform: { name: 'codex', harness: 'codex' as const, model: 'm' },
  });
  const poll = async () => await sessions.lease(source, auto());
  return {
    ...f,
    sessions,
    owner,
    source,
    presence,
    poll,
    /** A new target leased automatically; the worker's secret. */
    async leased() {
      await handle.start(source, { workflow: 'budget', requestId: request() });
      const input = auto();
      assert.ok((await sessions.lease(source, input)).session);
      return input.secret;
    },
    advance: (ms: number) => (clock += ms),
  };
}

test('a source runner’s idle poll, presence and sweep stay within their lock budget', async (t) => {
  const f = await sourced(t);
  assert.equal((await f.poll()).reason, 'no_candidates');
  f.advance(1000);
  // The same decision, 1 s after it was recorded; the offer's light pass finds nothing.
  await f.atMost(
    { writers: 0, checks: 0 },
    async () => assert.equal((await f.poll()).reason, 'no_candidates'),
    'an idle poll',
  );
  await f.atMost(
    { writers: 0, checks: 0 },
    () => f.sessions.heartbeatRunner(f.source, f.presence),
    'an unchanged presence',
  );
  await f.atMost(
    { writers: 1, checks: 0 },
    () =>
      f.sessions.heartbeatRunner(f.source, {
        ...f.presence,
        machine: { ...f.presence.machine, hostname: 'renamed' },
      }),
    'a changed presence',
  );
  f.advance(15_000);
  await f.atMost(
    { writers: 1, checks: 0 },
    async () => assert.equal((await f.poll()).reason, 'no_candidates'),
    'the same decision refreshed after 15 s',
  );
  for (let i = 0; i < 2; i++) await f.sessions.authenticate(await f.leased());
  // A healthy pass decides every subject on a snapshot and records nothing.
  await f.atMost(
    { writers: 0, checks: 0 },
    () => (f.sessions as unknown as { pass(full: boolean): Promise<void> }).pass(false),
    'a light pass over two live leases',
  );
  await f.atMost(
    { writers: 0, checks: 2 },
    () => f.sessions.sweep(),
    'a full pass over two live leases',
  );
});

test('a worker’s authentication, heartbeat and tool call stay within their lock budget', async (t) => {
  const f = await sourced(t);
  const token = await f.leased();
  const session = (await f.sessions.list(f.source))[0]!;
  let worker!: Caller;
  // An activation is decided on a snapshot and again in the writer that records it.
  await f.atMost(
    { writers: 1, checks: 2 },
    async () => (worker = await f.sessions.authenticate(token)),
    'activation',
  );
  await f.atMost(
    { writers: 0, checks: 1 },
    () => f.sessions.authenticate(token),
    'an active session',
  );
  f.advance(60_000);
  const control = { sessionId: session.id, runnerId: 'machine' };
  await f.atMost(
    { writers: 0, checks: 1 },
    () => f.sessions.heartbeat(f.source, control),
    'a heartbeat a minute later',
  );
  f.advance(900_000);
  await f.atMost(
    { writers: 1, checks: 2 },
    () => f.sessions.heartbeat(f.source, control),
    'a heartbeat that slides the window 15 minutes',
  );
  const input = { instanceId: session.instanceId, expectedRevision: 0 };
  await f.atMost(
    { writers: 2, checks: 6 },
    async () => {
      const invocation = await f.sessions.prepare(worker, 'finish', input);
      await f.sessions.validate(invocation.caller, 'finish', input);
      await f.sessions.run(invocation, () => undefined);
    },
    'a tool call: prepare, the registry’s validate and run',
  );
  await f.sessions.release(f.source, control);
  await f.atMost(
    { writers: 0, checks: 0 },
    () => assert.rejects(f.sessions.authenticate(token), { status: 401 }),
    'a closed session',
  );
});

/** Real Fleet renting one machine for a project, whose hosted runner has enrolled. */
async function rented(t: TestContext) {
  const f = await counted(t);
  const secretEnv = `MERV_BUDGET_HMAC_${randomUUID().replaceAll('-', '')}`;
  const modelEnv = `MERV_BUDGET_KEY_${randomUUID().replaceAll('-', '')}`;
  process.env[secretEnv] = randomBytes(48).toString('hex');
  process.env[modelEnv] = 'test-model-key';
  const issuer = 'https://identity.example/auth/v1';
  const founder = await f.scope.acceptVerifiedIdentity({
    issuer,
    subject: 'founder',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const caller = await f.scope.caller(
    founder,
    (await f.scope.createProject(founder, { name: 'Rented', requestId: 'rented' })).id,
  );
  const handle = await f.workflows.register(definition('hosted'), policy(f.scope));
  const sessions = await createService(
    new LeasedSessions(f.tracked, f.scope, f.workflows, f.events, {
      managedSecretEnv: secretEnv,
      sweepIntervalMs: 60_000,
    }),
  );
  const bootstraps = new Map<string, string>();
  const handles = new Map<string, SandboxRuntimeHandle>();
  const runtimes: SandboxRuntimes = {
    profiles: [{ key: 'standard', id: 'budget-profile', leaseSeconds: 600 }],
    describe: async () => null,
    connected: () => true,
    async provision(_projectId, operationKey) {
      const handle = handles.get(operationKey) ?? {
        sandboxId: `sbx_${handles.size + 1}`,
        state: 'ready' as const,
        ready: true,
        deleted: false,
        leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        revision: 1,
        launch: null,
      };
      handles.set(operationKey, handle);
      return structuredClone(handle);
    },
    async inspect(_projectId, { sandboxId }) {
      return structuredClone([...handles.values()].find((h) => h.sandboxId === sandboxId)!);
    },
    async launch(_projectId, { sandboxId }, operationKey, bootstrap) {
      const handle = [...handles.values()].find((h) => h.sandboxId === sandboxId)!;
      bootstraps.set(sandboxId, bootstrap);
      handle.launch = {
        sandboxId,
        launchId: `launch_${sandboxId}`,
        operationKey,
        releaseId: 'release_budget',
        jobId: 'job_budget',
        state: 'pending',
        deliveryState: 'launched',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      handle.revision++;
      return structuredClone(handle);
    },
    async acknowledge(_projectId, { sandboxId }) {
      const handle = [...handles.values()].find((h) => h.sandboxId === sandboxId)!;
      handle.launch!.state = 'consumed';
      return structuredClone(handle);
    },
    async stop(_projectId, { sandboxId }) {
      const handle = [...handles.values()].find((h) => h.sandboxId === sandboxId)!;
      Object.assign(handle, { state: 'stopped', ready: false, deleted: true });
      return structuredClone(handle);
    },
    async renew(_projectId, { sandboxId }) {
      return structuredClone([...handles.values()].find((h) => h.sandboxId === sandboxId)!);
    },
  };
  // Fleet's own passes are its cost, not Sessions': it runs on the uncounted state.
  const fleet = await createService(
    new FleetService(f.state, f.scope, runtimes, {
      enabled: true,
      globalLimit: 1,
      projectLimit: 1,
      pollIntervalMs: 60_000,
    }),
  );
  const adapter = new FleetWorkflowAdapter(
    fleet,
    sessions,
    f.scope,
    {
      enabled: true,
      people: [`${issuer} founder`],
      modelApiKeyEnv: modelEnv,
      baseUrl: 'https://merv.example.test',
      pollIntervalMs: 60_000,
      maxAgents: 1,
    },
    Date.now,
    f.state,
  );
  f.disposers.push(
    () => {
      delete process.env[secretEnv];
      delete process.env[modelEnv];
    },
    () => sessions.close(),
    () => fleet.close(),
    () => adapter.close(),
  );
  await sessions.setDispatch(caller, { enabled: true });
  const target = await handle.start(caller, { workflow: 'hosted', requestId: request() });
  await adapter.start();
  const [allocation] = await fleet.listOwned(adapter, []);
  assert.ok(allocation);
  await fleet.tick(); // Reserve and provision.
  await fleet.tick(); // Launch.
  const current = await fleet.inspectOwned(adapter, allocation.id);
  const { enrollmentToken } = JSON.parse(bootstraps.get(current.runtime!.sandboxId)!);
  const enrolled = await sessions.enrollManaged(enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const managed = await sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocation.id}`;
  const beat = async (hostname = runnerId) =>
    await sessions.heartbeatRunner(managed, {
      runnerId,
      machine: { hostname, system: 'Linux', architecture: 'x64' },
      platforms: [hostedCodexPlatform],
      capabilities: [...hostedCodexCapabilities],
      capacity: 1,
    });
  await beat();
  return {
    ...f,
    sessions,
    caller,
    target,
    handle,
    beat,
    poll: async () =>
      await sessions.lease(managed, {
        runnerId,
        requestId: request(),
        secret: secret(),
        platform: {
          name: hostedCodexPlatform.name,
          harness: 'codex' as const,
          model: hostedCodexPlatform.model,
        },
      }),
  };
}

test('a rented machine’s idle poll and presence stay within their lock budget', async (t) => {
  const f = await rented(t);
  // Its work was done another way, so the machine finds none.
  await f.handle.transition(f.caller, {
    instanceId: f.target.id,
    expectedRevision: f.target.revision,
    action: 'finish',
    requestId: request(),
  });
  assert.equal((await f.poll()).reason, 'no_candidates');
  // The managed pre-read and the lease, both on snapshots: the decision is the same.
  await f.atMost(
    { writers: 0, checks: 0 },
    async () => assert.equal((await f.poll()).reason, 'no_candidates'),
    'an idle managed poll',
  );
  // A changed presence runs again in a writer, which checks the machine's binding again too.
  const bindings = (
    f.sessions as unknown as { managed: { heartbeat(...args: unknown[]): Promise<unknown> } }
  ).managed;
  const checked: boolean[] = [];
  const heartbeat = bindings.heartbeat.bind(bindings);
  t.mock.method(bindings, 'heartbeat', async (...args: unknown[]) => {
    checked.push(!f.state.readScope);
    return await heartbeat(...args);
  });
  await f.atMost({ writers: 1, checks: 0 }, () => f.beat('renamed'), 'a changed managed presence');
  assert.deepEqual(checked, [false, true], 'on the snapshot, then in the writer');
});
