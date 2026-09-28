import { canonical, check, now } from '@merv/contracts';
import type {
  Sql,
  Transaction,
  WorkflowDefinition,
  WorkflowDependency,
  WorkflowSnapshot,
} from '@merv/contracts';

export function normalizeDependencies(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = typeof value === 'string' ? [value] : value;
  check(
    Array.isArray(values) && values.every((item) => typeof item === 'string'),
    'invalid_dependencies',
    'Dependencies must be a workflow id or an array of workflow ids',
  );
  return [...new Set((values as string[]).map((item) => item.trim()).filter(Boolean))];
}

/** A version's pinned success states; a stored `null` pins their absence, like a missing row. */
export const successOf = (row: { success_json: string } | undefined): string[] | undefined =>
  row ? ((JSON.parse(row.success_json) as string[] | null) ?? undefined) : undefined;

export async function persistSuccess(
  sql: Sql,
  definition: WorkflowDefinition,
  success?: string[],
): Promise<void> {
  if (success === undefined) return;
  const encoded = canonical([...success].sort());
  const existing = await sql.get<{ success_json: string }>(
    'SELECT success_json FROM wf_success_states WHERE workflow=? AND version=?',
    definition.name,
    definition.version,
  );
  check(
    !existing || existing.success_json === encoded,
    'workflow_version_conflict',
    `${definition.name}@${definition.version} success states changed; publish a new version`,
    409,
  );
  if (!existing)
    await sql.run(
      'INSERT INTO wf_success_states (workflow,version,success_json) VALUES (?,?,?)',
      definition.name,
      definition.version,
      encoded,
    );
}

interface EdgeRow {
  kind: 'declared' | 'system';
  owner: string | null;
  source_id: string;
  target_id: string;
  target_workflow: string;
  target_version: number;
  target_success_json: string;
  target_terminal_json: string;
}
interface NodeRow {
  id: string;
  workflow: string;
  version: number;
  state: string;
  data_json: string;
}

/** What an instance is called: its title, else its name, else the workflow it runs. */
export const instanceName = (data: { title?: unknown; name?: unknown }, workflow: string) =>
  [data.title, data.name].find((item): item is string => typeof item === 'string') ?? workflow;

/** Without declared success states an instance never settles, so it never counts as failed. */
function classify(
  node: NodeRow | undefined,
  id: string,
  workflow: string,
  version: number,
  success: string[] | undefined,
  terminal: string[],
): WorkflowDependency {
  const settled = !!node && !!success?.includes(node.state);
  return {
    id,
    workflow: node?.workflow ?? workflow,
    version: node?.version ?? version,
    name: instanceName(node ? JSON.parse(node.data_json) : {}, node?.workflow ?? workflow),
    state: node?.state ?? 'missing',
    settled,
    failed: !!node && success !== undefined && terminal.includes(node.state) && !settled,
  };
}

/** What an edge's source depends on, read against the target as it stands now. */
const prerequisiteOf = (edge: EdgeRow, target: NodeRow | undefined): WorkflowDependency => ({
  ...classify(
    target,
    edge.target_id,
    edge.target_workflow,
    edge.target_version,
    // The contract the edge pinned when it was made, whatever version the target runs now.
    JSON.parse(edge.target_success_json) as string[],
    JSON.parse(edge.target_terminal_json) as string[],
  ),
  ...(edge.kind === 'system' ? { kind: edge.kind, owner: edge.owner, failed: false } : {}),
});

export async function relations(
  sql: Sql,
  projectId: string,
  instanceId: string,
): Promise<{
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
}> {
  const edges = await sql.all<EdgeRow>(
    'SELECT * FROM wf_dependencies WHERE project_id=? AND (source_id=? OR target_id=?) ORDER BY created_at,target_id,source_id',
    projectId,
    instanceId,
    instanceId,
  );
  const dependencies: WorkflowDependency[] = [],
    dependents: WorkflowDependency[] = [];
  for (const edge of edges) {
    if (edge.source_id === instanceId) {
      const target = await sql.get<NodeRow>(
        'SELECT id,workflow,version,state,data_json FROM wf_instances WHERE id=? AND project_id=?',
        edge.target_id,
        projectId,
      );
      dependencies.push(prerequisiteOf(edge, target));
    }
    if (edge.target_id === instanceId) {
      const source = await sql.get<NodeRow>(
        'SELECT id,workflow,version,state,data_json FROM wf_instances WHERE id=? AND project_id=?',
        edge.source_id,
        projectId,
      );
      if (!source) continue;
      const semantics = await sql.get<{ success_json: string }>(
        'SELECT success_json FROM wf_success_states WHERE workflow=? AND version=?',
        source.workflow,
        source.version,
      );
      const graph = await sql.get<{ definition_json: string }>(
        'SELECT definition_json FROM wf_definitions WHERE name=? AND version=?',
        source.workflow,
        source.version,
      );
      dependents.push({
        ...classify(
          source,
          source.id,
          source.workflow,
          source.version,
          successOf(semantics),
          graph ? (JSON.parse(graph.definition_json) as WorkflowDefinition).terminal : [],
        ),
        ...(edge.kind === 'system' ? { kind: edge.kind, owner: edge.owner } : {}),
      });
    }
  }
  return { dependencies, dependents };
}

