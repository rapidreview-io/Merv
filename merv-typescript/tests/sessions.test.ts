import {
  check,
  createService,
  type Caller,
  type Transaction,
  type WorkflowPolicy,
} from '@merv/contracts';
import { DurableEvents } from '@merv/domain-events';
import { ProjectScope } from '@merv/scope';
import { LeasedSessions } from '@merv/sessions';
import { WorkflowsService } from '@merv/workflows';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { openState } from './fixtures/state.js';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext) {
  let clock = Date.now(),
    builds = 0,
    brokenBuild = false,
    largeBuild = false;
  let buildHook: ((tx: Transaction) => void | Promise<void>) | undefined;
  let leaseCheckHook: (() => void | Promise<void>) | undefined;
  const state = await openState();
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state)),
    access = scope.toolPolicy;
  await state.migrate('session_fixture', [
    {
      version: 1,
      sql: 'CREATE TABLE reservations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,live INTEGER NOT NULL);',
    },
  ]);
  const policy = (): WorkflowPolicy => ({
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
        build: async ({ tx }) => {
          builds++;
          await buildHook?.(tx);
          if (brokenBuild) throw new Error('Context must not be rebuilt');
          return {
            role: 'producer',
            label: 'Work',
            brief: largeBuild ? 'x'.repeat(600_000) : 'Frozen brief',
            references: [],
            handoff: { instruction: 'Finish', tools: ['finish'] },
            execution: { readOnly: false, tools: [] },
            context: null,
          };
        },
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
            {
              name: 'artifact.read',
              alternatives: [{ artifactId: { kind: 'oneOf', name: 'artifacts' } }],
            },
            {
              name: 'workflow.assignment',
              alternatives: [{ instanceId: { kind: 'target', field: 'instanceId' } }],
            },
          ],
        },
        references: () => ({ artifacts: ['frozen-artifact'] }),
        lease: {
          role: async ({ caller, tx }) => {
            await scope.require(caller, 'write', tx);
            return 'producer' as const;
          },
          acquire: async ({ caller, tx, leaseId }) => {
            await scope.require(caller, 'write', tx);
            await tx.run('INSERT INTO reservations VALUES(?,?,1)', leaseId, caller.actorId);
            return { leaseId };
          },
          check: async ({ caller, tx }, receipt) => {
            await leaseCheckHook?.();
            check(
              await tx.get(
                'SELECT id FROM reservations WHERE id=? AND actor_id=? AND live=1',
                receipt.leaseId as string,
                caller.actorId,
              ),
              'claim_lost',
              'Worker no longer owns this reservation',
              409,
            );
          },
          release: async ({ lease, tx }) => {
            await tx.run(
              'UPDATE reservations SET live=0 WHERE id=? AND actor_id=?',
              lease.leaseId,
              lease.actorId,
            );
          },
        },
      },
    ],
  });
  const definition = {
    name: 'session-fixture',
    version: 1,
    initial: 'working',
    states: ['working', 'done'],
    terminal: ['done'],
    edges: [{ from: 'working', action: 'finish', to: 'done' }],
  };
  let handle = await workflows.register(definition, policy());
  const boot = await scope.credentials.bootstrap({ projectName: 'Sessions', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await scope.credentials.issueActor(owner, {
    name: 'Producer',
    role: 'producer',
  });
  const source: Caller = {
    actorId: producer.actor.id,
    projectId: boot.project.id,
    credentialId: producer.credential.id,
  };
  let sessions = await createService(
    new LeasedSessions(state, scope, workflows, events, {
      clock: () => clock,
      sweepIntervalMs: 60_000,
    }),
  );
  const instance = async (caller = source) =>
    await handle.start(caller, {
      workflow: definition.name,
      requestId: randomBytes(10).toString('hex'),
    });
  const offer = async (caller = source) => {
    const target = await instance(caller);
    const token = secret();
    const input = {
      instanceId: target.id,
      expectedRevision: 0,
      runnerId: 'runner',
      requestId: randomBytes(10).toString('hex'),
      secret: token,
    };
    return { input, token, session: await sessions.offer(caller, input) };
  };
  t.after(async () => {
    await sessions.close();
    await events.close();
    await workflows.close();
    await state.close();
  });
  return {
    state,
    scope,
    workflows,
    events,
    access,
    owner,
    source,
    producer,
    boot,
    instance,
    offer,
    get sessions() {
      return sessions;
    },
    get handle() {
      return handle;
    },
    get builds() {
      return builds;
    },
    advance(ms: number) {
      clock += ms;
    },
    time() {
      return clock;
    },
    poison() {
      brokenBuild = true;
    },
    large() {
      largeBuild = true;
    },
    onBuild(hook: (tx: Transaction) => void | Promise<void>) {
      buildHook = hook;
    },
    onLeaseCheck(hook: () => void | Promise<void>) {
      leaseCheckHook = hook;
    },
    async reload() {
      handle.dispose();
      handle = await workflows.register(definition, policy());
    },
    async restart() {
      await sessions.close();
      handle.dispose();
      handle = await workflows.register(definition, policy());
      sessions = await createService(
        new LeasedSessions(state, scope, workflows, events, {
          clock: () => clock,
          sweepIntervalMs: 60_000,
        }),
      );
    },
  };
}

test('offers reserve one worker, store only the digest, bind receipts to source and runner, and cannot issue worker tokens', async (t) => {
  const f = await fixture(t),
    token = secret();
  const input = {
    instanceId: (await f.instance()).id,
    expectedRevision: 0,
    runnerId: 'runner',
    requestId: 'offer',
    secret: token,
  };
  const supplied = { ...input },
    source = { ...f.source };
  const offering = f.sessions.offer(source, supplied);
  Object.assign(source, f.owner);
  Object.assign(supplied, { runnerId: 'replacement', secret: secret() });
  const session = await offering;
  assert.equal(session.source.actorId, f.source.actorId);
  assert.equal(session.runnerId, input.runnerId);
  assert.equal(session.status, 'offered');
  assert.notEqual(session.actorId, f.source.actorId);
  assert.equal(session.source.kind, 'actor');
  assert.equal((await f.workflows.workStarts(f.source, session.instanceId)).length, 0);
  assert.deepEqual(await f.sessions.offer(f.source, input), session);
  await assert.rejects(
    async () => await f.sessions.offer(f.source, { ...input, secret: secret() }),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () => await f.sessions.offer(f.source, { ...input, requestId: 'other' }),
    {
      code: 'session_conflict',
    },
  );
  await assert.rejects(async () => await f.sessions.get(f.owner, session.id), {
    code: 'session_forbidden',
  });
  await assert.rejects(
    async () => await f.sessions.heartbeat(f.source, { sessionId: session.id, runnerId: 'runner' }),
    { code: 'session_not_active' },
  );
  const attachment = { sessionId: session.id, runnerId: 'runner', hostRef: 'host-a' };
  const pendingAttachment = f.sessions.attach(f.source, attachment);
  Object.assign(attachment, { sessionId: 'missing', runnerId: 'other', hostRef: '' });
  const attached = await pendingAttachment;
  assert.equal(attached.hostRef, 'host-a');
  assert.equal(attached.activatedAt, null);
  await assert.rejects(
    async () =>
      await f.sessions.attach(f.source, {
        sessionId: session.id,
        runnerId: 'runner',
        hostRef: 'host-b',
      }),
    { code: 'host_conflict' },
  );
  await assert.rejects(
    async () =>
      await f.scope.require({ actorId: session.actorId, projectId: session.projectId }, 'read'),
    { code: 'forbidden' },
  );
  await assert.rejects(
    async () =>
      await f.scope.credentials.issueActorCredential(f.owner, { actorId: session.actorId }),
    {
      code: 'member_actor',
    },
  );
  const storage = await f.state.read(async (sql) =>
    JSON.stringify(await sql.all('SELECT * FROM worker_sessions')),
  );
  assert.doesNotMatch(storage, new RegExp(token));
  assert.doesNotMatch(JSON.stringify(await f.state.events(session.projectId)), new RegExp(token));
  assert.equal(await f.scope.recognizesCredential(token), true);
  const caller = await f.sessions.authenticate(token);
  assert.deepEqual(caller, {
    actorId: session.actorId,
    projectId: session.projectId,
    session: { id: session.id, threadId: session.threadId },
  });
  await assert.rejects(
    async () => await f.sessions.offer(caller, { ...input, secret: secret(), requestId: 'nested' }),
    { code: 'nested_session' },
  );
});

test('durable human authority outlives the initiating JWT but never a membership epoch', async (t) => {
  const f = await fixture(t);
  const human = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test/auth/v1',
    subject: 'owner',
    expiresAt: new Date(f.time() + 1000).toISOString(),
  });
  const project = await f.scope.members.createProject(human, {
    name: 'Human leases',
    requestId: 'human-project',
  });
  await f.scope.members.addMember(human, project.id, { subject: 'worker', role: 'producer' });
  const user = await f.scope.members.acceptVerifiedIdentity({
    issuer: human.user.issuer,
    subject: 'worker',
    expiresAt: human.expiresAt,
  });
  const caller = await f.scope.caller(user, project.id),
    { token, session } = await f.offer(caller);
  f.advance(1500);
  assert.equal(
    (await f.sessions.authenticate(token)).actorId,
    session.actorId,
    'The lease pins current membership, not the initiating JWT expiry',
  );
  const refreshed = await f.scope.members.acceptVerifiedIdentity({
    ...human.user,
    expiresAt: new Date(f.time() + 100_000).toISOString(),
  });
  await f.scope.members.removeMember(refreshed, project.id, 'worker');
  await f.scope.members.addMember(refreshed, project.id, { subject: 'worker', role: 'producer' });
  await f.sessions.sweep();
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'unauthorized',
  });
  const row = (await f.state.read(
    async (sql) =>
      await sql.get<{ status: string }>(
        'SELECT status FROM worker_sessions WHERE id=?',
        session.id,
      ),
  ))!;
  assert.equal(row.status, 'expired');
});

