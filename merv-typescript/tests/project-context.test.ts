import { createService } from '@merv/contracts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { ProjectScope } from '@merv/scope';
import { parseProjectContextUpdate, projectContextUpdateSchema } from '@merv/scope/project-context';
import type {
  Caller,
  Data,
  Principal,
  ProjectContextUpdate,
  TaskContext,
  Transaction,
} from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { openState } from './fixtures/state.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-project-context-'));
  const path = directory;
  let time = Date.parse('2026-09-15T12:00:00.000Z');
  let state = await openState(path);
  let scope = await createService(new ProjectScope(state, () => time));
  const boot = await scope.bootstrap({
    projectName: 'Project Introduction',
    actorName: 'Operator',
  });
  const operator: Caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const issue = async (role: 'producer' | 'reviewer' | 'reader', expiresAt?: string) => {
    const value = await scope.issueActor(operator, { name: role, role, expiresAt });
    return {
      actorId: value.actor.id,
      projectId: value.actor.projectId,
      credentialId: value.credential.id,
    };
  };
  const producer = await issue('producer'),
    reader = await issue('reader'),
    reviewer = await issue('reviewer');
  const login = async (subject: string) =>
    await scope.acceptVerifiedIdentity({
      issuer: 'https://identity.example/auth/v1',
      subject,
      expiresAt: new Date(time + 60_000).toISOString(),
    });
  t.after(async () => {
    await state.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    boot,
    operator,
    producer,
    reader,
    reviewer,
    login,
    issue,
    get state() {
      return state;
    },
    get scope() {
      return scope;
    },
    advance(ms: number) {
      time += ms;
    },
    async restart() {
      await state.close();
      state = await openState(path);
      scope = await createService(new ProjectScope(state, () => time));
    },
    events: async () =>
      (await state.events(operator.projectId)).filter(
        (event) => event.type === 'project.context.updated',
      ),
  };
}
const update = (
  summary = 'A scoped research question.',
  expectedSummary = '',
  requestId = 'intro',
): ProjectContextUpdate => ({ summary, expectedSummary, requestId });

test('Introduction updates trim only new text, retain original receipts across later edits/restart and preserve identity', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.scope.project(f.reader), f.boot.project);
  assert.equal(f.boot.project.summary, '');
  assert.equal(f.boot.project.contextRevision, 0);
  const first = await f.scope.updateProjectContext(
    f.producer,
    update(' \n A scoped research question. \t'),
  );
  assert.deepEqual(first, {
    ...f.boot.project,
    summary: 'A scoped research question.',
    contextRevision: 1,
  });
  const second = await f.scope.updateProjectContext(
    f.operator,
    update('Different intent.', first.summary!, 'second'),
  );
  assert.equal(second.contextRevision, 2);
  assert.deepEqual(await f.scope.updateProjectContext(f.producer, update()), first);
  await assert.rejects(
    async () => await f.scope.updateProjectContext(f.producer, update('Changed payload.')),
    {
      code: 'request_conflict',
    },
  );
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(
        f.producer,
        update('New intent.', ' Different intent. ', 'stale'),
      ),
    { code: 'project_context_conflict' },
  );
  const same = await f.scope.updateProjectContext(
    f.producer,
    update('Different intent.', second.summary!, 'same'),
  );
  assert.equal(
    same.contextRevision,
    3,
    'A new accepted command is recorded even when text is unchanged',
  );
  const empty = await f.scope.updateProjectContext(
    f.operator,
    update(' \t\n', same.summary!, 'clear'),
  );
  assert.equal(empty.summary, '');
  assert.equal(empty.contextRevision, 4);
  const events = await f.events();
  assert.equal(events.length, 4);
  assert.deepEqual(events[0].data, {
    previousSummary: '',
    summary: first.summary,
    previousContextRevision: 0,
    contextRevision: 1,
    source: { kind: 'actor', credentialId: f.producer.credentialId },
  });
  assert.equal(events[0].actorId, f.producer.actorId);
  assert.equal(events[0].subjectId, f.operator.projectId);
  await f.restart();
  assert.deepEqual(await f.scope.updateProjectContext(f.producer, update()), first);
  assert.deepEqual(await f.scope.project(f.reader), empty);
  assert.equal((await f.events()).length, 4);
  for (const sql of [
    "UPDATE project_context_commands SET result_json='{}'",
    'DELETE FROM project_context_commands',
  ])
    await assert.rejects(async () => await f.state.transaction(async (tx) => await tx.run(sql)), {
      code: 'state_constraint',
    });
});