/**
 * What each of several instances depends on, in two reads however many there are: the
 * `dependencies` of relations() for each, in the same order, without what depends on them.
 */
export async function prerequisites(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
): Promise<Map<string, WorkflowDependency[]>> {
  const found = new Map(instanceIds.map((id) => [id, [] as WorkflowDependency[]]));
  if (!found.size) return found;
  const edges = await sql.all<EdgeRow>(
    `SELECT * FROM wf_dependencies WHERE project_id=? AND source_id IN (${[...found.keys()].map(() => '?').join(',')}) ORDER BY created_at,target_id,source_id`,
    projectId,
    ...found.keys(),
  );
  const wanted = [...new Set(edges.map((edge) => edge.target_id))];
  const targets = wanted.length
    ? await sql.all<NodeRow>(
        `SELECT id,workflow,version,state,data_json FROM wf_instances WHERE project_id=? AND id IN (${wanted.map(() => '?').join(',')})`,
        projectId,
        ...wanted,
      )
    : [];
  const byId = new Map(targets.map((target) => [target.id, target]));
  for (const edge of edges)
    found.get(edge.source_id)?.push(prerequisiteOf(edge, byId.get(edge.target_id)));
  return found;
}

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

/** Called only inside the owner's transaction: the edges named are gone, the rest untouched. */
export async function detachDependencies(
  tx: Transaction,
  source: WorkflowSnapshot,
  ids: string[],
): Promise<string[]> {
  const removed: string[] = [];
  for (const targetId of ids)
    if (
      (
        await tx.run(
          "DELETE FROM wf_dependencies WHERE project_id=? AND source_id=? AND target_id=? AND kind='declared'",
          source.projectId,
          source.id,
          targetId,
        )
      ).changes
    )
      removed.push(targetId);
  return removed;
}

/** Called only inside the owner's transaction. Existing edges keep their original success contract. */
export async function attachDependencies(
  tx: Transaction,
  source: WorkflowSnapshot,
  ids: string[],
  owner?: string,
): Promise<string[]> {
  const added: string[] = [];
  for (const targetId of ids) {
    check(targetId !== source.id, 'dependency_cycle', 'A workflow cannot depend on itself', 409);
    const existing = await tx.get<{ kind: string; owner: string | null }>(
      'SELECT kind,owner FROM wf_dependencies WHERE project_id=? AND source_id=? AND target_id=? AND kind=? AND owner=?',
      source.projectId,
      source.id,
      targetId,
      owner ? 'system' : 'declared',
      owner ?? '',
    );
    if (existing) continue;
    const target = await tx.get<NodeRow>(
      'SELECT id,workflow,version,state,data_json FROM wf_instances WHERE id=? AND project_id=?',
      targetId,
      source.projectId,
    );
    check(target, 'not_found', 'Dependency not found in this project', 404);
    const success = await tx.get<{ success_json: string }>(
      'SELECT success_json FROM wf_success_states WHERE workflow=? AND version=?',
      target.workflow,
      target.version,
    );
    check(
      success && successOf(success),
      'dependency_unsupported',
      `Workflow ${target.workflow}@${target.version} has no declared success states`,
      409,
    );
    const definition = await tx.get<{ definition_json: string }>(
      'SELECT definition_json FROM wf_definitions WHERE name=? AND version=?',
      target.workflow,
      target.version,
    );
    check(definition, 'dependency_unsupported', 'Dependency definition is unavailable', 409);
    const frontier = [targetId],
      seen = new Set<string>();
    while (frontier.length) {
      const current = frontier.pop()!;
      check(
        current !== source.id,
        'dependency_cycle',
        'These dependencies would create a cycle',
        409,
      );
      if (seen.has(current)) continue;
      seen.add(current);
      frontier.push(
        ...(
          await tx.all<{ target_id: string }>(
            'SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=?',
            source.projectId,
            current,
          )
        ).map((item) => item.target_id),
      );
    }
    await tx.run(
      'INSERT INTO wf_dependencies (project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at,kind,owner) VALUES (?,?,?,?,?,?,?,?,?,?)',
      source.projectId,
      source.id,
      targetId,
      target.workflow,
      target.version,
      success.success_json,
      canonical((JSON.parse(definition.definition_json) as WorkflowDefinition).terminal),
      now(),
      owner ? 'system' : 'declared',
      owner ?? '',
    );
    added.push(targetId);
  }
  return added;
}
