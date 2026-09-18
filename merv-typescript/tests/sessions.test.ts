import { createService } from '@merv/contracts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  MervError,
  check,
  type Caller,
  type Transaction,
  type WorkflowPolicy,
} from '@merv/contracts';
import { PostgresState, SqliteState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { DurableEvents } from '@merv/domain-events';
import { LeasedSessions } from '@merv/sessions';

const secret = () => `ms_${randomBytes(32).toString('base64url')}`;
async function fixture(t: TestContext, legacySchema = false, postgres = false) {
  let clock = Date.now(),
    builds = 0,
    brokenBuild = false,
    largeBuild = false;
  let buildHook: ((tx: Transaction) => void | Promise<void>) | undefined;
  const schema = `merv_sessions_${randomUUID().replaceAll('-', '')}`;
  const state = postgres
    ? await PostgresState.open({ connectionString: process.env.MERV_TEST_POSTGRES_URL!, schema })
    : new SqliteState(':memory:');
  const migrate = state.migrate.bind(state);
  if (legacySchema)
    state.migrate = async (component, migrations) =>
      await migrate(
        component,
        component === 'sessions' ? migrations.filter((m) => m.version <= 2) : migrations,
      );
  const scope = await createService(new ProjectScope(state, () => clock));
  const workflows = await createService(new WorkflowsService(state, scope));
  const events = await createService(new DurableEvents(state)),
    access = scope.toolPolicy;
  await state.migrate('session_fixture', [
    {
      version: 1,
      sql: 'CREATE TABLE reservations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,live INTEGER NOT NULL);',
      postgres:
        'CREATE TABLE reservations(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,live INTEGER NOT NULL);',
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
  const boot = await scope.bootstrap({ projectName: 'Sessions', actorName: 'Owner' });
  const owner: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const producer = await scope.issueActor(owner, { name: 'Producer', role: 'producer' });
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
  state.migrate = migrate;
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
    if (postgres) {
      const pool = new Pool({ connectionString: process.env.MERV_TEST_POSTGRES_URL });
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
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
    { input, token, session } = await f.offer();
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
  const attached = await f.sessions.attach(f.source, {
    sessionId: session.id,
    runnerId: 'runner',
    hostRef: 'host-a',
  });
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
    async () => await f.scope.issueActorCredential(f.owner, { actorId: session.actorId }),
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
    session: { id: session.id, agentSessionId: session.agentSessionId },
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
  const beat = await f.sessions.heartbeat(f.source, { sessionId: session.id, runnerId: 'runner' });
  assert.equal(Date.parse(beat.expiresAt), f.time() + 14_400_000);
  assert.ok(beat.expiresAt <= beat.hardDeadline);
  f.advance(14_400_001);
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'session_expired',
  });
  assert.equal((await f.sessions.get(f.source, session.id)).status, 'expired');
  assert.equal((await f.scope.require(f.source, 'write')).active, true);
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ active: number }>('SELECT active FROM actors WHERE id=?', session.actorId),
    ))!.active,
    0,
  );
  await f.events.drain();
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ live: number }>('SELECT live FROM reservations WHERE id=?', session.id),
    ))!.live,
    0,
  );
  assert.equal(
    (await f.events.status()).find((consumer) => consumer.id === 'sessions.lifecycle.v1')!.error,
    null,
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

test('revocation before first authentication creates no work start and sibling credentials do not replace the pinned source', async (t) => {
  const f = await fixture(t),
    { token, session } = await f.offer();
  const other = await f.scope.issueActorCredential(f.owner, { actorId: f.source.actorId });
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await f.events.drain();
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
    code: 'session_closed',
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
  const human = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.test/auth/v1',
    subject: 'owner',
    expiresAt: new Date(f.time() + 1000).toISOString(),
  });
  const project = await f.scope.createProject(human, {
    name: 'Human leases',
    requestId: 'human-project',
  });
  await f.scope.addMember(human, project.id, { subject: 'worker', role: 'producer' });
  const user = await f.scope.acceptVerifiedIdentity({
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
  const refreshed = await f.scope.acceptVerifiedIdentity({
    ...human.user,
    expiresAt: new Date(f.time() + 100_000).toISOString(),
  });
  await f.scope.removeMember(refreshed, project.id, 'worker');
  await f.scope.addMember(refreshed, project.id, { subject: 'worker', role: 'producer' });
  await f.events.drain();
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'session_closed',
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
    prepared = await f.sessions.prepare(worker, 'finish', {});
  assert.deepEqual(prepared.input, { instanceId: session.instanceId, expectedRevision: 0 });
  await f.sessions.run(
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
    f.sessions.run(prepared, () => {}),
    { code: 'session_invocation' },
  );
  await assert.rejects(async () => await f.scope.require(prepared.caller, 'read'), {
    code: 'session_invocation',
  });
  // The record moved by the worker's own hand: the session ends as a completed handoff,
  // whichever path meets it first; a halt that finds it so halts nothing.
  assert.equal((await f.sessions.halt(f.owner, { sessionId: session.id })).halted, 0);
  await assert.rejects(async () => await f.sessions.authenticate(token), {
    code: 'session_closed',
  });
  const done = await f.sessions.get(f.source, session.id);
  assert.equal(done.status, 'released');
  assert.equal(done.outcome, 'completed');
  assert.equal(done.closeReason, 'handoff');

  const next = await f.offer(),
    second = await f.sessions.authenticate(next.token),
    invocation = await f.sessions.prepare(second, 'finish', {});
  let entered = false;
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  await assert.rejects(
    f.sessions.run(invocation, () => {
      entered = true;
    }),
  );
  assert.equal(entered, false);
  await assert.rejects(async () => await f.scope.require(invocation.caller, 'read'));
});

test('frozen references survive reload, a prepared generation does not, and cancellation removes invocation authority', async (t) => {
  const f = await fixture(t),
    { token } = await f.offer();
  const caller = await f.sessions.authenticate(token),
    prepared = await f.sessions.prepare(caller, 'artifact.read', { artifactId: 'frozen-artifact' });
  await assert.rejects(
    async () => await f.sessions.prepare(caller, 'artifact.read', { artifactId: 'other-artifact' }),
    { code: 'execution_arguments_forbidden' },
  );
  await f.reload();
  await assert.rejects(
    f.sessions.run(prepared, () => {}),
    { code: 'execution_replaced' },
  );
  await f.restart();
  const restored = await f.sessions.authenticate(token);
  const next = await f.sessions.prepare(restored, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  await f.sessions.validate(next.caller, next.tool, next.input);
  await f.sessions.cancel(next);
  await assert.rejects(async () => await f.sessions.validate(next.caller, next.tool, next.input), {
    code: 'session_invocation',
  });
  const forged = {
    ...(await f.sessions.prepare(restored, 'artifact.read', { artifactId: 'frozen-artifact' })),
  };
  await assert.rejects(
    f.sessions.run(forged, () => {}),
    { code: 'session_invocation' },
  );
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
  const human = await f.scope.acceptVerifiedIdentity({
    issuer: 'https://identity.test/auth/v1',
    subject: 'key-owner',
    expiresAt: new Date(f.time() + 100_000).toISOString(),
  });
  const project = await f.scope.createProject(human, {
    name: 'Key sessions',
    requestId: 'key-project',
  });
  const first = await f.scope.createKey(human, { projectId: project.id });
  const keyCaller = await f.scope.caller(
    { kind: 'key', key: await f.scope.authenticateKey(first.token) },
    project.id,
  );
  const offered = await f.offer(keyCaller);
  const replacement = await f.scope.rotateKey(human, { keyId: first.key.id });
  await f.events.drain();
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
    code: 'session_closed',
  });
  const replacementCaller = await f.scope.caller(
    { kind: 'key', key: await f.scope.authenticateKey(replacement.token) },
    project.id,
  );
  assert.equal((await f.scope.require(replacementCaller, 'write')).id, keyCaller.actorId);
  const next = await f.offer(replacementCaller);
  await f.scope.revokeKey(human, replacement.key.id);
  await f.events.drain();
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

test('automatic dispatch moves past a candidate whose offer cannot be built', async (t) => {
  const f = await fixture(t);
  await f.instance();
  await f.instance();
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  // The first candidate's context is past its budget; the queue behind it still moves.
  let builds = 0;
  f.onBuild(() => {
    if (++builds === 1) throw new MervError('context_too_large', 'Context exceeds the budget', 400);
  });
  const leased = await f.sessions.lease(f.source, autoInput());
  assert.equal(leased.reason, 'offered');
  assert.equal(builds, 2);
  // With nothing else leasable, the runner sees why the remaining candidate cannot be offered.
  await f.sessions.release(f.source, { sessionId: leased.session!.id, runnerId: 'machine' });
  f.onBuild(() => {
    throw new MervError('context_too_large', 'Context exceeds the budget', 400);
  });
  await assert.rejects(async () => await f.sessions.lease(f.source, autoInput()), {
    code: 'context_too_large',
  });
});

test('automatic dispatch defaults off, pauses only new offers, and halt never revives old worker authority', async (t) => {
  const f = await fixture(t);
  await f.instance();
  const input = autoInput();
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  const before = f.builds;
  assert.deepEqual(await f.sessions.lease(f.source, input), {
    session: null,
    reason: 'dispatch_disabled',
  });
  assert.equal(f.builds, before);
  await assert.rejects(async () => await f.sessions.setDispatch(f.source, { enabled: true }), {
    code: 'forbidden',
  });
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const offered = (await f.sessions.lease(f.source, input)).session!;
  const worker = await f.sessions.authenticate(input.secret);
  await f.sessions.setDispatch(f.owner, { enabled: false });
  assert.equal((await f.scope.require(worker, 'write')).id, offered.actorId);
  assert.equal(
    (await f.sessions.lease(f.source, input)).session!.id,
    offered.id,
    'A retry returns the original receipt even while paused',
  );
  assert.equal((await f.sessions.lease(f.source, autoInput())).reason, 'dispatch_disabled');
  assert.equal((await f.sessions.halt(f.owner)).halted, 1);
  await assert.rejects(async () => await f.scope.require(worker, 'write'));
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await assert.rejects(async () => await f.sessions.authenticate(input.secret), {
    code: 'session_closed',
  });
  assert.equal((await f.scope.require(f.source, 'write')).active, true);
  const next = (await f.sessions.lease(f.source, autoInput())).session!;
  assert.notEqual(next.actorId, offered.actorId);
  assert.equal((await f.sessions.halt(f.owner, { sessionId: next.id })).halted, 1);
  assert.equal(
    (await f.sessions.projectStatus(f.owner)).dispatch.enabled,
    true,
    'Single-session halt does not pause the project',
  );
});

test('automatic leases need fresh source-bound presence, count offered capacity, and preserve request identity', async (t) => {
  const f = await fixture(t);
  await f.instance();
  await f.instance();
  await f.sessions.setDispatch(f.owner, { enabled: true });
  await assert.rejects(async () => await f.sessions.lease(f.source, autoInput()), {
    code: 'runner_required',
  });
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  f.advance(45_001);
  assert.equal((await f.sessions.lease(f.source, autoInput())).reason, 'runner_offline');
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  const first = autoInput();
  const competing = await Promise.all([
    Promise.resolve().then(async () => await f.sessions.lease(f.source, first)),
    Promise.resolve().then(async () => await f.sessions.lease(f.source, autoInput())),
  ]);
  assert.equal(competing.filter((item) => item.session).length, 1);
  assert.equal(competing[1].reason, 'capacity_full');
  assert.equal((await f.sessions.lease(f.source, first)).session!.id, competing[0].session!.id);
  await assert.rejects(
    async () => await f.sessions.lease(f.source, { ...first, secret: secret() }),
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
    async () => await f.sessions.lease(f.owner, autoInput()),
    { code: 'runner_required' },
    'Runner label alone is not registration authority',
  );
  assert.equal((await f.sessions.projectStatus(f.owner)).runners[0].live, true);
  await f.scope.revokeCredential(f.owner, f.source.credentialId!);
  assert.equal(
    (await f.sessions.projectStatus(f.owner)).runners[0].live,
    false,
    'Fresh metadata cannot make a revoked source online',
  );
});

test('server desired settings remain authoritative even when a runner claims they were applied', async (t) => {
  const f = await fixture(t);
  await f.instance();
  const runner = await f.sessions.heartbeatRunner(f.source, presenceInput);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const settings = {
    platforms: [{ name: 'codex', enabled: true, model: 'approved-model', parallelism: 1 }],
  };
  const desired = await f.sessions.setRunnerSettings(f.owner, { runnerId: runner.id, settings });
  assert.equal(desired.desiredVersion, 1);
  assert.equal((await f.sessions.lease(f.source, autoInput())).reason, 'settings_pending');
  await f.sessions.heartbeatRunner(f.source, { ...presenceInput, appliedVersion: 1 });
  await assert.rejects(async () => await f.sessions.lease(f.source, autoInput()), {
    code: 'settings_mismatch',
  });
  await f.sessions.heartbeatRunner(f.source, {
    ...presenceInput,
    platforms: [{ ...runnerPlatform, model: 'approved-model' }],
    appliedVersion: 1,
  });
  const input = autoInput();
  assert.equal(
    (
      await f.sessions.lease(f.source, {
        ...input,
        platform: { ...input.platform, model: 'approved-model' },
      })
    ).reason,
    'offered',
  );
  await f.sessions.setRunnerSettings(f.owner, {
    runnerId: runner.id,
    settings: { platforms: [{ name: 'codex', enabled: false, parallelism: 1 }] },
  });
  assert.equal(
    (
      await f.sessions.lease(f.source, {
        ...autoInput(),
        platform: { name: 'codex', harness: 'codex', model: 'approved-model' },
      })
    ).reason,
    'platform_disabled',
  );
  await assert.rejects(
    async () =>
      await f.sessions.heartbeatRunner(f.source, { ...presenceInput, appliedVersion: 99 }),
    { code: 'invalid_settings_version' },
  );
  await assert.rejects(
    async () =>
      await f.sessions.setRunnerSettings(f.owner, {
        runnerId: runner.id,
        settings: {
          platforms: [{ name: 'codex', enabled: true, parallelism: 1, command: ['evil'] } as any],
        },
      }),
    { code: 'invalid_runner_settings' },
  );
});

test('canonical process outcomes apply durable target backoff; freeform notes never become policy', async (t) => {
  const f = await fixture(t);
  await f.instance();
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const first = (await f.sessions.lease(f.source, autoInput())).session!;
  await f.sessions.release(f.source, {
    sessionId: first.id,
    runnerId: 'machine',
    outcome: 'host_failed',
    reason: 'Provider refused this launch.',
  });
  assert.equal((await f.sessions.lease(f.source, autoInput())).reason, 'retry_backoff');
  await f.restart();
  assert.equal((await f.sessions.lease(f.source, autoInput())).reason, 'retry_backoff');
  f.advance(30_001);
  const second = (await f.sessions.lease(f.source, autoInput())).session!;
  await f.sessions.release(f.source, {
    sessionId: second.id,
    runnerId: 'machine',
    reason: 'host_process_failed',
  });
  assert.equal(
    (await f.sessions.lease(f.source, autoInput())).reason,
    'offered',
    'Only the closed outcome enum controls backoff',
  );
  assert.equal(
    (await f.sessions.projectStatus(f.owner)).sessions.find((item) => item.id === first.id)!
      .outcome,
    'host_failed',
  );
});

test('project status is a sanitized metadata view and dispatch controls survive provider restart', async (t) => {
  const f = await fixture(t);
  await f.instance();
  await f.sessions.heartbeatRunner(f.source, presenceInput);
  await f.sessions.setDispatch(f.owner, { enabled: true });
  const input = autoInput(),
    leased = (await f.sessions.lease(f.source, input)).session!;
  f.poison();
  const status = await f.sessions.projectStatus(f.owner),
    rendered = JSON.stringify(status);
  assert.equal(status.canManage, true);
  assert.equal(status.sessions[0].id, leased.id);
  for (const hidden of [
    'Frozen brief',
    input.secret,
    f.source.credentialId!,
    'source_json',
    'assignment',
    'policyHash',
  ])
    assert.ok(!rendered.includes(hidden), `Status excludes ${hidden}`);
  await f.restart();
  assert.equal((await f.sessions.projectStatus(f.owner)).dispatch.enabled, true);
  assert.equal((await f.sessions.lease(f.source, input)).session!.id, leased.id);
});

test('project live counts and oldest live session remain correct beyond the history display cap', async (t) => {
  const f = await fixture(t),
    oldest = (await f.offer()).session;
  for (let index = 0; index < 201; index++) {
    const next = (await f.offer()).session;
    await f.sessions.release(f.source, { sessionId: next.id, runnerId: 'runner' });
  }
  const status = await f.sessions.projectStatus(f.owner);
  assert.equal(status.sessionTotal, 202);
  assert.equal(status.liveSessionCount, 1);
  assert.equal(status.sessions.length, 200);
  assert.equal(status.sessions[0].id, oldest.id, 'Live sessions precede capped closed history');
  assert.equal((await f.sessions.halt(f.owner)).halted, 1);
  assert.equal((await f.sessions.projectStatus(f.owner)).liveSessionCount, 0);
});

test('metadata and assignment callbacks cannot commit a lease after changing runner controls', async (t) => {
  for (const stage of ['metadata', 'build'] as const) {
    const f = await fixture(t);
    await f.instance();
    const runner = await f.sessions.heartbeatRunner(f.source, presenceInput);
    await f.sessions.setDispatch(f.owner, { enabled: true });
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
        const result = original(caller, tx);
        await tx.run(
          "UPDATE session_runners SET presence_json=json_set(presence_json,'$.platforms[0].enabled',json('false')) WHERE id=?",
          runner.id,
        );
        return result;
      });
    } else
      f.onBuild(async (tx) => {
        await tx.run(
          "UPDATE session_runners SET presence_json=json_set(presence_json,'$.capacity',0) WHERE id=?",
          runner.id,
        );
      });
    await assert.rejects(
      async () => await f.sessions.lease(f.source, autoInput()),
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
    assert.equal(f.builds, stage === 'metadata' ? 0 : 1);
  }
});

