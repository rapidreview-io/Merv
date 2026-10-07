/**
 * An agent's open question to its owner is said on its work's card, in Sessions' words, on the
 * Running board and the Work map alike, and links to its thread. It is "you" only to whoever
 * answers it, and counts as needing that person alone. Once the work it asked about ends, its
 * question stands nowhere: not on the card, not on its thread, not in the count, not in the
 * thread's box, and no message answers it.
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

test('a lens question marks its wave’s card until the lens it asked about ends', async (t) => {
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

  // A reader who does not answer it reads whose question it is, and it needs nothing of them.
  const issued = await app.ctx.scope.credentials.issueActor(owner, { name: 'B', role: 'producer' });
  const author: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
  assert.deepEqual(await card(author), {
    says: ['Its agent asked its owner a question'],
    needsYou: 0,
  });

  // Another author writes the lens: the work the question was about has ended.
  const report = await app.ctx.artifacts.create(author, {
    title: 'Evidence lens',
    content: '# Summary\nWritten by hand.',
  });
  const now = await app.ctx.reflections.lens(owner, lens.id);
  await app.ctx.reflections.submitLens(author, {
    lensId: lens.id,
    expectedRevision: now.workflow.revision,
    artifactId: report.id,
    requestId: 'by-hand',
  });
  assert.notDeepEqual((await card()).says, ['Asked you a question']);
  assert.equal((await card()).needsYou, 0);
  assert.equal((await thread())?.question, undefined, 'its thread no longer waits on the answer');
  assert.equal((await thread())?.attention, undefined, 'nor keeps its place on the first page');
  assert.equal((await app.ctx.sessions.threads.counts(owner)).waiting, 0);
  // Its thread's box no longer offers to answer it, and the thread, on ended work, takes no
  // message: none answers the old question in passing.
  assert.equal((await thread())?.takesMessage, false);
  const box = await app.ctx.sessions.messaging.thread(owner, threadId);
  assert.deepEqual(
    box.questions.map((question) => [question.open, question.answeredAt]),
    [[false, null]],
  );
  await assert.rejects(
    app.ctx.sessions.messaging.message(owner, {
      threadId,
      body: 'Use the 2024 cohort.',
      requestId: 'late-answer',
    }),
    (error: unknown) => error instanceof MervError && error.code === 'thread_retired',
  );
  const after = await app.ctx.sessions.messaging.thread(owner, threadId);
  assert.equal(
    after.questions[0]!.answeredAt,
    null,
    'the question that no longer stands is not answered',
  );
});
