import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './fixtures/app.js';
import {
  check,
  type Caller,
  type ProcessGraph,
  type WorkflowDecision,
  type WorkflowDefinition,
  type WorkflowPolicy,
} from '@merv/contracts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'merv-process-'));
  const config = JSON.parse(
    readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'),
  );
  config.plugins = config.plugins.filter(
    (entry: { id: string }) =>
      !['api', 'identity', 'ui'].includes(entry.id) &&
      !entry.id.endsWith('-api') &&
      !entry.id.endsWith('-ui'),
  );
  const app = await createApp({ directory, config });
  t.after(async () => {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  const boot = await app.ctx.scope.bootstrap({ projectName: 'Process', actorName: 'Owner' });
  const owner: Caller = { projectId: boot.project.id, actorId: boot.actor.id };
  return {
    app,
    owner,
    actor: async (name: string, role: 'producer' | 'operator' = 'producer') => ({
      projectId: owner.projectId,
      actorId: (await app.ctx.scope.issueActor(owner, { name, role })).actor.id,
    }),
    process: async (caller: Caller, instanceId: string) =>
      (await app.ctx.tools.call('workflow.process', caller, { instanceId })) as ProcessGraph,
    next: async (caller: Caller, instanceId: string) =>
      (await app.ctx.tools.call('workflow.status_and_next', caller, {
        instanceId,
      })) as WorkflowDecision,
  };
}

const definition: WorkflowDefinition = {
  name: 'audit',
  version: 1,
  initial: 'drafting',
  states: ['drafting', 'in_review', 'approved', 'abandoned'],
  terminal: ['approved', 'abandoned'],
  edges: [
    { from: 'drafting', action: 'submit', to: 'in_review' },
    { from: 'in_review', action: 'approve', to: 'approved' },
    { from: 'in_review', action: 'return', to: 'drafting' }, // the re-entry edge
    { from: 'drafting', action: 'abandon', to: 'abandoned' },
  ],
};

test('the process graph is the pinned definition stamped with what the record says happened', async (t) => {
  const f = await fixture(t);
  const author = await f.actor('Author'),
    second = await f.actor('Second author'),
    reviewer = await f.actor('Reviewer', 'operator');
  const rule = (name: string, states: string[], transitions: string[], tool: string) => ({
    name,
    states,
    transitions,
    tool,
    instruction: `Take ${name}.`,
    check: () => {},
  });
  const policy: WorkflowPolicy = {
    successStates: ['approved'],
    actions: [
      rule('submit', ['drafting'], ['submit'], 'audit.submit'),
      rule('abandon', ['drafting'], ['abandon'], 'audit.abandon'),
      // One rule owning both closing transitions, so the return is gated like the pass.
      {
        ...rule('verdict', ['in_review'], ['approve', 'return'], 'review.submit'),
        check: (context) =>
          check(
            context.caller.actorId === reviewer.actorId,
            'not_the_reviewer',
            'Only the named reviewer may close this read.',
            403,
          ),
      },
    ],
  };
  await f.app.ctx.workflows.register(definition, policy);
  const instance = await f.app.ctx.workflows.start(author, {
    workflow: 'audit',
    requestId: 'open',
  });
  // Bytes an agent authored: neither the file nor the note naming it may reach the graph.
  const artifact = await f.app.ctx.artifacts.create(author, {
    title: 'Draft',
    content: '# Draft\nprocess-graph-marker-8fbb',
  });
  const move = async (caller: Caller, action: string, revision: number) =>
    await f.app.ctx.workflows.transition(caller, {
      instanceId: instance.id,
      expectedRevision: revision,
      action,
      requestId: `${action}-${revision}`,
      data: { note: `see ${artifact.id}: process-graph-marker-8fbb` },
    });
  await move(author, 'submit', 0);
  await move(reviewer, 'return', 1); // a review return
  await move(second, 'submit', 2); // and the retry it forced
  const dependent = await f.app.ctx.workflows.start(author, {
    workflow: 'audit',
    requestId: 'dependent',
    dependsOn: [instance.id],
  });

  const graph = await f.process(reviewer, instance.id);
  const node = (state: string) => graph.nodes.find((item) => item.state === state)!;
  const edge = (action: string) => graph.edges.find((item) => item.action === action)!;
  assert.deepEqual(
    graph.nodes.map((item) => item.state).sort(),
    [...definition.states].sort(),
    'every node is a state of the registered definition',
  );
  assert.equal(graph.nodes[0].state, definition.initial);
  assert.deepEqual(
    graph.nodes.map((item) => item.terminal),
    [false, false, true, true],
    'nodes read forward from the initial state, ends last',
  );
  for (const item of graph.edges)
    assert.ok(
      definition.edges.some(
        (declared) =>
          declared.from === item.from && declared.action === item.action && declared.to === item.to,
      ),
      `${item.from} -${item.action}-> ${item.to} is a definition edge`,
    );
  assert.deepEqual(
    graph.dependencies.map((item) => [item.direction, item.id]),
    [['required_by', dependent.id]],
    'the only edges that are not definition edges are recorded dependencies between instances',
  );
  assert.deepEqual(
    [graph.state, node('in_review').current, node('drafting').entries, node('in_review').entries],
    ['in_review', true, 1, 2],
    'rework is visible: the record came back to drafting once and left it twice',
  );
  assert.deepEqual(
    edge('submit').traversals.map((item) => [item.revision, item.actorId]),
    [
      [1, author.actorId],
      [3, second.actorId],
    ],
    'a twice-taken edge carries both traversals in order, with distinct revisions and actors',
  );
  assert.deepEqual(
    [edge('abandon').traversals, edge('abandon').status, edge('abandon').tool],
    [[], null, null],
    'an untraversed edge stays present and unstamped',
  );

  const verdict = (await f.next(reviewer, instance.id)).actions.find(
    (item) => item.action === 'verdict',
  )!;
  assert.equal(verdict.status, 'ready');
  assert.deepEqual(
    graph.edges
      .filter((item) => item.from === graph.state)
      .map((item) => [item.action, item.status, item.tool, item.blockers]),
    [
      ['approve', verdict.status, verdict.tool, verdict.blockers],
      ['return', verdict.status, verdict.tool, verdict.blockers],
    ],
    "the current node's outgoing statuses are what status_and_next gives this caller",
  );
  const blocked = await f.process(author, instance.id);
  const refused = (await f.next(author, instance.id)).actions.find(
    (item) => item.action === 'verdict',
  )!;
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.blockers[0].code, 'not_the_reviewer');
  assert.deepEqual(
    blocked.edges.filter((item) => item.from === blocked.state).map((item) => item.blockers),
    [refused.blockers, refused.blockers],
    'another caller reads the same gate refused, with the blocker text that explains it',
  );

  const serialized = JSON.stringify(graph);
  assert.ok(
    !serialized.includes('process-graph-marker-8fbb') && !serialized.includes(artifact.id),
    'no field in the result originates in written bytes',
  );
  assert.deepEqual(
    (await f.process(author, dependent.id)).dependencies,
    [
      {
        direction: 'depends_on',
        id: instance.id,
        workflow: 'audit',
        version: 1,
        name: 'audit',
        state: 'in_review',
        settled: false,
        failed: false,
      },
    ],
    'the dependency edge is read from the record in both directions',
  );
});