test('a continuing agent keeps its identity and credential across explicit assignments while old calls stay fenced', async (t) => {
  const f = await fixture(t),
    token = secret();
  const registration = {
    name: 'My continuing agent',
    runnerId: 'external',
    requestId: 'agent',
    secret: token,
  };
  const agent = await f.sessions.registerAgent(f.source, registration);
  assert.deepEqual(await f.sessions.registerAgent(f.source, registration), agent);
  assert.equal((await f.sessions.agentSelf(token)).current, null);
  await assert.rejects(async () => await f.sessions.authenticate(token), { code: 'agent_idle' });
  await assert.rejects(async () => await f.sessions.agent(f.owner, agent.id), {
    code: 'agent_forbidden',
  });
  const first = await f.instance(),
    second = await f.instance();
  const firstInput = { instanceId: first.id, expectedRevision: 0, requestId: 'first' };
  const a = await f.sessions.assignAgent(token, firstInput);
  assert.equal(a.agentId, agent.id);
  assert.equal(a.actorId, agent.actorId);
  const callerA = await f.sessions.authenticate(token);
  const inputA = { instanceId: first.id, expectedRevision: 0 };
  const delayed = await f.sessions.prepare(callerA, 'finish', inputA);
  await assert.rejects(
    async () =>
      await f.sessions.assignAgent(token, {
        instanceId: second.id,
        expectedRevision: 0,
        requestId: 'too-early',
      }),
    { code: 'agent_busy' },
  );
  await assert.rejects(async () => await f.sessions.resetAgentContext(token, 'context reset'), {
    code: 'agent_busy',
  });
  await f.sessions.releaseAgentAssignment(token, a.id);
  assert.equal((await f.sessions.agentSelf(token)).agent.status, 'active');
  assert.equal(
    (await f.scope.actors(f.owner)).find((actor) => actor.id === agent.actorId)?.active,
    true,
  );
  const b = await f.sessions.assignAgent(token, {
    instanceId: second.id,
    expectedRevision: 0,
    requestId: 'second',
  });
  assert.notEqual(a.id, b.id);
  assert.equal(b.agentSessionId, a.agentSessionId);
  assert.equal(b.actorId, a.actorId);
  assert.equal(b.assignment.instanceId, second.id);
  await f.sessions.releaseAgentAssignment(token, a.id);
  assert.equal(
    (await f.sessions.agentSelf(token)).current?.id,
    b.id,
    'A late release cannot close the successor',
  );
  const otherToken = secret();
  await f.sessions.registerAgent(f.source, {
    name: 'Another agent',
    runnerId: 'external',
    requestId: 'other-agent',
    secret: otherToken,
  });
  await assert.rejects(async () => await f.sessions.releaseAgentAssignment(otherToken, b.id), {
    code: 'agent_forbidden',
  });
  await assert.rejects(
    async () =>
      await f.sessions.offer(f.owner, {
        agentId: agent.id,
        instanceId: (await f.instance(f.owner)).id,
        expectedRevision: 0,
        runnerId: 'external',
        requestId: 'takeover',
        secret: secret(),
      }),
    { code: 'agent_forbidden' },
  );
  await assert.rejects(async () => await f.scope.require(callerA, 'read'), {
    code: 'session_closed',
  });
  await assert.rejects(
    f.sessions.run(delayed, () => {
      throw new Error('Old handler must not run');
    }),
    { code: 'session_closed' },
  );
  const callerB = await f.sessions.authenticate(token);
  assert.equal(callerB.actorId, callerA.actorId);
  assert.equal(callerB.session?.id, b.id);
  await assert.rejects(async () => await f.sessions.prepare(callerB, 'finish', inputA));
  assert.equal(
    (await f.sessions.assignAgent(token, firstInput)).id,
    a.id,
    'Replay returns its historical receipt',
  );
  assert.equal(
    (await f.sessions.agentSelf(token)).current?.id,
    b.id,
    'Replay cannot change current work',
  );
  await f.restart();
  assert.equal((await f.sessions.authenticate(token)).actorId, agent.actorId);
  assert.equal((await f.sessions.agentSelf(token)).assignments.length, 2);
  await f.sessions.releaseAgentAssignment(token, b.id);
  const reset = await f.sessions.resetAgentContext(token, 'Agent compacted its context');
  assert.equal(reset.contextEpoch, 1);
  const c = await f.sessions.assignAgent(token, {
    instanceId: (await f.instance()).id,
    expectedRevision: 0,
    requestId: 'third',
  });
  assert.equal(c.contextEpoch, 1);
  assert.equal((await f.sessions.agentSelf(token)).assignments[0].contextEpoch, 0);
  await f.sessions.retireAgent(f.source, agent.id);
  await assert.rejects(async () => await f.sessions.agentSelf(token), { code: 'agent_retired' });
  assert.equal(
    (await f.scope.actors(f.owner)).find((actor) => actor.id === agent.actorId)?.active,
    false,
  );
  assert.equal((await f.sessions.get(f.source, c.id)).status, 'released');
  assert.ok(
    !JSON.stringify(
      await f.state.read(async (sql) => await sql.all('SELECT * FROM agents')),
    ).includes(token),
  );
});

