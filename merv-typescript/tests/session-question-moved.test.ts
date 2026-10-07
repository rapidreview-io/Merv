/**
 * Cycle 11 review: whether a question stands is one rule, and Workflows' blocker for it is about
 * one revision. Once the work it asked about moves on by another hand (not ending), the card drops
 * it; the thread, the count, the box and a plain message must agree.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller, RunningBoard } from '@merv/contracts';
import { MervError } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

const token = () => `ms_${randomBytes(32).toString('base64url')}`;

test('a question about a revision the work has moved past stands nowhere, as its blocker does not', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-question-cards-'));
  const { plugins } = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  ) as { plugins: { id: string; config?: unknown }[] };
  const app = await createApp({
    directory: join(directory, 'data'),
    config: {
      plugins: plugins.map((entry) =>
        entry.id === 'api'
          ? { ...entry, config: { host: '127.0.0.1', port: 0 } }
          : entry.id === 'ui'
            ? { ...entry, config: { assets: join(directory, 'nowhere') } }
            : entry,
      ) as never,
    },
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.credentials.bootstrap({ projectName: 'Q', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const wave = await app.ctx.reflections.create(owner, { requestId: 'wave' });
  const lens = wave.lenses[0]!;
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

  const card = async (reader = owner) => {
    const board = (await app.ctx.tools.call('ui.running', reader, {})) as RunningBoard;
    const node = board.lanes.work.nodes.find((item) => item.key === `work:${wave.id}`);
    return { says: node?.attention?.says, needsYou: board.lanes.work.needsYou };
  };
  const thread = async () =>
    (await app.ctx.sessions.threads.project(owner)).threads.find((item) =>
      item.visits.some((visit) => visit.status !== 'offered'),
    );
  const threadId = (await thread())!.id;
  // The lens is folded into its wave's card, which says what the lens's agent did.
  assert.deepEqual(await card(), { says: ['Asked you a question'], needsYou: 1 });
  assert.equal((await thread())?.question?.question, 'Which cohort counts?');
  assert.equal((await app.ctx.sessions.threads.counts(owner)).waiting, 1);
  // Its card links to the thread, on Sessions' own Agents page, where the box answers it.
  const board = (await app.ctx.tools.call('ui.running', owner, {})) as RunningBoard;
  assert.deepEqual(
    board.lanes.work.nodes.find((item) => item.key === `work:${wave.id}`)?.attention?.to,
    { route: `/sessions?thread=${encodeURIComponent(threadId)}`, text: 'Answer it' },
  );

  // The work moves on by another hand, at the same state: the question's blocker was about the
  // revision it was asked at, so Workflows no longer holds it.
  await app.ctx.state.transaction(
    async (tx) => await tx.run('UPDATE wf_instances SET revision=revision+1 WHERE id=?', lens.id),
  );
  assert.notDeepEqual((await card()).says, ['Asked you a question'], 'the card drops it');
  assert.equal((await card()).needsYou, 0);
  assert.equal((await thread())?.question, undefined, 'its thread no longer waits on the answer');
  assert.equal((await app.ctx.sessions.threads.counts(owner)).waiting, 0);
  const box = await app.ctx.sessions.messaging.thread(owner, threadId);
  assert.deepEqual(
    box.questions.map((question) => [question.open, question.answeredAt]),
    [[false, null]],
  );
  // The thread is on open work, so it takes a message, which does not answer the old question.
  await app.ctx.sessions.messaging.message(owner, {
    threadId,
    body: 'Carry on.',
    requestId: 'later',
  });
  const after = await app.ctx.sessions.messaging.thread(owner, threadId);
  assert.equal(
    after.questions[0]!.answeredAt,
    null,
    'a question that no longer stands is not answered',
  );
});
