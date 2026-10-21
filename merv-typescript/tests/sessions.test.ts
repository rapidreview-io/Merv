import {
  MervError,
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
import { z } from 'zod';
import { ToolRegistry } from '../packages/api/src/registry.js';
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

test('activation is metadata-only and once; active heartbeat is bounded, expiry retires only the worker and recovers its claim', async (t) => {
  const f = await fixture(t),
    { token, session } = await f.offer();
  const builds = f.builds;
  f.poison();
  const worker = await f.sessions.authenticate(token);
  assert.deepEqual(await f.sessions.authenticate(token), worker);
  assert.equal(f.builds, builds);
  assert.equal((await f.workflows.workStarts(f.source, session.instanceId)).length, 1);
  assert.equal(
    (await f.state.events(session.projectId)).filter((event) => event.type === 'session.activated')
      .length,
    1,
  );
  f.advance(60_000);
  const quiet = { sessionId: session.id, runnerId: 'runner' };
  const unmoved = (await f.sessions.get(f.source, session.id)).expiresAt;
  // A slide under 15 minutes rewrites nothing, and the answer keeps the stored window.
  assert.equal((await f.sessions.heartbeat(f.source, quiet)).expiresAt, unmoved);
  f.advance(900_000);
  const heartbeat = { sessionId: session.id, runnerId: 'runner' };
  const pendingHeartbeat = f.sessions.heartbeat(f.source, heartbeat);
  Object.assign(heartbeat, { sessionId: 'missing', runnerId: 'other' });
  const beat = await pendingHeartbeat;
  assert.equal(Date.parse(beat.expiresAt), f.time() + 14_400_000);
  assert.ok(beat.expiresAt <= beat.hardDeadline);
  f.advance(14_400_001);
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'unauthorized',
  });
  assert.equal((await f.sessions.get(f.source, session.id)).status, 'expired');
  await f.sessions.sweep();
  assert.equal((await f.scope.require(f.source, 'write')).active, true);
  // Its credential is gone; its agent waits, dormant, for the work to come back to it.
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ active: number }>('SELECT active FROM actors WHERE id=?', session.actorId),
    ))!.active,
    1,
  );
  await f.events.drain();
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ live: number }>('SELECT live FROM reservations WHERE id=?', session.id),
    ))!.live,
    0,
  );
});

test('controller polls fence changed workflow revisions and expired offers without activating or rendering', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer();
  const builds = f.builds;
  f.poison();
  assert.equal((await f.sessions.get(f.source, session.id)).status, 'offered');
  assert.equal((await f.workflows.workStarts(f.source, session.instanceId)).length, 0);
  assert.equal(f.builds, builds);
  await f.handle.transition(f.source, {
    instanceId: session.instanceId,
    expectedRevision: 0,
    action: 'finish',
    requestId: 'finish-before-controller-poll',
  });
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          session.id,
        ))!.status,
    ),
    'offered',
    'No sweep or background consumer has run',
  );
  const closed = await f.sessions.get(f.source, session.id);
  assert.equal(closed.status, 'expired');
  assert.equal(closed.closeReason, 'revision_conflict');
  assert.equal(f.builds, builds);
  assert.deepEqual(await f.sessions.get(f.source, session.id), closed);
  // A poll only reports; the sweep's next pass records the moved record.
  await f.sessions.sweep();
  assert.equal(
    (await f.state.events(session.projectId)).filter((event) => event.type === 'session.closed')
      .length,
    1,
  );
  assert.equal((await f.workflows.workStarts(f.source, session.instanceId)).length, 0);
});

test('controller polls preserve offered leases across provider outages and commit deadline closure', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer();
  f.handle.dispose();
  await assert.rejects(async () => await f.sessions.get(f.source, session.id), {
    code: 'workflow_unavailable',
    status: 503,
  });
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          session.id,
        ))!.status,
    ),
    'offered',
  );
  assert.equal(
    (await f.state.events(session.projectId)).filter((event) => event.type === 'session.closed')
      .length,
    0,
  );
  await f.reload();
  f.poison();
  assert.equal((await f.sessions.get(f.source, session.id)).status, 'offered');
  f.advance(300_001);
  const expired = await f.sessions.get(f.source, session.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.closeReason, 'session_expired');
  assert.equal((await f.workflows.workStarts(f.source, session.instanceId)).length, 0);
});

