/** Pure rules: how every owner of work draws a record's dependency relations on Running. */
import { workLink } from '@merv/contracts';
import type { RunningLinkRow, WorkRoute } from '@merv/contracts';
import type { WorkflowDependency } from './models.js';

/**
 * A record's open relations as rows: what it still waits on (unsettled, or failed and
 * marked red) and the open work that waits on it. A settled prerequisite and an ended
 * dependent are history and are left out.
 */
export function dependencyRows(
  dependsOn: readonly WorkflowDependency[],
  requiredBy: readonly WorkflowDependency[],
  route: WorkRoute,
): { waitsOn: RunningLinkRow[]; unblocks: RunningLinkRow[] } {
  const row = (dependency: WorkflowDependency): RunningLinkRow => ({
    ...workLink(route, dependency.workflow, dependency.id),
    name: dependency.name,
    says: [{ state: dependency.state }],
    ...(dependency.failed ? { attention: true } : {}),
  });
  return {
    waitsOn: dependsOn.filter((d) => !d.settled || d.failed).map(row),
    unblocks: requiredBy.filter((d) => !d.settled && !d.failed).map(row),
  };
}
