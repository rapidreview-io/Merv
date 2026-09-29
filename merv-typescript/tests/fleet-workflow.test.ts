import test, { type TestContext } from 'node:test';
import { Context } from 'cordis';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { sessionsToolsPlugin } from '@merv/sessions/tools';
import { FleetService } from '@merv/fleet';
import { ArtifactStore } from '@merv/artifacts';
import { DiskBlobs } from '@merv/blobs';
import { RecipeContextBuilder } from '@merv/context-builder';
import { ReviewService } from '@merv/reviews';
import { TaskService } from '@merv/tasks';
import type { SandboxRuntimes, SandboxRuntimeHandle } from '@merv/sandboxes';
import type { Fleet, FleetAllocation, FleetOwner, ModelRelayConfig } from '@merv/fleet/types';
import type {
  Sessions,
  ManagedModelGrant,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from '@merv/sessions/types';
import { ModelRelay } from '../packages/fleet/src/model-relay.js';
import {
  fleetWorkflowPlugin,
  FleetWorkflowAdapter,
  type FleetWorkflowConfig,
  hostedCodexCapabilities,
  hostedCodexPlatform,
} from '../packages/fleet/src/workflow.js';
import {
  codexModelRelay,
  modelBudgetStatus,
  setDailyTokens,
} from '../packages/fleet/src/codex-relay.js';
import { ToolRegistry } from '../packages/api/src/registry.js';
import { NisaService } from '../packages/nisa/src/index.js';
import { nisaTools } from '../packages/nisa/src/tools.js';
import type { NisaPaperList } from '../packages/nisa/src/types.js';
import { buildLaunch, validateProfile } from '../packages/runner/src/profiles.js';
import { WebService } from '../packages/web/src/index.js';
import { webTools } from '../packages/web/src/tools.js';
import type { WebSearch } from '../packages/web/src/types.js';
import { openState } from './fixtures/state.js';
import { confirmedDelivery } from './fixtures/task-evidence.js';
import { keyEnv, provider, tavilyResults } from './fixtures/web.js';

const enrollmentExpiresAt = '2026-09-22T00:15:00.000Z';
const issuer = 'https://identity.example/auth/v1';
type Target = { instanceId: string; expectedRevision: number };
/** A machine was created for it, whether or not it ever launched. */
const machine = { sandboxId: 'sbx_created' } as FleetAllocation['runtime'];
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
  const refused = new Map<string, MervError>();
  const requests: string[] = [];
  const inspections = new Map<string, ManagedRunnerInspection>();
  const allocations: FleetAllocation[] = [];
  /** While set, a reconcile waits at its first read. */
  let held: Promise<void> | undefined;
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
      input: { requestId: string; owner: { kind: string; id: string }; seconds?: number },
    ) {
      requests.push(caller.projectId);
      const refusal = refused.get(caller.projectId);
      if (refusal) throw refusal;
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
        seconds: input.seconds,
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
      await held;
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
      state,
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
    /** Holds the next reconcile at its first read until the returned function is called. */
    hold: () => {
      let release!: () => void;
      held = new Promise((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    serves: (projectId: string) => validator!.serves!(projectId),
    demand: (value: Target[] | Error, projectId = main.id) => {
      demands.set(projectId, value);
    },
    refuse: (
      projectId: string,
      error = new MervError('sandbox_not_connected', 'Hosted agents are not set up', 403),
    ) => refused.set(projectId, error),
    sessions: fakeSessions,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    modelEnv,
    modelApiKey: process.env[modelEnv]!,
  };
}

test('a refused model reservation stops new Fleet rents until its payer has enough tokens', async (t) => {
  const f = await fixture(t);
  const person = digest({ issuer, subject: 'founder' });
  const today = new Date().toISOString().slice(0, 10);
  await f.state.transaction(async (tx) => {
    await tx.run(
      'INSERT INTO fleet_model_usage(person,day,tokens) VALUES(?,?,?)',
      person,
      today,
      19_926_575,
    );
    await tx.run(
      'INSERT INTO fleet_model_blockers(person,day,required_tokens) VALUES(?,?,?)',
      person,
      today,
      109_851,
    );
  });
  f.demand([{ instanceId: 'task_waiting', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.open(), []);
  assert.equal((await f.adapter.modelBudget(f.caller))?.blocked, true);
  assert.equal((await modelBudgetStatus(f.state, person, 20_000_000)).remaining, 73_425);
  await setDailyTokens(f.state, person, 20_100_000);
  await f.adapter.reconcile();
  assert.deepEqual(f.requests, [f.caller.projectId]);
  assert.equal((await f.adapter.modelBudget(f.caller))?.blocked, false);
});

test('a step’s payer is its person, read without a lookup; a voucher that cannot be read refuses', async (t) => {
  const f = await fixture(t);
  let lookups = 0;
  const requireDelegation = f.scope.requireDelegation.bind(f.scope);
  f.scope.requireDelegation = async (...args) => (lookups++, await requireDelegation(...args));
  const payer = (source: DelegationSource) =>
    f.state.transaction((tx) => f.adapter.payer(source, 'task:0', tx));
  const founder = digest({ issuer, subject: 'founder' });
  assert.equal(await payer(f.source), founder);
  assert.equal(
    await payer({
      kind: 'service',
      projectId: f.source.projectId,
      actorId: 'r',
      vouchedBy: f.source,
    }),
    founder,
  );
  assert.equal(lookups, 0);
  // A review director vouched for by an issued actor counts toward that actor, while it lasts.
  const issued = await f.scope.issueActor(f.caller, { name: 'Voucher', role: 'operator' });
  const voucher = await f.scope.delegationSource({
    actorId: issued.actor.id,
    projectId: f.source.projectId,
    credentialId: issued.credential.id,
  });
  const reviewer: DelegationSource = {
    kind: 'service',
    projectId: f.source.projectId,
    actorId: 'reviewer',
    vouchedBy: voucher,
  };
  assert.equal(
    await payer(reviewer),
    digest({ projectId: f.source.projectId, actorId: issued.actor.id }),
  );
  await f.scope.revokeActor(f.caller, issued.actor.id);
  await assert.rejects(payer(reviewer), MervError);
});

test('workflow adapter covers demand with one pending slot and retries a claimed generation', async (t) => {
  const f = await fixture(t);
  f.demand([
    { instanceId: 'task_a', expectedRevision: 2 },
    { instanceId: 'task_b', expectedRevision: 0 },
  ]);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 1);
  assert.deepEqual(f.allocations[0]?.owner, { kind: 'workflow', id: 'task_a:2' });
  // A two-hour step, and ten minutes more for its machine to start and stop.
  assert.equal(f.allocations[0]?.seconds, 130 * 60);
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

test('a runner claimed by another step covers its actual work and frees the rent target', async (t) => {
  const f = await fixture(t, { maxAgents: 3 });
  const a = { instanceId: 'task_a', expectedRevision: 0 };
  const b = { instanceId: 'task_b', expectedRevision: 0 };
  f.demand([a]);
  await f.adapter.reconcile();
  const first = f.allocations[0]!;
  first.phase = 'running';
  first.runtime = { launch: { deliveryState: 'launched' } } as FleetAllocation['runtime'];
  f.inspections.set(first.id, {
    runnerId: 'managed-machine',
    enrollmentExpiresAt,
    session: null,
  });
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 1, 'an unclaimed runner still covers its rent target');

  f.inspections.get(first.id)!.session = {
    id: 'session_b',
    instanceId: b.instanceId,
    expectedRevision: b.expectedRevision,
    status: 'active',
    closedAt: null,
    outcome: null,
    releaseAcknowledged: false,
    capturePending: false,
  };
  f.demand([a, b]);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2);
  assert.equal(f.allocations[1]?.owner.id, 'task_a:0');
  assert.notEqual(f.allocations[1]?.requestId, first.requestId);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2, 'actual task and fresh rent target are both covered');
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
  first.runtime = machine;
  first.phase = 'released';
  first.updatedAt = new Date(Date.parse(first.createdAt)).toISOString();
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 2, 'a failed create cannot rent again immediately');
  f.advance(60_000);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 3, 'one cooled-down retry is allowed');

  const second = f.allocations[2]!;
  second.createAttempted = true;
  second.runtime = machine;
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

test(
  'an administrator can reopen only an exhausted exact revision with a retained idempotent grant',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const target = { instanceId: 'retry_target', expectedRevision: 2 };
    const reason = 'Ranked reflection context is deployed; retry its frozen synthesis revision.';
    // A revision with no rental yet is offered, but has nothing to retry.
    f.demand([target]);
    assert.equal((await f.adapter.retryStatus(f.caller, [target]))[0]?.state, 'ready');
    await assert.rejects(
      f.adapter.retry(f.caller, { ...target, reason, requestId: 'nothing-to-retry' }),
      { code: 'fleet_retry_unavailable' },
    );
    await f.adapter.reconcile();
    for (let index = 0; index < 2; index++) {
      const allocation = f.allocations[index]!;
      allocation.createAttempted = true;
      allocation.runtime = machine;
      allocation.phase = 'released';
      allocation.updatedAt = new Date(Date.parse(allocation.createdAt)).toISOString();
      if (index === 0) f.advance(60_000);
      await f.adapter.reconcile();
    }
    assert.equal(f.allocations.length, 2, 'two failed rentals exhaust the revision');
    assert.equal((await f.adapter.retryStatus(f.caller, [target]))[0]?.state, 'exhausted_cooldown');
    await assert.rejects(
      f.adapter.retry(f.caller, { ...target, reason, requestId: 'too-early-retry' }),
      { code: 'fleet_retry_unavailable' },
    );
    f.advance(60_000);
    assert.equal(
      (await f.adapter.retryStatus(f.caller, [target]))[0]?.state,
      'exhausted_unclaimed',
    );
    const former = await f.scope.issueActor(f.caller, {
      name: 'Former director',
      role: 'producer',
    });
    const formerCaller = {
      projectId: f.caller.projectId,
      actorId: former.actor.id,
      credentialId: former.credential.id,
    };
    const formerSource = await f.scope.delegationSource(formerCaller);
    for (const allocation of f.allocations) allocation.source = formerSource;
    await f.scope.revokeActor(f.caller, former.actor.id);
    assert.equal(
      (await f.adapter.retryStatus(f.caller, [target]))[0]?.state,
      'exhausted_unclaimed',
      'the current director keeps the blocker visible after the old director is revoked',
    );
    const producer = await f.scope.issueActor(f.caller, {
      name: 'Retry producer',
      role: 'producer',
    });
    const producerCaller = {
      projectId: f.caller.projectId,
      actorId: producer.actor.id,
      credentialId: producer.credential.id,
    };
    await assert.rejects(
      f.adapter.retry(producerCaller, { ...target, reason, requestId: 'producer-retry' }),
      { status: 403 },
    );
    await assert.rejects(
      f.adapter.retry(f.caller, {
        ...target,
        expectedRevision: 1,
        reason,
        requestId: 'stale-retry',
      }),
      { code: 'revision_conflict' },
    );
    const otherProject = await f.project(f.founder, 'Other retry project');
    await assert.rejects(
      f.adapter.retry(otherProject.caller, { ...target, reason, requestId: 'cross-project' }),
      { code: 'revision_conflict' },
    );
    const borrowed = {
      ...f.allocations[1]!,
      id: 'flt_borrowed',
      owner: { kind: 'workflow', id: 'other_target:0' },
      phase: 'running' as const,
      createAttempted: true,
    };
    f.allocations.push(borrowed);
    f.inspections.set(borrowed.id, {
      runnerId: 'borrowed-runner',
      enrollmentExpiresAt,
      session: {
        id: 'borrowed-session',
        ...target,
        status: 'active',
        closedAt: null,
        outcome: null,
        releaseAcknowledged: false,
        capturePending: false,
      },
    });
    assert.equal((await f.adapter.retryStatus(f.caller, [target]))[0]?.state, 'active');
    await assert.rejects(
      f.adapter.retry(f.caller, { ...target, reason, requestId: 'active-retry' }),
      { code: 'fleet_retry_unavailable' },
    );
    f.inspections.delete(borrowed.id);
    f.allocations.pop();
    const input = { ...target, reason, requestId: 'approved-retry' };
    const grant = await f.adapter.retry(f.caller, input);
    assert.equal(grant.priorAllocations, 2);
    assert.deepEqual(
      await f.adapter.retry(f.caller, input),
      grant,
      'same request does not create a second window',
    );
    await assert.rejects(
      f.adapter.retry(f.caller, {
        ...input,
        reason: `${reason} Different`,
        requestId: input.requestId,
      }),
      { code: 'request_conflict' },
    );
    await f.adapter.reconcile();
    assert.equal(
      f.allocations.length,
      3,
      'new window rents once and retains both older allocations',
    );
    assert.notEqual(f.allocations[2]?.requestId, f.allocations[1]?.requestId);
    const rows = await f.state.read((sql) =>
      sql.all<{ reason: string; prior_allocations: number }>(
        'SELECT reason,prior_allocations FROM fleet_workflow_retry_grants',
      ),
    );
    assert.deepEqual(rows, [{ reason, prior_allocations: 2 }]);
    f.allocations[2]!.createAttempted = true;
    f.allocations[2]!.runtime = machine;
    f.allocations[2]!.phase = 'released';
    f.advance(60_000);
    await f.adapter.reconcile();
    assert.equal(f.allocations.length, 4);
    f.allocations[3]!.createAttempted = true;
    f.allocations[3]!.runtime = machine;
    f.allocations[3]!.phase = 'released';
    f.advance(60_000);
    await f.adapter.reconcile();
    assert.equal(f.allocations.length, 4, 'reopened window remains capped at two failed rentals');
    const raced = await Promise.allSettled([
      f.adapter.retry(f.caller, { ...target, reason, requestId: 'raced-1' }),
      f.adapter.retry(f.caller, { ...target, reason, requestId: 'raced-2' }),
    ]);
    assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
    const lost = raced.filter((result) => result.status === 'rejected');
    assert.equal(lost.length, 1);
    assert.equal(lost[0]!.reason.status, 409);
    assert.equal(
      (await f.state.read((sql) => sql.all('SELECT id FROM fleet_workflow_retry_grants'))).length,
      2,
      'concurrent requests cannot open two windows',
    );
  },
);

test('wallet refusals pause all workflow demand, retry one target, and preserve task attempts', async (t) => {
  const f = await fixture(t, { maxAgents: 5 });
  f.demand(targets('task', 4));
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 4);
  for (const a of f.allocations) {
    a.phase = 'released';
    a.createAttempted = true;
    a.error = 'wallet_refused';
  }
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 4);
  f.advance(15 * 60_000);
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 5);
  f.allocations[4]!.phase = 'released';
  f.allocations[4]!.createAttempted = true;
  f.allocations[4]!.error = 'wallet_refused';
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 5);
  f.advance(15 * 60_000);
  await f.adapter.reconcile();
  assert.equal(
    f.allocations.length,
    6,
    'the same revision can retry after repeated wallet refusals',
  );
  f.allocations[5]!.runtime = { sandboxId: 'admitted' } as FleetAllocation['runtime'];
  f.allocations[5]!.phase = 'running';
  f.allocations[5]!.updatedAt = new Date(Date.parse(f.allocations[4]!.updatedAt) + 1).toISOString();
  await f.adapter.reconcile();
  assert.equal(f.allocations.length, 9, 'one admission restores normal filling');
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
  });
  // The provider key stays on Main: hosted Codex reaches the model through its relay.
  assert.equal(first.includes(f.modelApiKey), false);
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

