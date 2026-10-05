import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeService } from '@merv/code/service';
import { CodeStore } from '@merv/code/store/operations';
import { git, gitSource } from './fixtures/code-store.js';
import { boundProject } from './fixtures/code-binding.js';
import {
  createService,
  MervError,
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
    sourceKind?: 'human' | 'key' | 'service-human' | 'service-key';
    workHost?: boolean;
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
  const service = !!options.sourceKind?.startsWith('service');
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
          await scope.require(caller, service ? 'review' : 'write', tx);
        },
      },
    ],
    assignments: [
      {
        state: 'working',
        check: async ({ caller, tx }) => {
          await scope.require(caller, service ? 'review' : 'write', tx);
        },
        build: () => ({
          role: service ? 'reviewer' : 'producer',
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
          role: () => (service ? 'reviewer' : 'producer'),
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      },
    ],
  };
  const phases = ['working', 'review', 'rework', 'review_again'];
  if (options.workHost) {
    const template = policy.assignments![0]!;
    policy.assignments = phases.map((phase, index) => {
      const review = index % 2 === 1;
      const permission = review ? 'review' : 'write';
      return {
        ...template,
        state: phase,
        check: async ({ caller, tx }) => {
          await scope.require(caller, permission, tx);
        },
        build: () => ({
          role: review ? 'reviewer' : 'producer',
          label: 'Phase',
          brief: 'Fresh phase',
          references: [],
          handoff: { instruction: 'Finish', tools: ['finish'] },
          execution: { readOnly: review, tools: [] },
          context: null,
        }),
        execution: { ...template.execution!, readOnly: review },
        lease: {
          ...template.lease!,
          role: async ({ caller, tx }) => {
            await scope.require(caller, permission, tx);
            return review ? 'reviewer' : 'producer';
          },
        },
      };
    });
    policy.actions![0]!.states = phases;
    policy.actions![0]!.check = async ({ caller, snapshot, tx }) => {
      await scope.require(caller, phases.indexOf(snapshot.state) % 2 ? 'review' : 'write', tx);
    };
  }
  const handle = await workflows.register(
    {
      name: 'managed-test',
      version: 1,
      initial: 'working',
      states: options.workHost ? [...phases, 'done'] : ['working', 'done'],
      terminal: ['done'],
      edges: options.workHost
        ? phases.map((from, index) => ({ from, action: 'finish', to: phases[index + 1] ?? 'done' }))
        : [{ from: 'working', action: 'finish', to: 'done' }],
    },
    policy,
  );
  const boot = await scope.bootstrap({ projectName: 'Managed', actorName: 'Owner' });
  let owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issued = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
  let source: Caller = {
    actorId: issued.actor.id,
    projectId: boot.project.id,
    credentialId: issued.credential.id,
  };
  let revokePerson: (() => Promise<unknown>) | undefined;
  if (options.sourceKind) {
    const person = await scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example',
      subject: 'original-person',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const project = await scope.createProject(person, {
      name: 'Personal source',
      requestId: 'personal',
    });
    owner = source = await scope.caller(person, project.id);
    if (options.sourceKind.endsWith('key')) {
      const key = await scope.createKey(person, {
        projectId: project.id,
        label: 'Personal worker',
      });
      source = await scope.caller({ kind: 'key', key: await scope.authenticateKey(key.token) });
      revokePerson = () => scope.revokeKey(person, key.key.id);
    } else {
      revokePerson = undefined;
    }
    if (options.sourceKind.startsWith('service')) {
      const vouchedBy = await scope.delegationSource(source);
      source = {
        ...(await scope.serviceActor('fleet-review', project.id, undefined, 'reviewer')),
        service: { vouchedBy },
      };
    }
  }
  const sourceIdentity = await scope.delegationSource(source);
  const workTarget = options.workHost
    ? await handle.start(source, { workflow: 'managed-test', requestId: 'pinned-work' })
    : undefined;
  const reviewer = options.workHost
    ? await scope.serviceActor('fleet-review', source.projectId, undefined, 'reviewer')
    : undefined;

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
    assignmentSources: async () => [
      sourceIdentity,
      ...(reviewer
        ? [
            {
              kind: 'service' as const,
              actorId: reviewer.actorId,
              projectId: source.projectId,
              vouchedBy: sourceIdentity,
            },
          ]
        : []),
    ],
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
    ...(workTarget ? { workInstanceId: workTarget.id, stepSeconds: 900 } : {}),
    epoch: 1,
    source: sourceIdentity,
    runtimeProfileId: 'codex-profile',
    platform: profile,
    capabilities: [
      ...(options.codeWorkspace || options.reviewWorkspace ? ['code.v2'] : []),
      ...(options.workHost ? ['workflow.workhost.1'] : []),
    ],
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
    capabilities: [
      ...(options.codeWorkspace || options.reviewWorkspace ? ['code.v2'] : []),
      ...(options.workHost ? ['workflow.workhost.1'] : []),
    ],
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
    workTarget,
    revokePerson,
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

for (const sourceKind of [undefined, 'human', 'key', 'service-human', 'service-key'] as const) {
  test(`HF delivery uses only the attached managed lease's immutable ${sourceKind ?? 'actor'} source`, async (t) => {
    const f = await fixture(t, { sourceKind });
    const marker = 'hf_' + 'AccountMarker'.repeat(3);
    let token: string | null = marker;
    const identities: unknown[] = [];
    f.sessions.secrets = {
      resolveHuggingFaceToken: async (person) => {
        identities.push(person);
        return token;
      },
    };
    await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
    await f.sessions.setDispatch(f.owner, { enabled: true });
    await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
    const bound = (await f.sessions.lease(f.caller, f.lease())).session!;
    assert.ok(bound);
    const input = { sessionId: bound.id, runnerId: f.runnerId, hostRef: 'hf-host' };
    await assert.rejects(f.sessions.huggingface(f.caller, input), { code: 'host_conflict' });
    await f.sessions.attach(f.caller, input);
    await assert.rejects(f.sessions.huggingface(f.source, input), {
      code: 'managed_runner_forbidden',
    });
    await assert.rejects(
      f.sessions.huggingface({ ...f.caller, projectId: 'other-project' }, input),
    );
    await assert.rejects(f.sessions.huggingface(f.caller, { ...input, runnerId: 'other-runner' }), {
      code: 'session_forbidden',
    });
    await assert.rejects(
      f.sessions.huggingface(f.caller, { ...input, sessionId: 'session_other' }),
      { code: 'session_forbidden' },
    );
    await assert.rejects(f.sessions.huggingface(f.caller, { ...input, hostRef: 'other-host' }), {
      code: 'host_conflict',
    });
    assert.equal(identities.length, 0);
    assert.deepEqual(await f.sessions.huggingface(f.caller, input), {
      hfToken: sourceKind ? marker : null,
    });
    assert.deepEqual(
      identities,
      sourceKind ? [{ issuer: 'https://identity.example', subject: 'original-person' }] : [],
    );
    token = null;
    assert.deepEqual(await f.sessions.huggingface(f.caller, input), { hfToken: null });
    assert.ok(!JSON.stringify(await f.sessions.get(f.caller, bound.id)).includes(marker));
    f.current(false);
    const reads = identities.length;
    await assert.rejects(f.sessions.huggingface(f.caller, input), { code: 'managed_revoked' });
    f.current(true);
    if (sourceKind?.endsWith('key')) {
      await f.revokePerson!();
      await assert.rejects(f.sessions.huggingface(f.caller, input));
    } else {
      await f.sessions.release(f.caller, { sessionId: bound.id, runnerId: f.runnerId });
      await assert.rejects(f.sessions.huggingface(f.caller, input), { code: 'session_closed' });
    }
    assert.equal(identities.length, reads);
  });
}

test('sealed review gets no HF account credential', async (t) => {
  const f = await fixture(t, { sourceKind: 'human', reviewWorkspace: 'retained' });
  f.sessions.secrets = {
    resolveHuggingFaceToken: async () => {
      assert.fail('sealed review read a secret');
    },
  };
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const bound = (await f.sessions.lease(f.caller, f.lease())).session!;
  assert.ok(bound);
  const input = { sessionId: bound.id, runnerId: f.runnerId, hostRef: 'sealed-host' };
  const workspace = {
    mode: 'persistent' as const,
    baseOid: 'a'.repeat(40),
    headOid: 'a'.repeat(40),
    repositoryId: 'hf-repository',
    workspaceId: 'hf-workspace',
    branch: 'merv/hf-review',
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  await f.sessions.attach(f.caller, { ...input, workspace });
  assert.deepEqual(await f.sessions.huggingface(f.caller, input), { hfToken: null });
  assert.deepEqual(await f.sessions.huggingfaceAccess(f.caller, input), { access: null });
});

for (const sourceKind of ['human', 'key', 'service-human', 'service-key'] as const) {
  test(`HF broker rechecks frozen ${sourceKind} authority without the writer lock`, async (t) => {
    const f = await fixture(t, { sourceKind });
    let grant: import('@merv/secrets/types').HuggingFaceGrant | undefined;
    f.sessions.secrets = {
      resolveHuggingFaceToken: async () => {
        throw Error('raw token delivery used');
      },
      createHuggingFaceAccess: async (value) => {
        grant = value;
        return { token: 'opaque-test', endpoint: 'https://merv.example/hf' };
      },
    };
    await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
    await f.sessions.setDispatch(f.owner, { enabled: true });
    await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
    const session = (await f.sessions.lease(f.caller, f.lease())).session!;
    const input = { sessionId: session.id, runnerId: f.runnerId, hostRef: 'hf-proxy-host' };
    await assert.rejects(f.sessions.huggingfaceAccess(f.caller, input), { code: 'host_conflict' });
    await f.sessions.attach(f.caller, input);
    assert.ok((await f.sessions.huggingfaceAccess(f.caller, input)).access);
    assert.ok(grant);
    const expected = { issuer: 'https://identity.example', subject: 'original-person' };
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((r) => (release = r)),
      started = new Promise<void>((r) => (entered = r));
    const writer = f.state.transaction(async (tx) => {
      await tx.run('UPDATE worker_sessions SET id=id WHERE id=?', session.id);
      entered();
      await held;
    });
    await started;
    try {
      const deadline = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('HF read waited on writer')), 1000);
        timer.unref();
      });
      assert.deepEqual(
        await Promise.race([f.sessions.authorizeHuggingFaceGrant(grant), deadline]),
        expected,
      );
    } finally {
      release();
      await writer;
    }
    if (sourceKind === 'human') {
      const start = performance.now();
      for (let i = 0; i < 25; i++)
        await Promise.all(
          Array.from({ length: 8 }, () => f.sessions.authorizeHuggingFaceGrant(grant!)),
        );
      t.diagnostic(
        `200 HF authorization reads, batches of 8: ${Math.round(performance.now() - start)} ms`,
      );
    }
    for (const changed of [
      { epoch: grant.epoch + 1 },
      { runnerId: 'wrong' },
      { allocationId: 'wrong' },
      { sessionId: 'session_other' },
      { hostRef: 'wrong' },
    ])
      await assert.rejects(f.sessions.authorizeHuggingFaceGrant({ ...grant, ...changed }));
    f.current(false);
    await assert.rejects(f.sessions.authorizeHuggingFaceGrant(grant));
    f.current(true);
    if (sourceKind.endsWith('key')) await f.revokePerson!();
    else await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
    await assert.rejects(f.sessions.authorizeHuggingFaceGrant(grant));
  });
}