test('a halt during a workflow outage still closes the session it answers for', async (t) => {
  const f = await fixture(t);
  const { session } = await f.offer();
  f.handle.dispose();
  assert.equal((await f.sessions.dispatch.halt(f.owner, { sessionId: session.id })).halted, 1);
  assert.equal(
    await f.state.read(
      async (sql) =>
        (await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          session.id,
        ))!.status,
    ),
    'released',
  );
});

test('revocation before first authentication creates no work start and sibling credentials do not replace the pinned source', async (t) => {
  const f = await fixture(t),
    { token, session } = await f.offer();
  const other = await f.scope.credentials.issueActorCredential(f.owner, {
    actorId: f.source.actorId,
  });
  await f.scope.credentials.revokeCredential(f.owner, f.source.credentialId!);
  await f.sessions.sweep();
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ status: string }>(
          'SELECT status FROM worker_sessions WHERE id=?',
          session.id,
        ),
    ))!.status,
    'expired',
  );
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'unauthorized',
  });
  const otherCaller: Caller = { ...f.source, credentialId: other.credential.id };
  assert.equal((await f.workflows.workStarts(otherCaller, session.instanceId)).length, 0);
  assert.equal((await f.scope.require(otherCaller, 'write')).active, true);
  await assert.rejects(async () => await f.sessions.get(otherCaller, session.id), {
    code: 'session_forbidden',
  });
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

test('a tool call that committed answers its result when recording its finish fails', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const caller = await f.sessions.authenticate(token);
  const observations = (
    f.sessions as unknown as { observations: { finish: (...args: unknown[]) => Promise<void> } }
  ).observations;
  const finish = observations.finish.bind(observations);
  const finished: unknown[] = [];
  observations.finish = async (...args) => {
    finished.push(args[1]);
    if (finished.length === 1) throw new MervError('state_timeout', 'Timed out', 503);
    await finish(...args);
  };
  const prepared = await f.sessions.invocations.prepare(caller, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  assert.equal(await f.sessions.invocations.run(prepared, () => 'committed'), 'committed');
  // The failed record is not overwritten as a failed call; the startup sweep settles it.
  assert.deepEqual(finished, ['succeeded']);
});

test('a read in noun form is admitted as given, and a flat read is still bound', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const caller = await f.sessions.authenticate(token);
  // One artifact in the assignment fills a flat read's artifactId; a noun-form read names its own.
  const flat = await f.sessions.invocations.prepare(caller, 'artifact.read', {}, true);
  assert.deepEqual(flat.input, { artifactId: 'frozen-artifact' });
  const noun = { action: 'content', content: { artifactId: 'other-artifact' } };
  const given = await f.sessions.invocations.prepare(caller, 'artifact.read', noun, true);
  assert.deepEqual(given.input, noun);
  for (const prepared of [flat, given]) await f.sessions.invocations.cancel(prepared);
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

test('session metadata and tool preparation cannot adopt a replacement worker', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const worker = await f.sessions.authenticate(token);
  for (const method of ['describe', 'allowsTool', 'prepare'] as const) {
    await t.test(method, async () => {
      const caller = { ...structuredClone(worker), actorId: 'missing' };
      const pending =
        method === 'describe'
          ? f.sessions.session(caller)
          : method === 'allowsTool'
            ? f.sessions.invocations.allowsTool(caller, 'artifact.read')
            : f.sessions.invocations.prepare(caller, 'artifact.read', {
                artifactId: 'frozen-artifact',
              });
      Object.assign(caller, worker);
      await assert.rejects(pending, { code: 'forbidden' });
    });
  }
});

