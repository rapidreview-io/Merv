import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { canonical, digest, type WorkflowPolicy } from '@merv/contracts';
import { LeasedSessions } from '@merv/sessions';
import { declaredWithinMs } from '@merv/sessions/dispatch';

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