const nativeConnection = {
  name: 'sandboxes',
  url: 'https://sandbox.example/mcp',
  bearer: 'sbxt_' + 'PrivateNative'.repeat(4),
};
async function attachedNative(t: TestContext, options: Parameters<typeof fixture>[1] = {}) {
  const f = await fixture(t, options);
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: randomUUID() });
  const session = (await f.sessions.lease(f.caller, f.lease())).session!;
  const input = { sessionId: session.id, runnerId: f.runnerId, hostRef: 'native-host' };
  const workspace = options.reviewWorkspace
    ? {
        mode:
          options.reviewWorkspace === 'retained' ? ('persistent' as const) : ('ephemeral' as const),
        baseOid: 'a'.repeat(40),
        headOid: 'a'.repeat(40),
        repositoryId: 'native-repository',
        workspaceId: 'native-workspace',
        branch: 'merv/native-review',
        stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
      }
    : undefined;
  await f.sessions.attach(f.caller, { ...input, ...(workspace ? { workspace } : {}) });
  return { ...f, session, input };
}

test('private native issuance has immutable input, no database lock and no public secret state', async (t) => {
  const f = await attachedNative(t);
  assert.deepEqual(await f.sessions.launchConnections(f.caller, f.input), { connections: [] });
  let called = 0;
  const dispose = f.sessions.registerLaunchConnections(async (session) => {
    called++;
    assert.ok(Object.isFrozen(session));
    assert.ok(Object.isFrozen(session.execution));
    assert.ok(Object.isFrozen(session.assignment));
    assert.equal(f.state.ambient, undefined);
    await f.state.transaction((tx) =>
      tx.run('UPDATE worker_sessions SET id=id WHERE id=?', session.id),
    );
    return [nativeConnection];
  });
  assert.throws(() => f.sessions.registerLaunchConnections(async () => []), {
    code: 'launch_connections_registered',
  });
  for (const patch of [{ hostRef: 'other' }, { runnerId: 'other' }, { sessionId: 'session_other' }])
    await assert.rejects(f.sessions.launchConnections(f.caller, { ...f.input, ...patch }));
  await assert.rejects(f.sessions.launchConnections({ ...f.caller, projectId: 'other' }, f.input));
  assert.equal(called, 0);
  assert.deepEqual(await f.sessions.launchConnections(f.caller, f.input), {
    connections: [nativeConnection],
  });
  assert.equal(called, 1);
  assert.ok(
    !JSON.stringify(await f.sessions.get(f.caller, f.session.id)).includes(nativeConnection.bearer),
  );
  const stored = await f.state.read((tx) =>
    tx.get<{ session_json: string }>(
      'SELECT session_json FROM worker_sessions WHERE id=?',
      f.session.id,
    ),
  );
  assert.ok(!stored!.session_json.includes(nativeConnection.bearer));
  dispose();
  assert.deepEqual(await f.sessions.launchConnections(f.caller, f.input), { connections: [] });
});