test('closing unregisters first: a bound session is never judged stale while a pass finishes', async (t) => {
  const f = await fixture(t);
  f.demand([{ instanceId: 'task_a', expectedRevision: 0 }]);
  await f.adapter.reconcile();
  const allocation = f.allocations[0]!;
  const binding = {
    allocationId: allocation.id,
    epoch: 1,
    source: f.source,
    runtimeProfileId: 'image-profile',
    platform: hostedCodexPlatform,
    capabilities: ['code.v2'],
    expiresAt: allocation.deadlineAt,
  };
  const [owner, validator] = [f.owner(), f.validator()];
  const release = f.hold();
  const pass = f.adapter.reconcile();
  const closing = f.adapter.close();
  // Without a validator Sessions answers 503 and keeps its sessions; a Fleet pass that still
  // holds the owner keeps its machine.
  assert.equal(f.validator(), undefined);
  assert.equal(f.owner(), undefined);
  assert.equal(await f.state.transaction((tx) => validator.current(binding, tx)), true);
  assert.equal(await f.state.transaction((tx) => owner.valid(allocation, tx)), true);
  release();
  await Promise.all([pass, closing]);
  assert.equal(await f.state.transaction((tx) => validator.current(binding, tx)), true);
});

test('a relay call in flight when the adapter unloads gets 503, never 401: its route goes first', async (t) => {
  const state = await openState();
  const modelEnv = `MERV_WORKFLOW_MODEL_${randomUUID().replaceAll('-', '')}`;
  process.env[modelEnv] = `sk-test-${randomBytes(32).toString('hex')}`;
  const order: string[] = [];
  let validator: ManagedRunnerValidator | undefined;
  let route: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  let asked!: () => void;
  const asking = new Promise<void>((resolve) => (asked = resolve));
  let answer!: () => void;
  const answering = new Promise<void>((resolve) => (answer = resolve));
  const ctx = new Context();
  ctx.provide('state', state);
  // Fleet's model migrations reference Scope's projects table.
  ctx.provide('scope', await createService(new ProjectScope(state)));
  ctx.provide('tools', { register: () => () => undefined });
  ctx.provide('api', {
    mount: (_prefix: string, handler: typeof route) => {
      route = handler;
      return () => {
        order.push('unmount');
        route = undefined;
      };
    },
  });
  ctx.provide('fleet', {
    registerOwner: () => () => order.push('owner'),
    listOwned: async () => [],
    modelRelay: (config: ModelRelayConfig<ManagedModelGrant, string, unknown>) => {
      const relay = new ModelRelay(config);
      const close = relay.close.bind(relay);
      relay.close = () => (order.push('relay'), close());
      return relay;
    },
  });
  ctx.provide('sessions', {
    registerManagedValidator: (value: ManagedRunnerValidator) => {
      validator = value;
      return () => {
        order.push('validator');
        validator = undefined;
      };
    },
    servedSources: async () => [],
    // Sessions refuses the session once its owner has gone.
    managedModelGrant: async () => {
      asked();
      await answering;
      throw new MervError('unauthorized', 'No live managed session', 401);
    },
  });
  const fiber = ctx.plugin(fleetWorkflowPlugin, {
    enabled: true,
    people: ['*'],
    modelApiKeyEnv: modelEnv,
    baseUrl: 'https://merv.example.test',
    pollIntervalMs: 60_000,
  });
  await fiber;
  const server = createServer((req, res) => {
    if (route) return void route(req, res);
    res.writeHead(503).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.close();
    await state.close();
    delete process.env[modelEnv];
  });
  const call = fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/codex-model/responses`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ms_${'b'.repeat(43)}` },
      body: '{}',
    },
  );
  await asking;
  const unloading = fiber.dispose();
  while (!order.includes('validator')) await new Promise((resolve) => setImmediate(resolve));
  answer();
  const response = await call;
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'relay_unavailable' });
  await unloading;
  assert.deepEqual(order, ['unmount', 'relay', 'validator', 'owner']);
});

