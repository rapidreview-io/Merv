/**
 * Home and the rail read every wave on each poll, so Reflections answers them in a fixed number
 * of statements however many waves the project has made.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Caller, State, Transaction } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

/** How many statements `run` issues itself; background work the app does meanwhile is not counted. */
function counter(state: State) {
  const mine = new AsyncLocalStorage<{ statements: number }>();
  const patched = new WeakSet<object>();
  const patch = (tx: Transaction) => {
    if (patched.has(tx)) return;
    patched.add(tx);
    for (const key of ['get', 'all', 'run'] as const) {
      const original = tx[key] as (...args: unknown[]) => unknown;
      Object.assign(tx, {
        [key]: (...args: unknown[]) => {
          const count = mine.getStore();
          if (count) count.statements++;
          return original.apply(tx, args);
        },
      });
    }
  };
  const target = state as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of ['transaction', 'read'] as const) {
    const original = target[name]!.bind(state);
    target[name] = (fn: unknown, ...rest: unknown[]) =>
      original(
        async (tx: Transaction) => {
          patch(tx);
          return await (fn as (tx: Transaction) => unknown)(tx);
        },
        ...rest,
      );
  }
  return async (run: () => Promise<unknown>) => {
    const count = { statements: 0 };
    await mine.run(count, run);
    return count.statements;
  };
}

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
});
