import { MervError, type WorkflowDefinition } from '@merv/contracts';

/** Names of workflows, states, actions and callbacks. */
export const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
/** The public Tools naming contract, including reserved mounted namespaces. */
export const toolName = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/;

export function validateDefinition(input: WorkflowDefinition): WorkflowDefinition {
  if (!input || typeof input !== 'object')
    throw new MervError('invalid_workflow_policy', 'A workflow definition is required');
  for (const [field, value] of [
    ['name', input.name],
    ['initial', input.initial],
  ] as const) {
    if (typeof value !== 'string' || !identifier.test(value)) {
      throw new MervError(
        'invalid_workflow_policy',
        `Workflow ${field} must be a nonempty identifier`,
      );
    }
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new MervError('invalid_workflow_policy', 'Workflow version must be a positive integer');
  if (!Array.isArray(input.states) || !input.states.length)
    throw new MervError('invalid_workflow_policy', 'Workflow states must be nonempty');
  if (input.states.some((state) => typeof state !== 'string' || !identifier.test(state))) {
    throw new MervError(
      'invalid_workflow_policy',
      'Workflow state names must be nonempty identifiers',
    );
  }
  const states = new Set(input.states);
  if (states.size !== input.states.length)
    throw new MervError('invalid_workflow_policy', 'Workflow states must be unique');
  if (!states.has(input.initial))
    throw new MervError('invalid_workflow_policy', 'Workflow initial state is not declared');
  if (!Array.isArray(input.terminal) || input.terminal.some((state) => !states.has(state)))
    throw new MervError('invalid_workflow_policy', 'Workflow terminal states must be declared');
  if (new Set(input.terminal).size !== input.terminal.length)
    throw new MervError('invalid_workflow_policy', 'Workflow terminal states must be unique');
  if (!Array.isArray(input.edges))
    throw new MervError('invalid_workflow_policy', 'Workflow edges must be an array');
  if (input.managed !== undefined && typeof input.managed !== 'boolean')
    throw new MervError('invalid_workflow_policy', 'Workflow managed must be boolean');
  if (
    input.blocksStarts !== undefined &&
    (!Array.isArray(input.blocksStarts) ||
      input.blocksStarts.some((name) => typeof name !== 'string' || !identifier.test(name)) ||
      new Set(input.blocksStarts).size !== input.blocksStarts.length)
  )
    throw new MervError(
      'invalid_workflow_policy',
      'Blocked workflow types must be unique identifiers',
    );
  const edges = new Set<string>();
  for (const edge of input.edges) {
    if (!edge || !states.has(edge.from) || !states.has(edge.to))
      throw new MervError('invalid_workflow_policy', 'Workflow transition states must be declared');
    if (typeof edge.action !== 'string' || !identifier.test(edge.action))
      throw new MervError(
        'invalid_workflow_policy',
        'Workflow action must be a nonempty identifier',
      );
    if (input.terminal.includes(edge.from))
      throw new MervError(
        'invalid_workflow_policy',
        'Terminal workflow states cannot have outgoing transitions',
      );
    const key = `${edge.from}:${edge.action}`;
    if (edges.has(key))
      throw new MervError(
        'invalid_workflow_policy',
        `Duplicate workflow action ${edge.action} from ${edge.from}`,
      );
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
  if (reachable.size !== states.size)
    throw new MervError(
      'invalid_workflow_policy',
      'All workflow states must be reachable from the initial state',
    );
  // A sorted copy only the engine holds: a caller cannot change it after fingerprinting, and
  // the upgrade check compares its sorted states and terminal lists.
  return {
    name: input.name,
    version: input.version,
    initial: input.initial,
    states: [...input.states].sort(),
    terminal: [...input.terminal].sort(),
    edges: input.edges
      .map((edge) => ({ ...edge }))
      .sort((a, b) => `${a.from}:${a.action}`.localeCompare(`${b.from}:${b.action}`)),
    managed: input.managed ?? false,
    ...(input.blocksStarts === undefined ? {} : { blocksStarts: [...input.blocksStarts].sort() }),
  };
}
