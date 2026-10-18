/**
 * Sessions answers what Customer experiments' healer asks of a worker's questions, from its own
 * table: whether a thread asked about a work item, and which question there waits unanswered.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { httpApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

const token = () => `ms_${randomBytes(32).toString('base64url')}`;

test('Sessions says whether a thread asked about a work item and which question waits unanswered', async (t) => {
  const { app } = await httpApp(t, 'merv-question-reads-');
  const boot = await app.ctx.scope.credentials.bootstrap({ projectName: 'Q', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const wave = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  const lens = wave.lenses[0]!;
  const { messaging } = app.ctx.sessions;
  assert.equal(await messaging.unansweredQuestion(lens.id), null);
  const secret = token();
  await app.ctx.sessions.offer(owner, {
    instanceId: lens.id,
    expectedRevision: 0,
    runnerId: 'external',
    requestId: `assign-${lens.id}`,
    secret,
  });
  const worker = await app.ctx.sessions.authenticate(secret);
  await app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Which cohort counts?' });
  const threadId = (await app.ctx.sessions.threads.project(owner)).threads.find((item) =>
    item.visits.some((visit) => visit.status !== 'offered'),
  )!.id;
  const [asked] = (await messaging.thread(owner, threadId)).questions;

  assert.equal(await messaging.threadAsked(threadId, lens.id), true);
  assert.equal(await messaging.threadAsked(threadId, wave.id), false, 'about another item');
  assert.equal(await messaging.threadAsked('thread_other', lens.id), false);
  assert.deepEqual(await messaging.unansweredQuestion(lens.id), {
    id: asked!.id,
    threadId,
    askedAt: asked!.askedAt,
    question: 'Which cohort counts?',
  });

  await messaging.message(owner, { threadId, body: 'The 2024 one.', requestId: 'answer' });
  assert.equal(await messaging.unansweredQuestion(lens.id), null);
  assert.equal(await messaging.threadAsked(threadId, lens.id), true, 'answered, it was asked');
});