for (const race of ['release', 'managed-revoke', 'provider-unload', 'expiry'] as const) {
  test(`private native issuance withholds credentials after ${race}`, async (t) => {
    let now = Date.now();
    const f = await attachedNative(t, { clock: () => now });
    const dispose = f.sessions.registerLaunchConnections(async () => {
      if (race === 'release')
        await f.sessions.release(f.caller, {
          sessionId: f.input.sessionId,
          runnerId: f.input.runnerId,
        });
      else if (race === 'managed-revoke') f.current(false);
      else if (race === 'provider-unload') dispose();
      else now = Date.parse(f.session.hardDeadline) + 1;
      return [nativeConnection];
    });
    await assert.rejects(f.sessions.launchConnections(f.caller, f.input), (error: any) => {
      assert.ok(!String(error).includes(nativeConnection.bearer));
      return [
        'session_closed',
        'managed_revoked',
        'execution_replaced',
        'session_expired',
        'unauthorized',
      ].includes(error.code);
    });
  });
}

test('native provider errors and malformed responses cannot expose credentials', async (t) => {
  const f = await attachedNative(t);
  const dispose = f.sessions.registerLaunchConnections(async () => {
    throw Error(nativeConnection.bearer);
  });
  await assert.rejects(
    f.sessions.launchConnections(f.caller, f.input),
    (error: any) =>
      error.code === 'launch_connections_unavailable' &&
      !String(error).includes(nativeConnection.bearer),
  );
  dispose();
  f.sessions.registerLaunchConnections(async () => [{ ...nativeConnection, name: 'merv' }]);
  await assert.rejects(f.sessions.launchConnections(f.caller, f.input), {
    code: 'invalid_launch_connections',
  });
});

