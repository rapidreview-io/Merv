import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { canonical, digest, type Caller, type WorkflowPolicy } from '@merv/contracts';
import { LeasedSessions } from '@merv/sessions';
import { declaredWithinMs } from '@merv/sessions/dispatch';
import type { HoldRow } from '@merv/sessions/dispatch-holds';
import { nativeAdmissionSnapshot } from '@merv/sessions/native-admission';
import type { ComputeTargetState, ThreadQuestion } from '@merv/sessions/types';
import { twoStepWorkflow } from './fixtures/session-workflow.js';

async function fixture(t: TestContext) {
  const f = await twoStepWorkflow(t, 'migrationwaits', () => ({
    computeKind: 'task',
    computeProfile: 'execute',
  }));
  const sessions = f.sessions as LeasedSessions;
  await sessions.dispatch.setDispatch(f.owner, { enabled: true });
  const state = f.app.ctx.state;
  const workflows = f.app.ctx.workflows;
  const definition = (await workflows.pinned('migrationwaits-test', 1))!.definition;
  const policy: WorkflowPolicy = {
    successStates: ['done'],
    actions: definition.edges.map((edge) => ({
      name: edge.action,
      states: [edge.from],
      transitions: [edge.action],
      tool: edge.action,
      instruction: edge.action,
      check: async ({ caller, tx }) => {
        await f.app.ctx.scope.require(caller, 'write', tx);
      },
    })),
    assignments: ['working', 'review'].map((step) => {
      const role = step === 'review' ? 'reviewer' : 'producer';
      const execution = { readOnly: role === 'reviewer', tools: [] };
      return {
        state: step,
        check: () => {},
        build: () => ({
          role,
          label: `${step} work`,
          brief: 'Continue the same work',
          references: [],
          handoff: { instruction: 'Hand off', tools: [] },
          execution,
          context: null,
        }),
        references: () => ({ computeKind: 'task', computeProfile: 'execute' }),
        execution,
        lease: {
          role: () => role,
          acquire: ({ leaseId }) => ({ leaseId }),
          check: () => {},
          release: () => {},
        },
      };
    }),
  };
  const native = await workflows.register({ ...definition, version: 2 }, policy);
  // Exercise real Sessions before and after a retained protocol boundary without enabling
  // legacy product producer leases. The real product migration command is covered by the
  // admission suite; these identical fixture programs isolate questions and compute waits.
  const migrate = (instanceId: string) =>
    state.transaction(async (tx) => {
      const row = (await tx.get<Record<string, unknown>>(
        'SELECT * FROM wf_instances WHERE project_id=? AND id=?',
        f.owner.projectId,
        instanceId,
      ))!;
      const revision = Number(row.revision);
      const source = { ...row, revision, version: Number(row.version) };
      const at = new Date().toISOString();
      await tx.run(
        'INSERT INTO wf_protocol_migrations(project_id,instance_id,source_revision,source_version,target_revision,target_version,source_json,source_hash,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        f.owner.projectId,
        instanceId,
        revision,
        1,
        revision + 1,
        2,
        canonical(source),
        digest(source),
        f.owner.actorId,
        'Preserve the same work across a protocol-only revision.',
        at,
      );
      await tx.run(
        'UPDATE wf_instances SET version=2,revision=?,updated_at=? WHERE id=?',
        revision + 1,
        at,
        instanceId,
      );
    });
  const move = async (instanceId: string) => {
    const item = await workflows.get(f.owner, instanceId);
    await native.transition(f.owner, {
      instanceId,
      expectedRevision: item.revision,
      action: 'submit',
      requestId: randomUUID(),
    });
  };
  const queued = (instanceId: string) =>
    state.transaction(async (tx) =>
      (await sessions.dispatch.candidates(f.owner, tx)).queue.some(
        (item) => item.instanceId === instanceId,
      ),
    );
  const ask = async (instanceId: string) => {
    const visit = await f.offer(instanceId);
    const worker = await sessions.authenticate(visit.input.secret);
    const asked = (
      await f.app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Which cohort?' })
    ).value as { question: ThreadQuestion };
    return { ...visit, question: asked.question };
  };
  let status: ComputeTargetState['status'] = 'running';
  const checked: string[] = [];
  sessions.computeWaits.register({
    offers: async () => true,
    states: async ({ sessionId, targets }) => {
      checked.push(sessionId);
      return { targets: targets.map((target) => ({ ...target, status })), idle: [] };
    },
  });
  const wait = async (instanceId: string) => {
    const visit = await f.offer(instanceId);
    const worker = await sessions.authenticate(visit.input.secret);
    await f.app.ctx.tools.invoke('session.await_compute', worker, {
      jobIds: ['job_fixture'],
      reason: 'Keep waiting for the accepted run.',
    });
    return visit;
  };
  const waitRow = (instanceId: string) =>
    state.read((sql) =>
      sql.get<{ revision: number; settled_at: string | null; outcome: string | null }>(
        'SELECT * FROM session_compute_waits WHERE instance_id=? ORDER BY _merv_rowid DESC LIMIT 1',
        instanceId,
      ),
    );
  return {
    ...f,
    state,
    sessions,
    workflows,
    migrate,
    move,
    queued,
    ask,
    wait,
    waitRow,
    checked,
    complete: () => {
      status = 'succeeded';
    },
  };
}

