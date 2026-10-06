import { check } from '@merv/contracts';
import type {
  Transaction,
  WorkflowCheckContext,
  WorkflowDependency,
  WorkflowExecutionBinding,
} from '@merv/contracts';

// Workflow rules other units apply themselves: pure, so they import it without the service.

/** What an instance is called: its title, else its name, else the workflow it runs. */
export const instanceName = (data: { title?: unknown; name?: unknown }, workflow: string) =>
  [data.title, data.name].find((item): item is string => typeof item === 'string') ?? workflow;

/**
 * Failure is judged over every edge, so a failed declared edge is reported even where a
 * provider's edge to the same target came first. A target held by both is named once, by
 * its declared edge; one held only by a provider says which provider holds it.
 */
export function requireDependencies(dependencies: WorkflowDependency[]): void {
  const pending = dependencies.filter((item) => !item.settled);
  if (!pending.length) return;
  const failed = pending.filter((item) => item.failed);
  const named = new Map<string, WorkflowDependency>();
  for (const item of failed.length ? failed : pending) {
    const seen = named.get(item.id);
    if (!seen || (seen.kind === 'system' && item.kind !== 'system')) named.set(item.id, item);
  }
  const names = [...named.values()]
    .map(
      (item) =>
        `${item.workflow} ${item.name || item.id} (${item.state}${item.kind === 'system' ? `, required by ${item.owner}` : ''})`,
    )
    .join(', ');
  check(
    false,
    failed.length ? 'dependency_failed' : 'dependencies_pending',
    failed.length
      ? `A dependency has ended without succeeding: ${names}.`
      : `Work is waiting on unfinished dependencies: ${names}.`,
    409,
  );
}

/** The argument bindings an execution policy grants a tool with. */
export const target = (field: 'instanceId' | 'revision'): WorkflowExecutionBinding => ({
  kind: 'target',
  field,
});
export const reference = (name: string): WorkflowExecutionBinding => ({ kind: 'reference', name });
export const literal = (value: string): WorkflowExecutionBinding => ({ kind: 'literal', value });
export const grant = (
  name: string,
  ...alternatives: Record<string, WorkflowExecutionBinding>[]
) => ({
  name,
  alternatives,
});

const edgeKey = (instanceId: string, revision: number, action: string) =>
  `${instanceId}@${revision}:${action}`;

/**
 * Lets a command that ran an action's guard itself take the transition without the guard
 * running twice. Workflows runs the action rule's check again inside `transition`; only that
 * run, in the same transaction and for the same instance, revision and transition, finds what
 * the command found. Guidance, preflight and every other path still run the guard in full.
 */
export class CheckedTransitions {
  private pending = new WeakMap<Transaction, Map<string, { value: unknown }>>();

  /** Runs `transition` with `value` standing for this edge's guard until it settles. */
  async take<R>(
    tx: Transaction,
    edge: { instanceId: string; revision: number; action: string },
    transition: () => Promise<R>,
    value?: unknown,
  ): Promise<R> {
    const key = edgeKey(edge.instanceId, edge.revision, edge.action);
    const pending = this.pending.get(tx) ?? new Map<string, { value: unknown }>();
    this.pending.set(tx, pending.set(key, { value }));
    try {
      return await transition();
    } finally {
      pending.delete(key);
    }
  }

  /** What the command taking this check's transition found; undefined on every other path. */
  found<T>({ snapshot, transition, tx }: WorkflowCheckContext): { value: T } | undefined {
    if (transition === undefined) return undefined;
    return this.pending.get(tx)?.get(edgeKey(snapshot.id, snapshot.revision, transition)) as
      { value: T } | undefined;
  }
}
