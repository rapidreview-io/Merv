/**
 * A lens agent may ask its owner (its visits keep a conversation), and while its question
 * stands dispatch withholds the lens, so the wave cannot join and every new task and experiment
 * waits. Its question is therefore a line on Needs you, counted once by the rail, and its link
 * opens the wave's card on the asking thread.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import './ui-render.js';

await import('../packages/ui/web/components.js');
const { needsYou } = await import('../packages/ui/web/views/needs-you.js');

test('a lens agent’s question reaches Needs you once, and its link opens the wave on its thread', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-lens-question-'));
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
  const secret = `ms_${randomBytes(32).toString('base64url')}`;
  const session = await app.ctx.sessions.offer(owner, {
    instanceId: lens.id,
    expectedRevision: lens.workflow.revision,
    runnerId: 'external',
    requestId: `assign-${lens.id}`,
    secret,
  });
  const worker = await app.ctx.sessions.authenticate(secret);
  await app.ctx.tools.invoke('session.ask_owner', worker, { question: 'Which cohort counts?' });

  const lines = async () => {
    const shell = (await app.ctx.tools.call('ui.shell', owner, {})) as { rows: never[] };
    const home = (await app.ctx.tools.call('ui.home', owner, {})) as never;
    return needsYou(shell.rows, home, { id: owner.actorId }, () => undefined);
  };
  // One line, so the rail counts one: the lens's question, under its wave's name.
  const asked = await lines();
  assert.deepEqual(
    asked.map((line) => [line.id, line.kind, line.name, line.sentence]),
    [
      [
        lens.id,
        'reflections',
        wave.title,
        'Answer its agent’s question with a message to its thread; dispatch then offers the work again',
      ],
    ],
  );
  assert.ok(asked[0]!.says.includes('Its agent asked its owner: Which cohort counts?'));
  // The link opens the wave's card on the asking thread.
  assert.equal(asked[0]!.to, `/work?key=work:${wave.id}&thread=${session.threadId}`);

  // The answer ends the line.
  await app.ctx.tools.call('session.message', owner, {
    threadId: session.threadId,
    body: 'The 2025 cohort.',
    requestId: 'answer',
  });
  assert.deepEqual(await lines(), []);
});