for (const status of [401, 403])
  test(`revoked launch access (${status}) fails without retrying or exposing credentials`, async (t) => {
    const f = await attachedNative(t);
    f.sessions.registerLaunchConnections(async () => {
      throw new MervError('provider_denied', nativeConnection.bearer, status);
    });
    await assert.rejects(f.sessions.launchConnections(f.caller, f.input), (error: unknown) => {
      assert.ok(error instanceof MervError);
      assert.equal(error.status, 409);
      assert.equal(error.code, 'launch_connections_denied');
      assert.ok(!error.message.includes(nativeConnection.bearer));
      return true;
    });
  });

for (const workspace of ['retained', 'ephemeral'] as const) {
  test(`native connection ${workspace === 'retained' ? 'is withheld from sealed' : 'can reach explicitly allowed'} review`, async (t) => {
    const f = await attachedNative(t, { reviewWorkspace: workspace });
    let calls = 0;
    f.sessions.registerLaunchConnections(async () => {
      calls++;
      return [nativeConnection];
    });
    assert.deepEqual(await f.sessions.launchConnections(f.caller, f.input), {
      connections: workspace === 'retained' ? [] : [nativeConnection],
    });
    assert.equal(calls, workspace === 'retained' ? 0 : 1);
  });
}

test('one work host runs four fresh producer/reviewer phases with retained binding history', async (t) => {
  const f = await fixture(t, { workHost: true });
  const connectionSources: string[] = [];
  f.sessions.registerLaunchConnections(async (session) => {
    connectionSources.push(session.source.kind);
    return [
      { name: 'sandboxes', url: 'https://sandbox.invalid/mcp', bearer: 'private-phase-connection' },
    ];
  });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  // A second ready unit must never be selected, even after the pinned work ends.
  await f.handle.start(f.source, { workflow: 'managed-test', requestId: 'foreign-unit' });
  const sessions: string[] = [],
    actors: string[] = [],
    tokens: string[] = [];
  for (let phase = 0; phase < 4; phase++) {
    const request = f.lease();
    const result = await f.sessions.lease(f.caller, request);
    assert.ok(result.session, result.reason);
    const session = result.session;
    assert.equal(session.instanceId, f.workTarget!.id);
    assert.ok(
      Date.parse(session.hardDeadline) - Date.parse(session.createdAt) <= 900_000,
      'server caps each phase',
    );
    assert.equal(session.role, phase % 2 ? 'reviewer' : 'producer');
    assert.equal(session.source.kind, phase % 2 ? 'service' : 'actor');
    assert.equal(
      (await f.sessions.lease(f.caller, request)).session?.id,
      session.id,
      'exact request replays',
    );
    assert.equal((await f.sessions.lease(f.caller, f.lease())).reason, 'capacity_full');
    sessions.push(session.id);
    actors.push(session.actorId);
    tokens.push(request.secret);
    if (phase) {
      await assert.rejects(f.sessions.managedModelGrant(tokens[phase - 1]!), {
        code: 'unauthorized',
      });
      await assert.rejects(f.sessions.managedModelGrant(sessions[phase - 1]!), {
        code: 'unauthorized',
      });
    }
    await f.sessions.attach(f.caller, {
      sessionId: session.id,
      runnerId: f.runnerId,
      hostRef: `launch-${phase}`,
    });
    assert.equal(
      (
        await f.sessions.launchConnections(f.caller, {
          sessionId: session.id,
          runnerId: f.runnerId,
          hostRef: `launch-${phase}`,
        })
      ).connections.length,
      1,
    );
    if (phase)
      await assert.rejects(f.sessions.get(f.caller, sessions[phase - 1]!), {
        code: 'session_forbidden',
      });
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
            requestId: `phase-${phase}`,
          },
          tx,
        ),
      ),
    );
    assert.equal(
      (await f.sessions.lease(f.caller, f.lease())).reason,
      'capacity_full',
      'closure alone cannot reuse a process',
    );
    await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
  }
  assert.deepEqual(connectionSources, ['actor', 'service', 'actor', 'service']);
  assert.equal(new Set(sessions).size, 4);
  assert.equal(new Set(actors).size, 4);
  assert.equal(
    (await f.sessions.lease(f.caller, f.lease())).session,
    null,
    'never lease the unrelated work',
  );
  const rows = await f.state.read((tx) =>
    tx.all<any>(
      'SELECT * FROM session_managed_assignments WHERE allocation_id=? ORDER BY bound_at,session_id',
      f.input.allocationId,
    ),
  );
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.release_ack_at && row.settled_at));
  assert.equal(
    (await f.state.read((tx) =>
      tx.get<any>(
        'SELECT bound_session_id FROM session_managed_runners WHERE allocation_id=?',
        f.input.allocationId,
      ),
    ))!.bound_session_id,
    null,
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run('DELETE FROM session_managed_assignments WHERE session_id=?', sessions[0]),
    ),
    { code: 'state_constraint' },
  );
  await assert.rejects(
    f.state.transaction((tx) =>
      tx.run(
        'UPDATE session_managed_runners SET work_instance_id=? WHERE allocation_id=?',
        'other',
        f.input.allocationId,
      ),
    ),
    { code: 'state_constraint' },
  );
  const presence = await f.state.read((tx) =>
    tx.all('SELECT id FROM session_runners WHERE runner_id=?', f.runnerId),
  );
  assert.equal(presence.length, 1, 'phase sources do not create separate physical presences');
});

