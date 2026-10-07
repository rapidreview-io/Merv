/**
 * Cycle 11 review: "Asked you a question" reaches only whoever answers the question. Another
 * blocker on the same work that is the reader's own move (a model budget wait, say) does not make
 * the question theirs.
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

test('a question is “you” only to its answerer, whatever else of the reader’s the work waits on', async (t) => {
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

  // The same work also waits on the author's own move, published by another provider.
  await app.ctx.state.transaction(
    async (tx) =>
      await app.ctx.workflows.replaceBlockers(
        {
          projectId: owner.projectId,
          instanceId: lens.id,
          provider: 'zz-review-budget',
          blockers: [
            {
              key: 'budget',
              code: 'model_budget',
              status: 409,
              message: 'Your daily model tokens are used up',
              next: 'Raise your limit in Settings',
              whose: `actor:${author.actorId}`,
            },
          ],
        },
        tx,
      ),
  );
  const theirs = (await card(author)).says;
  assert.notDeepEqual(theirs, ['Asked you a question'], 'the author does not answer the question');
});
