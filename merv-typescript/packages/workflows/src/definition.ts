import { check, type WorkflowDefinition } from '@merv/contracts';

/** Names of workflows, states, actions and callbacks. */
export const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
/** The public Tools naming contract, including reserved mounted namespaces. */
export const toolName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;
/**
 * The actions the engine itself writes into wf_history beside the state it found. A graph
 * cannot declare them: its own edge would be indistinguishable from the engine's bookkeeping.
 */
export const ENGINE_ACTIONS: readonly string[] = Object.freeze([
  'start',
  'add_dependencies',
  'replan_dependencies',
]);
/** Code-unit order: the stored definition, and so its fingerprint, never depends on the locale. */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const valid: (ok: unknown, message: string) => asserts ok = (ok, message) =>
  check(ok, 'invalid_workflow_policy', message);

export function validateDefinition(input: WorkflowDefinition): WorkflowDefinition {
  valid(input && typeof input === 'object', 'A workflow definition is required');
  for (const [field, value] of [
    ['name', input.name],
    ['initial', input.initial],
  ] as const)
    valid(
      typeof value === 'string' && identifier.test(value),
      `Workflow ${field} must be a nonempty identifier`,
    );
  valid(
    Number.isSafeInteger(input.version) && input.version >= 1,
    'Workflow version must be a positive integer',
  );
  valid(Array.isArray(input.states) && input.states.length, 'Workflow states must be nonempty');
  valid(
    input.states.every((state) => typeof state === 'string' && identifier.test(state)),
    'Workflow state names must be nonempty identifiers',
  );
  const states = new Set(input.states);
  valid(states.size === input.states.length, 'Workflow states must be unique');
  valid(states.has(input.initial), 'Workflow initial state is not declared');
  valid(
    Array.isArray(input.terminal) && input.terminal.every((state) => states.has(state)),
    'Workflow terminal states must be declared',
  );
  valid(
    new Set(input.terminal).size === input.terminal.length,
    'Workflow terminal states must be unique',
  );
  valid(Array.isArray(input.edges), 'Workflow edges must be an array');
  valid(input.states.length <= 256 && input.edges.length <= 2048, 'Workflow graph too large');
  valid(
    input.managed === undefined || input.managed === true,
    'Every workflow is managed by its program; managed may only be true',
  );
  valid(
    input.blocksStarts === undefined ||
      (Array.isArray(input.blocksStarts) &&
        input.blocksStarts.every((name) => typeof name === 'string' && identifier.test(name)) &&
        new Set(input.blocksStarts).size === input.blocksStarts.length),
    'Blocked workflow types must be unique identifiers',
  );
  const edges = new Set<string>();
  for (const edge of input.edges) {
    valid(
      edge &&
        typeof edge.from === 'string' &&
        typeof edge.to === 'string' &&
        states.has(edge.from) &&
        states.has(edge.to),
      'Workflow transition states must be declared',
    );
    valid(
      typeof edge.action === 'string' && identifier.test(edge.action),
      'Workflow action must be a nonempty identifier',
    );
    valid(!ENGINE_ACTIONS.includes(edge.action), `${edge.action} is reserved by the engine`);
    valid(
      !input.terminal.includes(edge.from),
      'Terminal workflow states cannot have outgoing transitions',
    );
    const key = `${edge.from}:${edge.action}`;
    valid(!edges.has(key), `Duplicate workflow action ${edge.action} from ${edge.from}`);
    edges.add(key);
  }
  const reachable = new Set([input.initial]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of input.edges)
      if (reachable.has(edge.from) && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        changed = true;
      }
  }
  valid(
    reachable.size === states.size,
    'All workflow states must be reachable from the initial state',
  );
  // A sorted copy only the engine holds: a caller cannot change it after fingerprinting.
  return {
    name: input.name,
    version: input.version,
    initial: input.initial,
    states: [...input.states].sort(),
    terminal: [...input.terminal].sort(),
    // Only the three edge fields are kept: anything else a caller attached would be stored,
    // fingerprinted and copied into every read of the definition.
    edges: input.edges
      .map(({ from, action, to }) => ({ from, action, to }))
      .sort((a, b) => byCodeUnit(`${a.from}:${a.action}`, `${b.from}:${b.action}`)),
    // Only a program's handle changes an instance. The flag stays in the stored form, and so
    // in every published digest.
    managed: true,
    ...(input.blocksStarts === undefined ? {} : { blocksStarts: [...input.blocksStarts].sort() }),
  };
}