test('source revocation retires even an idle continuing agent; failed assignment does not leak ownership or alter identity', async (t) => {
  const f = await fixture(t),
    token = secret();
  const agent = await f.sessions.registerAgent(f.source, {
    name: 'Idle agent',
    runnerId: 'external',
    requestId: 'idle',
    secret: token,
  });
  await assert.rejects(
    async () =>
      await f.sessions.assignAgent(token, {
        instanceId: 'missing',
        expectedRevision: 0,
        requestId: 'failed',
      }),
  );
  assert.equal((await f.sessions.agentSelf(token)).assignments.length, 0);
  assert.equal((await f.sessions.agentSelf(token)).agent.id, agent.id);
  await f.scope.revokeActor(f.owner, f.source.actorId);
  await f.sessions.sweep();
  await assert.rejects(async () => await f.sessions.agentSelf(token), { code: 'agent_retired' });
  assert.equal(
    (await f.scope.actors(f.owner)).find((actor) => actor.id === agent.actorId)?.active,
    false,
  );
});

test('upgrading the historical one-worker schema preserves a live execution and its dispatch receipt', async (t) => {
  const f = await fixture(t, true);
  const { token, session } = await f.offer();
  const active = await f.sessions.authenticate(token);
  const runner = await f.sessions.heartbeatRunner(f.source, {
    runnerId: 'runner',
    machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
    platforms: [{ name: 'test', harness: 'command', enabled: true, parallelism: 1 }],
    capacity: 1,
  });
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'INSERT INTO session_dispatch_receipts(owner_hash,runner_id,request_id,fingerprint,session_id,runner_ref,platform_json) VALUES(?,?,?,?,?,?,?)',
        'legacy-owner',
        'runner',
        'legacy-request',
        'legacy-fingerprint',
        session.id,
        runner.id,
        '{}',
      ),
  );
  const before = await f.sessions.get(f.source, session.id);
  await f.restart();
  assert.deepEqual(await f.sessions.get(f.source, session.id), before);
  assert.deepEqual(await f.sessions.authenticate(token), active);
  assert.deepEqual(
    await f.state.read(async (sql) => await sql.all('PRAGMA foreign_key_check')),
    [],
  );
  assert.equal(
    (
      await f.state.read(
        async (sql) =>
          await sql.get<{ session_id: string }>(
            'SELECT session_id FROM session_dispatch_receipts WHERE request_id=?',
            'legacy-request',
          ),
      )
    )?.session_id,
    session.id,
  );
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run('DELETE FROM worker_sessions WHERE id=?', session.id),
      ),
    /retained/,
  );
});

