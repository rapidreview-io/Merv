import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  createService,
  digest,
  type Caller,
  type WorkflowPolicy,
  type WorkflowWorkspacePolicy,
} from '@merv/contracts';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';
import { CredentialStore, tokenDigest } from '@merv/identity/credentials';
import type { SessionDispatch } from '../packages/sessions/src/dispatch.js';
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
  options: {
    codeWorkspace?: boolean;
    reviewWorkspace?: 'ephemeral' | 'retained';
    clock?: () => number;
  } = {},
) {
  const env = `MERV_MANAGED_TEST_${randomUUID().replaceAll('-', '')}`;
  process.env[env] = randomBytes(48).toString('hex');
  const state = await openState();
  const scope = await createService(new ProjectScope(state));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state));
  const reviewWorkspace: WorkflowWorkspacePolicy | undefined = options.reviewWorkspace
    ? options.reviewWorkspace === 'ephemeral'
      ? {
          mode: 'ephemeral',
          namespace: 'managed-review',
          base: 'central',
          retain: false,
          driver: 'code.v2',
        }
      : {
          mode: 'persistent',
          namespace: 'managed-review',
          base: 'central',
          perBase: false,
          retain: true,
          advancesCentral: false,
          driver: 'code.v2',
        }
    : undefined;
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
          execution: { readOnly: !!reviewWorkspace, tools: [] },
          context: null,
        }),
        execution: {
          readOnly: !!reviewWorkspace,
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
          ...(reviewWorkspace
            ? { workspace: reviewWorkspace }
            : options.codeWorkspace
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
    admits = true,
    retired = false;
  const validator: Parameters<LeasedSessions['registerManagedValidator']>[0] = {
    current: async (binding) => current && binding.runtimeProfileId === 'codex-profile',
    admits: async () => admits,
    retired: async () => retired,
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
    capabilities: options.codeWorkspace || options.reviewWorkspace ? ['code.v2'] : [],
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
    capabilities: options.codeWorkspace || options.reviewWorkspace ? ['code.v2'] : [],
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
    retire: () => {
      current = false;
      retired = true;
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

test('rented machines never exhaust a project’s own runners, and another project’s runner of the same name stays its own', async (t) => {
  const f = await fixture(t);
  const dispatcher = (f.sessions as unknown as { dispatcher: SessionDispatch }).dispatcher;
  const machines = (caller: Caller) =>
    f.state.transaction(async (tx) => (await dispatcher.running(caller, tx)).machines.live);
  const listed = async (caller: Caller) =>
    (await f.sessions.projectStatus(caller)).runners.map((runner) => runner.runnerId);
  // A thousand of the project's own runners, long gone.
  await f.state.transaction((tx) =>
    tx.run(
      "INSERT INTO session_runners(id,project_id,owner_hash,runner_id,source_json,presence_json,settings_json,last_seen_at) SELECT 'runner_old_'||i,?,'old','old-'||i,'{}','{}','{}','2000-01-01T00:00:00.000Z' FROM generate_series(1,1000) i",
      f.owner.projectId,
    ),
  );
  // Fleet's own caps bound the machines it rents, so the project's limit is not theirs.
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  const own = { ...f.heartbeat(1), runnerId: 'own' };
  await assert.rejects(f.sessions.heartbeatRunner(f.owner, own), { code: 'runner_limit' });
  // Only the project's own rows count against it: 999 of them and one rented leave room.
  await f.state.transaction((tx) => tx.run("DELETE FROM session_runners WHERE id='runner_old_1'"));
  await f.sessions.heartbeatRunner(f.owner, own);
  // A live rented machine is listed, and is not one of the project's own machines.
  assert.ok((await listed(f.owner)).includes(f.runnerId));
  assert.equal(await machines(f.owner), 1);

  // Another project's runner that happens to share the rented machine's name.
  const other = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other owner' });
  const otherOwner: Caller = {
    actorId: other.actor.id,
    projectId: other.project.id,
    credentialId: other.credential.id,
  };
  await f.sessions.heartbeatRunner(otherOwner, { ...f.heartbeat(1), runnerId: f.runnerId });
  assert.equal(await machines(otherOwner), 1, 'another project’s machine is never rented');
  await f.state.transaction((tx) =>
    tx.run(
      'UPDATE session_managed_runners SET runner_released_at=? WHERE allocation_id=?',
      new Date().toISOString(),
      f.input.allocationId,
    ),
  );
  assert.ok(!(await listed(f.owner)).includes(f.runnerId), 'the released machine leaves');
  assert.deepEqual(await listed(otherOwner), [f.runnerId], 'and hides no other project’s');
  assert.equal(await machines(otherOwner), 1);
});

test('a machine a release retired mid-step closes its session as machine_retired, which counts against nothing', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const target = await f.handle.start(f.source, {
    workflow: 'managed-test',
    requestId: randomUUID(),
  });
  const bound = (await f.sessions.lease(f.caller, f.lease())).session!;
  assert.ok(bound);
  f.retire();
  await f.sessions.sweep();
  const closed = await f.sessions.get(f.source, bound.id);
  assert.equal(closed.status, 'expired');
  assert.equal(closed.outcome, 'machine_retired');
  const hold = await f.state.read((sql) =>
    sql.get<{ attempts: number }>(
      'SELECT attempts FROM session_dispatch_holds WHERE instance_id=?',
      target.id,
    ),
  );
  assert.equal(Number(hold?.attempts ?? 0), 0, 'a retired machine is no failed attempt');
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

test('a hosted step ends five minutes before its machine, and a machine with under ten left starts none', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  // The machine runs until its allocation's end, fixed at enrollment an hour from now.
  now = Date.parse(f.input.expiresAt) - 599_999;
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await assert.rejects(f.sessions.lease(f.caller, f.lease()), { code: 'managed_expiring' });
  // With ten minutes left it does start, and its step, whatever the runner asked, ends at five.
  now -= 1;
  const { session } = await f.sessions.lease(f.caller, { ...f.lease(), hardDeadlineSeconds: 3600 });
  assert.ok(session);
  assert.equal(Date.parse(session.hardDeadline), Date.parse(f.input.expiresAt) - 300_000);
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
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.capturePending,
    true,
  );
  await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.capturePending,
    true,
  );
});

test('managed inspection does not hold a released disposable read-only checkout for capture', async (t) => {
  for (const mode of ['ephemeral', 'retained'] as const) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest, { reviewWorkspace: mode });
      await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
      await f.sessions.setDispatch(f.owner, { enabled: true });
      await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
      const request = f.lease();
      const leased = await f.sessions.lease(f.caller, request);
      const session = leased.session!;
      assert.ok(session, leased.reason);
      const checkout = {
        repositoryId: 'repository-managed',
        workspaceId: 'workspace-managed',
        mode: mode === 'ephemeral' ? ('ephemeral' as const) : ('persistent' as const),
        branch: mode === 'ephemeral' ? null : 'merv/review/managed',
        baseOid: 'a'.repeat(40),
        headOid: 'a'.repeat(40),
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      };
      await f.sessions.attach(f.caller, {
        sessionId: session.id,
        runnerId: f.runnerId,
        hostRef: 'launch-managed',
        workspace: checkout,
      });
      await f.sessions.authenticate(request.secret);
      await f.sessions.release(f.caller, {
        sessionId: session.id,
        runnerId: f.runnerId,
      });
      const inspected = (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session;
      assert.equal(inspected?.status, 'released');
      assert.equal(inspected?.releaseAcknowledged, true);
      assert.equal(inspected?.capturePending, mode === 'retained');
    });
  }
});

