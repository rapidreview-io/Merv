import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunnerConfig } from '@merv/runner';
import { createApp } from './fixtures/app.js';

test('documented no-Code server and runner compose usable research without Git plugins', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'merv-no-code-config-'));
  const app = await createApp({
    directory,
    configFile: fileURLToPath(new URL('../config/no-code.example.json', import.meta.url)),
    port: 0,
  });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(app.status().every((entry) => !entry.id.startsWith('code')));
  for (const id of ['research', 'tasks', 'experiments', 'reflections', 'reviews', 'api', 'ui'])
    assert.equal(app.status().find((entry) => entry.id === id)?.state, 'active', id);
  assert.equal(app.ctx.get('code'), undefined);
  assert.equal(app.ctx.get('codeResearch'), undefined);
  const boot = await app.ctx.scope.bootstrap({ projectName: 'No Git', actorName: 'Researcher' });
  const caller = {
    projectId: boot.project.id,
    actorId: boot.actor.id,
    credentialId: boot.credential.id,
  };
  const task = await app.ctx.tasks.create(caller, {
    title: 'Compare observations',
    goal: 'Explain the evidence',
    checks: ['Evidence retained'],
    requestId: 'task',
  });
  assert.equal(task.workflow.state, 'in_progress');
  const shell = (await app.ctx.tools.call('ui.shell', caller, {})) as { rows: { id: string }[] };
  assert.ok(!shell.rows.some((row) => row.id === 'code'));
  assert.ok(!(await app.ctx.tools.list()).some((tool) => tool.name.startsWith('code.')));
  const runner = validateRunnerConfig(
    JSON.parse(
      readFileSync(new URL('../config/runner-no-code.example.json', import.meta.url), 'utf8'),
    ),
  );
  assert.deepEqual(runner.workspaceDrivers, []);
  assert.equal(runner.workspace, undefined);
});
