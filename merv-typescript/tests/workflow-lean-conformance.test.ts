import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createService } from '@merv/contracts';
import type { WorkflowDefinition, WorkflowSnapshot } from '@merv/contracts';
import { PostgresState } from '@merv/state';
import { ProjectScope } from '@merv/scope';
import { WorkflowsService } from '@merv/workflows';
import { openState } from './fixtures/state.js';

/** The executable model receives an abstract command fingerprint, not engine internals. */
type Command = {
  requestId: string;
  fingerprint: string;
  expectedRevision: number;
  action: string;
  guard: true;
};
type Observation = {
  kind: 'committed' | 'replayed' | 'revision_conflict' | 'request_conflict' | 'invalid_transition';
  state: string;
  revision: number;
  historyLength: number;
  currentState: string;
  currentRevision: number;
  receiptCount: number;
};

type Scenario = { graph: WorkflowDefinition; path: (seed: number) => string[] };
const scenarios: Scenario[] = [
  {
    graph: {
      name: 'lean_cycle',
      version: 1,
      initial: 'draft',
      states: ['draft', 'review', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'draft', action: 'submit', to: 'review' },
        { from: 'review', action: 'revise', to: 'draft' },
        { from: 'review', action: 'accept', to: 'done' },
      ],
    },
    path: (seed) => [
      ...Array.from({ length: 1 + (seed % 3) }, () => ['submit', 'revise']).flat(),
      'submit',
      'accept',
    ],
  },
  {
    graph: {
      name: 'lean_self_loop',
      version: 1,
      initial: 'active',
      states: ['active', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'active', action: 'tick', to: 'active' },
        { from: 'active', action: 'finish', to: 'done' },
      ],
    },
    path: (seed) => [...Array.from({ length: 1 + (seed % 3) }, () => 'tick'), 'finish'],
  },
  {
    graph: {
      name: 'lean_branch',
      version: 1,
      initial: 'ready',
      states: ['ready', 'left', 'right', 'done'],
      terminal: ['done'],
      edges: [
        { from: 'ready', action: 'go_left', to: 'left' },
        { from: 'ready', action: 'go_right', to: 'right' },
        { from: 'left', action: 'finish_left', to: 'done' },
        { from: 'right', action: 'finish_right', to: 'done' },
      ],
    },
    path: (seed) => (seed % 2 ? ['go_left', 'finish_left'] : ['go_right', 'finish_right']),
  },
  {
    graph: {
      name: 'lean_terminal_initial',
      version: 1,
      initial: 'done',
      states: ['done'],
      terminal: ['done'],
      edges: [],
    },
    path: () => [],
  },
  {
    graph: {
      name: 'lean_dead_end',
      version: 1,
      initial: 'draft',
      states: ['draft', 'stalled'],
      terminal: [],
      edges: [{ from: 'draft', action: 'halt', to: 'stalled' }],
    },
    path: () => ['halt'],
  },
];

const modelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../verification/lean');
const modelBinary = resolve(modelDir, '.lake/build/bin/workflow_model');
const modelAvailable = existsSync(modelBinary);

function modelInput(graph: WorkflowDefinition, commands: Command[]): string {
  return JSON.stringify({
    graph,
    commands,
    initialReceipts: [
      {
        requestId: 'start',
        fingerprint: 'start-payload',
        response: { state: graph.initial, revision: 0 },
      },
    ],
  });
}