test('work host keeps capture and transcript barriers, settings, source authority and global capacity', async (t) => {
  let now = Date.now();
  const f = await fixture(t, { workHost: true, codeWorkspace: true, clock: () => now });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const presence = await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  const concurrent = await Promise.all([
    f.sessions.lease(f.caller, f.lease()),
    f.sessions.lease(f.caller, f.lease()),
  ]);
  assert.equal(concurrent.filter((x) => x.session).length, 1);
  const session = concurrent.find((x) => x.session)!.session!;
  const control = { sessionId: session.id, runnerId: f.runnerId, hostRef: 'reuse-capture' };
  const workspace = {
    repositoryId: 'repo',
    workspaceId: 'work',
    mode: 'persistent' as const,
    branch: 'merv/work/test',
    baseOid: 'a'.repeat(40),
    headOid: 'a'.repeat(40),
    stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
  };
  await f.sessions.attach(f.caller, { ...control, workspace });
  const stored = new Map<string, number>();
  f.sessions.transcripts.blobs = {
    put: async () => assert.fail(),
    get: async () => assert.fail(),
    upload: async () => ({
      url: 'https://test.invalid/upload',
      headers: {},
      expiresAt: new Date(now + 3600000).toISOString(),
    }),
    stored: async (ns, hash) => stored.get(`${ns}/${hash}`) ?? null,
  };
  const transcript = {
    ...control,
    sha256: 'b'.repeat(64),
    size: 10,
    logBytes: 10,
    truncated: false,
  };
  await f.sessions.transcript(f.caller, transcript);
  await f.sessions.release(f.caller, { sessionId: session.id, runnerId: f.runnerId });
  assert.equal((await f.sessions.lease(f.caller, f.lease())).reason, 'capacity_full');
  await f.sessions.workspaceResult(f.caller, { ...control, workspace });
  assert.equal(
    (await f.sessions.lease(f.caller, f.lease())).reason,
    'capacity_full',
    'transcript still owed',
  );
  now += 31 * 60_000;
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))!.session!.capturePending,
    true,
    'expiry grace cannot authorize reuse',
  );
  stored.set(`transcripts-${session.projectId}/${transcript.sha256}`, 10);
  await f.sessions.transcript(f.caller, { ...transcript, deliver: true });
  assert.equal(
    (await f.sessions.inspectManaged(f.input.allocationId, 1))!.session!.capturePending,
    false,
  );
  // A settings hold is checked under the one host presence, including later phase sources.
  await f.sessions.setRunnerSettings(f.owner, {
    runnerId: presence.id,
    settings: { platforms: [{ name: profile.name, enabled: false, parallelism: 1 }] },
  });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  assert.equal((await f.sessions.lease(f.caller, f.lease())).reason, 'platform_disabled');
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(f.sessions.lease(f.caller, f.lease()), (error: any) =>
    [401, 403].includes(error.status),
  );
});

