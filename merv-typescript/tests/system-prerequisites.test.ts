import { requireDependencies } from '@merv/workflows/rules';
import { historicalTask } from './fixtures/historical-task.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolutionFixture } from './fixtures/resolution.js';

/** Work that finishes only once its prerequisites have succeeded, and can fail by hand. */
async function prerequisiteWorkflow(f: Awaited<ReturnType<typeof resolutionFixture>>) {
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
  return {
    handle,
    start: (requestId: string, title?: string) =>
      handle.start(f.admin, {
        workflow: 'prerequisite',
        requestId,
        ...(title ? { data: { title } } : {}),
      }),
  };
}

test('provider prerequisites gate work without declaring failure', async (t) => {
  const f = await resolutionFixture(t);
  const { handle, start } = await prerequisiteWorkflow(f);
  const upstream = await start('upstream'),
    waiter = await start('waiter');
  const capability = f.workflows.systemPrerequisites('code');
  const input = {
    projectId: f.admin.projectId,
    instanceId: waiter.id,
    dependencies: [upstream.id],
  };
  for (let i = 0; i < 2; i++) await f.state.transaction((tx) => capability.replace(input, tx));
  const edges = (await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!;
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, 'system');
  assert.equal(edges[0].owner, 'code');
  await assert.rejects(
    async () =>
      requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!),
    {
      code: 'dependencies_pending',
    },
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
  // The target has ended without succeeding: that is a fact on the edge, not a failure of it.
  const { settled, terminal, failed } = decision.dependencies[0];
  assert.deepEqual(
    { settled, terminal, failed },
    { settled: false, terminal: true, failed: false },
  );
  await f.state.transaction((tx) =>
    f.workflows.systemPrerequisites('other').replace({ ...input, dependencies: [] }, tx),
  );
  assert.equal((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!.length, 1);
  await handle.addDependencies(f.admin, {
    instanceId: waiter.id,
    expectedRevision: 0,
    dependsOn: [upstream.id],
    requestId: 'declared',
  });
  assert.equal((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!.length, 2);
  await handle.addDependencies(f.admin, {
    instanceId: waiter.id,
    expectedRevision: 1,
    dependsOn: [],
    drop: [upstream.id],
    requestId: 'drop-declared',
  });
  assert.equal(
    (await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)![0].kind,
    'system',
  );
  await f.state.transaction((tx) => capability.replace({ ...input, dependencies: [] }, tx));
  requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!);
});

test('dependency messages judge failure over every edge and name each target once', async (t) => {
  const f = await resolutionFixture(t);
  const { handle, start } = await prerequisiteWorkflow(f);
  const upstream = await start('upstream', 'Upstream'),
    waiter = await start('waiter');
  const input = {
    projectId: f.admin.projectId,
    instanceId: waiter.id,
    dependencies: [upstream.id],
  };
  await f.state.transaction((tx) => f.workflows.systemPrerequisites('code').replace(input, tx));
  await assert.rejects(
    async () =>
      requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!),
    {
      code: 'dependencies_pending',
      message:
        'Work is waiting on unfinished dependencies: prerequisite Upstream (working, required by code).',
    },
  );
  // The provider's edge comes first; the declared one to the same target is the one named.
  await handle.addDependencies(f.admin, {
    instanceId: waiter.id,
    expectedRevision: 0,
    dependsOn: [upstream.id],
    requestId: 'declared',
  });
  assert.deepEqual(
    (await f.workflows.prerequisites(f.admin, [waiter.id]))
      .get(waiter.id)!
      .map((item) => item.kind),
    ['system', undefined],
  );
  await assert.rejects(
    async () =>
      requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!),
    {
      code: 'dependencies_pending',
      message: 'Work is waiting on unfinished dependencies: prerequisite Upstream (working).',
    },
  );
  await handle.transition(f.admin, {
    instanceId: upstream.id,
    action: 'fail',
    expectedRevision: 0,
    requestId: 'fail',
  });
  await assert.rejects(
    async () =>
      requireDependencies((await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!),
    {
      code: 'dependency_failed',
      message: 'A dependency has ended without succeeding: prerequisite Upstream (failed).',
    },
  );
  const decision = await f.workflows.evaluate(f.admin, waiter.id);
  assert.equal(decision.currentGate, 'dependency_failed');
  assert.equal(
    decision.instruction,
    'A dependency has ended without succeeding: prerequisite Upstream (failed). Fail.',
  );
});