test('a migrated owner question stays visible and answerable with its original immutable revision', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const visit = await f.ask(unit.id);
  const raw = () =>
    f.state.read((sql) => sql.get('SELECT * FROM session_questions WHERE id=?', visit.question.id));
  const before = await raw();
  await f.migrate(unit.id);
  assert.deepEqual(await raw(), before);
  const read = await f.sessions.messaging.thread(f.owner, visit.session.threadId!);
  assert.equal(read.questions[0]!.open, true);
  assert.equal(read.questions[0]!.revision, 0, 'The question still names the visit that asked it');
  assert.deepEqual(await f.sessions.threads.counts(f.owner), { live: 0, waiting: 1 });
  assert.equal(await f.queued(unit.id), false);
  assert.equal((await f.workflows.blockers(f.owner, unit.id))[0]!.revision, 1);
  const input = { threadId: visit.session.threadId!, body: 'Use 2025.', requestId: 'answer' };
  const reply = await f.sessions.messaging.message(f.owner, input);
  assert.deepEqual(await f.sessions.messaging.message(f.owner, input), reply);
  const answered = await f.sessions.messaging.thread(f.owner, visit.session.threadId!);
  assert.equal(answered.questions[0]!.revision, 0);
  assert.equal(answered.questions[0]!.open, false);
  assert.equal(answered.questions[0]!.answerMessageId, reply.id);
  assert.equal(await f.queued(unit.id), false, 'Conversation upload grace still applies');
  t.mock.method(f.sessions.dispatch, 'clock', () => Date.now() + declaredWithinMs + 1000);
  assert.equal(await f.queued(unit.id), true);
});

test('a question asked after migration stands until an ordinary workflow revision', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  await f.migrate(unit.id);
  const visit = await f.ask(unit.id);
  assert.equal(visit.question.revision, 1);
  assert.equal(
    (await f.sessions.messaging.thread(f.owner, visit.session.threadId!)).questions[0]!.open,
    true,
  );
  assert.equal(await f.queued(unit.id), false);
  await f.move(unit.id);
  const obsolete = (await f.sessions.messaging.thread(f.owner, visit.session.threadId!))
    .questions[0]!;
  assert.equal(obsolete.open, false);
  assert.equal(obsolete.answeredAt, null, 'A real move does not fabricate an answer');
  assert.deepEqual(await f.sessions.threads.counts(f.owner), { live: 0, waiting: 0 });
});