test('Introduction CAS preserves previously stored whitespace exactly and fences stale observations after reopening', async (t) => {
  const f = await fixture(t);
  await f.state.transaction(
    async (tx) =>
      await tx.run(
        'UPDATE projects SET summary=? WHERE id=?',
        ' legacy whitespace \n',
        f.operator.projectId,
      ),
  );
  await assert.rejects(
    async () => await f.scope.updateProjectContext(f.producer, update('Next', 'legacy whitespace')),
    { code: 'project_context_conflict' },
  );
  const first = await f.scope.updateProjectContext(
    f.producer,
    update('Next', ' legacy whitespace \n'),
  );
  assert.equal((await f.events())[0].data.previousSummary, ' legacy whitespace \n');
  const staleRead = await f.scope.project(f.reader);
  await f.scope.updateProjectContext(f.operator, update('Winner', first.summary!, 'winner'));
  await f.restart();
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(f.producer, update('Loser', staleRead.summary!, 'loser')),
    { code: 'project_context_conflict' },
  );
  assert.equal((await f.scope.project(f.reader)).summary, 'Winner');
  assert.equal((await f.events()).length, 2);
});

test('Current ordinary write authority is required before both new edits and receipt replay', async (t) => {
  const f = await fixture(t);
  for (const caller of [f.reader, f.reviewer])
    await assert.rejects(async () => await f.scope.updateProjectContext(caller, update()), {
      code: 'forbidden',
    });
  const result = await f.scope.updateProjectContext(f.producer, update());
  const foreign = await f.scope.bootstrap({ projectName: 'Other', actorName: 'Other operator' });
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(
        { ...f.producer, projectId: foreign.project.id },
        update(),
      ),
    { code: 'forbidden' },
  );
  await f.scope.revokeCredential(f.operator, f.producer.credentialId);
  await assert.rejects(async () => await f.scope.updateProjectContext(f.producer, update()), {
    code: 'forbidden',
  });
  const expiring = await f.issue('producer', '2026-09-15T12:00:00.001Z');
  await f.scope.updateProjectContext(
    expiring,
    update('Temporary author', result.summary!, 'expiring'),
  );
  f.advance(2);
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(
        expiring,
        update('Temporary author', result.summary!, 'expiring'),
      ),
    { code: 'forbidden' },
  );
  const active = await f.issue('producer');
  const source = await f.scope.delegationSource(f.operator);
  const worker = await f.state.transaction(
    async (tx) =>
      await f.scope.createSessionActor(
        source,
        { sessionId: 'session_context', role: 'producer', name: 'Leased producer' },
        tx,
      ),
  );
  const unbind = f.scope.registerSessionAuthority({ require: async () => source });
  t.after(unbind);
  for (const caller of [
    { actorId: worker.id, projectId: worker.projectId, session: { id: worker.sessionId! } },
    { actorId: worker.id, projectId: worker.projectId },
    { ...active, session: { id: worker.sessionId! } },
  ])
    await assert.rejects(async () => await f.scope.updateProjectContext(caller, update()), {
      code: 'forbidden',
    });
  assert.equal((await f.events()).length, 2);
});

test('Human and user-key projects expose current Introduction, while membership/key loss fences replay', async (t) => {
  const f = await fixture(t),
    alice = await f.login('alice'),
    bob = await f.login('bob');
  const project = await f.scope.createProject(alice, {
    name: 'Human project',
    requestId: 'project',
  });
  assert.equal(project.summary, '');
  assert.equal(project.contextRevision, 0);
  const owner = await f.scope.caller(alice, project.id);
  await f.scope.addMember(alice, project.id, { subject: 'bob', role: 'producer' });
  const human = await f.scope.caller(bob, project.id);
  const first = await f.scope.updateProjectContext(human, update('Human intent'));
  const issued = await f.scope.createKey(bob, { projectId: project.id });
  const principal: Principal = { kind: 'key', key: await f.scope.authenticateKey(issued.token) };
  const keyCaller = await f.scope.caller(principal, project.id);
  const second = await f.scope.updateProjectContext(
    keyCaller,
    update('Key intent', first.summary!, 'key'),
  );
  assert.deepEqual(await f.scope.projects(alice), [second]);
  assert.deepEqual(await f.scope.projects(principal), [second]);
  assert.deepEqual(
    await f.scope.createProject(alice, { name: 'Human project', requestId: 'project' }),
    second,
    'Existing create-project replay keeps its live-project behavior',
  );
  const events = (await f.state.events(project.id)).filter(
    (event) => event.type === 'project.context.updated',
  );
  assert.deepEqual(events[0].data.source, {
    kind: 'human',
    issuer: human.human!.issuer,
    subject: 'bob',
    membershipId: human.human!.membershipId,
  });
  assert.deepEqual(events[1].data.source, {
    kind: 'user-key',
    keyId: issued.key.id,
    membershipId: keyCaller.key!.membershipId,
  });
  await f.scope.revokeKey(bob, issued.key.id);
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(keyCaller, update('Key intent', first.summary!, 'key')),
    { code: 'forbidden' },
  );
  await f.scope.changeMemberRole(alice, project.id, { subject: 'bob', role: 'reader' });
  await assert.rejects(
    async () => await f.scope.updateProjectContext(human, update('Human intent')),
    {
      code: 'membership_required',
    },
  );
  const reader = await f.scope.caller(bob, project.id);
  await assert.rejects(
    async () => await f.scope.updateProjectContext(reader, update('Human intent')),
    {
      code: 'forbidden',
    },
  );
  assert.deepEqual(await f.scope.project(owner), second);
  f.advance(60_001);
  await assert.rejects(
    async () =>
      await f.scope.updateProjectContext(
        owner,
        update('Expired login', second.summary!, 'expired'),
      ),
    { code: 'forbidden' },
  );
});