test('one invocation may finish its own handoff transaction, while later calls and revoked sources are fenced', async (t) => {
  const f = await fixture(t),
    { token, session } = await f.offer();
  const worker = await f.sessions.authenticate(token),
    prepared = await f.sessions.invocations.prepare(worker, 'finish', {});
  assert.deepEqual(prepared.input, { instanceId: session.instanceId, expectedRevision: 0 });
  await f.sessions.invocations.run(
    prepared,
    async (caller) =>
      await f.state.transaction(async (tx) => {
        await f.scope.require(caller, 'write', tx);
        await f.handle.transition(
          caller,
          {
            instanceId: session.instanceId,
            expectedRevision: 0,
            action: 'finish',
            requestId: 'finish',
          },
          tx,
        );
        assert.equal(
          (await f.scope.require(caller, 'write', tx)).id,
          session.actorId,
          'Node fence is memoized only for this invocation transaction',
        );
      }),
  );
  await assert.rejects(
    f.sessions.invocations.run(prepared, () => {}),
    { code: 'session_invocation' },
  );
  await assert.rejects(async () => await f.scope.require(prepared.caller, 'read'), {
    code: 'session_invocation',
  });
  // The record moved by the worker's own hand. Workflows sees only a stale revision; Sessions
  // tells the worker its handoff landed.
  await assert.rejects(async () => await f.scope.require(worker, 'read'), {
    code: 'session_completed',
    status: 409,
  });
  // The session ends as a completed handoff, whichever path meets it first; a halt that finds
  // it so halts nothing.
  assert.equal((await f.sessions.dispatch.halt(f.owner, { sessionId: session.id })).halted, 0);
  // And it keeps saying so. A worker retrying a handoff whose response was lost has only
  // this refusal to tell it the work committed.
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'unauthorized',
  });
  const done = await f.sessions.get(f.source, session.id);
  assert.equal(done.status, 'released');
  assert.equal(done.outcome, 'completed');
  assert.equal(done.closeReason, 'handoff');

  const next = await f.offer(),
    second = await f.sessions.authenticate(next.token),
    invocation = await f.sessions.invocations.prepare(second, 'finish', {});
  let wrote = false;
  await f.scope.credentials.revokeCredential(f.owner, f.source.credentialId!);
  // The call was validated once, when prepared; its write re-checks the source in its own
  // transaction and is refused.
  await assert.rejects(
    f.sessions.invocations.run(
      invocation,
      async (caller) =>
        await f.state.transaction(async (tx) => {
          await f.scope.require(caller, 'write', tx);
          wrote = true;
        }),
    ),
  );
  assert.equal(wrote, false);
  await assert.rejects(async () => await f.scope.require(invocation.caller, 'read'));
});

