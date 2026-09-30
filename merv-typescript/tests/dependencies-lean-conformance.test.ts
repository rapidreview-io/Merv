import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { createService, type WorkflowDefinition, type WorkflowPolicy } from '@merv/contracts';
import { WorkflowsService } from '@merv/workflows';
import { ProjectScope } from '@merv/scope';
import { openState, schemaFor } from './fixtures/state.js';

type Command =
  | { kind: 'add' | 'drop'; source: number; targets: number[] }
  | { kind: 'replace'; source: number; owner: number; targets: number[] }
  | { kind: 'finish' | 'fail' | 'gate'; node: number };
type Observation = { outcome: string; edges: number[][]; revisions: number[]; states: string[] };
const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const binary = resolve(modelDir, '.lake/build/bin/workflow_dependencies_model');
const skip =
  !existsSync(binary) && process.env.MERV_REQUIRE_LEAN !== '1'
    ? 'Build workflow_dependencies_model to run dependency conformance'
    : undefined;
function model(commands: Command[]): Observation[] {
  const run = spawnSync(binary, [], {
    input: JSON.stringify({ nodes: 4, commands }),
    encoding: 'utf8',
  });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  return (JSON.parse(run.stdout) as { observations: Observation[] }).observations;
}
function canonical(observations: Observation[]): Observation[] {
  return observations.map((o) => ({
    ...o,
    edges: [...o.edges].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!),
  }));
}
const definition: WorkflowDefinition = {
  name: 'lean_dependencies',
  version: 1,
  managed: true,
  initial: 'working',
  states: ['working', 'done', 'failed'],
  terminal: ['done', 'failed'],
  edges: [
    { from: 'working', action: 'finish', to: 'done' },
    { from: 'working', action: 'fail', to: 'failed' },
  ],
};
const policy: WorkflowPolicy = {
  successStates: ['done'],
  actions: [
    {
      name: 'finish',
      states: ['working'],
      transitions: ['finish'],
      tool: 'work.finish',
      instruction: 'Finish.',
      requiresDependencies: true,
      check: async () => {},
    },
    {
      name: 'fail',
      states: ['working'],
      transitions: ['fail'],
      tool: 'work.fail',
      instruction: 'End without success.',
      check: async () => {},
    },
  ],
};
async function fixture(t: TestContext, omitCycleCheck = false) {
  const schema = schemaFor();
  const state = await openState(':memory:', { schema });
  const scope = await createService(new ProjectScope(state));
  const boot = await scope.bootstrap({ projectName: 'Dependency proof', actorName: 'Owner' });
  const caller = { actorId: boot.actor.id, projectId: boot.project.id };
  const workflows = await createService(new WorkflowsService(state, scope));
  const handle = await workflows.register(definition, policy);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++)
    ids.push(
      (
        await handle.start(caller, {
          workflow: definition.name,
          requestId: `start-${i}`,
        })
      ).id,
    );
  let injected = 0;
  if (omitCycleCheck) {
    const transaction = state.transaction.bind(state);
    state.transaction = (fn) =>
      transaction((tx) => {
        const get = tx.get.bind(tx);
        tx.get = async (sql, ...params) => {
          if (sql.includes('WITH RECURSIVE reached')) {
            injected++;
            return undefined;
          }
          return get(sql, ...params);
        };
        return fn(tx);
      });
  }
  t.after(async () => {
    await workflows.close();
    await state.close();
  });
  const observations: Observation[] = [];
  const apply = async (command: Command) => {
    let outcome: string =
      command.kind === 'add'
        ? 'added'
        : command.kind === 'drop'
          ? 'dropped'
          : command.kind === 'replace'
            ? 'replaced'
            : command.kind === 'finish'
              ? 'done'
              : command.kind === 'fail'
                ? 'failed'
                : 'ready';
    const target = (id: number) => ids[id] ?? `missing-${id}`;
    try {
      if (command.kind === 'add' || command.kind === 'drop') {
        const before = await workflows.get(caller, target(command.source));
        await handle.addDependencies(caller, {
          instanceId: before.id,
          expectedRevision: before.revision,
          requestId: `command-${observations.length}`,
          dependsOn: command.kind === 'add' ? command.targets.map(target) : [],
          ...(command.kind === 'drop' ? { drop: command.targets.map(target) } : {}),
        });
      } else if (command.kind === 'replace') {
        await state.transaction((tx) =>
          workflows.systemPrerequisites(`provider-${command.owner}`).replace(
            {
              projectId: caller.projectId,
              instanceId: target(command.source),
              dependencies: command.targets.map(target),
            },
            tx,
          ),
        );
      } else if (command.kind === 'gate') {
        await workflows.checkDependencies(caller, target(command.node));
      } else if (command.kind === 'finish' || command.kind === 'fail') {
        const before = await workflows.get(caller, target(command.node));
        await handle.transition(caller, {
          instanceId: before.id,
          expectedRevision: before.revision,
          requestId: `command-${observations.length}`,
          action: command.kind,
        });
      }
    } catch (error) {
      outcome = (error as { code: string }).code;
      assert.ok(
        [
          'invalid_transition',
          'dependency_cycle',
          'not_found',
          'dependencies_pending',
          'dependency_failed',
        ].includes(outcome),
        String(error),
      );
    }
    const current = await Promise.all(ids.map((id) => workflows.get(caller, id)));
    const edges = await state.read((sql) =>
      sql.all<{ source_id: string; target_id: string; owner: string }>(
        'SELECT source_id,target_id,owner FROM wf_dependencies WHERE project_id=?',
        caller.projectId,
      ),
    );
    observations.push({
      outcome,
      edges: edges.map((e) => [
        ids.indexOf(e.source_id),
        ids.indexOf(e.target_id),
        e.owner ? Number(e.owner.slice(9)) : 0,
      ]),
      revisions: current.map((s) => s.revision),
      states: current.map((s) => s.state),
    });
  };
  return {
    apply,
    observations,
    injected: () => injected,
    state,
    workflows,
    handle,
    ids,
    caller,
    schema,
  };
}
function trace(seed: number): Command[] {
  const commands: Command[] = [
    { kind: 'add', source: 0, targets: [1, 1] },
    { kind: 'add', source: 0, targets: [1] }, // no-op receipt, no revision
    { kind: 'add', source: 1, targets: [2] },
    { kind: 'add', source: 2, targets: [0] }, // longer cycle
    { kind: 'replace', source: 2, owner: 1, targets: [3] },
    { kind: 'add', source: 3, targets: [0] }, // cycle traverses system edge
    { kind: 'add', source: 3, targets: [3] },
    { kind: 'add', source: 3, targets: [0, 4] }, // whole batch refused
    { kind: 'finish', node: 0 },
    { kind: 'gate', node: 2 },
    { kind: 'replace', source: 2, owner: 2, targets: [3] },
    { kind: 'replace', source: 2, owner: 1, targets: [] }, // other provider retained
    { kind: 'drop', source: 0, targets: [1] },
  ];
  let random = seed >>> 0;
  const next = (n: number) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random % n;
  };
  for (let i = 0; i < 45; i++) {
    const source = next(4),
      targets = [next(4)];
    switch (next(4)) {
      case 0:
        commands.push({ kind: 'add', source, targets });
        break;
      case 1:
        commands.push({ kind: 'drop', source, targets });
        break;
      case 2:
        commands.push({ kind: 'replace', source, owner: 1 + next(2), targets });
        break;
      default:
        commands.push({ kind: 'gate', node: source });
    }
  }
  commands.push(
    { kind: 'fail', node: 3 },
    { kind: 'gate', node: 2 },
    { kind: 'add', source: 2, targets: [3] },
    { kind: 'gate', node: 2 },
    { kind: 'drop', source: 2, targets: [3] },
    { kind: 'gate', node: 2 },
  );
  // Re-plan to a known graph, then exercise success as well as refusals: an oracle
  // that never opens a gate must not pass this comparator.
  for (const source of [0, 1, 2]) {
    commands.push(
      { kind: 'drop', source, targets: [0, 1, 2, 3] },
      { kind: 'replace', source, owner: 1, targets: [] },
      { kind: 'replace', source, owner: 2, targets: [] },
    );
  }
  commands.push(
    { kind: 'finish', node: 2 },
    { kind: 'add', source: 0, targets: [2] },
    { kind: 'replace', source: 0, owner: 1, targets: [2] },
    { kind: 'gate', node: 0 },
    { kind: 'finish', node: 0 },
    { kind: 'finish', node: 0 },
    { kind: 'add', source: 0, targets: [1] },
    { kind: 'fail', node: 1 },
  );
  return commands;
}
test(
  'Lean dependency rank certificates agree with real declared and system graph commands',
  { skip },
  async (t) => {
    for (const seed of [1, 7, 23])
      await t.test(`seed ${seed}`, async (t) => {
        const f = await fixture(t),
          commands = trace(seed);
        for (const command of commands) await f.apply(command);
        assert.deepEqual(
          canonical(f.observations),
          canonical(model(commands)),
          JSON.stringify(commands),
        );
        const outcomes = new Set(f.observations.map((o) => o.outcome));
        for (const outcome of [
          'added',
          'dropped',
          'replaced',
          'dependency_cycle',
          'not_found',
          'dependencies_pending',
          'dependency_failed',
          'ready',
          'done',
          'failed',
          'invalid_transition',
        ])
          assert.ok(outcomes.has(outcome), `missing ${outcome}`);
      });
  },
);
test(
  'dependency comparator rejects an actual omitted SQL cycle check',
  {
    skip:
      skip ?? (process.env.MERV_LEAN_MUTATIONS === '1' ? undefined : 'Set MERV_LEAN_MUTATIONS=1'),
  },
  async (t) => {
    const f = await fixture(t, true);
    const commands: Command[] = [
      { kind: 'add', source: 0, targets: [1] },
      { kind: 'add', source: 1, targets: [0] },
    ];
    for (const command of commands) await f.apply(command);
    assert.equal(f.injected(), 2, 'mutation must run through the production cycle query');
    assert.throws(() => assert.deepEqual(canonical(f.observations), canonical(model(commands))), {
      code: 'ERR_ASSERTION',
    });
    assert.equal(f.observations[1]!.edges.length, 2, 'mutant really committed a cycle');
  },
);