test('agent observations retain tool timings and estimates across assignments without retaining payloads', async (t) => {
  const f = await fixture(t);
  const token = secret();
  const agent = await f.sessions.registerAgent(f.source, {
    name: 'Observed agent',
    runnerId: 'external',
    requestId: 'observe',
    secret: token,
  });
  const assign = async (requestId: string) =>
    await f.sessions.assignAgent(token, {
      instanceId: (await f.instance()).id,
      expectedRevision: 0,
      requestId,
    });
  const first = await assign('first');
  const caller = await f.sessions.authenticate(token);
  const pending = await f.sessions.prepare(caller, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  let finish!: (value: unknown) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = f.sessions.run(
    pending,
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  await entered;
  await assert.rejects(
    f.sessions.run(pending, () => 'duplicate'),
    { code: 'session_invocation' },
  );
  let observed = await f.sessions.agentObservation(f.owner, agent.id);
  assert.equal(observed.toolCalls[0]!.status, 'running');
  assert.equal(observed.toolCalls[0]!.outputTokens, null);
  assert.equal(observed.agent.currentExecutionId, first.id);
  assert.equal(observed.assignments[0]!.workflow.name, 'session-fixture');
  f.advance(1234);
  finish({ secret: 'sensitive-result-never-retained' });
  await running;
  observed = await f.sessions.agentObservation(f.owner, agent.id);
  assert.equal(observed.toolCalls[0]!.status, 'succeeded');
  assert.equal(observed.toolCalls[0]!.durationMs, 1234);
  assert.ok(observed.toolCalls[0]!.inputTokens > 0);
  assert.ok(observed.toolCalls[0]!.outputTokens! > 0);
  assert.equal(observed.tokenAccounting.kind, 'estimate');
  assert.equal(observed.tokenStats.totalCalls, 1);
  assert.equal(observed.tokenStats.completedCalls, 1);
  assert.deepEqual(observed.tokenStats, {
    totalCalls: 1,
    completedCalls: 1,
    inputTokens: observed.toolCalls[0]!.inputTokens,
    outputTokens: observed.toolCalls[0]!.outputTokens,
  });
  await assert.rejects(async () => await f.sessions.agentObservation(caller, agent.id), {
    code: 'session_forbidden',
  });
  await assert.rejects(
    async () =>
      await f.state.transaction(
        async (tx) => await tx.run("UPDATE session_tool_calls SET status='failed'"),
      ),
    /immutable/,
  );
  await f.sessions.releaseAgentAssignment(token, first.id);
  const second = await assign('second');
  const worker = await f.sessions.authenticate(token);
  const failed = await f.sessions.prepare(worker, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  await assert.rejects(
    f.sessions.run(failed, () => {
      throw new Error('secret-in-error');
    }),
  );
  const cancelled = await f.sessions.prepare(worker, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  await f.sessions.cancel(cancelled);
  await f.sessions.cancel(cancelled);
  const interrupted = await f.sessions.prepare(worker, 'artifact.read', {
    artifactId: 'frozen-artifact',
  });
  let complete!: () => void;
  let resuming!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resuming = resolve;
  });
  const unfinished = f.sessions.run(
    interrupted,
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
        resuming();
      }),
  );
  await resumed;
  await f.restart();
  complete();
  await unfinished;
  observed = await f.sessions.agentObservation(f.owner, agent.id);
  assert.equal(observed.agent.id, agent.id);
  assert.equal(observed.assignments.length, 2);
  assert.equal(observed.assignments[0]!.id, second.id);
  assert.deepEqual(
    observed.toolCalls.map((c) => c.status),
    ['interrupted', 'failed', 'succeeded'],
  );
  assert.equal(observed.toolCalls[0]!.finishedAt, null);
  assert.equal(observed.tokenStats.totalCalls, 3);
  assert.equal(observed.tokenStats.completedCalls, 2);
  const serialized =
    JSON.stringify(observed) +
    JSON.stringify(
      await f.state.read(async (sql) => await sql.all('SELECT * FROM session_tool_calls')),
    );
  for (const secret of [
    token,
    'sensitive-result-never-retained',
    'secret-in-error',
    'frozen-artifact',
  ])
    assert.equal(serialized.includes(secret), false);
});