test('frozen references survive reload, a prepared generation does not, and cancellation removes invocation authority', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const caller = await f.sessions.authenticate(token);
  const input = { artifactId: 'frozen-artifact', options: { format: 'original' } };
  const pending = f.sessions.invocations.prepare(caller, 'artifact.read', input);
  input.artifactId = 'other-artifact';
  input.options.format = 'changed';
  const prepared = await pending;
  assert.deepEqual(prepared.input, {
    artifactId: 'frozen-artifact',
    options: { format: 'original' },
  });
  await assert.rejects(
    async () =>
      await f.sessions.invocations.prepare(caller, 'artifact.read', {
        artifactId: 'other-artifact',
      }),
    { code: 'execution_arguments_forbidden' },
  );
  await f.reload();
  await assert.rejects(
    f.sessions.invocations.run(prepared, () => {}),
    { code: 'execution_replaced' },
  );
  await f.restart();
  const restored = await f.sessions.authenticate(token);
  const next = await f.sessions.invocations.prepare(restored, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  const parsed = { ...next.input, options: { format: 'parsed' } };
  const validatingCaller = structuredClone(next.caller);
  const validating = f.sessions.invocations.validate(validatingCaller, next.tool, parsed);
  validatingCaller.session!.invocationId = 'missing';
  parsed.options.format = 'changed';
  await validating;
  await f.sessions.invocations.validate(next.caller, next.tool, {
    ...next.input,
    options: { format: 'parsed' },
  });
  let getters = 0;
  const unsafe = Object.defineProperty({ options: { format: 'parsed' } }, 'artifactId', {
    enumerable: true,
    get() {
      getters++;
      return 'frozen-artifact';
    },
  });
  for (const method of ['prepare', 'validate'] as const)
    await assert.rejects(f.sessions.invocations[method](next.caller, next.tool, unsafe), {
      code: 'invalid_input',
    });
  assert.equal(getters, 0);
  await f.sessions.invocations.cancel(next);
  await assert.rejects(
    async () => await f.sessions.invocations.validate(next.caller, next.tool, next.input),
    {
      code: 'session_invocation',
    },
  );
  const forged = {
    ...(await f.sessions.invocations.prepare(restored, 'artifact.read', {
      artifactId: 'frozen-artifact',
    })),
  };
  await assert.rejects(
    f.sessions.invocations.run(forged, () => {}),
    { code: 'session_invocation' },
  );
});