test('a bound responder can resolve the original question after migration and becomes obsolete after a real move', async (t) => {
  let dispose: (() => Promise<void>) | undefined;
  t.after(() => dispose?.());
  const f = await fixture(t);
  const conversations = new Set<string>();
  const disposeAuthority = f.app.ctx.scope.registerConversationAuthority({
    require: async (caller) => {
      assert.ok(conversations.has(caller.conversation!.id));
      return {
        actorId: f.owner.actorId,
        projectId: f.owner.projectId,
        kind: 'actor',
        credentialId: f.owner.credentialId!,
        expiresAt: null,
      };
    },
  });
  const disposeResponder = f.sessions.messaging.registerResponder({
    name: 'fixture',
    label: 'Fixture responder',
    start: async ({ question, attach }) => {
      assert.equal(question.revision, 0);
      conversations.add(question.id);
      assert.equal(await attach({ id: question.id, route: `/fixture/${question.id}` }), true);
    },
    inspect: async () => null,
  });
  dispose = async () => {
    await disposeResponder();
    disposeAuthority();
  };
  const caller = (id: string): Caller => ({
    actorId: f.owner.actorId,
    projectId: f.owner.projectId,
    conversation: { id, epoch: 1, commandId: 'command', runtimeId: 'runtime' },
  });
  const input = (questionId: string) => ({
    questionId,
    expectedRevision: 0,
    outcome: 'answered' as const,
    body: 'Use the retained cohort.',
    requestId: 'resolution',
  });
  const unit = await f.start();
  const first = await f.ask(unit.id);
  await f.migrate(unit.id);
  await f.sessions.messaging.responders.sweep();
  const investigating = (await f.sessions.messaging.thread(f.owner, first.session.threadId!))
    .questions[0]!;
  assert.equal(investigating.response?.state, 'investigating');
  assert.equal(investigating.response?.reference?.id, first.question.id);
  const resolved = await f.sessions.messaging.resolve(
    caller(first.question.id),
    input(first.question.id),
  );
  assert.equal(resolved.open, false);
  assert.equal(resolved.revision, 0);
  assert.deepEqual(
    await f.sessions.messaging.resolve(caller(first.question.id), input(first.question.id)),
    resolved,
  );

  const other = await f.start();
  const second = await f.ask(other.id);
  await f.migrate(other.id);
  await f.sessions.messaging.responders.sweep();
  await f.move(other.id);
  await f.state.transaction((tx) =>
    tx.run(
      "UPDATE session_question_responses SET check_at='2000-01-01T00:00:00.000Z' WHERE question_id=?",
      second.question.id,
    ),
  );
  await f.sessions.messaging.responders.sweep();
  const obsolete = (await f.sessions.messaging.thread(f.owner, second.session.threadId!))
    .questions[0]!;
  assert.equal(obsolete.response?.state, 'obsolete');
  assert.equal(obsolete.answeredAt, null);
  await assert.rejects(
    f.sessions.messaging.resolve(caller(second.question.id), input(second.question.id)),
    { code: 'question_obsolete' },
  );
});

test('a migrated compute wait survives sweep, then its actual completion reaches the next visit', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const visit = await f.wait(unit.id);
  const before = await f.waitRow(unit.id);
  await f.migrate(unit.id);
  await f.sessions.computeWaits.sweep();
  assert.deepEqual(await f.waitRow(unit.id), before);
  assert.equal(f.checked.at(-1), visit.session.id, 'The waiter still checks the original visit');
  assert.equal(await f.queued(unit.id), false);
  assert.equal((await f.workflows.blockers(f.owner, unit.id))[0]!.revision, 1);
  f.complete();
  await f.sessions.computeWaits.sweep();
  assert.equal((await f.waitRow(unit.id))!.outcome, 'ended');
  assert.equal((await f.waitRow(unit.id))!.revision, 0);
  const next = await f.offer(unit.id);
  assert.equal(next.session.expectedRevision, 1);
  assert.equal(next.session.awaited?.outcome, 'ended');
  assert.equal(next.session.awaited?.reason, 'Keep waiting for the accepted run.');
});

test('a hand offer wakes the inherited compute wait and reports that wake exactly once', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  await f.wait(unit.id);
  await f.migrate(unit.id);
  const next = await f.offer(unit.id);
  assert.equal(next.session.awaited?.outcome, 'woken');
  assert.equal((await f.waitRow(unit.id))!.outcome, 'woken');
  const row = await f.waitRow(unit.id);
  await f.sessions.computeWaits.sweep();
  assert.deepEqual(await f.waitRow(unit.id), row);
});