test('managed inspection holds a released session for its declared transcript for thirty minutes', async (t) => {
  for (const ending of ['stamped', 'expired'] as const) {
    await t.test(ending, async (subtest) => {
      let now = Date.now();
      const f = await fixture(subtest, { clock: () => now });
      // A store that signs locally and holds whatever sizes the test puts in it.
      const stored = new Map<string, number>();
      f.sessions.transcripts.blobs = {
        put: async () => assert.fail('no bytes pass through Main'),
        get: async () => assert.fail('nothing reads a transcript back'),
        upload: async (_namespace, hash) => ({
          url: `https://store.test/${hash}`,
          headers: {},
          expiresAt: new Date(now + 3_600_000).toISOString(),
        }),
        stored: async (namespace, hash) => stored.get(`${namespace}/${hash}`) ?? null,
      };
      await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
      await f.sessions.setDispatch(f.owner, { enabled: true });
      await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
      const request = f.lease();
      const leased = await f.sessions.lease(f.caller, request);
      assert.ok(leased.session, leased.reason);
      const control = { sessionId: leased.session.id, runnerId: f.runnerId };
      await f.sessions.attach(f.caller, { ...control, hostRef: 'launch-managed' });
      await f.sessions.authenticate(request.secret);
      const pending = async () =>
        (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session?.capturePending;
      // No checkout and nothing declared: nothing is owed.
      assert.equal(await pending(), false);
      const transcript = {
        ...control,
        hostRef: 'launch-managed',
        sha256: 'a'.repeat(64),
        size: 10,
        logBytes: 10,
        truncated: false,
      };
      await f.sessions.transcript(f.caller, transcript);
      await f.sessions.release(f.caller, control);
      const released = (await f.sessions.inspectManaged(f.input.allocationId, 1))?.session;
      assert.deepEqual(
        [released?.status, released?.releaseAcknowledged, released?.capturePending],
        ['released', true, true],
      );
      if (ending === 'stamped') {
        now += 29 * 60_000;
        // A delivery with nothing stored is handed a PUT and keeps the machine.
        assert.ok((await f.sessions.transcript(f.caller, { ...transcript, deliver: true })).upload);
        assert.equal(await pending(), true);
        stored.set(`transcripts-${leased.session.projectId}/${transcript.sha256}`, 10);
        const confirmed = await f.sessions.transcript(f.caller, { ...transcript, deliver: true });
        assert.ok(confirmed.uploadedAt);
        assert.equal(await pending(), false);
      } else {
        // Counted from the declaration, whether or not the upload ever arrives.
        now += 30 * 60_000 - 1;
        assert.equal(await pending(), true);
        now += 1;
        assert.equal(await pending(), false);
      }
    });
  }
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

test('a hosted session’s model grant holds while it is live or just handed off, and never activates it', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const request = f.lease();
  const { session } = await f.sessions.lease(f.caller, request);
  assert.ok(session);
  const grant = await f.sessions.managedModelGrant(request.secret);
  assert.deepEqual(grant, {
    id: session.id,
    projectId: f.source.projectId,
    allocationId: f.input.allocationId,
    // Keyed as Pi keys a person; this source is an issued actor, not a member.
    person: digest({ projectId: f.source.projectId, actorId: f.source.actorId }),
    model: profile.model,
    expiresAt: new Date(
      Math.min(Date.parse(session.hardDeadline), Date.parse(f.input.expiresAt)),
    ).toISOString(),
  });
  assert.equal((await f.sessions.get(f.caller, session.id)).status, 'offered');
  assert.deepEqual(await f.sessions.managedModelGrant(session.id), grant);
  // A session no managed runner holds, a stopped allocation and a source without read get none.
  await assert.rejects(f.sessions.managedModelGrant(secret()), { code: 'unauthorized' });
  f.current(false);
  await assert.rejects(f.sessions.managedModelGrant(request.secret), { code: 'managed_revoked' });
  f.current(true);
  const worker = await f.sessions.authenticate(request.secret);
  const prepared = await f.sessions.prepare(worker, 'finish', {});
  await f.sessions.run(prepared, (caller) =>
    f.state.transaction((tx) =>
      f.handle.transition(
        caller,
        {
          instanceId: session.instanceId,
          expectedRevision: session.expectedRevision,
          action: 'finish',
          requestId: 'finish',
        },
        tx,
      ),
    ),
  );
  await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
  assert.equal((await f.sessions.get(f.caller, session.id)).closeReason, 'handoff');
  // Codex writes its closing turn after the handoff: the runner's minute of grace.
  now += 59_000;
  assert.deepEqual(await f.sessions.managedModelGrant(request.secret), grant);
  assert.deepEqual(await f.sessions.managedModelGrant(session.id), grant);
  // A relay validating an admitted stream by session id still depends on its original credential.
  await new CredentialStore(f.state, () => now).revoke(tokenDigest(request.secret), 'sessions');
  await assert.rejects(f.sessions.managedModelGrant(session.id), { code: 'unauthorized' });
  await assert.rejects(f.sessions.managedModelGrant(request.secret), { code: 'unauthorized' });
  now += 2_000;
  await assert.rejects(f.sessions.managedModelGrant(request.secret), { code: 'unauthorized' });
});

test('a model grant ends when the managed source loses read', async (t) => {
  const f = await fixture(t);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const request = f.lease();
  assert.ok((await f.sessions.lease(f.caller, request)).session);
  await f.sessions.managedModelGrant(request.secret);
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(
    f.sessions.managedModelGrant(request.secret),
    (error: any) => error?.status === 401 || error?.status === 403,
  );
});