test('key revocation drains immediately and replacement keys never inherit leases', async (t) => {
  const f = await fixture(t);
  const human = await f.scope.members.acceptVerifiedIdentity({
    issuer: 'https://identity.test/auth/v1',
    subject: 'key-owner',
    expiresAt: new Date(f.time() + 100_000).toISOString(),
  });
  const project = await f.scope.members.createProject(human, {
    name: 'Key sessions',
    requestId: 'key-project',
  });
  const first = await f.scope.userKeys.create(human, { projectId: project.id });
  const keyCaller = await f.scope.caller(
    { kind: 'key', key: await f.scope.userKeys.authenticate(first.token) },
    project.id,
  );
  const offered = await f.offer(keyCaller);
  const replacement = await f.scope.userKeys.rotate(human, { keyId: first.key.id });
  await f.sessions.sweep();
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          offered.session.id,
        ),
    ))!.status,
    'expired',
  );
  await assert.rejects(async () => await f.sessions.authenticate(offered.token), {
    code: 'unauthorized',
  });
  const replacementCaller = await f.scope.caller(
    { kind: 'key', key: await f.scope.userKeys.authenticate(replacement.token) },
    project.id,
  );
  assert.equal((await f.scope.require(replacementCaller, 'write')).id, keyCaller.actorId);
  const next = await f.offer(replacementCaller);
  await f.scope.userKeys.revoke(human, replacement.key.id);
  await f.sessions.sweep();
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          next.session.id,
        ),
    ))!.status,
    'expired',
  );
  assert.equal(
    (await f.workflows.workStarts(await f.scope.caller(human, project.id), next.session.instanceId))
      .length,
    0,
  );
});