test('a compute wait started after migration settles as moved only on an ordinary revision', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  await f.migrate(unit.id);
  await f.wait(unit.id);
  const before = await f.waitRow(unit.id);
  await f.sessions.computeWaits.sweep();
  assert.deepEqual(await f.waitRow(unit.id), before);
  assert.equal(before!.revision, 1);
  await f.move(unit.id);
  await f.sessions.computeWaits.sweep();
  assert.equal((await f.waitRow(unit.id))!.outcome, 'moved');
});

test('migration keeps quiet age and deferred-close reporting without rewriting retained visits', async (t) => {
  const f = await fixture(t);
  const quiet = await f.start();
  const deferred = await f.start();
  const old = new Date(Date.now() - 24 * 3600_000).toISOString();
  await f.state.transaction((tx) =>
    tx.run('UPDATE wf_instances SET updated_at=? WHERE id=?', old, quiet.id),
  );
  for (let index = 0; index < 3; index++) {
    const visit = await f.offer(deferred.id);
    await f.sessions.release(f.owner, {
      sessionId: visit.session.id,
      runnerId: visit.control.runnerId,
      outcome: 'preparation_deferred',
      deferral: { cause: 'store_busy', code: 'code_store_full' },
    });
  }
  const history = () =>
    f.state.read((sql) =>
      sql.all('SELECT * FROM session_usage WHERE instance_id=? ORDER BY session_id', deferred.id),
    );
  const before = await history();
  await f.migrate(quiet.id);
  await f.migrate(deferred.id);
  const report = await f.sessions.dispatch.stuck(f.owner);
  const quietItem = report.items.find(
    (item) => item.instanceId === quiet.id && item.kind === 'ready_quiet',
  );
  assert.equal(quietItem?.since, old);
  assert.equal(quietItem?.expectedRevision, 1);
  const deferredItem = report.items.find(
    (item) => item.instanceId === deferred.id && item.kind === 'work_deferred',
  );
  assert.equal(deferredItem?.attempts, 3);
  assert.equal(deferredItem?.expectedRevision, 1);
  assert.deepEqual(await history(), before);
  await f.move(quiet.id);
  await f.move(deferred.id);
  const moved = await f.sessions.dispatch.stuck(f.owner);
  assert.equal(
    moved.items.some((item) => item.instanceId === quiet.id && item.kind === 'ready_quiet'),
    false,
  );
  assert.equal(
    moved.items.some((item) => item.instanceId === deferred.id && item.kind === 'work_deferred'),
    false,
  );
});

test('a live migrated target hides its inherited hold from stuck and running without clearing it', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const at = new Date().toISOString();
  const hold = await f.state.transaction(async (tx) => {
    const row = (await tx.get<HoldRow>(
      `INSERT INTO session_dispatch_holds(project_id,instance_id,revision,attempts,last_code,last_message,last_session_id,first_at,last_at,held_at)
      VALUES(?,?,0,3,'launch_failed','Read the previous visit',NULL,?,?,?) RETURNING *`,
      f.owner.projectId,
      unit.id,
      at,
      at,
      at,
    ))!;
    await f.sessions.dispatch.reportHold(f.owner.projectId, unit.id, row, tx);
    return row;
  });
  await f.migrate(unit.id);
  assert.equal(
    (await f.sessions.dispatch.stuck(f.owner)).items.find((item) => item.kind === 'dispatch_held')
      ?.expectedRevision,
    1,
  );
  await f.offer(unit.id);
  assert.equal(
    (await f.sessions.dispatch.stuck(f.owner)).items.some(
      (item) => item.instanceId === unit.id && item.kind === 'dispatch_held',
    ),
    false,
  );
  const running = await f.state.transaction((tx) => f.sessions.dispatch.running(f.owner, tx));
  assert.equal(
    running.failures.some((item) => item.instanceId === unit.id),
    false,
  );
  assert.deepEqual(
    await f.state.read((sql) =>
      sql.get('SELECT * FROM session_dispatch_holds WHERE instance_id=?', unit.id),
    ),
    hold,
  );
});

