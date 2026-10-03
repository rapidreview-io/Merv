import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';
import { waitForManagedCode } from './fixtures/managed-code.js';

test('the default application creates Git without GitHub and offers new work from its retained root', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-managed-app-'));
  const app = await createApp({ directory, port: 0 });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({
    projectName: 'Disconnected research',
    actorName: 'Owner',
  });
  const caller = { projectId: boot.project.id, actorId: boot.actor.id };
  const status = await waitForManagedCode(app.ctx.codeWork, caller);
  assert.equal(status.store?.source, 'managed');
  assert.equal((await app.ctx.codeWork.github.status(caller)).repository, null);
  const tasks = await Promise.all(
    ['one', 'two'].map((requestId) =>
      app.ctx.tasks.create(caller, {
        title: requestId,
        goal: 'Retain source',
        checks: ['Source is retained'],
        requestId,
      }),
    ),
  );
  for (const task of tasks) {
    assert.equal(task.workspace, 'git');
    const assignment = await app.ctx.workflows.assignment(caller, task.id);
    assert.ok(assignment);
    const unit = await app.ctx.codeWork.unit(caller, task.id);
    assert.notEqual(unit.baseStatus?.status, 'blocked');
  }
  const after = await app.ctx.codeWork.status(caller);
  assert.equal(after.project?.main.oid, status.project!.main.oid);
  assert.deepEqual(after.store?.tips, [status.project!.main.oid]);
});
