import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createService,
  digest,
  type Caller,
  type Data,
  type WorkflowExecutionPolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { validateExecution, executionFingerprint } from '@merv/workflows/execution-policy';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import type { RunnerPlatform } from '@merv/sessions/types';
import { openState } from './fixtures/state.js';

const astra = { harness: 'codex' as const, model: 'gpt-6-astra', effort: 'medium' };
const platform = { ...astra, name: 'test-codex', enabled: true, parallelism: 1 };
const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext, execution: WorkflowExecutionPolicy, receipt: Data = {}) {
  let now = Date.now();
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => now));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => now,
      sweepIntervalMs: 60_000,
    }),
  );
  const boot = await scope.credentials.bootstrap({
    projectName: 'Execution limits',
    actorName: 'Owner',
  });
  const caller: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const handle = await workflows.register(
    {
      name: 'execution-limits',
      version: 1,
      initial: 'run',
      states: ['run', 'done'],
      terminal: ['done'],
      edges: [{ from: 'run', action: 'finish', to: 'done' }],
    },
    {
      actions: [
        {
          name: 'finish',
          tool: 'finish',
          instruction: 'Finish',
          states: ['run'],
          transitions: ['finish'],
          check: async () => {},
        },
      ],
      assignments: [
        {
          state: 'run',
          execution,
          check: async ({ caller, tx }) => {
            await scope.require(caller, 'write', tx);
          },
          build: async () => ({
            role: 'producer',
            label: 'Run',
            brief: 'Execute the fixed experiment',
            references: [],
            handoff: { instruction: 'Finish', tools: ['finish'] },
            execution: { readOnly: false, tools: [] },
            context: null,
          }),
          lease: {
            role: async () => 'producer' as const,
            acquire: async () => receipt,
            check: async () => {},
            release: async () => {},
          },
        },
      ],
    },
  );
  const instance = await handle.start(caller, {
    workflow: 'execution-limits',
    requestId: randomUUID(),
  });
  await sessions.dispatch.setDispatch(caller, { enabled: true });
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  return {
    state,
    workflows,
    sessions,
    caller,
    instance,
    advance: (ms: number) => {
      now += ms;
    },
    offer: () =>
      sessions.offer(caller, {
        instanceId: instance.id,
        expectedRevision: 0,
        runnerId: 'machine',
        requestId: randomUUID(),
        secret: secret(),
      }),
    demand: (offered: RunnerPlatform) =>
      sessions.dispatch.dispatchDemand(caller, { platform: offered }),
    lease: async (offered: RunnerPlatform) => {
      await sessions.dispatch.heartbeatRunner(caller, {
        runnerId: 'machine',
        machine: { hostname: 'test', system: 'test', architecture: 'test' },
        platforms: [offered],
        capacity: 1,
      });
      const { name, harness, model, effort } = offered;
      return sessions.dispatch.lease(caller, {
        runnerId: 'machine',
        requestId: randomUUID(),
        secret: secret(),
        platform: { name, harness, model, effort },
      });
    },
  };
}

test('optional platform and budget policies preserve old manifests and are included in immutable hashes', () => {
  const old = { readOnly: false, tools: [] };
  assert.deepEqual(validateExecution(old), old);
  assert.equal(
    executionFingerprint(validateExecution(old)),
    digest({ formatVersion: 1, policy: old }),
  );
  for (const extra of [
    { platform: astra },
    { maxDurationSeconds: 600 },
    { maxModelTokens: 100_000 },
  ]) {
    const policy = validateExecution({ ...old, ...extra });
    assert.notEqual(executionFingerprint(policy), executionFingerprint(old));
    assert.deepEqual(policy, { ...old, ...extra });
  }
  assert.throws(() => validateExecution({ ...old, maxModelTokens: 0 }), {
    code: 'invalid_workflow_policy',
  });
});

test('pinned execution cannot use direct offers, other models, other efforts, or another harness', async (t) => {
  const f = await fixture(t, { readOnly: false, tools: [], platform: astra });
  await assert.rejects(f.offer(), { code: 'platform_required' });
  for (const wrong of [
    { ...platform, model: 'gpt-6.1-sol' },
    { ...platform, effort: 'low' },
    { ...platform, effort: undefined },
    { ...platform, harness: 'claude' as const },
  ]) {
    assert.deepEqual((await f.demand(wrong)).candidates, []);
    assert.equal((await f.lease(wrong)).session, null);
  }
  assert.equal((await f.demand(platform)).candidates.length, 1);
  const { session } = await f.lease(platform);
  assert.ok(session);
  assert.deepEqual(session.execution.policy.platform, astra);
  const stored = await f.state.read((sql) =>
    sql.get<{ platform_json: string }>(
      'SELECT platform_json FROM session_dispatch_receipts WHERE session_id=?',
      session.id,
    ),
  );
  assert.deepEqual(JSON.parse(stored!.platform_json), { name: platform.name, ...astra });
});

test('workflow and per-request limits clamp session deadlines and model token grants', async (t) => {
  const f = await fixture(
    t,
    {
      readOnly: false,
      tools: [],
      platform: astra,
      maxDurationSeconds: 900,
      maxModelTokens: 100_000,
    },
    { sessionLimits: { durationSeconds: 600, modelTokens: 40_000 } },
  );
  const { session } = await f.lease(platform);
  assert.ok(session);
  assert.equal(Date.parse(session.hardDeadline) - Date.parse(session.createdAt), 600_000);
  assert.equal(session.tokenBudget, 40_000);
  await f.sessions.attach(f.caller, {
    sessionId: session.id,
    runnerId: 'machine',
    hostRef: 'process',
  });
  f.advance(601_000);
  await assert.rejects(
    f.sessions.heartbeat(f.caller, { sessionId: session.id, runnerId: 'machine' }),
    { code: 'session_expired' },
  );
});

test('a lease receipt cannot enlarge the fixed execution limits', async (t) => {
  const f = await fixture(
    t,
    { readOnly: false, tools: [], maxDurationSeconds: 600, maxModelTokens: 20_000 },
    {
      sessionLimits: { durationSeconds: 3600, modelTokens: 100_000 },
    },
  );
  const session = await f.offer();
  assert.equal(Date.parse(session.hardDeadline) - Date.parse(session.createdAt), 600_000);
  assert.equal(session.tokenBudget, 20_000);
});
