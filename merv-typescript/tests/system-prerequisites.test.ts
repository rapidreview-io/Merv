import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolutionFixture } from './fixtures/resolution.js';

test('provider prerequisites gate work without declaring failure', async (t) => {
  const f = await resolutionFixture(t);
  const handle = await f.workflows.register(
    {
      name: 'prerequisite',
      version: 1,
      managed: true,
      initial: 'working',
      states: ['working', 'done', 'failed'],
      terminal: ['done', 'failed'],
      edges: [
        { from: 'working', action: 'finish', to: 'done' },
        { from: 'working', action: 'fail', to: 'failed' },
      ],
    },
    {
      successStates: ['done'],
      dependencyFailureAction: 'fail',
      actions: [
        {
          name: 'finish',
          tool: 'probe.finish',
          instruction: 'Finish.',
          states: ['working'],
          transitions: ['finish'],
          requiresDependencies: true,
          check: () => {},
        },
        {
          name: 'fail',
          tool: 'probe.fail',
          instruction: 'Fail.',
          states: ['working'],
          transitions: ['fail'],
          suggested: false,
          check: () => {},
        },
      ],
    },
  );
  const start = (requestId: string) =>
    handle.start(f.admin, { workflow: 'prerequisite', requestId });
  const upstream = await start('upstream'),
    waiter = await start('waiter');
  const capability = f.workflows.systemPrerequisites('code');
  const input = {
    projectId: f.admin.projectId,
    instanceId: waiter.id,
    requestId: 'attach',
    dependencies: [upstream.id],
  };
  for (let i = 0; i < 2; i++) await f.state.transaction((tx) => capability.replace(input, tx));
  const edges = (await f.workflows.dependencies(f.admin, waiter.id)).dependencies;
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'system');
  assert.equal(edges[0].owner, 'code');
  await assert.rejects(f.workflows.checkDependencies(f.admin, waiter.id), {
    code: 'dependencies_pending',
  });
  await assert.rejects(
    f.state.transaction((tx) => capability.replace({ ...input, dependencies: [] }, tx)),
    { code: 'idempotency_conflict' },
  );
  await handle.transition(f.admin, {
    instanceId: upstream.id,
    action: 'fail',
    expectedRevision: 0,
    requestId: 'fail',
  });
  const decision = await f.workflows.evaluate(f.admin, waiter.id);
  assert.equal(decision.currentGate, 'dependencies_pending');
  assert.equal(decision.nextAction, null);
  assert.equal(decision.dependencies[0].failed, false);
  await f.state.transaction((tx) =>
    f.workflows
      .systemPrerequisites('other')
      .replace({ ...input, requestId: 'other', dependencies: [] }, tx),
  );
  assert.equal((await f.workflows.dependencies(f.admin, waiter.id)).dependencies.length, 1);
  await handle.addDependencies(f.admin, {
    instanceId: waiter.id,
    expectedRevision: 0,
    dependsOn: [upstream.id],
    requestId: 'declared',
  });
  assert.equal((await f.workflows.dependencies(f.admin, waiter.id)).dependencies.length, 2);
  await handle.addDependencies(f.admin, {
    instanceId: waiter.id,
    expectedRevision: 1,
    dependsOn: [],
    drop: [upstream.id],
    requestId: 'drop-declared',
  });
  assert.equal((await f.workflows.dependencies(f.admin, waiter.id)).dependencies[0].kind, 'system');
  await f.state.transaction((tx) =>
    capability.replace({ ...input, requestId: 'detach', dependencies: [] }, tx),
  );
  await f.workflows.checkDependencies(f.admin, waiter.id);
});

test('workspace-free tasks work with Code absent and task manifests retain their published hashes', async (t) => {
  const f = await resolutionFixture(t);
  const task = await f.tasks.create(f.admin, {
    title: 'Note',
    goal: 'Write a note.',
    checks: ['The note exists.'],
    requestId: 'note',
  });
  assert.equal(task.workflow.version, 2);
  assert.equal(
    await f.workflows.leaseRole(f.admin, { instanceId: task.id, expectedRevision: 0 }),
    'producer',
  );
  const published = JSON.parse(
    readFileSync(new URL('./fixtures/published-policies.json', import.meta.url), 'utf8'),
  );
  await f.state.read(async (sql) => {
    for (const row of published.definitions.filter((row: { name: string }) => row.name === 'task'))
      assert.equal(
        (await sql.get<{ fingerprint: string }>(
          'SELECT fingerprint FROM wf_definitions WHERE name=? AND version=?',
          row.name,
          row.version,
        ))!.fingerprint,
        row.fingerprint,
      );
    for (const row of published.policies.filter(
      (row: { workflow: string }) => row.workflow === 'task',
    ))
      assert.equal(
        (await sql.get<{ fingerprint: string }>(
          'SELECT fingerprint FROM wf_execution_policies WHERE workflow=? AND version=? AND state=?',
          row.workflow,
          row.version,
          row.state,
        ))!.fingerprint,
        row.fingerprint,
      );
  });
});