test('revoking the host sponsor ends its review phase and never restores old producer credentials', async (t) => {
  const f = await fixture(t, { workHost: true });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  const firstRequest = f.lease();
  const first = (await f.sessions.lease(f.caller, firstRequest)).session!;
  const worker = await f.sessions.authenticate(firstRequest.secret);
  const prepared = await f.sessions.prepare(worker, 'finish', {});
  await f.sessions.run(prepared, (caller) =>
    f.state.transaction((tx) =>
      f.handle.transition(
        caller,
        {
          instanceId: first.instanceId,
          expectedRevision: first.expectedRevision,
          action: 'finish',
          requestId: 'review-next',
        },
        tx,
      ),
    ),
  );
  await f.sessions.release(f.caller, { sessionId: first.id, runnerId: f.runnerId });
  const nextRequest = f.lease();
  const next = (await f.sessions.lease(f.caller, nextRequest)).session!;
  assert.equal(next.role, 'reviewer');
  assert.equal((await f.sessions.managedModelGrant(nextRequest.secret)).id, next.id);
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(f.sessions.managedModelGrant(nextRequest.secret), (error: any) =>
    [401, 403].includes(error.status),
  );
  await assert.rejects(f.sessions.authenticateManaged(f.enrolled.controlToken), (error: any) =>
    [401, 403].includes(error.status),
  );
  // Its old producer credential is still revoked; changing source never transfers it.
  await assert.rejects(f.sessions.managedModelGrant(firstRequest.secret), { code: 'unauthorized' });
});