test('one derivation serves an experiment instance and a reflection instance', async (t) => {
  const f = await fixture(t);
  const experiment = await f.app.ctx.experiments.create(await f.actor('Producer'), {
    name: 'weight-decay-sweep',
    intent: 'Test whether weight decay moves the grokking step.',
    requestId: 'experiment',
  });
  const wave = await f.app.ctx.research.startReflection(f.owner, { requestId: 'wave' });
  for (const [instanceId, workflow] of [
    [experiment.id, 'experiment'],
    [wave.id, 'reflection'],
  ]) {
    const graph = await f.process(f.owner, instanceId);
    assert.equal(graph.workflow, workflow);
    assert.deepEqual(Object.keys(graph), [
      'instanceId',
      'workflow',
      'version',
      'revision',
      'state',
      'currentGate',
      'terminal',
      'nodes',
      'edges',
      'dependencies',
    ]);
    const pinned = f.app.ctx.workflows
      .catalog()
      .find((item) => item.name === graph.workflow && item.version === graph.version)!;
    assert.deepEqual(graph.nodes.map((item) => item.state).sort(), [...pinned.states].sort());
    assert.equal(graph.nodes[0].state, pinned.initial);
    assert.deepEqual(
      graph.edges.map((item) => ({ from: item.from, action: item.action, to: item.to })),
      pinned.edges,
    );
    assert.equal(graph.nodes.filter((item) => item.current).length, 1);
    assert.ok(graph.edges.every((item) => !item.traversals.length));
  }
});