test('provider prerequisites are a set: replacing restores it by value', async (t) => {
  const f = await resolutionFixture(t);
  const { handle, start } = await prerequisiteWorkflow(f);
  const a = await start('a'),
    b = await start('b'),
    waiter = await start('waiter');
  const replace = (dependencies: unknown) =>
    f.state.transaction((tx) =>
      f.workflows.systemPrerequisites('code').replace(
        {
          projectId: f.admin.projectId,
          instanceId: waiter.id,
          dependencies: dependencies as string[],
        },
        tx,
      ),
    );
  const held = async () =>
    (await f.workflows.prerequisites(f.admin, [waiter.id])).get(waiter.id)!.map((item) => item.id);
  // A to B and back to A at one revision: the last value wins, whatever was asked before.
  await replace([a.id]);
  await replace([b.id]);
  await replace([a.id]);
  assert.deepEqual(await held(), [a.id]);
  assert.equal((await f.workflows.get(f.admin, waiter.id)).revision, 0);
  await replace([` ${b.id}  `, a.id, b.id]);
  assert.deepEqual((await held()).sort(), [a.id, b.id].sort());
  await assert.rejects(replace(5), { code: 'invalid_dependencies', status: 400 });
  await assert.rejects(replace([a.id, 5]), { code: 'invalid_dependencies', status: 400 });
  assert.deepEqual((await held()).sort(), [a.id, b.id].sort());
  // Ended work is not refused; a provider still clears what it holds.
  await handle.transition(f.admin, {
    instanceId: waiter.id,
    action: 'fail',
    expectedRevision: 0,
    requestId: 'fail',
  });
  await replace([]);
  assert.deepEqual(await held(), []);
});

test('the engine names no program in what it says', () => {
  const source = new URL('../packages/workflows/src/', import.meta.url);
  for (const file of readdirSync(source, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.ts'),
  ))
    assert.doesNotMatch(readFileSync(new URL(file, source), 'utf8'), /\bresearch\./, file);
});

test('historical tasks remain read-only and current published hashes remain', async (t) => {
  const f = await resolutionFixture(t);
  const task = await historicalTask(f, f.admin, {
    title: 'Note',
    goal: 'Write a note.',
    checks: ['The note exists.'],
    requestId: 'note',
  });
  assert.equal(task.workflow.version, 28);
  assert.equal((await f.tasks.get(f.admin, task.id)).guidance.available, false);
  assert.deepEqual(await f.workflows.dispatchCandidates(f.admin), []);
  await assert.rejects(
    f.tasks.markFailed(f.admin, {
      taskId: task.id,
      expectedRevision: 0,
      reason: 'Cannot change history',
      requestId: 'no-write',
    }),
    { code: 'workflow_version_retired' },
  );
  const published = JSON.parse(
    readFileSync(new URL('./fixtures/published-policies.json', import.meta.url), 'utf8'),
  );
  // A retired version is no longer registered; its published row is kept only as history.
  const live = (row: { retired?: boolean }) => !row.retired;
  await f.state.read(async (sql) => {
    for (const row of published.definitions.filter(
      (row: { name: string; retired?: boolean }) => row.name === 'task' && live(row),
    ))
      assert.equal(
        (await sql.get<{ fingerprint: string }>(
          'SELECT fingerprint FROM wf_definitions WHERE name=? AND version=?',
          row.name,
          row.version,
        ))!.fingerprint,
        row.fingerprint,
      );
    for (const row of published.policies.filter(
      (row: { workflow: string; retired?: boolean }) => row.workflow === 'task' && live(row),
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