const runnerPlatform = { name: 'codex', harness: 'codex' as const, enabled: true, parallelism: 1 };
const presenceInput = {
  runnerId: 'machine',
  machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
  platforms: [runnerPlatform],
  capacity: 1,
};
const autoInput = (requestId = randomBytes(10).toString('hex')) => ({
  runnerId: 'machine',
  requestId,
  secret: secret(),
  platform: { name: 'codex', harness: 'codex' as const },
});

test('automatic leases need fresh source-bound presence, count offered capacity, and preserve request identity', async (t) => {
  const f = await fixture(t);
  await f.instance();
  await f.instance();
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  await assert.rejects(async () => await f.sessions.dispatch.lease(f.source, autoInput()), {
    code: 'runner_required',
  });
  await f.sessions.dispatch.heartbeatRunner(f.source, presenceInput);
  f.advance(45_001);
  assert.equal((await f.sessions.dispatch.lease(f.source, autoInput())).reason, 'runner_offline');
  await f.sessions.dispatch.heartbeatRunner(f.source, presenceInput);
  // The two leases race for the writer lock, so either may win; only one may.
  const inputs = [autoInput(), autoInput()];
  const competing = await Promise.all(
    inputs.map((input) =>
      Promise.resolve().then(async () => await f.sessions.dispatch.lease(f.source, input)),
    ),
  );
  assert.equal(competing.filter((item) => item.session).length, 1);
  const winner = competing.findIndex((item) => item.session);
  assert.equal(competing[1 - winner].reason, 'capacity_full');
  assert.equal(
    (await f.sessions.dispatch.lease(f.source, inputs[winner])).session!.id,
    competing[winner].session!.id,
  );
  await assert.rejects(
    async () => await f.sessions.dispatch.lease(f.source, { ...inputs[winner], secret: secret() }),
    {
      code: 'request_conflict',
    },
  );
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM session_dispatch_receipts'))!.n,
    ),
    1,
  );
  await assert.rejects(
    async () => await f.sessions.dispatch.lease(f.owner, autoInput()),
    { code: 'runner_required' },
    'Runner label alone is not registration authority',
  );
  assert.equal((await f.sessions.dispatch.projectStatus(f.owner)).runners[0].live, true);
  await f.scope.credentials.revokeCredential(f.owner, f.source.credentialId!);
  assert.equal(
    (await f.sessions.dispatch.projectStatus(f.owner)).runners[0].live,
    false,
    'Fresh metadata cannot make a revoked source online',
  );
});
