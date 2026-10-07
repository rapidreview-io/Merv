/**
 * What one worker tool call costs in SQL. A worker's authority is checked many times per call
 * (the tool's own reads, the admission, every owner hook the lease check consults), so Scope
 * keeps one tool call's decisions per transaction: the lease is validated once per call, not
 * once per check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Caller } from '@merv/contracts';
import { createApp } from './fixtures/app.js';
import { currentTask } from './fixtures/current-work.js';

test(
  'a worker artifact.read reads its actor and lease once per transaction',
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'merv-worker-cost-'));
    const app = await createApp({ directory, api: true, port: 0 });
    t.after(async () => {
      await app.stop();
      rmSync(directory, { recursive: true, force: true });
    });
    const boot = await app.ctx.scope.credentials.bootstrap({
      projectName: 'P',
      actorName: 'Owner',
    });
    const owner = {
      actorId: boot.actor.id,
      projectId: boot.project.id,
      credentialId: boot.credential.id,
    };
    await app.ctx.sessions.dispatch.heartbeatRunner(owner, {
      runnerId: 'external',
      machine: { hostname: 'fixture', system: 'test', architecture: 'test' },
      platforms: [{ name: 'test', harness: 'codex', enabled: true, parallelism: 4 }],
      capacity: 4,
      capabilities: ['code.v2'],
    });
    const task = await currentTask(app.ctx, owner, {
      title: 't',
      goal: 'g',
      checks: ['c'],
      requestId: 'r1',
    });
    const token = `ms_${randomBytes(32).toString('base64url')}`;
    await app.ctx.sessions.offer(owner, {
      instanceId: task.id,
      expectedRevision: task.workflow.revision,
      runnerId: 'external',
      requestId: 'o1',
      secret: token,
    });
    const worker = await app.ctx.sessions.authenticate(token);
    const artifact = (await app.ctx.tools.call('artifact.create', worker, {
      title: 'A',
      content: 'x',
    })) as { id: string };

    // Only this call's statements: background consumers run outside it.
    const counting = new AsyncLocalStorage<string[]>();
    const query = pg.Client.prototype.query;
    t.mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (text) counting.getStore()?.push(text);
      return (query as (...args: unknown[]) => unknown).apply(this, args);
    });
    const cost = async (caller: Caller) => {
      const statements: string[] = [];
      const read = await counting.run(statements, () =>
        app.ctx.tools.call('artifact.read', caller, { artifactId: artifact.id }),
      );
      assert.ok(JSON.stringify(read).includes(artifact.id));
      return statements;
    };
    await cost(worker);
    const statements = await cost(worker);
    const count = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql)).length;
    const snapshots = count(/^BEGIN/);
    const message = `${statements.length} statements in ${snapshots} transactions:\n${statements.join('\n')}`;
    // Sessions checks the worker's authority in each transaction of the call; within one, the
    // actor rows (the worker's and its delegator's) and the lease row are read once, however many
    // checks and hooks ask.
    assert.ok(count(/FROM actors a/) <= 2 * snapshots, message);
    assert.ok(count(/FROM wf_leases/) <= snapshots, message);
    // The stored receipt (up to 128K characters) is never read to check a lease.
    assert.equal(count(/SELECT \*.*FROM wf_leases|SELECT receipt FROM/), 0, message);
    assert.ok(statements.length < 140, message);
    // The owner's same call, for scale, is a dozen.
    assert.ok((await cost(owner)).length < 20);
  },
);