test('tool policy replacement fences real session invocations and cleanup releases original authority', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const caller = await f.sessions.authenticate(token);
  const tools = new ToolRegistry(f.scope);
  t.after(() => tools.close());
  let calls = 0;
  tools.register({
    name: 'artifact.read',
    description: 'Policy-bound read',
    inputSchema: z.object({ artifactId: z.string() }).strict(),
    handler: () => ++calls,
  });
  let dispose = tools.registerSessionPolicy(f.sessions.invocations);
  const prepare = f.sessions.invocations.prepare.bind(f.sessions.invocations);
  const prepared: Awaited<ReturnType<typeof prepare>>[] = [];
  t.mock.method(f.sessions.invocations, 'prepare', async (...args: Parameters<typeof prepare>) => {
    prepared.push(await prepare(...args));
    return prepared.at(-1)!;
  });
  // Sessions.run validates again after storing its observation; replace the provider there.
  const validate = f.sessions.invocations.validate.bind(f.sessions.invocations);
  let validations = 0;
  t.mock.method(
    f.sessions.invocations,
    'validate',
    async (...args: Parameters<typeof validate>) => {
      await validate(...args);
      if (++validations === 2) {
        dispose();
        dispose = tools.registerSessionPolicy(f.sessions.invocations);
      }
    },
  );
  await assert.rejects(tools.call('artifact.read', caller, { artifactId: 'frozen-artifact' }), {
    code: 'session_unavailable',
  });
  assert.equal(calls, 0);
  const [original] = prepared;
  await assert.rejects(
    f.sessions.invocations.validate(original.caller, original.tool, original.input),
    {
      code: 'session_invocation',
    },
  );
  assert.equal(await tools.call('artifact.read', caller, { artifactId: 'frozen-artifact' }), 1);
});

test('failed packet construction rolls back worker creation and domain reservation', async (t) => {
  const f = await fixture(t),
    target = await f.instance();
  const counts = async () =>
    await f.state.read(async (sql) => [
      (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM actors'))!.n,
      (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM reservations'))!.n,
    ]);
  const before = await counts(),
    head = await f.state.eventHead();
  f.large();
  await assert.rejects(
    async () =>
      await f.sessions.offer(f.source, {
        instanceId: target.id,
        expectedRevision: 0,
        runnerId: 'runner',
        requestId: 'large',
        secret: secret(),
      }),
    { code: 'session_packet_large' },
  );
  assert.deepEqual(await counts(), before);
  assert.equal(await f.state.eventHead(), head);
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

test('expired and released reservations recover before immediate successor offers without manual draining', async (t) => {
  const f = await fixture(t),
    previous = await f.offer();
  f.advance(300_001);
  const successor = await f.sessions.offer(f.source, {
    ...previous.input,
    secret: secret(),
    requestId: 'successor',
  });
  assert.notEqual(successor.actorId, previous.session.actorId);
  assert.equal((await f.sessions.get(f.source, previous.session.id)).status, 'expired');
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ live: number }>(
          'SELECT live FROM reservations WHERE id=?',
          previous.session.id,
        ),
    ))!.live,
    0,
  );
  await f.sessions.release(f.source, { sessionId: successor.id, runnerId: 'runner' });
  const third = await f.sessions.offer(f.source, {
    ...previous.input,
    secret: secret(),
    requestId: 'third',
  });
  assert.equal(third.status, 'offered');
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ live: number }>('SELECT live FROM reservations WHERE id=?', successor.id),
    ))!.live,
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

