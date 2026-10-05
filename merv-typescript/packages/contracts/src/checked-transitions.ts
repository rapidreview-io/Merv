import type { Transaction, WorkflowCheckContext } from './index.js';

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
