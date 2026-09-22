import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { enqueueMirror, type MirrorTransport } from '@merv/code/store/mirror';
import type { CodeService } from '@merv/code-research/service';
import { createApp } from '../src/app.js';
import type { ApplicationConfig } from '../src/config.js';
import { boundProject } from './fixtures/code-binding.js';
import { gitSource } from './fixtures/code-store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'hosted bridge unload joins the mirror journal and reload preserves the independent repository owner',
  { timeout: 15_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-bridge-unload-'));
    const config = JSON.parse(
      readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
    ) as ApplicationConfig;
    const ids = new Set([
      'state',
      'scope',
      'workflows',
      'domain-events',
      'blobs',
      'artifacts',
      'sessions',
      'code',
      'code-research',
    ]);
    config.plugins = config.plugins.filter(({ id }) => ids.has(id));
    config.plugins.find(({ id }) => id === 'code-research')!.config = {
      repositories: { autoMerge: false, mirrorSeconds: 0 },
    };
    const app = await createApp({ directory, config });
    const entered = deferred(),
      release = deferred();
    t.after(async () => {
      release.resolve();
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    const { ctx } = app;
    const core = ctx.code;
    const repositories = core.repositories!;
    const source = gitSource(t);
    const head = source.commit({ 'notes.md': 'retained research' });
    const boot = await ctx.scope.bootstrap({ projectName: 'Hosted reload', actorName: 'Owner' });
    const caller = {
      projectId: boot.project.id,
      actorId: boot.actor.id,
      credentialId: boot.credential.id,
    };
    await boundProject(ctx.state, caller.projectId, head, 'repository');
    const bridge = ctx.codeResearch as CodeService;
    const bundle = source.bundle(head);
    const imported = await bridge.importRepository(caller, {
      source: 'bundle',
      tip: head,
      bundle: { sha256: bundle.sha256, bytes: bundle.bytes },
      requestId: 'import',
    });
    await bridge.v2!.putPart(caller, imported.id, 0, bundle.content);
    const completed = (await bridge.v2!.call(caller, `uploads/${imported.id}/complete`, {})) as {
      operation: { status: string };
    };
    assert.equal(completed.operation.status, 'completed');
    await ctx.workflows.register({
      name: 'mirror-work',
      version: 1,
      initial: 'working',
      states: ['working', 'done'],
      terminal: ['done'],
      edges: [{ from: 'working', action: 'finish', to: 'done' }],
    });
    const unit = await ctx.workflows.start(caller, { workflow: 'mirror-work', requestId: 'work' });
    await ctx.state.transaction(async (tx) => {
      await bridge.declareUnit(caller, unit.id, tx);
      await enqueueMirror(tx, caller.projectId, 'mirror-accepted', unit.id, head);
    });
    let pushes = 0;
    // The real mirror pass and its journal run; only the remote endpoint is replaced.
    const transport: MirrorTransport = {
      target: async () => ({ repository: 'fixture/remote' }),
      lsRemote: async () => null,
      push: async () => {
        pushes++;
        return 'ok';
      },
    };
    (bridge as unknown as { mirrorStore: { transport: MirrorTransport } }).mirrorStore.transport =
      transport;
    const transaction = ctx.state.transaction.bind(ctx.state);
    ctx.state.transaction = (body) =>
      transaction(async (tx) => {
        const run = tx.run.bind(tx);
        tx.run = async (sql, ...params) => {
          if (sql.includes("SET status='completed',phase='mirrored'")) {
            entered.resolve();
            await release.promise;
          }
          return run(sql, ...params);
        };
        return body(tx);
      });
    const mirroring = bridge.mirrorStep();
    await entered.promise;
    assert.equal(pushes, 1, 'the push finished before the held journal write');
    let unloaded = false;
    const unloading = app.setEnabled('code-research', false).then(() => {
      unloaded = true;
    });
    await setImmediate();
    await setImmediate();
    assert.equal(app.status().find(({ id }) => id === 'code-research')?.state, 'unloading');
    assert.equal(unloaded, false, 'withdrawal must join the final journal, not just the push');
    release.resolve();
    await Promise.all([unloading, mirroring]);
    ctx.state.transaction = transaction;
    assert.equal(ctx.get('codeResearch'), undefined);
    assert.equal(ctx.code, core);
    const journal = await ctx.state.read((sql) =>
      sql.get<{ status: string; phase: string }>(
        "SELECT status,phase FROM code_operations WHERE kind='mirror-accepted'",
      ),
    );
    assert.deepEqual(journal && { ...journal }, { status: 'completed', phase: 'mirrored' });
    const env = repositories.environment(caller.projectId);
    await repositories.run(caller.projectId, () =>
      repositories.git.ok(['update-ref', 'refs/merv/core-survives', head], { env }),
    );
    await app.setEnabled('code-research', true);
    assert.equal(app.status().find(({ id }) => id === 'code-research')?.state, 'active');
    assert.equal(ctx.code.repositories, repositories);
    assert.notEqual(ctx.codeResearch, bridge);
    assert.equal(
      (await repositories.git.ok(['rev-parse', 'refs/merv/core-survives'], { env }))
        .toString()
        .trim(),
      head,
    );
    (
      ctx.codeResearch as unknown as { mirrorStore: { transport: MirrorTransport } }
    ).mirrorStore.transport = transport;
    await (ctx.codeResearch as CodeService).mirrorStep();
    assert.equal(pushes, 1, 'the completed journal is not republished after reload');
  },
);