test('automatic dispatch defaults off, pauses only new offers, and halt never revives old worker authority', async (t) => {
  const f = await fixture(t);
  await f.instance();
  const input = autoInput();
  await f.sessions.dispatch.heartbeatRunner(f.source, presenceInput);
  const before = f.builds;
  assert.deepEqual(await f.sessions.dispatch.lease(f.source, input), {
    session: null,
    reason: 'dispatch_disabled',
  });
  assert.equal(f.builds, before);
  await assert.rejects(
    async () => await f.sessions.dispatch.setDispatch(f.source, { enabled: true }),
    {
      code: 'forbidden',
    },
  );
  const dispatch = { enabled: true };
  const pendingDispatch = f.sessions.dispatch.setDispatch(f.owner, dispatch);
  dispatch.enabled = false;
  assert.equal((await pendingDispatch).enabled, true);
  const source = { ...f.source };
  const pendingLease = f.sessions.dispatch.lease(source, input);
  Object.assign(source, f.owner);
  const offered = (await pendingLease).session!;
  assert.equal(offered.source.actorId, f.source.actorId);
  const worker = await f.sessions.authenticate(input.secret);
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  assert.equal((await f.scope.require(worker, 'write')).id, offered.actorId);
  assert.equal(
    (await f.sessions.dispatch.lease(f.source, input)).session!.id,
    offered.id,
    'A retry returns the original receipt even while paused',
  );
  assert.equal(
    (await f.sessions.dispatch.lease(f.source, autoInput())).reason,
    'dispatch_disabled',
  );
  assert.equal((await f.sessions.dispatch.halt(f.owner)).halted, 1);
  await assert.rejects(async () => await f.scope.require(worker, 'write'));
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  await assert.rejects(async () => await f.sessions.authenticate(input.secret), {
    code: 'unauthorized',
  });
  assert.equal((await f.scope.require(f.source, 'write')).active, true);
  const next = (await f.sessions.dispatch.lease(f.source, autoInput())).session!;
  assert.notEqual(next.actorId, offered.actorId);
  const halt = { sessionId: next.id, reason: 'stop this session' };
  const pendingHalt = f.sessions.dispatch.halt(f.owner, halt);
  Object.assign(halt, { sessionId: undefined, reason: 'changed' });
  assert.equal((await pendingHalt).halted, 1);
  assert.equal((await f.sessions.get(f.source, next.id)).closeReason, 'stop this session');
  assert.equal(
    (await f.sessions.dispatch.projectStatus(f.owner)).dispatch.enabled,
    true,
    'Single-session halt does not pause the project',
  );
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

test('metadata and assignment callbacks cannot commit a lease after changing runner controls', async (t) => {
  for (const stage of ['metadata', 'build'] as const) {
    const f = await fixture(t);
    await f.instance();
    const runner = await f.sessions.dispatch.heartbeatRunner(f.source, presenceInput);
    await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
    const counts = async () =>
      await f.state.read(async (sql) => ({
        actors: (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM actors'))!.n,
        reservations: (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM reservations'))!.n,
        sessions: (await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM worker_sessions'))!.n,
        receipts: (await sql.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM session_dispatch_receipts',
        ))!.n,
      }));
    const before = await counts(),
      head = await f.state.eventHead();
    if (stage === 'metadata') {
      const original = f.workflows.dispatchCandidates.bind(f.workflows);
      t.mock.method(f.workflows, 'dispatchCandidates', async (caller: Caller, tx: Transaction) => {
        const result = await original(caller, tx);
        await tx.run(
          "UPDATE session_runners SET presence_json=jsonb_set(presence_json::jsonb,'{platforms,0,enabled}','false')::text WHERE id=?",
          runner.id,
        );
        return result;
      });
    } else
      f.onBuild(async (tx) => {
        await tx.run(
          "UPDATE session_runners SET presence_json=jsonb_set(presence_json::jsonb,'{capacity}','0')::text WHERE id=?",
          runner.id,
        );
      });
    await assert.rejects(
      async () => await f.sessions.dispatch.lease(f.source, autoInput()),
      { code: 'runner_control_changed' },
      stage,
    );
    assert.deepEqual(
      await counts(),
      before,
      `${stage} rejects and rolls back worker, reservation and receipt together`,
    );
    assert.equal(await f.state.eventHead(), head);
    const persisted = await f.state.read(async (sql) =>
      JSON.parse(
        (await sql.get<{ presence_json: string }>(
          'SELECT presence_json FROM session_runners WHERE id=?',
          runner.id,
        ))!.presence_json,
      ),
    );
    assert.equal(persisted.capacity, 1);
    assert.equal(persisted.platforms[0].enabled, true);
    // The fence after the offer catches a change either callback made; the offer rolls back.
    assert.equal(f.builds, 1);
  }
});

test('every session control names its runner and nothing else, and only that runner controls it', async (t) => {
  const f = await fixture(t),
    { session, token } = await f.offer();
  await f.sessions.authenticate(token);
  for (const method of ['attach', 'heartbeat', 'release'] as const) {
    const host = method === 'attach' ? { hostRef: 'host' } : {};
    for (const [control, code] of [
      [{ sessionId: session.id }, 'invalid_session_control'],
      [{ sessionId: session.id, runnerId: 'runner', extra: true }, 'invalid_session_control'],
      [{ sessionId: session.id, runnerId: 'other' }, 'session_forbidden'],
    ] as const)
      await assert.rejects(
        async () => await f.sessions[method](f.source, { ...control, ...host } as never),
        { code },
        method,
      );
  }
  assert.equal((await f.sessions.get(f.source, session.id)).status, 'active');
});

test('a session credential hash that is not in the ledger never authenticates, even after a restart', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  // Records whose hash the ledger does not hold, as an image before Identity owned it wrote them.
  await f.state.transaction(async (tx) => {
    await tx.run('ALTER TABLE identity_credentials DISABLE TRIGGER identity_credentials_no_delete');
    await tx.run(
      'DELETE FROM identity_credentials WHERE owner=? AND subject=?',
      'sessions',
      offered.session.id,
    );
    await tx.run('ALTER TABLE identity_credentials ENABLE TRIGGER identity_credentials_no_delete');
  });
  await assert.rejects(f.sessions.authenticate(offered.token), { code: 'unauthorized' });
  await f.restart();
  await assert.rejects(f.sessions.authenticate(offered.token), { code: 'unauthorized' });
  assert.equal(
    await f.state.read((sql) =>
      sql.get(
        'SELECT 1 FROM identity_credentials WHERE owner=? AND subject=?',
        'sessions',
        offered.session.id,
      ),
    ),
    undefined,
  );
  // Its owner can still release it.
  await f.sessions.release(f.source, { sessionId: offered.session.id, runnerId: 'runner' });
});

test('PostgreSQL preserves lease fencing and tool observations', async (t) => {
  const f = await fixture(t);
  const { session: first, token } = await f.offer();
  assert.deepEqual((await f.sessions.observations.calls(f.owner, first.threadId)).totals, {
    calls: 0,
    completed: 0,
    inputTokens: 0,
    outputTokens: 0,
  });
  const worker = await f.sessions.authenticate(token);
  const prepared = await f.sessions.invocations.prepare(worker, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  await f.sessions.invocations.run(prepared, () => ({ content: 'answer' }));
  const observation = await f.sessions.observations.calls(f.owner, first.threadId);
  assert.equal(observation.calls[0]?.sessionId, first.id);
  assert.equal(observation.calls[0]?.status, 'succeeded');
  assert.ok(observation.totals.inputTokens > 0);
  assert.deepEqual(observation.totals, {
    calls: 1,
    completed: 1,
    inputTokens: observation.calls[0]!.inputTokens,
    outputTokens: observation.calls[0]!.outputTokens,
  });
  assert.ok(Object.values(observation.totals).every(Number.isSafeInteger));
  await f.sessions.release(f.source, { sessionId: first.id, runnerId: 'runner' });
  const next = await f.offer();
  await assert.rejects(f.scope.require(worker, 'read'), { code: 'session_closed' });
  assert.equal((await f.sessions.dispatch.projectStatus(f.owner)).liveSessionCount, 1);
  await f.instance();
  await f.sessions.dispatch.heartbeatRunner(f.source, presenceInput);
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: true });
  assert.ok((await f.sessions.dispatch.lease(f.source, autoInput())).session);
  assert.equal((await f.sessions.dispatch.projectStatus(f.owner)).liveSessionCount, 2);
  await f.scope.credentials.revokeActor(f.owner, f.source.actorId);
  await f.sessions.sweep();
  await assert.rejects(f.sessions.authenticate(next.token), { code: 'unauthorized' });
});

for (const boundary of ['offer expiry', 'hard deadline'] as const) {
  test(`activation refuses a lease that crosses its ${boundary} during acquisition checks`, async (t) => {
    const f = await fixture(t);
    const { token, session } = await f.offer();
    let checks = 0;
    f.onLeaseCheck(() => {
      // Reconciliation checks first; activation checks the lease again.
      if (++checks === 2)
        f.advance(
          Date.parse(boundary === 'offer expiry' ? session.expiresAt : session.hardDeadline) -
            f.time(),
        );
    });
    // Expired between the snapshot and the writer that would activate it: its credential with it.
    await assert.rejects(f.sessions.authenticate(token), { status: 401 });
    assert.equal(checks, 2);
    assert.deepEqual(await f.workflows.workStarts(f.source, session.instanceId), []);
    assert.equal(
      (await f.state.events(session.projectId)).filter(
        (event) => event.type === 'session.activated',
      ).length,
      0,
    );
    const closed = await f.sessions.get(f.source, session.id);
    assert.equal(closed.status, 'expired');
    assert.equal(closed.closeReason, 'session_expired');
    await f.sessions.sweep();
    assert.equal(
      await f.state.read(
        async (sql) =>
          (await sql.get<{ live: number }>('SELECT live FROM reservations WHERE id=?', session.id))!
            .live,
      ),
      0,
    );
  });
}
