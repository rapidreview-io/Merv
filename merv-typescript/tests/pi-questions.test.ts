import assert from 'node:assert/strict';
import test from 'node:test';
import { questionResponder } from '@merv/pi/questions';
import type { ThreadQuestion } from '@merv/sessions/types';
import { fixture } from './fixtures/pi.js';

const question: ThreadQuestion = {
  id: 'question_1',
  threadId: 'thread_1',
  sessionId: 'session_1',
  instanceId: 'work_1',
  revision: 7,
  question: 'Which cohort counts?',
  askedAt: '2026-09-23T00:00:00Z',
  answeredAt: null,
  answerMessageId: null,
  open: true,
};

test('Pi binds before launching, reuses its durable conversation and runs with normal delegated authority', async (t) => {
  const f = await fixture(t);
  const source = await f.scope.delegationSource(f.operator);
  const responder = questionResponder(f.pi, f.scope);
  let reference: { id: string; route: string } | undefined;
  const attach = async (ref: { id: string; route: string }) => {
    reference = ref;
    assert.equal((await f.pi.snapshot(f.operator, ref.id)).commands.length, 0);
    return true;
  };
  await responder.start({ question, source, attach });
  assert.ok(reference);
  assert.equal(reference.route, `/agent?conversation=${reference.id}`);
  const snapshot = await f.pi.snapshot(f.operator, reference.id);
  assert.equal(snapshot.commands.length, 1);
  assert.match(snapshot.commands[0]!.messages[0]!.text, /session.question.resolve/);
  assert.match(snapshot.commands[0]!.messages[0]!.text, /Expected revision: 7/);
  await responder.start({
    question,
    source,
    attach: async (ref) => {
      assert.equal(ref.id, reference!.id);
      return true;
    },
  });
  assert.equal((await f.pi.snapshot(f.operator, reference.id)).commands.length, 1);
  assert.equal(await responder.inspect(source, reference), null);
  const bound = await f.claimed(snapshot.commands[0]!);
  await f.pi.begin(bound.token, bound.input);
  const result = await f.pi.tool(bound.token, { ...bound.input, name: 'project.get', input: {} });
  assert.equal((result as { error?: unknown }).error, undefined, 'it reads as the person');
  await f.pi.complete(bound.token, f.completion(bound.input));
  assert.match((await responder.inspect(source, reference))!, /finished without resolving/);
});

test('an obsolete question does not launch a turn; revoked authority cannot start one', async (t) => {
  const f = await fixture(t);
  const source = await f.scope.delegationSource(f.operator);
  const responder = questionResponder(f.pi, f.scope);
  let id = '';
  await responder.start({
    question,
    source,
    attach: async (ref) => {
      id = ref.id;
      return false;
    },
  });
  assert.equal((await f.pi.snapshot(f.operator, id)).commands.length, 0);
  await f.state.transaction(async (tx) => {
    await tx.run('UPDATE actors SET active=0 WHERE id=?', f.operator.actorId);
  });
  await assert.rejects(
    responder.start({
      question: { ...question, id: 'question_2' },
      source,
      attach: async () => true,
    }),
    { code: 'forbidden' },
  );
});

test('a question with a character across its 100th unit still reaches Pi', async (t) => {
  const f = await fixture(t);
  let reference: { id: string } | undefined;
  await questionResponder(f.pi, f.scope).start({
    question: { ...question, question: `${'Is the bound '.padEnd(99, '.')}𝒪(n log n) tight?` },
    source: await f.scope.delegationSource(f.operator),
    attach: async (ref) => !!(reference = ref),
  });
  const { conversation } = await f.pi.snapshot(f.operator, reference!.id);
  assert.equal(conversation.title, `Worker question: ${'Is the bound '.padEnd(99, '.')}`);
});
