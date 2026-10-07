/**
 * Home and the rail read every wave on each poll, so Reflections answers them in a fixed number
 * of statements however many waves the project has made; a wave's page reads it without
 * running an action's check.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';
import { counter } from './fixtures/statements.js';

test('Home reads its waves in the same statements however many there are', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-reflections-home-'));
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
  const boot = await app.ctx.scope.credentials.bootstrap({ projectName: 'H', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  await waitForManagedCode(app.ctx.codeWork, owner);
  const measure = counter(app.ctx.state);
  let made = 0;
  const home = async (waves: number) => {
    for (; made < waves; made++) {
      const wave = await app.ctx.reflections.create(owner, { requestId: `wave-${made}` });
      await app.ctx.reflections.end(owner, {
        reflectionId: wave.id,
        expectedRevision: wave.workflow.revision,
        reason: 'Superseded by a later wave.',
        requestId: `end-${made}`,
      });
    }
    // The first read after a write warms what later reads remember; the second is the poll's.
    await app.ctx.tools.call('ui.home', owner, {});
    return await measure(() => app.ctx.tools.call('ui.home', owner, {}));
  };
  const one = await home(1);
  const four = await home(4);
  assert.equal(four, one, `ui.home took ${one} statements with 1 wave and ${four} with 4`);
  const { reflections } = (await app.ctx.tools.call('ui.home', owner, {})) as {
    reflections: { id: string; workflow: { state: string }; lenses: unknown[] }[];
  };
  assert.equal(reflections.length, 4);
  const [newest] = reflections;
  const full = await app.ctx.reflections.get(owner, newest!.id);
  assert.equal(newest!.workflow.state, full.workflow.state);
  assert.deepEqual(
    newest!.lenses,
    full.lenses.map((lens) => ({
      id: lens.id,
      workflow: JSON.parse(JSON.stringify(lens.workflow)),
      written: !!lens.artifact,
    })),
  );
  // A wave's page reads the wave and its stage with no action checked, in fewer statements.
  const page = (await app.ctx.tools.call('ui.read', owner, {
    rowId: 'reflections',
    params: { id: newest!.id },
  })) as { reflection: unknown; process: unknown };
  assert.deepEqual(page, {
    reflection: JSON.parse(JSON.stringify(full)),
    process: JSON.parse(
      JSON.stringify(await app.ctx.workflows.process(owner, newest!.id, { checks: false })),
    ),
  });
});
