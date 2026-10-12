import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Caller, RunningBoard } from '@merv/contracts';
import type { QuestionResponder, ThreadQuestion } from '@merv/sessions/types';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-question-responder-'));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  const options = {
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry: { id: string }) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'absent') } }
            : entry,
      ),
    },
  };
  let app = await createApp(options);
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({
    projectName: 'Questions',
    actorName: 'Owner',
  });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const source = await app.ctx.scope.delegationSource(owner);
  t.after(app.ctx.scope.registerConversationAuthority({ require: async () => source }));
  const agent: Caller = {
    projectId: owner.projectId,
    actorId: owner.actorId,
    conversation: { id: 'investigation', commandId: 'turn', runtimeId: 'runtime', epoch: 1 },
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const wave = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  let index = 0;
  const ask = async () => {
    const lens = wave.lenses[index++]!;
    const secret = `ms_${randomBytes(32).toString('base64url')}`;
    await app.ctx.sessions.offer(owner, {
      instanceId: lens.id,
      expectedRevision: 0,
      runnerId: 'external',
      requestId: lens.id,
      secret,
    });
    return await app.ctx.sessions.messaging.ask(await app.ctx.sessions.authenticate(secret), {
      question: 'Which cohort counts?',
    });
  };
  let messaging = app.ctx.sessions.messaging;
  const view = async (q: ThreadQuestion) =>
    (await messaging.thread(owner, q.threadId)).questions.find((row) => row.id === q.id)!;
  const due = () =>
    app.ctx.state.transaction(async (tx) => {
      await tx.run(
        "UPDATE session_question_responses SET check_at='2000-01-01T00:00:00Z' WHERE state='investigating'",
      );
    });
  let starts = 0;
  const register = (overrides: Partial<QuestionResponder> = {}) =>
    messaging.registerResponder({
      name: 'test',
      label: 'Investigator',
      async start({ attach }) {
        starts++;
        await attach({ id: 'investigation', route: '/agent?conversation=investigation' });
      },
      async inspect() {
        return null;
      },
      ...overrides,
    });
  const resolve = (
    q: ThreadQuestion,
    outcome: 'answered' | 'needs_you' = 'answered',
    requestId = 'resolution',
  ) =>
    messaging.resolve(agent, {
      questionId: q.id,
      expectedRevision: q.revision,
      outcome,
      body: 'Checked the data; cohort A.',
      requestId,
    });
  const board = async () => (await app.ctx.tools.call('ui.running', owner, {})) as RunningBoard;
  return {
    get app() {
      return app;
    },
    owner,
    agent,
    ask,
    get messaging() {
      return messaging;
    },
    view,
    due,
    register,
    resolve,
    board,
    starts: () => starts,
    async restart() {
      await app.stop();
      app = await createApp(options);
      messaging = app.ctx.sessions.messaging;
      t.after(app.ctx.scope.registerConversationAuthority({ require: async () => source }));
    },
  };
}

test('without a responder, questions go directly to the owner; registering later does not take them away', async (t) => {
  const f = await fixture(t);
  const q = await f.ask();
  assert.equal((await f.view(q)).response, undefined);
  assert.equal((await f.board()).lanes.work.needsYou, 1);
  const unregister = f.register();
  await f.app.ctx.sessions.sweep();
  assert.equal(f.starts(), 0);
  await f.messaging.message(f.owner, {
    threadId: q.threadId,
    body: 'Cohort A',
    requestId: 'human',
  });
  assert.equal((await f.view(q)).open, false);
  await unregister();
});

test('investigation hides human attention, answers exactly once, queues attribution and releases the blocker', async (t) => {
  const f = await fixture(t);
  const unregister = f.register();
  const q = await f.ask();
  assert.equal((await f.view(q)).response?.state, 'investigating');
  assert.equal(
    (await f.app.ctx.sessions.threads.project(f.owner)).threads.find(
      (thread) => thread.id === q.threadId,
    )?.question?.response?.state,
    'investigating',
  );
  assert.equal((await f.board()).lanes.work.needsYou, 0);
  await f.app.ctx.sessions.sweep();
  await f.due();
  await f.app.ctx.sessions.sweep();
  assert.equal(f.starts(), 1, 'attached investigations are inspected, not started again');
  await assert.rejects(
    f.messaging.message(f.agent, {
      threadId: q.threadId,
      body: 'Broad answer',
      requestId: 'broad',
    }),
    { code: 'question_resolution_required' },
  );
  const answered = await f.resolve(q);
  assert.equal(answered.open, false);
  assert.equal(answered.response?.state, 'answered');
  assert.deepEqual(await f.resolve(q), answered, 'retry is the same accepted answer');
  const thread = await f.messaging.thread(f.owner, q.threadId);
  assert.equal(thread.messages.length, 1);
  assert.match(thread.messages[0]!.body, /Investigator acting on your behalf/);
  assert.equal((await f.app.ctx.sessions.threads.counts(f.owner)).waiting, 0);
  await unregister();
});