test('agent observations are project-scoped read-only metadata with a bounded call window and lifetime totals', async (t) => {
  const f = await fixture(t);
  const offered = await f.offer();
  const caller = await f.sessions.authenticate(offered.token);
  const reader = await f.scope.issueActor(f.owner, { name: 'Observer', role: 'reader' });
  const viewer: Caller = { actorId: reader.actor.id, projectId: f.owner.projectId };
  for (let index = 0; index < 105; index++) {
    const invocation = await f.sessions.prepare(caller, 'artifact.read', {
      artifactId: 'frozen-artifact',
    });
    await f.sessions.run(invocation, () => ({ content: 'test' }));
  }
  const before = await f.state.read(
    async (sql) => await sql.get('SELECT COUNT(*) AS n FROM events'),
  );
  const observation = await f.sessions.agentObservation(viewer, offered.session.agentId!);
  assert.equal(observation.toolCalls.length, 100);
  assert.equal(observation.toolCallTotal, 105);
  assert.equal(observation.tokenStats.totalCalls, 105);
  assert.deepEqual(
    await f.state.read(async (sql) => await sql.get('SELECT COUNT(*) AS n FROM events')),
    before,
  );
  const other = await f.scope.bootstrap({ projectName: 'Other project', actorName: 'Other owner' });
  await assert.rejects(
    async () =>
      await f.sessions.agentObservation(
        { actorId: other.actor.id, projectId: other.project.id },
        offered.session.agentId!,
      ),
    { code: 'agent_not_found' },
  );
  await f.scope.revokeActor(f.owner, reader.actor.id);
  await assert.rejects(
    async () => await f.sessions.agentObservation(viewer, offered.session.agentId!),
  );
});