test('without checks the graph is the record alone: no program callback runs and no edge carries a status', async (t) => {
  const f = await fixture(t);
  const author = await f.actor('Author');
  const calls: string[] = [];
  const rule = (name: string, states: string[], transitions: string[]) => ({
    name,
    states,
    transitions,
    tool: `audit.${name}`,
    instruction: `Take ${name}.`,
    requiresDependencies: name === 'submit',
    suggested: name !== 'abandon',
    arguments: () => (calls.push(`arguments ${name}`), {}),
    check: () => void calls.push(`check ${name}`),
  });
  await f.app.ctx.workflows.register(definition, {
    successStates: ['approved'],
    describe: () => (calls.push('describe'), { label: 'Audit', references: [] }),
    limits: [{ name: 'returns', from: 'in_review', actions: ['return'], max: 1 }],
    actions: [
      rule('submit', ['drafting'], ['submit']),
      rule('abandon', ['drafting'], ['abandon']),
      rule('verdict', ['in_review'], ['approve', 'return']),
    ],
  });
  const first = await f.app.ctx.workflows.start(author, { workflow: 'audit', requestId: 'first' });
  const waiting = await f.app.ctx.workflows.start(author, {
    workflow: 'audit',
    requestId: 'waiting',
    dependsOn: [first.id],
  });
  const unchecked = async (instanceId: string) => {
    calls.length = 0;
    const graph = await f.app.ctx.workflows.process(author, instanceId, { checks: false });
    assert.deepEqual(calls, [], 'no program callback runs');
    return graph;
  };
  const drawn = (graph: ProcessGraph) => ({
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, blockers: [] })),
    edges: graph.edges.map((edge) => ({ ...edge, status: null, tool: null, blockers: [] })),
  });

  const pending = await unchecked(waiting.id);
  assert.equal(pending.currentGate, 'dependencies_pending');
  assert.deepEqual(
    pending.nodes.find((node) => node.current)?.blockers.map((blocker) => blocker.code),
    ['dependencies_pending'],
  );
  assert.ok(pending.edges.every((edge) => edge.status === null && edge.tool === null));
  const checked = await f.process(author, waiting.id);
  assert.ok(calls.length > 0, 'the checked graph asks the program');
  assert.equal(checked.currentGate, pending.currentGate);
  assert.deepEqual(drawn(pending), drawn(checked), 'where the work stands reads the same');

  const move = async (action: string, revision: number) =>
    await f.app.ctx.workflows.transition(author, {
      instanceId: first.id,
      expectedRevision: revision,
      action,
      requestId: `${action}-${revision}`,
    });
  await move('submit', 0);
  await move('return', 1);
  await move('submit', 2);
  const spent = await unchecked(first.id);
  assert.deepEqual(
    [
      spent.state,
      spent.currentGate,
      spent.nodes.find((node) => node.state === 'drafting')?.entries,
    ],
    ['in_review', 'loop_limit_reached', 1],
    'every return used is read from the record, without asking the program',
  );
});