test('Borrowed transactions compose and authority loss after event publication rolls everything back', async (t) => {
  const f = await fixture(t);
  const before = await f.scope.project(f.operator),
    head = await f.state.eventHead();
  let finished!: Transaction;
  await assert.rejects(
    async () =>
      await f.state.transaction(async (tx) => {
        finished = tx;
        const value = await f.scope.updateProjectContext(f.producer, update(), tx);
        assert.deepEqual(await f.scope.project(f.reader, tx), value);
        throw new Error('outer rollback');
      }),
    /outer rollback/,
  );
  assert.deepEqual(await f.scope.project(f.reader), before);
  assert.equal(await f.state.eventHead(), head);
  await assert.rejects(
    async () => await f.scope.updateProjectContext(f.producer, update(), finished),
    {
      code: 'invalid_transaction',
    },
  );
  const other = await openState(':memory:');
  try {
    await other.transaction(
      async (tx) =>
        await assert.rejects(
          async () => await f.scope.updateProjectContext(f.producer, update(), tx),
          {
            code: 'invalid_transaction',
          },
        ),
    );
  } finally {
    await other.close();
  }
  const append = f.state.appendEvent.bind(f.state);
  f.state.appendEvent = async (tx, event) => {
    const saved = await append(tx, event);
    if (event.type === 'project.context.updated')
      await tx.run(
        'UPDATE actor_credentials SET revoked_at=? WHERE id=?',
        '2026-09-15T12:00:00.000Z',
        f.producer.credentialId,
      );
    return saved;
  };
  await assert.rejects(async () => await f.scope.updateProjectContext(f.producer, update()), {
    code: 'forbidden',
  });
  f.state.appendEvent = append;
  assert.deepEqual(await f.scope.project(f.reader), before);
  assert.equal(await f.state.eventHead(), head);
  assert.equal(
    (await f.state.read(
      async (sql) =>
        await sql.get<{ n: number }>('SELECT COUNT(*) AS n FROM project_context_commands'),
    ))!.n,
    0,
  );
  assert.equal((await f.scope.updateProjectContext(f.producer, update())).contextRevision, 1);
});

test('Input validation is strict and bounded without evaluating accessors, proxies or prototype traps', async (t) => {
  const f = await fixture(t);
  let traps = 0;
  const trap = () => {
    traps++;
    throw new Error('untrusted execution');
  };
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const getter = Object.defineProperty(update(), 'summary', { enumerable: true, get: trap });
  const inherited = Object.create(proxy);
  const hidden = Object.defineProperty(update(), 'summary', { value: 'hidden', enumerable: false });
  for (const input of [
    null,
    [],
    proxy,
    revoked.proxy,
    getter,
    inherited,
    hidden,
    { ...update(), summary: 12 },
    { ...update(), expectedSummary: undefined },
    { ...update(), requestId: ' ' },
    { ...update(), name: 'Must not rename' },
    { ...update(), [Symbol('identity')]: 'bad' },
    update('é'.repeat(8001)),
    update('', 'é'.repeat(8001)),
    update('', '', 'x'.repeat(257)),
  ])
    await assert.rejects(
      async () => await f.scope.updateProjectContext(f.producer, input as ProjectContextUpdate),
      {
        code: 'invalid_project_context',
      },
    );
  assert.equal(traps, 0);
  assert.equal((await f.events()).length, 0);
  assert.equal(
    parseProjectContextUpdate(Object.assign(Object.create(null), update('  ok  ', ' \t ')))
      .expectedSummary,
    ' \t ',
  );
  const maximum = update('é'.repeat(8000));
  assert.equal(projectContextUpdateSchema.parse(maximum).summary, maximum.summary);
  assert.equal((await f.scope.updateProjectContext(f.producer, maximum)).summary, maximum.summary);
});

