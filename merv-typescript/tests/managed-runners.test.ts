import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

async function fixture(
  t: TestContext,
  options: { codeWorkspace?: boolean; clock?: () => number } = {},
) {
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
          ...(options.codeWorkspace
            ? {
                workspace: {
                  mode: 'persistent' as const,
                  namespace: 'managed-test',
                  base: 'reference:code' as const,
                  perBase: false,
                  retain: true,
                  advancesCentral: false,
                  driver: 'code.v2',
                },
              }
            : {}),
        },
        ...(options.codeWorkspace ? { references: () => ({ code: 'a'.repeat(40) }) } : {}),
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
  let sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      managedSecretEnv: env,
      sweepIntervalMs: 60_000,
      clock: options.clock,
    }),
  );
  let current = true,
    admits = true;
  const validator: Parameters<LeasedSessions['registerManagedValidator']>[0] = {
    current: async (binding) => current && binding.runtimeProfileId === 'codex-profile',
    admits: async () => admits,
  };
  sessions.registerManagedValidator(validator);
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
    capabilities: options.codeWorkspace ? ['code.v2'] : [],
    expiresAt: new Date((options.clock?.() ?? Date.now()) + 3_600_000).toISOString(),
  };
  const workerNonce = randomBytes(32).toString('hex');
  const enrollment = await sessions.ensureManagedEnrollment(input);
  const enrolled = await sessions.enrollManaged(enrollment.enrollmentToken, { workerNonce });
  const caller = await sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocationId}`;
  const heartbeat = (capacity: number) => ({
    runnerId,
    machine,
    platforms: [profile],
    capabilities: options.codeWorkspace ? ['code.v2'] : [],
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
    workerNonce,
    enrollment,
    enrolled,
    restart: async () => {
      await sessions.close();
      sessions = await createService(
        new LeasedSessions(state, scope, workflows, events, {
          managedSecretEnv: env,
          sweepIntervalMs: 60_000,
          clock: options.clock,
        }),
      );
      sessions.registerManagedValidator(validator);
      return sessions;
    },
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
    (await f.sessions.enrollManaged(f.enrollment.enrollmentToken, { workerNonce: f.workerNonce }))
      .controlToken,
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
  assert.equal(row.worker_nonce_hash, createHash('sha256').update(f.workerNonce).digest('hex'));
  assert.equal(JSON.stringify(row).includes(f.workerNonce), false);
  assert.equal(JSON.stringify(row).includes(f.enrolled.controlToken), false);
  assert.equal(JSON.stringify(row).includes(f.enrollment.enrollmentToken), false);
  assert.deepEqual(await f.sessions.inspectManaged(f.input.allocationId, 1), {
    runnerId: null,
    enrollmentExpiresAt: row.enrollment_expires_at,
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

test('lost enrollment response replays the same control after restart; changed nonce conflicts', async (t) => {
  const f = await fixture(t);
  const changed = { workerNonce: randomBytes(32).toString('hex') };
  await assert.rejects(f.sessions.enrollManaged(f.enrollment.enrollmentToken, changed), {
    code: 'managed_binding_conflict',
    status: 409,
  });
  const restarted = await f.restart();
  const replay = await restarted.enrollManaged(f.enrollment.enrollmentToken, {
    workerNonce: f.workerNonce,
  });
  assert.equal(replay.controlToken, f.enrolled.controlToken);
  await assert.rejects(restarted.enrollManaged(f.enrollment.enrollmentToken, changed), {
    code: 'managed_binding_conflict',
    status: 409,
  });
  assert.equal(
    (await restarted.authenticateManaged(replay.controlToken)).managed?.credentialHash,
    f.caller.managed?.credentialHash,
  );
});

test('only an admitted enrollment pins the nonce and control identity once', async (t) => {
  const f = await fixture(t);
  const allocationId = randomUUID();
  const { enrollmentToken } = await f.sessions.ensureManagedEnrollment({
    ...f.input,
    allocationId,
  });
  const binding = async () =>
    f.state.read((tx) =>
      tx.get<{ worker_nonce_hash: string | null; control_hash: string }>(
        'SELECT worker_nonce_hash, control_hash FROM session_managed_runners WHERE allocation_id=?',
        allocationId,
      ),
    );
  const before = await binding();
  assert.equal(before?.worker_nonce_hash, null);
  f.admits(false);
  await assert.rejects(
    f.sessions.enrollManaged(enrollmentToken, {
      workerNonce: f.workerNonce,
    }),
    { code: 'managed_not_admitted' },
  );
  assert.deepEqual(await binding(), before);
  f.admits(true);
  const enrolled = await f.sessions.enrollManaged(enrollmentToken, {
    workerNonce: f.workerNonce,
  });
  assert.equal(
    (await binding())?.worker_nonce_hash,
    createHash('sha256').update(f.workerNonce).digest('hex'),
  );
  assert.notEqual((await binding())?.control_hash, before?.control_hash);
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        'UPDATE session_managed_runners SET control_hash=? WHERE allocation_id=?',
        'a'.repeat(64),
        allocationId,
      ),
    ),
    { code: 'state_constraint' },
  );
  assert.equal(
    (await f.sessions.authenticateManaged(enrolled.controlToken)).managed?.allocationId,
    allocationId,
  );
});

test('enrollment rejects absent, malformed and extra nonce fields', async (t) => {
  const f = await fixture(t);
  for (const input of [
    {},
    { workerNonce: '' },
    { workerNonce: 'F'.repeat(64) },
    { workerNonce: randomBytes(32).toString('base64url') },
    { workerNonce: f.workerNonce, allocationId: f.input.allocationId },
    null,
    [],
  ]) {
    await assert.rejects(f.sessions.enrollManaged(f.enrollment.enrollmentToken, input), {
      code: 'invalid_managed_enrollment',
    });
  }
});

test('enrollment retries fail closed after allocation expiry or source revocation', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now });
  const allocationId = randomUUID();
  const { enrollmentToken } = await f.sessions.ensureManagedEnrollment({
    ...f.input,
    allocationId,
  });
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(
    f.sessions.enrollManaged(enrollmentToken, {
      workerNonce: f.workerNonce,
    }),
    (error: any) => error?.status === 401 || error?.status === 403,
  );
  const unbound = await f.state.read((tx) =>
    tx.get<{ worker_nonce_hash: string | null }>(
      'SELECT worker_nonce_hash FROM session_managed_runners WHERE allocation_id=?',
      allocationId,
    ),
  );
  assert.equal(unbound?.worker_nonce_hash, null);
  now += 3_600_001;
  await assert.rejects(
    f.sessions.enrollManaged(f.enrollment.enrollmentToken, {
      workerNonce: f.workerNonce,
    }),
    { code: 'unauthorized' },
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
  // A runner whose lease reply was lost still offers its slot, then replays the lease below.
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await assert.rejects(f.sessions.heartbeatRunner(f.caller, f.heartbeat(2)), {
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

test('a failure on one rented machine holds its target back on the next, and a released machine leaves the Runners list', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const bound = (await f.sessions.lease(f.caller, f.lease())).session!;
  assert.ok(bound);
  await f.sessions.release(f.caller, {
    sessionId: bound.id,
    runnerId: f.runnerId,
    outcome: 'host_failed',
  });
  // Fleet's next machine for the same source is a new runner with no history of its own.
  const allocationId = randomUUID();
  const enrollment = await f.sessions.ensureManagedEnrollment({ ...f.input, allocationId });
  const enrolled = await f.sessions.enrollManaged(enrollment.enrollmentToken, {
    workerNonce: randomBytes(32).toString('hex'),
  });
  const caller = await f.sessions.authenticateManaged(enrolled.controlToken);
  const runnerId = `managed-${allocationId}`;
  await f.sessions.heartbeatRunner(caller, { ...f.heartbeat(1), runnerId });
  assert.deepEqual(await f.sessions.lease(caller, { ...f.lease(), runnerId }), {
    session: null,
    reason: 'retry_backoff',
  });
  const listed = (await f.sessions.projectStatus(f.owner)).runners.map((r) => r.runnerId);
  assert.ok(listed.includes(runnerId));
  assert.ok(!listed.includes(f.runnerId), 'a machine whose release was acknowledged is gone');
});

test('own machines give a managed runner no new work, and the session it holds runs to release', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true, ownMachines: true });
  assert.equal((await f.sessions.projectStatus(f.owner)).dispatch.fleet, true);
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  assert.deepEqual(await f.sessions.lease(f.caller, f.lease()), {
    session: null,
    reason: 'dispatch_disabled',
  });
  await f.sessions.setDispatch(f.owner, { ownMachines: false });
  const request = f.lease();
  const bound = (await f.sessions.lease(f.caller, request)).session!;
  assert.ok(bound);
  await f.sessions.authenticate(request.secret);
  await f.sessions.setDispatch(f.owner, { ownMachines: true });
  await f.sessions.sweep();
  assert.equal((await f.sessions.get(f.caller, bound.id)).status, 'active');
  await f.sessions.release(f.caller, { sessionId: bound.id, runnerId: f.runnerId });
  assert.equal((await f.sessions.get(f.caller, bound.id)).status, 'released');
});

test('a person’s source enrolls a managed runner that leases as that person', async (t) => {
  const f = await fixture(t);
  const person = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.example/auth/v1',
    subject: 'founder',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const project = await f.scope.createProject(person, { name: 'Person', requestId: 'person' });
  const owner = await f.scope.caller(person, project.id);
  const source = await f.scope.delegationSource(owner);
  const allocationId = randomUUID();
  const runnerId = `managed-${allocationId}`;
  const { enrollmentToken } = await f.sessions.ensureManagedEnrollment({
    ...f.input,
    allocationId,
    source,
  });
  const enrolled = await f.sessions.enrollManaged(enrollmentToken, { workerNonce: f.workerNonce });
  const managed = await f.sessions.authenticateManaged(enrolled.controlToken);
  assert.equal(managed.projectId, project.id);
  await f.sessions.heartbeatRunner(managed, { ...f.heartbeat(1), runnerId });
  await f.sessions.setDispatch(owner, { enabled: true });
  const target = await f.handle.start(owner, { workflow: 'managed-test', requestId: randomUUID() });
  const leased = await f.sessions.lease(managed, { ...f.lease(), runnerId });
  assert.ok(leased.session, leased.reason);
  assert.deepEqual([leased.session.instanceId, leased.session.source], [target.id, source]);
});

test('the sweep ends a bound session once its machine is no longer current', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const request = f.lease();
  assert.ok((await f.sessions.lease(f.caller, request)).session);
  await f.sessions.authenticate(request.secret);
  const bound = async () => (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session;
  await f.sessions.sweep();
  assert.equal((await bound())?.status, 'active');
  f.current(false);
  await f.sessions.sweep();
  assert.equal((await bound())?.status, 'expired');
  assert.equal((await bound())?.outcome, 'host_failed');
});

test('managed Code v2 runner attaches its bound checkout using its verified source capability', async (t) => {
  const f = await fixture(t, { codeWorkspace: true });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const request = f.lease();
  const leased = await f.sessions.lease(f.caller, request);
  assert.ok(leased.session, leased.reason);
  const session = leased.session;
  const checkout = {
    repositoryId: 'repository-managed',
    workspaceId: 'workspace-managed',
    mode: 'persistent' as const,
    branch: 'merv/work/managed',
    baseOid: 'a'.repeat(40),
    headOid: 'a'.repeat(40),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  const attached = await f.sessions.attach(f.caller, {
    sessionId: session.id,
    runnerId: f.runnerId,
    hostRef: 'launch-managed',
    workspace: checkout,
  });
  assert.equal(attached.status, 'offered');
  assert.equal(attached.hostRef, 'launch-managed');
  assert.deepEqual(attached.workspace?.attachment, checkout);
  await f.sessions.authenticate(request.secret);
  assert.equal((await f.sessions.get(f.caller, session.id)).status, 'active');
  await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
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
