/** Pure rules: how every owner of work draws a record's dependency relations on Running. */
import { ellipsis, runningKey, workLink } from '@merv/contracts';
import type {
  RunningLinkRow,
  RunningNodeLink,
  RunningPhrase,
  RunningSection,
  WorkRoute,
} from '@merv/contracts';
import type { WorkflowDependency } from './models.js';

/** A name as long as a card or a row holds one. */
const short = (name: string) => ellipsis(name, 200);

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
    name: short(dependency.name),
    says: [{ state: dependency.state }],
    ...(dependency.failed ? { attention: true } : {}),
  });
  return {
    waitsOn: dependsOn.filter((d) => !d.settled || d.failed).map(row),
    unblocks: requiredBy.filter((d) => !d.settled && !d.failed).map(row),
  };
}

/**
 * A record's sidebar sections for its open relations, "Waits on" then "Unblocks". A failed
 * prerequisite's row is red, and its section leads, only where it is why the record needs a
 * person (`red`); otherwise the row still says failed, without the red.
 */
export function dependencySections(
  dependsOn: readonly WorkflowDependency[],
  requiredBy: readonly WorkflowDependency[],
  route: WorkRoute,
  red: boolean,
): RunningSection[] {
  const { waitsOn, unblocks } = dependencyRows(dependsOn, requiredBy, route);
  const waits = waitsOn.map(({ attention, ...row }): RunningLinkRow =>
    red && attention ? { ...row, attention } : row,
  );
  return [
    ...(waits.length
      ? [
          {
            title: 'Waits on',
            place: 'relations' as const,
            kind: 'links' as const,
            rows: waits,
            ...(red && waitsOn.some((row) => row.attention) ? { attention: true } : {}),
          },
        ]
      : []),
    ...(unblocks.length
      ? [{ title: 'Unblocks', place: 'relations' as const, kind: 'links' as const, rows: unblocks }]
      : []),
  ];
}

/**
 * A card's lines to its prerequisites: each one it waits on, dashed while it is still open. A
 * failed one is not waited on any more; the card's own red says so.
 */
export function dependencyLinks(dependsOn: readonly WorkflowDependency[]): RunningNodeLink[] {
  return dependsOn.map((dependency) => ({
    to: runningKey('work', dependency.id),
    verb: 'waits on' as const,
    ...(!dependency.settled && !dependency.failed ? { waiting: true } : {}),
  }));
}

/** The first of the prerequisites a card says it waits on, and how many more. */
export function prerequisiteNames(names: readonly string[]): RunningPhrase {
  return [short(names[0]!), ...(names.length > 1 ? [` and ${names.length - 1} more`] : [])];
}