test('agent table includes retired instances in join order and is not truncated by the execution window', async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  for (let index = 0; index < 202; index++) {
    f.advance(1000);
    const agent = await f.sessions.registerAgent(f.source, {
      name: `Agent ${index}`,
      runnerId: 'external',
      requestId: `join-${index}`,
      secret: secret(),
    });
    ids.unshift(agent.id);
    if (index === 201) await f.sessions.retireAgent(f.source, agent.id);
  }
  const agents = (await f.sessions.projectStatus(f.owner)).agents!;
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ids,
  );
  assert.equal(agents[0]!.status, 'retired');
  assert.ok(agents.every((agent) => agent.createdAt && agent.runnerId === 'external'));
});

test(
  'PostgreSQL preserves continuing agent identity, lease fencing and tool observations',
  {
    skip: !process.env.MERV_TEST_POSTGRES_URL,
  },
  async (t) => {
    const f = await fixture(t, false, true);
    const token = secret();
    const agent = await f.sessions.registerAgent(f.source, {
      name: 'PostgreSQL agent',
      runnerId: 'external',
      requestId: 'postgres-agent',
      secret: token,
    });
    assert.deepEqual((await f.sessions.agentObservation(f.owner, agent.id)).tokenStats, {
      totalCalls: 0,
      completedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    const first = await f.sessions.assignAgent(token, {
      instanceId: (await f.instance()).id,
      expectedRevision: 0,
      requestId: 'first',
    });
    const worker = await f.sessions.authenticate(token);
    const prepared = await f.sessions.prepare(worker, 'artifact.read', {
      artifactId: 'frozen-artifact',
    });
    await f.sessions.run(prepared, () => ({ content: 'answer' }));
    const observation = await f.sessions.agentObservation(f.owner, agent.id);
    assert.equal(observation.toolCalls[0]?.executionId, first.id);
    assert.equal(observation.toolCalls[0]?.status, 'succeeded');
    assert.equal(observation.tokenStats.totalCalls, 1);
    assert.equal(observation.tokenStats.completedCalls, 1);
    assert.ok(observation.tokenStats.inputTokens > 0);
    assert.deepEqual(observation.tokenStats, {
      totalCalls: 1,
      completedCalls: 1,
      inputTokens: observation.toolCalls[0]!.inputTokens,
      outputTokens: observation.toolCalls[0]!.outputTokens,
    });
    assert.ok(Object.values(observation.tokenStats).every(Number.isSafeInteger));
    assert.equal(typeof observation.toolCallTotal, 'number');
    await f.sessions.releaseAgentAssignment(token, first.id);
    const next = await f.sessions.assignAgent(token, {
      instanceId: (await f.instance()).id,
      expectedRevision: 0,
      requestId: 'next',
    });
    assert.equal(next.actorId, first.actorId);
    assert.equal(next.agentId, agent.id);
    assert.notEqual(next.id, first.id);
    await assert.rejects(f.scope.require(worker, 'read'), { code: 'session_closed' });
    assert.equal((await f.sessions.agentSelf(token)).assignments.length, 2);
    assert.equal((await f.sessions.projectStatus(f.owner)).liveSessionCount, 1);
    await f.instance();
    await f.sessions.heartbeatRunner(f.source, presenceInput);
    await f.sessions.setDispatch(f.owner, { enabled: true });
    assert.ok((await f.sessions.lease(f.source, autoInput())).session);
    assert.equal((await f.sessions.projectStatus(f.owner)).liveSessionCount, 2);
    await f.scope.revokeActor(f.owner, f.source.actorId);
    await f.events.drain();
    await assert.rejects(f.sessions.agentSelf(token), { code: 'agent_retired' });
  },
);