test('needs_you preserves the blocker and conversation; a later turn can answer', async (t) => {
  const f = await fixture(t);
  const unregister = f.register();
  const q = await f.ask();
  await f.app.ctx.sessions.sweep();
  await f.resolve(q, 'needs_you', 'escalate');
  assert.equal((await f.view(q)).open, true);
  assert.equal((await f.view(q)).response?.reference?.id, 'investigation');
  assert.equal((await f.board()).lanes.work.needsYou, 1);
  assert.equal((await f.messaging.thread(f.owner, q.threadId)).messages.length, 0);
  await f.resolve(q, 'answered', 'after-person');
  assert.equal((await f.view(q)).open, false);
  await unregister();
});

test('a human answer wins and stale or unrelated conversation answers cannot queue messages', async (t) => {
  const f = await fixture(t);
  const unregister = f.register();
  const q = await f.ask();
  await f.app.ctx.sessions.sweep();
  await assert.rejects(
    f.messaging.resolve(
      { ...f.agent, conversation: { ...f.agent.conversation!, id: 'other' } },
      {
        questionId: q.id,
        expectedRevision: 0,
        outcome: 'answered',
        body: 'wrong conversation',
        requestId: 'other',
      },
    ),
    { code: 'question_responder_forbidden' },
  );
  await f.messaging.message(f.owner, {
    threadId: q.threadId,
    body: 'Human answer',
    requestId: 'human',
  });
  await assert.rejects(f.resolve(q), { code: 'question_obsolete' });
  assert.equal((await f.messaging.thread(f.owner, q.threadId)).messages.length, 1);
  const next = await f.ask();
  await f.app.ctx.sessions.sweep();
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run('UPDATE wf_instances SET revision=revision+1 WHERE id=?', next.instanceId);
  });
  await assert.rejects(f.resolve(next), { code: 'question_obsolete' });
  assert.equal((await f.messaging.thread(f.owner, next.threadId)).messages.length, 0);
  await unregister();
});

test('launch failure, stopped investigation, timeout and unload all return attention to the person', async (t) => {
  const f = await fixture(t);
  let unregister = f.register({
    async start() {
      throw new Error('unavailable');
    },
  });
  const failed = await f.ask();
  await f.app.ctx.sessions.sweep();
  assert.equal((await f.view(failed)).response?.state, 'needs_you');
  await unregister();
  unregister = f.register({
    async inspect() {
      return 'Investigation failed';
    },
  });
  const stopped = await f.ask();
  await f.app.ctx.sessions.sweep();
  await f.due();
  await f.app.ctx.sessions.sweep();
  assert.equal((await f.view(stopped)).response?.state, 'needs_you');
  await unregister();
  unregister = f.register();
  const timeout = await f.ask();
  await f.app.ctx.state.transaction(async (tx) => {
    await tx.run(
      "UPDATE session_question_responses SET deadline='2000-01-01T00:00:00Z' WHERE question_id=?",
      timeout.id,
    );
  });
  await f.app.ctx.sessions.sweep();
  assert.equal((await f.view(timeout)).response?.state, 'needs_you');
  const unloaded = await f.ask();
  await unregister();
  assert.equal((await f.view(unloaded)).response?.state, 'needs_you');
  assert.equal((await f.view(unloaded)).open, true);
  assert.equal(
    (await f.board()).lanes.work.needsYou,
    1,
    'the wave needs its owner, regardless of how many lenses wait',
  );
});

test('restart recovers an attached investigation without starting it again; absent responder falls back', async (t) => {
  const f = await fixture(t);
  f.register();
  const q = await f.ask();
  await f.app.ctx.sessions.sweep();
  assert.equal(f.starts(), 1);
  await f.restart();
  let inspected = 0;
  f.register({
    async inspect() {
      inspected++;
      return null;
    },
  });
  await f.due();
  await f.app.ctx.sessions.sweep();
  assert.equal(inspected, 1);
  assert.equal(f.starts(), 1);
  assert.equal((await f.view(q)).response?.state, 'investigating');
  await f.restart();
  await f.due();
  await f.app.ctx.sessions.sweep();
  assert.equal((await f.view(q)).response?.state, 'needs_you');
});
