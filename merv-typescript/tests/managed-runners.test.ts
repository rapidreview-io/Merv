import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createService, type Caller, type WorkflowPolicy } from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { countWrites, openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
const profile = {
  name: 'codex',
  harness: 'codex' as const,
  model: 'gpt-6-luna',
  enabled: true,
  parallelism: 1,
};
const machine = { hostname: 'managed-test', system: 'Linux', architecture: 'x64' };

async function fixture(t: TestContext) {
  const env = `MERV_MANAGED_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
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
          label: 'Managed work',
          brief: 'Do the work',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
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
  const handle = await workflows.register(
    {
      name: 'managed-test',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    },
    policy,
  );
  const boot = await scope.bootstrap({ projectName: 'Managed', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  const source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  const sourceIdentity = await scope.delegationSource(source);
  const sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      managedSecretEnv: env,
      sweepIntervalMs: 60_000,
    }),
  );
  let current = true,
    admits = true;
  sessions.registerManagedValidator({
    current: async (binding) =>
      current &&
      binding.source.projectId === boot.project.id &&
      binding.runtimeProfileId === 'codex-profile',
    admits: async () => admits,
  });
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
    delete process.env[env];
  });
  const allocationId = randomUUID();
  const input = {
    allocationId,
    epoch: 1,
    source: sourceIdentity,
    runtimeProfileId: 'codex-profile',
    platform: profile,
    capabilities: [],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const enrollment = await sessions.ensureManagedEnrollment(input);
  const enrolled = await sessions.enrollManaged(enrollment.enrollmentToken, {});
  const caller = await sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocationId}`;
  const heartbeat = (capacity: number) => ({
    runnerId,
    machine,
    platforms: [profile],
    capabilities: [],
    capacity,
  });
  const lease = (requestId = randomUUID()) => ({
    runnerId,
    requestId,
    secret: secret(),
    platform: { name: profile.name, harness: profile.harness, model: profile.model },
  });
  return {
    state,
    scope,
    handle,
    owner,
    source,
    sessions,
    current: (value: boolean) => {
      current = value;
    },
    admits: (value: boolean) => {
      admits = value;
    },
    input,
    enrollment,
    enrolled,
    caller,
    runnerId,
    heartbeat,
    lease,
  };
}

test('managed enrollment is stable, hashed at rest, pinned on heartbeat and denied ordinary APIs', async (t) => {
  const f = await fixture(t);
  const writes = countWrites(f.state);
  const beforeAuthentication = writes();
  await f.sessions.authenticateManaged(f.enrolled.controlToken);
  assert.equal(writes(), beforeAuthentication);
  assert.match(f.enrollment.enrollmentToken, /^me_[0-9a-f]{64}$/);
  assert.match(f.enrolled.controlToken, /^mr_[0-9a-f]{64}$/);
  assert.equal(
    (await f.sessions.ensureManagedEnrollment(f.input)).enrollmentToken,
    f.enrollment.enrollmentToken,
  );
  assert.equal(
    (await f.sessions.enrollManaged(f.enrollment.enrollmentToken, {})).controlToken,
    f.enrolled.controlToken,
  );
  await assert.rejects(
    f.sessions.enrollManaged(f.enrollment.enrollmentToken, { runnerId: 'injected' }),
    { code: 'invalid_managed_enrollment' },
  );
  const row = await f.state.read((tx) =>
    tx.get<any>(
      'SELECT * FROM session_managed_runners WHERE allocation_id=?',
      f.input.allocationId,
    ),
  );
  assert.ok(row);
  assert.equal(JSON.stringify(row).includes(f.enrolled.controlToken), false);
  assert.equal(JSON.stringify(row).includes(f.enrollment.enrollmentToken), false);
  assert.deepEqual(await f.sessions.inspectManaged(f.input.allocationId, 1), {
    runnerId: null,
    session: null,
  });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  assert.equal((await f.sessions.inspectManaged(f.input.allocationId, 1))?.runnerId, f.runnerId);
  await assert.rejects(
    f.sessions.heartbeatRunner(f.caller, { ...f.heartbeat(1), runnerId: 'other' }),
    { code: 'managed_runner_conflict' },
  );
  await assert.rejects(
    f.sessions.heartbeatRunner(f.caller, {
      ...f.heartbeat(1),
      platforms: [{ ...profile, model: 'wrong' }],
    }),
    { code: 'managed_profile' },
  );
  await assert.rejects(f.sessions.list(f.caller), { code: 'forbidden' });
  await assert.rejects(f.sessions.usage(f.caller), { code: 'forbidden' });
  await assert.rejects(
    f.sessions.offer(f.caller, {
      instanceId: 'x',
      expectedRevision: 0,
      runnerId: f.runnerId,
      requestId: 'x',
      secret: secret(),
    }),
    { code: 'forbidden' },
  );
});

test('managed lease binds once, replays after admission closes, and rejects another session', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const first = f.lease();
  const result = await f.sessions.lease(f.caller, first);
  assert.ok(result.session, result.reason);
  const bound = result.session;
  assert.equal((await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.id, bound.id);
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.releaseAcknowledged,
    false,
  );
  assert.equal((await f.sessions.get(f.caller, bound.id)).id, bound.id);
  await assert.rejects(f.sessions.get(f.caller, 'session_wrong'), { code: 'session_forbidden' });
  await assert.rejects(f.sessions.heartbeatRunner(f.caller, f.heartbeat(1)), {
    code: 'managed_capacity',
  });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(0));
  f.admits(false);
  assert.equal((await f.sessions.lease(f.caller, first)).session?.id, bound.id);
  assert.equal((await f.sessions.lease(f.caller, f.lease())).session, null);
  await f.sessions.release(f.caller, { sessionId: bound.id, runnerId: f.runnerId });
  assert.equal((await f.sessions.get(f.caller, bound.id)).status, 'released');
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.status,
    'released',
  );
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.releaseAcknowledged,
    true,
  );
  f.current(false);
  await assert.rejects(f.sessions.authenticateManaged(f.enrolled.controlToken), {
    code: 'managed_revoked',
  });
  await assert.rejects(f.sessions.lease(f.caller, first), { code: 'managed_revoked' });
});

