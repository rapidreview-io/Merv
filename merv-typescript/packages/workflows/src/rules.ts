import { check } from '@merv/contracts';
import type { WorkflowDependency } from '@merv/contracts';

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
