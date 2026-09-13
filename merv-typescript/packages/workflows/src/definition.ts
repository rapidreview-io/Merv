import { createHash } from 'node:crypto';
import type { WorkflowDefinition } from '@merv/contracts';

/** Canonical JSON rejects values that silently disappear or mutate during persistence. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Workflow data must contain only finite JSON values');
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function validateDefinition(input: WorkflowDefinition): WorkflowDefinition {
  if (!input || typeof input !== 'object') throw new TypeError('A workflow definition is required');
  for (const [field, value] of [
    ['name', input.name],
    ['initial', input.initial],
  ] as const) {
    if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
      throw new TypeError(`Workflow ${field} must be a nonempty identifier`);
    }
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new TypeError('Workflow version must be a positive integer');
  if (!Array.isArray(input.states) || !input.states.length)
    throw new TypeError('Workflow states must be nonempty');
  if (
    input.states.some(
      (state) => typeof state !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(state),
    )
  ) {
    throw new TypeError('Workflow state names must be nonempty identifiers');
  }
  const states = new Set(input.states);
  if (states.size !== input.states.length) throw new TypeError('Workflow states must be unique');
  if (!states.has(input.initial)) throw new TypeError('Workflow initial state is not declared');
  if (!Array.isArray(input.terminal) || input.terminal.some((state) => !states.has(state)))
    throw new TypeError('Workflow terminal states must be declared');
  if (new Set(input.terminal).size !== input.terminal.length)
    throw new TypeError('Workflow terminal states must be unique');
  if (!Array.isArray(input.edges)) throw new TypeError('Workflow edges must be an array');
  if (input.managed !== undefined && typeof input.managed !== 'boolean')
    throw new TypeError('Workflow managed must be boolean');
  const edges = new Set<string>();
  for (const edge of input.edges) {
    if (!edge || !states.has(edge.from) || !states.has(edge.to))
      throw new TypeError('Workflow transition states must be declared');
    if (typeof edge.action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(edge.action))
      throw new TypeError('Workflow action must be a nonempty identifier');
    if (input.terminal.includes(edge.from))
      throw new TypeError('Terminal workflow states cannot have outgoing transitions');
    const key = `${edge.from}:${edge.action}`;
    if (edges.has(key))
      throw new TypeError(`Duplicate workflow action ${edge.action} from ${edge.from}`);
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
    throw new TypeError('All workflow states must be reachable from the initial state');
  // Clone and freeze every level: callers cannot change installed behavior after fingerprinting.
  return Object.freeze({
    name: input.name,
    version: input.version,
    initial: input.initial,
    states: Object.freeze([...input.states].sort()) as unknown as string[],
    terminal: Object.freeze([...input.terminal].sort()) as unknown as string[],
    edges: Object.freeze(
      input.edges
        .map((edge) => Object.freeze({ ...edge }))
        .sort((a, b) => `${a.from}:${a.action}`.localeCompare(`${b.from}:${b.action}`)),
    ) as unknown as WorkflowDefinition['edges'],
    managed: input.managed ?? false,
  });
}