test(
  'two database connections cannot jointly admit a reverse dependency cycle',
  { skip },
  async (t) => {
    const f = await fixture(t);
    const second = await openState(':memory:', { schema: f.schema });
    const otherScope = await createService(new ProjectScope(second));
    const otherWorkflows = await createService(new WorkflowsService(second, otherScope));
    const other = await otherWorkflows.register(definition, policy);
    t.after(async () => {
      await otherWorkflows.close();
      await second.close();
    });
    const results = await Promise.allSettled([
      f.handle.addDependencies(f.caller, {
        instanceId: f.ids[0]!,
        dependsOn: [f.ids[1]!],
        expectedRevision: 0,
        requestId: 'race-a',
      }),
      other.addDependencies(f.caller, {
        instanceId: f.ids[1]!,
        dependsOn: [f.ids[0]!],
        expectedRevision: 0,
        requestId: 'race-b',
      }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal((loser.reason as { code: string }).code, 'dependency_cycle');
    const winner = results[0]!.status === 'fulfilled' ? 0 : 1;
    const expected = model([
      { kind: 'add', source: winner, targets: [1 - winner] },
      { kind: 'add', source: 1 - winner, targets: [winner] },
    ]).at(-1)!;
    const edges = await f.state.read((sql) =>
      sql.all<{ source_id: string; target_id: string }>(
        'SELECT source_id,target_id FROM wf_dependencies',
      ),
    );
    assert.deepEqual(
      edges.map((e) => [f.ids.indexOf(e.source_id), f.ids.indexOf(e.target_id), 0]),
      expected.edges,
    );
    const receipt = await f.state.read((sql) =>
      sql.get(
        'SELECT request_id FROM wf_requests WHERE request_id=?',
        winner === 0 ? 'race-b' : 'race-a',
      ),
    );
    assert.equal(receipt, undefined, 'losing addition committed no replay receipt');
  },
);