test('the admission snapshot is private, deterministic and unchanged by migration but tracks an explicit answer or dispatch change', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const other = await f.start();
  const visit = await f.ask(unit.id);
  const snapshot = () =>
    f.state.read((sql) => nativeAdmissionSnapshot(sql, f.owner.projectId, [unit.id, unit.id]));
  const before = await snapshot();
  assert.equal(before.questions.count, 1);
  assert.equal(before.closures.count, 1);
  assert.equal(JSON.stringify(before).includes('Which cohort?'), false);
  assert.equal(JSON.stringify(before).includes(visit.input.secret), false);
  assert.deepEqual(await snapshot(), before);
  await f.migrate(unit.id);
  assert.deepEqual(await snapshot(), before);
  await f.ask(other.id);
  const sibling = await snapshot();
  assert.deepEqual(
    { ...sibling, accounting: before.accounting },
    before,
    'Another question does not alter this work’s question or wait facts',
  );
  assert.notEqual(sibling.accounting.usage.hash, before.accounting.usage.hash);
  await f.sessions.messaging.message(f.owner, {
    threadId: visit.session.threadId!,
    body: '2025',
    requestId: 'answer',
  });
  const answered = await snapshot();
  assert.notEqual(answered.questions.hash, before.questions.hash);
  await f.sessions.dispatch.setDispatch(f.owner, { enabled: false });
  assert.notDeepEqual((await snapshot()).dispatch, answered.dispatch);
});

test('the admission snapshot binds project accounting from nonmigrating work and server settlements', async (t) => {
  const f = await fixture(t);
  const unit = await f.start();
  const sibling = await f.start();
  await f.sessions.dispatch.setBudget(f.owner, { maxTokens: 100 });
  const visit = await f.offer(sibling.id);
  await f.sessions.authenticate(visit.input.secret);
  const release = { sessionId: visit.session.id, runnerId: visit.control.runnerId };
  await f.sessions.release(f.owner, release);
  const snapshot = () =>
    f.state.read((sql) => nativeAdmissionSnapshot(sql, f.owner.projectId, [unit.id]));
  const admissible = async () =>
    (
      await f.sessions.dispatch.dispatchDemand(f.owner, {
        platform: { name: 'fixture', harness: 'codex', enabled: true, parallelism: 1 },
      })
    ).candidates.some((item) => item.instanceId === unit.id);
  const unreported = await snapshot();
  assert.equal(unreported.closures.count, 0, 'The sibling is outside the migration set');
  assert.equal(await admissible(), false, 'Its unreported usage holds the project budget');
  await f.migrate(unit.id);
  assert.deepEqual(await snapshot(), unreported);
  await f.sessions.release(f.owner, {
    ...release,
    usage: { inputTokens: 10, outputTokens: 0 },
  });
  const reported = await snapshot();
  assert.notEqual(reported.accounting.usage.hash, unreported.accounting.usage.hash);
  assert.deepEqual(reported.closures, unreported.closures);
  assert.equal(await admissible(), true, 'The late sibling report changes actual admission');

  const execution = {
    provider: 'fixture',
    operationId: randomUUID(),
    executionEpoch: 1,
    projectId: f.owner.projectId,
    sponsors: [sibling.id],
    deadline: new Date(Date.now() + 60_000).toISOString(),
  };
  await f.state.transaction(async (tx) => {
    assert.equal((await f.sessions.serviceWork.admit(tx, execution)).admitted, true);
  });
  const reserved = await snapshot();
  assert.notEqual(reserved.accounting.serviceWork.hash, reported.accounting.serviceWork.hash);
  await f.state.transaction((tx) => f.sessions.serviceWork.settle(tx, execution, 'completed'));
  const settled = await snapshot();
  assert.notEqual(settled.accounting.serviceWork.hash, reserved.accounting.serviceWork.hash);
  assert.deepEqual(settled.closures, reported.closures);
  assert.equal(JSON.stringify(settled).includes(execution.operationId), false);
});
