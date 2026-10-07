/**
 * An agent's open question to its owner is said on its work's card, in Sessions' words, on the
 * Running board and the Work map alike, and counts as needing a person. Once the work it asked
 * about ends, its question stands nowhere: not on the card, not on its thread, not in the count.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller, RunningBoard } from '@merv/contracts';
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

  const card = async () => {
    const board = (await app.ctx.tools.call('ui.running', owner, {})) as RunningBoard;
    const node = board.lanes.work.nodes.find((item) => item.key === `work:${wave.id}`);
    return { says: node?.attention?.says, needsYou: board.lanes.work.needsYou };
  };
  const thread = async () =>
    (await app.ctx.sessions.threads.project(owner)).threads.find((item) =>
      item.visits.some((visit) => visit.status !== 'offered'),
    );
  // The lens is folded into its wave's card, which says what the lens's agent did.
  assert.deepEqual(await card(), { says: ['Asked you a question'], needsYou: 1 });
  assert.equal((await thread())?.question?.question, 'Which cohort counts?');
  assert.equal((await app.ctx.sessions.threads.counts(owner)).waiting, 1);

  // Another author writes the lens: the work the question was about has ended.
  const issued = await app.ctx.scope.credentials.issueActor(owner, { name: 'B', role: 'producer' });
  const author: Caller = {
    projectId: owner.projectId,
    actorId: issued.actor.id,
    credentialId: issued.credential.id,
  };
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
});