test('Existing project rows gain empty Introduction defaults through migration without replacing project identity', async (t) => {
  const state = await openState(':memory:');
  t.after(async () => await state.close());
  const migrate = state.migrate.bind(state);
  state.migrate = async (component, migrations) =>
    await migrate(
      component,
      component === 'scope' ? migrations.filter((migration) => migration.version < 6) : migrations,
    );
  const legacy = await createService(new ProjectScope(state));
  const boot = await legacy.bootstrap({ projectName: 'Legacy project', actorName: 'Operator' });
  const columns = async () =>
    (
      await state.read(
        async (sql) =>
          await sql.all<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='projects'",
          ),
      )
    ).map((column) => column.name);
  assert.ok((await columns()).includes('id'));
  assert.equal((await columns()).includes('summary'), false);
  state.migrate = migrate;
  const scope = await createService(new ProjectScope(state));
  assert.ok((await columns()).includes('summary'));
  const caller = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  assert.deepEqual(await scope.project(caller), boot.project);
  assert.equal((await scope.updateProjectContext(caller, update())).contextRevision, 1);
});

test('Task contexts freeze the Introduction at lease offer and retain saved packets across project changes and restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-task-introduction-'));
  let app = await createApp({ directory, api: false });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Frozen context', actorName: 'Owner' });
  const source = {
    actorId: boot.actor.id,
    projectId: boot.project.id,
    credentialId: boot.credential.id,
  };
  const first = await app.ctx.scope.updateProjectContext(source, update('INTRO_AT_OFFER_731'));
  const task = await app.ctx.tasks.create(source, {
    title: 'Observe intent',
    goal: 'Verify the result.',
    checks: ['The result is 42.'],
    requestId: 'task',
  });
  const contextInput: TaskContext = {
    taskId: task.id,
    purpose: 'work',
    expectedRevision: task.workflow.revision,
    requestId: 'before-offer',
  };
  const saved = await app.ctx.tasks.context(source, contextInput);
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const offered = await app.ctx.sessions.offer(source, {
    instanceId: task.id,
    expectedRevision: task.workflow.revision,
    runnerId: 'context-test',
    requestId: 'offer',
    secret,
  });
  assert.match(offered.assignment.context!.prompt, /INTRO_AT_OFFER_731/);
  assert.equal(offered.assignment.context!.recipeHash, saved.recipeHash);
  const pin = {
    id: boot.project.id,
    name: boot.project.name,
    summary: first.summary,
    contextRevision: 1,
  };
  assert.deepEqual(offered.lease.receipt.project, pin);
  await app.ctx.scope.updateProjectContext(
    source,
    update('INTRO_AFTER_OFFER_942', first.summary!, 'later'),
  );
  assert.deepEqual(
    await app.ctx.tasks.context(source, contextInput),
    saved,
    'A saved ordinary context replays without rebuilding live Introduction',
  );
  // While the worker holds the revision, the source is told so instead of a fresh assignment.
  await assert.rejects(async () => await app.ctx.workflows.assignment(source, task.id), {
    code: 'task_leased',
  });
  async function workerContext(requestId: string) {
    const worker = await app.ctx.sessions.authenticate(secret);
    const invocation = await app.ctx.sessions.prepare(worker, 'task.context', { requestId });
    return app.ctx.sessions.run(
      invocation,
      async (caller, input: Data) =>
        await app.ctx.tasks.context(caller, input as unknown as TaskContext),
    );
  }
  const workerSaved = await workerContext('worker-first');
  assert.match(workerSaved.prompt, /INTRO_AT_OFFER_731/);
  assert.doesNotMatch(workerSaved.prompt, /INTRO_AFTER_OFFER_942/);
  const frozenPacket = offered.assignment;
  await app.stop();
  app = await createApp({ directory, api: false });
  assert.deepEqual((await app.ctx.sessions.get(source, offered.id)).assignment, frozenPacket);
  assert.deepEqual(await workerContext('worker-first'), workerSaved);
  const freshWorkerContext = await workerContext('worker-after-restart');
  assert.match(freshWorkerContext.prompt, /INTRO_AT_OFFER_731/);
  assert.doesNotMatch(freshWorkerContext.prompt, /INTRO_AFTER_OFFER_942/);
  assert.equal(freshWorkerContext.recipeHash, saved.recipeHash);
  assert.equal((await app.ctx.scope.project(source)).contextRevision, 2);
});