test('work-host Code transfers use only the unfinished assignment, including closed final capture', async (t) => {
  const f = await fixture(t, { workHost: true });
  const root = mkdtempSync(join(tmpdir(), 'merv-managed-code-'));
  const source = gitSource(t);
  const head = source.commit({ 'tracked.txt': 'evidence' });
  const core = await createService(new CodeService(f.state, f.scope, {}));
  await boundProject(f.state, f.owner.projectId, head);
  let finalized = 0;
  const store = new CodeStore(
    f.state,
    f.scope,
    { root, reservedFreeBytes: 1 },
    {
      imported: async () => {},
      workspaces: async () => [],
      frozen: async () => [],
      fenced: async () => {},
      advanced: async () => {
        finalized++;
      },
      quarantined: async () => {},
    },
  );
  await store.initialize();
  const repository = store.repositories.paths(f.owner.projectId).repository;
  mkdirSync(dirname(repository), { recursive: true });
  git(root, ['clone', '--quiet', '--bare', source.repository, repository]);
  t.after(async () => {
    await store.close();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.sessions.heartbeatRunner(f.caller, f.heartbeat(1));
  const request = f.lease();
  const first = (await f.sessions.lease(f.caller, request)).session!;
  const caller = await f.sessions.authenticateManaged(f.enrolled.controlToken);
  assert.equal(caller.managed!.boundSessionId, first.id);
  const read = (who: Caller, sessionId = first.id) =>
    store.export(who, { sessionId, head, haves: [head] });
  assert.deepEqual(await read(caller), { upToDate: true, head });
  const final = {
    kind: 'final' as const,
    sessionId: first.id,
    runnerId: f.runnerId,
    hostRef: 'code-launch',
    leaseId: first.lease.leaseId,
    unitId: first.instanceId,
    generation: 1,
    expectedHead: head,
    proposedHead: head,
    treeOid: source.git('rev-parse', 'HEAD^{tree}'),
    bundle: null,
  };
  await f.sessions.attach(caller, {
    sessionId: first.id,
    runnerId: f.runnerId,
    hostRef: 'code-launch',
  });
  const worker = await f.sessions.authenticate(request.secret);
  const prepared = await f.sessions.prepare(worker, 'finish', {});
  await f.sessions.run(prepared, (who) =>
    f.state.transaction((tx) =>
      f.handle.transition(
        who,
        {
          instanceId: first.instanceId,
          expectedRevision: first.expectedRevision,
          action: 'finish',
          requestId: 'next',
        },
        tx,
      ),
    ),
  );
  await f.sessions.release(caller, { sessionId: first.id, runnerId: f.runnerId });
  // Closure does not revoke the supervisor's owed final transfer before settlement.
  assert.equal((await store.beginUpload(caller, final)).status, 'completed');
  assert.equal(finalized, 1);
  const second = (await f.sessions.lease(f.caller, f.lease())).session!;
  assert.ok(second);
  const successor = await f.sessions.authenticateManaged(f.enrolled.controlToken);
  assert.equal(successor.managed!.boundSessionId, second.id);
  await assert.rejects(read(caller), { code: 'unauthorized' });
  await assert.rejects(store.beginUpload(caller, final), { code: 'unauthorized' });
  await assert.rejects(read(successor), { code: 'managed_runner_forbidden' });
  await assert.rejects(store.beginUpload(successor, final), { code: 'managed_runner_forbidden' });
  assert.deepEqual(await read(successor, second.id), { upToDate: true, head });
  const prior = { sessionId: first.id, runnerId: f.runnerId, hostRef: 'code-launch' };
  for (const action of [
    () => f.sessions.attach(successor, prior),
    () => f.sessions.release(successor, { sessionId: first.id, runnerId: f.runnerId }),
    () =>
      f.sessions.workspaceResult(successor, {
        ...prior,
        workspace: {
          repositoryId: 'repo',
          workspaceId: 'work',
          mode: 'persistent',
          branch: 'merv/work/test',
          baseOid: head,
          headOid: head,
          stats: { commitCount: 0, filesChanged: 0, insertions: 0, deletions: 0 },
        },
      }),
    () => f.sessions.launchConnections(successor, prior),
  ])
    await assert.rejects(action(), { code: 'session_forbidden' });
});