test('the mounted relay reads a grant through the adapter, charged to the allocation’s person', async (t) => {
  const state = await openState();
  const modelEnv = `MERV_WORKFLOW_MODEL_${randomUUID().replaceAll('-', '')}`;
  process.env[modelEnv] = `sk-test-${randomBytes(32).toString('hex')}`;
  let relay: ModelRelayConfig<ManagedModelGrant, string, unknown> | undefined;
  const ctx = new Context();
  ctx.provide('state', state);
  ctx.provide('scope', await createService(new ProjectScope(state)));
  ctx.provide('tools', { register: () => () => undefined });
  ctx.provide('api', { mount: () => () => undefined });
  const kinds = new Map<string, FleetOwner>();
  ctx.provide('fleet', {
    registerOwner: (kind: string, owner: FleetOwner) => (kinds.set(kind, owner), () => undefined),
    listOwned: async () => [],
    inspectOwned: async (owner: FleetOwner, id: string) => {
      assert.equal(owner, kinds.get('workflow'));
      return { id, person: 'voucher' };
    },
    modelRelay: (config: typeof relay) => ((relay = config), new ModelRelay(config!)),
  });
  const grant = { id: 'session', projectId: 'p', allocationId: 'flt_1', person: 'actor' };
  ctx.provide('sessions', {
    registerManagedValidator: () => () => undefined,
    servedSources: async () => [],
    managedModelGrant: async () => ({ ...grant, model: 'm', expiresAt: '2099-01-01T00:00:00Z' }),
  });
  const fiber = ctx.plugin(fleetWorkflowPlugin, {
    enabled: true,
    people: ['*'],
    modelApiKeyEnv: modelEnv,
    baseUrl: 'https://merv.example.test',
    pollIntervalMs: 60_000,
  });
  await fiber;
  t.after(async () => {
    await fiber.dispose();
    await state.close();
    delete process.env[modelEnv];
  });
  assert.equal(
    ((await relay!.authority!.authorize(`ms_${'b'.repeat(43)}`)) as ManagedModelGrant).person,
    'voucher',
  );
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
  // An acknowledgement lost for two minutes after the close no longer keeps the machine.
  f.inspections.get(allocation.id)!.session!.closedAt = '2026-09-21T00:00:00Z';
  assert.equal(await f.owner().observe(allocation), 'finished');
  f.inspections.get(allocation.id)!.session!.closedAt = new Date().toISOString();
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

test('Fleet serves each project whose admin chose it, as that admin, within its machines', async (t) => {
  const f = await fixture(t, {
    people: [`${issuer} founder`, `${issuer} colleague`],
    maxAgents: 5,
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
  // Five machines in all, taken in the order the projects are served.
  const first = f.caller.projectId;
  assert.deepEqual(f.open(), [
    [first, 'first_0:0'],
    [first, 'first_1:0'],
    [second.id, 'second_0:0'],
    [second.id, 'second_1:0'],
    [theirs.id, 'theirs_0:0'],
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
  // counts, its unlaunched one is cancelled, and the room goes to the next work waiting.
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
    [second.id, 'second_1:0'],
    [theirs.id, 'theirs_0:0'],
    [theirs.id, 'theirs_1:0'],
  ]);

  await f.restart({ people: ['*'], maxAgents: 10 });
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

test('a project whose demand cannot be read keeps its machines and its standing for the pass', async (t) => {
  const f = await fixture(t);
  f.demand(targets('kept', 1));
  await f.adapter.reconcile();
  assert.deepEqual(f.open(), [[f.caller.projectId, 'kept_0:0']]);
  f.allocations[0]!.phase = 'provisioning';
  f.demand(new MervError('state_unavailable', 'Lock timeout', 503));
  await f.adapter.reconcile();
  assert.deepEqual(
    f.open(),
    [[f.caller.projectId, 'kept_0:0']],
    'a transient error cancels nothing',
  );
  assert.equal(f.allocations[0]!.intent, 'run');
  assert.equal(f.serves(f.caller.projectId), true);
  f.demand([]);
  await f.adapter.reconcile();
  assert.deepEqual(f.open(), [], 'work read as gone is still cancelled');
});

test('a spend cap refusal keeps the project served and passes over its other targets for the pass', async (t) => {
  const f = await fixture(t, { maxAgents: 5 });
  f.demand(targets('capped', 3));
  f.refuse(
    f.caller.projectId,
    new MervError('fleet_compute_cap', "Today's compute is used up", 429),
  );
  await f.adapter.reconcile();
  assert.deepEqual(f.requests, [f.caller.projectId], 'one request is refused, once a pass');
  assert.equal(f.serves(f.caller.projectId), true);
  await f.adapter.reconcile();
  assert.equal(f.requests.length, 2);
  assert.equal(f.serves(f.caller.projectId), true);
});

test('refusals pause renting and spend no attempt; machines that never launched exhaust a revision', async (t) => {
  const f = await fixture(t);
  const target = { instanceId: 'task_a', expectedRevision: 0 };
  f.demand([target]);
  const end = (a: FleetAllocation, fields: Partial<FleetAllocation>) =>
    Object.assign(a, { phase: 'released', intent: 'stop', createAttempted: true, ...fields });
  await f.adapter.reconcile();
  for (const i of [0, 1]) {
    end(f.allocations[i]!, { error: 'runtime_refused' });
    f.advance(60_001);
    await f.adapter.reconcile();
    assert.equal(f.allocations.length, i + 1, 'a provider refusal pauses renting');
    f.advance(15 * 60_000);
    await f.adapter.reconcile();
    assert.equal(f.allocations.length, i + 2, 'and spends no attempt');
  }
  for (const i of [2, 3]) {
    end(f.allocations[i]!, { runtime: machine });
    f.advance(60_001);
    await f.adapter.reconcile();
  }
  assert.equal(f.allocations.length, 4, 'two machines that never claimed work exhaust it');
  assert.equal((await f.adapter.retryStatus(f.caller, [target]))[0]?.state, 'exhausted_unclaimed');
});

test('an idle machine gets its grace from its launch, and work claimed while demand is read keeps it', async (t) => {
  const f = await fixture(t);
  f.demand(targets('task', 1));
  await f.adapter.reconcile();
  const a = f.allocations[0]!;
  f.inspections.set(a.id, { runnerId: 'managed-machine', enrollmentExpiresAt, session: null });
  f.demand([]);
  a.phase = 'running';
  a.updatedAt = new Date(Date.parse(a.createdAt) + 30_000).toISOString();
  f.advance(30_000);
  assert.equal(await f.owner().observe(a), 'running', 'counted from the launch, not the request');
  f.advance(30_000);
  const dispatch = f.sessions.dispatchDemand;
  f.sessions.dispatchDemand = async (...args) => {
    const demand = await dispatch(...args);
    f.inspections.get(a.id)!.session = {
      id: 'session_a',
      ...targets('task', 1)[0]!,
      status: 'active',
      closedAt: null,
      outcome: null,
      releaseAcknowledged: false,
      capturePending: false,
    };
    return demand;
  };
  assert.equal(await f.owner().observe(a), 'running');
  f.sessions.dispatchDemand = dispatch;
  f.inspections.get(a.id)!.session = null;
  assert.equal(await f.owner().observe(a), 'finished');
});

test('the review director takes only what the admin’s own hand may not, within Fleet’s machines', async (t) => {
  const f = await fixture(t, { maxAgents: 2 });
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
  const adapter = new FleetWorkflowAdapter(
    fleet,
    sessions,
    scope,
    {
      enabled: true,
      people: [`${issuer} founder`, `${issuer} colleague`],
      modelApiKeyEnv: modelEnv,
      baseUrl: 'https://merv.example.test',
      pollIntervalMs: 60_000,
      maxAgents: workers,
    },
    () => now,
    state,
  );
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
    state,
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
    events,
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

test(
  'real Sessions and Fleet admit an exhausted-revision grant without nested transactions',
  { timeout: 20_000 },
  async (t) => {
    const h = await hosted(t, 1);
    const caller = await h.project('Retry integration');
    await h.sessions.setDispatch(caller, { enabled: true });
    const work = await h.start(caller);
    const target = { instanceId: work.id, expectedRevision: work.revision };
    const id = `${work.id}:${work.revision}`;
    await h.adapter.start();
    for (let index = 0; index < 2; index++) {
      const attempts = (await h.fleet.listOwned(h.adapter, [id])).filter((a) => a.owner.id === id);
      const allocation = attempts[index]!;
      assert.ok(allocation, `rental ${index + 1} exists`);
      const ended = {
        ...allocation,
        phase: 'released' as const,
        createAttempted: true,
        runtime: machine,
        updatedAt: new Date(Date.parse(allocation.createdAt) - 60_000).toISOString(),
      };
      await h.state.transaction((tx) =>
        tx.run(
          'UPDATE fleet_allocations SET phase=?,data_json=? WHERE id=?',
          'released',
          JSON.stringify(ended),
          allocation.id,
        ),
      );
      h.advance(60_000);
      await h.adapter.reconcile();
    }
    assert.equal((await h.adapter.retryStatus(caller, [target]))[0]?.state, 'exhausted_unclaimed');
    const grant = await h.adapter.retry(caller, {
      ...target,
      reason: 'Ranked reflection context is deployed; retry the exact frozen revision.',
      requestId: 'real-retry',
    });
    assert.equal(grant.priorAllocations, 2);
    await h.adapter.reconcile();
    const attempts = (await h.fleet.listOwned(h.adapter, [id])).filter((a) => a.owner.id === id);
    assert.equal(attempts.length, 3);
    assert.equal(attempts[2]?.phase, 'queued');
  },
);

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
      assert.equal(bootstrap.projectId, allocation.projectId);
      assert.equal(JSON.stringify(bootstrap).includes('test-model-key'), false);
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
      const worker = await sessions.authenticate(managedClaim.secret);
      return { allocation, managed, runnerId, session: leased.session, worker };
    }),
  );
  const tools = new ToolRegistry(h.scope);
  tools.registerSessionPolicy(sessions);
  sessionsToolsPlugin.apply({
    tools,
    sessions,
    get: (name: string) => (name === 'fleetWorkflow' ? adapter : undefined),
    effect: (register: () => unknown) => register(),
  } as unknown as Context);
  const ownStatus = await tools.call('system.status', workers[0]!.worker, {});
  assert.equal((ownStatus as { scope: string }).scope, 'session');
  assert.equal((ownStatus as { modelBudget: { blocked: boolean } }).modelBudget.blocked, false);
  assert.equal(JSON.stringify(ownStatus).includes('"tokens"'), false);
  tools.close();
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

test('a Fleet machine’s hosted Codex launch is given web and literature search, and its session calls both', async (t) => {
  const h = await hosted(t, 1);
  const caller = await h.project('Searching');
  await h.sessions.setDispatch(caller, { enabled: true });
  const target = await h.start(caller);
  await h.adapter.start();
  const [allocation] = await h.fleet.listOwned(h.adapter, []);
  assert.equal(allocation.owner.id, `${target.id}:0`);
  await h.fleet.tick(); // Reserve and provision.
  await h.fleet.tick(); // Launch.
  const machine = await boot(h, allocation);
  // The launch the hosted runner builds for that session, with its own profile
  // (scripts/hosted-runner/smoke-supervisor.ts).
  const launch = buildLaunch(
    validateProfile({
      name: 'hosted-codex',
      harness: 'codex',
      executable: '/usr/local/bin/codex',
      isolatedLauncher: '/usr/local/bin/merv-assignment',
      hosted: true,
      model: hostedCodexPlatform.model,
      enabled: true,
      parallelism: 1,
    }),
    {
      session: machine.session,
      secret: machine.secret,
      mcpUrl: 'https://merv.example.test/mcp',
      cwd: '/home/assignment/work',
    },
    {},
  );
  const servers = launch.args.find((arg) => arg.startsWith('mcp_servers='))!;
  // It sees every read the server lists to its session, the searches included, and none is
  // hidden from it: its shell has the network.
  assert.doesNotMatch(servers, /enabled_tools|disabled_tools/);
  assert.match(servers, /default_tools_approval_mode="approve"/);
  // And its launch text says which to use for what.
  assert.match(launch.stdin, /nisa\.search and nisa\.semantic_search find scholarly papers/);
  assert.match(
    launch.stdin,
    /web\.search and web\.extract find and read the rest of the public web/,
  );

  // Main lists that session both, and runs them as reads its policy never names.
  const tavily = await provider(t, () => ({ body: tavilyResults(1) }));
  const nisa = await provider(t, () => ({
    body: {
      truncated: false,
      papers: [{ arxiv_id: '1706.03762', title: 'Attention Is All You Need', score: 1 }],
    },
  }));
  const tools = new ToolRegistry(h.scope);
  t.after(() => tools.close());
  const web = new WebService(
    { keyEnv: keyEnv(t, 'tvly-fixture'), origin: tavily.origin },
    { log: () => {} },
  );
  const papers = new NisaService({
    keyEnv: keyEnv(t, `rr_sk_${'k'.repeat(43)}`),
    origin: nisa.origin,
  });
  t.after(() => {
    web.close();
    papers.close();
  });
  for (const tool of [...webTools(web), ...nisaTools(papers)]) tools.register(tool);
  tools.registerSessionPolicy(h.sessions);
  const worker = await h.sessions.authenticate(machine.secret);
  const offered = (await tools.describe(worker)).map(({ name }) => name);
  for (const name of [
    'web.search',
    'web.extract',
    'nisa.search',
    'nisa.semantic_search',
    'nisa.paper',
    'nisa.excerpts',
    'nisa.related',
  ])
    assert.ok(offered.includes(name), name);
  const found = (await tools.call('web.search', worker, { query: 'cordis plugin' })) as WebSearch;
  assert.deepEqual(
    found.results.map(({ url }) => url),
    ['https://example.com/0'],
  );
  const literature = (await tools.call('nisa.search', worker, {
    query: 'attention',
  })) as NisaPaperList;
  assert.deepEqual(
    literature.papers.map(({ identifier }) => identifier),
    ['arxiv:1706.03762'],
  );
  assert.deepEqual([tavily.seen.length, nisa.seen.length], [1, 1]);
});

test('Fleet produces Pi-directed work and its review director reviews the admin’s desk delivery', async (t) => {
  const h = await hosted(t, 2);
  const caller = await h.project('Reviewed');
  await h.sessions.setDispatch(caller, { enabled: true });
  // Pi acts with the person's source to direct work, but cannot produce its delivery.
  const source = await h.scope.delegationSource(caller);
  h.scope.registerConversationAuthority({ require: async () => source });
  const pi: Caller = {
    ...caller,
    human: undefined,
    conversation: { id: 'conversation', epoch: 1, commandId: 'command', runtimeId: 'runtime' },
  };
  const review = await delivered(h, caller, 'human');
  const producing = await h.tasks.create(pi, {
    title: 'Producing',
    goal: 'Add.',
    checks: ['It adds.'],
    requestId: 'producing',
  });
  await assert.rejects(
    h.tasks.submitDelivery(
      pi,
      confirmedDelivery({
        taskId: producing.id,
        expectedRevision: producing.workflow.revision,
        artifactIds: [],
        requestId: 'pi-delivery',
      }),
    ),
    { code: 'conversation_task_producer_forbidden' },
  );
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
  // The role change's event closes its session, so its worker's credential no longer works.
  await h.events.drain();
  await assert.rejects(h.sessions.authenticate(machine.secret), { code: 'unauthorized' });
  await h.fleet.tick();
  assert.equal(h.stopped.size, 1);
});

test('a review step’s model calls count toward the admin who vouched for its director', async (t) => {
  const h = await hosted(t, 1);
  const caller = await h.project('Charged');
  await h.sessions.setDispatch(caller, { enabled: true });
  await delivered(h, caller, 'charged');
  await h.adapter.start();
  const [allocation] = await h.fleet.listOwned(h.adapter, []);
  assert.equal(allocation?.source.kind, 'service');
  const voucher = digest({ issuer, subject: 'founder' });
  assert.equal(allocation.person, voucher);
  await h.fleet.tick(); // Reserve and provision.
  await h.fleet.tick(); // Launch.
  const machine = await boot(h, allocation);
  // Sessions names the review director itself; Fleet rented its machine for the voucher.
  assert.notEqual((await h.sessions.managedModelGrant(machine.secret)).person, voucher);
  const relay = codexModelRelay(h.sessions, h.state, {
    providerKey: () => 'test-model-key',
    dailyTokensPerPerson: 20_000_000,
    authorize: (token) => h.adapter.modelGrant(token),
  });
  const grant = (await relay.authority!.authorize(machine.secret)) as ManagedModelGrant;
  assert.deepEqual([grant.allocationId, grant.person], [allocation.id, voucher]);
  const charge = await relay.reserve!(grant, { model: grant.model, input: [] });
  assert.equal((await modelBudgetStatus(h.state, voucher, 20_000_000)).usedToday, charge.tokens);
  // The worker's own budget is the voucher's too.
  const worker = await h.sessions.authenticate(machine.secret);
  assert.equal((await h.adapter.modelBudget(worker))?.blocked, false);
  await setDailyTokens(h.state, voucher, charge.tokens + 1_000);
  assert.equal((await h.adapter.modelBudget(worker))?.blocked, true);
});
