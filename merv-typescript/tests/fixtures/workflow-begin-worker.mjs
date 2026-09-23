import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

// Workers need their own loader registration for workspace TypeScript exports.
register();
const [{ PostgresState }, { ProjectScope }, { WorkflowsService }] = await Promise.all([
  import('@merv/state'),
  import('@merv/scope'),
  import('@merv/workflows'),
]);

const { url, schema, graph, caller, instanceId, first, barrier } = workerData;
const control = new Int32Array(barrier);
// The second worker waits on the first one's writer lock for as long as the parent holds it.
const state = await PostgresState.open({
  connectionString: url,
  schema,
  maxConnections: 2,
  readConnections: 1,
  lockTimeoutMs: 30000,
});
const scope = new ProjectScope(state);
await scope.initialize();
const workflows = new WorkflowsService(state, scope);
await workflows.initialize();
await workflows.register(graph, {
  actions: graph.edges.map((edge) => ({
    name: edge.action,
    states: [edge.from],
    transitions: [edge.action],
    tool: `test.${edge.action}`,
    instruction: 'Complete the workflow step.',
    check: ({ caller: actor, tx }) => scope.require(actor, 'write', tx),
  })),
  assignments: [
    {
      state: 'work',
      check: async ({ caller: actor, tx }) => {
        await scope.require(actor, 'write', tx);
        if (!first) Atomics.store(control, 2, 1);
      },
      build: () => {
        if (first) {
          // This runs inside the open database write transaction, after its start insert.
          Atomics.store(control, 0, 1);
          parentPort.postMessage({ type: 'held' });
          if (Atomics.wait(control, 1, 0, 5000) === 'timed-out')
            throw new Error('Parent did not release the held transaction');
          Atomics.store(control, 0, 0);
        }
        return {
          role: 'worker',
          label: 'Concurrent assignment',
          brief: 'Measure the instrument.',
          references: [],
          handoff: { instruction: 'Submit the result.', tools: ['test.finish'] },
          execution: { readOnly: false, tools: [] },
          context: null,
        };
      },
    },
  ],
});

parentPort.on('message', async (message) => {
  if (message !== 'begin') return;
  parentPort.postMessage({ type: 'attempt' });
  try {
    const assignment = await workflows.begin(caller, { instanceId, expectedRevision: 0 });
    parentPort.postMessage({ type: 'result', workStart: assignment.workStart });
  } finally {
    await state.close();
    parentPort.close();
  }
});
parentPort.postMessage({ type: 'ready' });