test('two concurrent managed lease requests create at most one bound session', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const [a, b] = await Promise.all([
    f.sessions.lease(f.caller, f.lease()),
    f.sessions.lease(f.caller, f.lease()),
  ]);
  assert.equal([a, b].filter((result) => result.session).length, 1);
  const bound = await f.state.read((tx) =>
    tx.get<{ bound_session_id: string }>(
      'SELECT bound_session_id FROM session_managed_runners WHERE allocation_id=?',
      f.input.allocationId,
    ),
  );
  assert.equal(bound?.bound_session_id, (a.session ?? b.session)?.id);
});

test('cancelled admission cannot create a new managed claim', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  f.admits(false);
  await assert.rejects(f.sessions.lease(f.caller, f.lease()), { code: 'managed_not_admitted' });
  const row = await f.state.read((tx) =>
    tx.get<{ bound_session_id: string | null }>(
      'SELECT bound_session_id FROM session_managed_runners WHERE allocation_id=?',
      f.input.allocationId,
    ),
  );
  assert.equal(row?.bound_session_id, null);
  assert.equal((await f.sessions.list(f.source)).length, 0);
});

test('revoking the captured source credential ends managed authority', async (t) => {
  const f = await fixture(t);
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(
    f.sessions.authenticateManaged(f.enrolled.controlToken),
    (error: any) => error?.status === 401 || error?.status === 403,
  );
  await assert.rejects(
    f.sessions.heartbeatRunner(f.caller, f.heartbeat(1)),
    (error: any) => error?.status === 401 || error?.status === 403,
  );
});