function modelObservations(graph: WorkflowDefinition, commands: Command[]): Observation[] {
  const run = spawnSync(modelBinary, [], {
    cwd: modelDir,
    input: modelInput(graph, commands),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.equal(run.error, undefined, `Lean could not start: ${run.error?.message}`);
  assert.equal(run.status, 0, `Lean model failed:\n${run.stderr}`);
  const output = JSON.parse(run.stdout) as { observations: Observation[] };
  assert.equal(output.observations.length, commands.length);
  return output.observations;
}

function assertTraceEqual(
  expected: Observation[],
  actual: Observation[],
  graph: WorkflowDefinition,
  commands: Command[],
  seed: number,
): void {
  assert.equal(actual.length, commands.length);
  actual.forEach((step, index) => {
    assert.deepEqual(
      step,
      expected[index],
      `${graph.name}, seed ${seed}, step ${index}: ${JSON.stringify(commands[index])}`,
    );
  });
}

/** A small fixed generator keeps every failure reproducible by seed and step. */
function trace(scenario: Scenario, seed: number): Command[] {
  let randomState = seed;
  const next = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const commands: Command[] = [];
  const command = (requestId: string, action: string, expectedRevision: number): Command => ({
    requestId,
    fingerprint: JSON.stringify({ action, expectedRevision }),
    action,
    expectedRevision,
    guard: true,
  });
  const fresh = (action: string, expectedRevision: number) => {
    const requestId = `seed-${seed}-step-${commands.length}`;
    commands.push(command(requestId, action, expectedRevision));
  };
  // Start owns a project-wide request id, so a transition cannot reuse it.
  commands.push(command('start', 'unknown', 0));
  let revision = 0;
  let prior: Command | undefined;
  let firstCommitted: Command | undefined;
  for (const action of scenario.path(seed)) {
    fresh(`unknown_${next() % 7}`, revision); // invalid while the instance is live
    if (prior) {
      commands.push({ ...prior }); // replay an older response after later commits
      commands.push(command(prior.requestId, 'different', prior.expectedRevision));
      fresh(action, revision - 1); // stale revision has priority over edge selection
    }
    fresh(action, revision);
    prior = commands.at(-1);
    firstCommitted ??= prior;
    revision++;
  }
  fresh(`unknown_${next() % 7}`, revision); // terminal or nonterminal dead end
  if (revision > 0) fresh('unknown', revision - 1);
  if (prior) commands.push({ ...prior });
  if (firstCommitted && firstCommitted !== prior) commands.push({ ...firstCommitted });
  commands.push(command('start', 'different', revision));
  return commands;
}

async function engineObservations(
  graph: WorkflowDefinition,
  commands: Command[],
): Promise<Observation[]> {
  const state: PostgresState = await openState();
  try {
    const scope = await createService(new ProjectScope(state));
    const credentials = await scope.bootstrap({
      projectName: 'Lean conformance',
      actorName: 'Operator',
    });
    const caller = { actorId: credentials.actor.id, projectId: credentials.project.id };
    const workflows = await createService(new WorkflowsService(state, scope));
    const program = await workflows.register(graph);
    const initial = await program.start(caller, { workflow: graph.name, requestId: 'start' });
    const committed = new Set<string>();
    const observations: Observation[] = [];
    for (const command of commands) {
      let kind: Observation['kind'];
      let response: WorkflowSnapshot | undefined;
      try {
        response = await program.transition(caller, {
          instanceId: initial.id,
          requestId: command.requestId,
          expectedRevision: command.expectedRevision,
          action: command.action,
        });
        kind = committed.has(command.requestId) ? 'replayed' : 'committed';
        if (kind === 'committed') committed.add(command.requestId);
      } catch (error) {
        const code = (error as { code?: string }).code;
        assert.ok(
          code === 'revision_conflict' ||
            code === 'request_conflict' ||
            code === 'invalid_transition',
          `Unexpected engine error: ${String(code ?? error)}`,
        );
        kind = code;
      }
      const current = await workflows.get(caller, initial.id);
      const historyLength = (await workflows.history(caller, initial.id)).length;
      const eventCount = (await state.events(caller.projectId)).filter(
        (event) => event.type === 'workflow.transition',
      ).length;
      const receiptCount = await state.transaction(async (tx) => {
        const row = await tx.get<{ count: string }>(
          'SELECT COUNT(*) AS count FROM wf_requests WHERE project_id = ?',
          caller.projectId,
        );
        return Number(row?.count);
      });
      assert.equal(eventCount, historyLength, 'a command changed the event count without history');
      assert.equal(
        receiptCount,
        historyLength,
        'a command changed the receipt count without history',
      );
      observations.push({
        kind,
        state: response?.state ?? current.state,
        revision: response?.revision ?? current.revision,
        historyLength,
        currentState: current.state,
        currentRevision: current.revision,
        receiptCount,
      });
    }
    return observations;
  } finally {
    await state.close();
  }
}

test(
  'generated workflow traces agree with the executable Lean transition model',
  {
    skip:
      !modelAvailable && process.env.MERV_REQUIRE_LEAN !== '1'
        ? 'Build the Lean model with lake build workflow_model to run conformance'
        : undefined,
  },
  async (t) => {
    assert.ok(modelAvailable, `Lean model binary is missing: ${modelBinary}`);
    const seen = new Set<Observation['kind']>();
    const visitedStates = new Map<string, Set<string>>();
    let commandCount = 0;
    for (const scenario of scenarios) {
      for (const seed of [1, 2, 7]) {
        const commands = trace(scenario, seed);
        const expected = modelObservations(scenario.graph, commands);
        const actual = await engineObservations(scenario.graph, commands);
        assertTraceEqual(expected, actual, scenario.graph, commands, seed);
        commandCount += commands.length;
        const states = visitedStates.get(scenario.graph.name) ?? new Set<string>();
        states.add(scenario.graph.initial);
        visitedStates.set(scenario.graph.name, states);
        actual.forEach((step) => {
          seen.add(step.kind);
          states.add(step.currentState);
        });
        assert.equal(
          actual.filter((step) => step.kind === 'committed').length,
          scenario.path(seed).length,
        );
      }
    }
    assert.ok(commandCount >= 180, `Only ${commandCount} commands were exercised`);
    t.diagnostic(
      `${commandCount} commands across ${scenarios.length * 3} traces and ${scenarios.length} graphs`,
    );
    for (const scenario of scenarios) {
      assert.deepEqual(
        [...visitedStates.get(scenario.graph.name)!].sort(),
        scenario.graph.states.slice().sort(),
        `${scenario.graph.name} did not visit every state`,
      );
    }
    assert.deepEqual(
      [...seen].sort(),
      [
        'committed',
        'invalid_transition',
        'replayed',
        'request_conflict',
        'revision_conflict',
      ].sort(),
    );
  },
);

test(
  'the conformance comparator rejects a Lean model that replays current state',
  { skip: process.env.MERV_LEAN_MUTATIONS !== '1' ? 'Set MERV_LEAN_MUTATIONS=1' : undefined },
  async () => {
    const scenario = scenarios[1]; // self-loop keeps the instance live across older replays
    const seed = 2;
    const commands = trace(scenario, seed);
    const actual = await engineObservations(scenario.graph, commands);
    assertTraceEqual(
      modelObservations(scenario.graph, commands),
      actual,
      scenario.graph,
      commands,
      seed,
    );

    const folder = mkdtempSync(join(tmpdir(), 'merv-lean-mutation-'));
    try {
      const workflow = readFileSync(resolve(modelDir, 'Workflow.lean'), 'utf8');
      const main = readFileSync(resolve(modelDir, 'Main.lean'), 'utf8');
      const cut = workflow.indexOf('theorem stale_revision_rejected');
      assert.ok(cut > 0, 'Could not isolate the executable model from its theorems');
      assert.ok(workflow.includes('outcome := .replayed prior.response'));
      const mutation = workflow
        .slice(0, cut)
        .replace('outcome := .replayed prior.response', 'outcome := .replayed s.current');
      const entrypoint = main.replace(/^import Lean\r?\nimport Workflow\r?\n/m, '');
      assert.notEqual(entrypoint, main, 'Could not inline Main.lean imports');
      const source = resolve(folder, 'Mutated.lean');
      writeFileSync(source, `import Lean\n${mutation}\nend Merv.Workflow\n${entrypoint}`);
      const run = spawnSync('lake', ['env', 'lean', '--run', source], {
        cwd: modelDir,
        input: modelInput(scenario.graph, commands),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      assert.equal(
        run.error,
        undefined,
        `Mutated Lean model could not start: ${run.error?.message}`,
      );
      assert.equal(run.status, 0, `Mutated Lean model failed to execute:\n${run.stderr}`);
      const mutated = (JSON.parse(run.stdout) as { observations: Observation[] }).observations;
      assert.throws(() => assertTraceEqual(mutated, actual, scenario.graph, commands, seed), {
        code: 'ERR_ASSERTION',
      });
      assert.ok(
        mutated.some(
          (step, index) => step.kind === 'replayed' && step.revision !== actual[index].revision,
        ),
        'The injected replay mutation did not alter a response',
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
