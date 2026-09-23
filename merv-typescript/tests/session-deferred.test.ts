import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Caller } from '@merv/contracts';
import type { Session } from '@merv/sessions/types';
import { MachineRunner } from '@merv/runner';
import { CodeWorkspaceDriver } from '@merv/code/driver/index';
import { createApp } from './fixtures/app.js';
import { boundProject } from './fixtures/code-binding.js';
import { gitSource, importBundle } from './fixtures/code-store.js';

/**
 * A machine that is ready and willing and cannot reach what keeps the project's history.
 * Nothing here is a fault of the work or of the machine, so the lease is given back as
 * deferred: the target backs off and no counter moves.
 */
test('a machine that cannot reach Code defers its lease instead of failing it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'merv-deferred-'));
  const operator = gitSource(t);
  const main = operator.commit({ 'README.md': 'The project.\n' }, 'Initial');
  const app = await createApp({ directory: join(root, 'server'), api: true, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Deferred', actorName: 'Owner' });
  const owner: Caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const { codeResearch: code, tasks, sessions, state } = app.ctx;

  await boundProject(state, owner.projectId, main, 'fixture-repository');
  await importBundle(code, owner, operator.bundle(main));

  const task = await tasks.create(owner, {
    title: 'Harness',
    goal: 'Build the harness.',
    checks: ['It runs'],
    workspace: 'git',
    requestId: 'hosted',
  });
  assert.equal(task.workflow.version, 5);

  const credentialEnv = 'MERV_DEFERRED_RUNNER';
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = (
    await app.ctx.scope.issueActor(owner, { name: 'Machine', role: 'operator' })
  ).token;
  t.after(() => {
    if (previous === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previous;
  });
  const executable = join(root, 'agent.sh');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  let away = true;
  const runner = new MachineRunner(
    {
      directory: join(root, 'machine'),
      baseUrl: app.ctx.api.url!,
      projectId: owner.projectId,
      credentialEnv,
      profiles: [{ name: 'worker', harness: 'claude', executable, enabled: true, parallelism: 1 }],
    },
    {
      autoPoll: false,
      drivers: [
        {
          name: 'code.v2',
          create: (host, transport) => new CodeWorkspaceDriver(host, transport, { pollMs: 25 }),
        },
      ],
      fetch: async (input, init) => {
        if (away && String(input).endsWith('/code/v2/workspace'))
          return new Response(
            JSON.stringify({ error: { code: 'code_store_unavailable', message: 'Busy' } }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        return await fetch(input, init);
      },
    },
  );
  t.after(async () => await runner.stop());
  await runner.start();
  await sessions.setDispatch(owner, { enabled: true });

  const stored = async (): Promise<Session[]> =>
    (
      await state.read(
        async (sql) =>
          await sql.all<{ session_json: string }>('SELECT session_json FROM worker_sessions'),
      )
    ).map((row) => JSON.parse(row.session_json) as Session);
  const closed = await (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      await runner.tick().catch(() => {});
      const ended = (await stored()).find((session) => session.closedAt !== null);
      if (ended) return ended;
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(50);
    }
  })();
  assert.equal(closed.outcome, 'preparation_deferred');
  assert.deepEqual(closed.deferral, {
    cause: 'store_busy',
    code: 'code_store_unavailable',
  });
  assert.deepEqual(
    await state.read(async (sql) => await sql.all('SELECT * FROM session_dispatch_holds')),
    [],
    'a deferral counts against nobody, so no hold can form',
  );
  // A generation that never attached closes with nothing in it, so the unit is free again.
  const unit = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const current = await code.unit(owner, task.id);
      if (current.writerState !== 'reserved') return current;
      assert.ok(Date.now() < deadline, current.writerState);
      await delay(50);
    }
  })();
  assert.deepEqual([unit.generation, unit.writerState, unit.canonicalHead], [1, 'closed', null]);

  // The machine is not held either: once Code answers, the next lease is generation two.
  // Dispatch spaces a deferred target's next lease by 30 s from the close it reads in the
  // session row; closing it that long ago takes the place of waiting out the window.
  away = false;
  await state.transaction(async (tx) => {
    await tx.run('ALTER TABLE worker_sessions DISABLE TRIGGER worker_sessions_immutable');
    await tx.run(
      "UPDATE worker_sessions SET session_json=jsonb_set(session_json::jsonb,'{closedAt}',to_jsonb(?::text))::text WHERE id=?",
      new Date(Date.parse(closed.closedAt!) - 31_000).toISOString(),
      closed.id,
    );
    await tx.run('ALTER TABLE worker_sessions ENABLE TRIGGER worker_sessions_immutable');
  });
  const resumed = await (async () => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      await runner.tick().catch(() => {});
      const leased = (await stored()).find((session) => session.id !== closed.id);
      if (leased) return leased;
      assert.ok(Date.now() < deadline, JSON.stringify(runner.snapshot()));
      await delay(200);
    }
  })();
  assert.equal(resumed.instanceId, task.id);
  assert.equal((await code.unit(owner, task.id)).generation, 2);
});
