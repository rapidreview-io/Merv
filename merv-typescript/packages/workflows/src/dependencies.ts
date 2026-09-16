import { check, now } from '@merv/contracts';
import type {
  Sql,
  Transaction,
  WorkflowDefinition,
  WorkflowDependency,
  WorkflowSnapshot,
} from '@merv/contracts';
import { canonical } from './definition.js';

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

function classify(
  node: NodeRow | undefined,
  id: string,
  workflow: string,
  version: number,
  successJson?: string,
  terminalJson?: string,
): WorkflowDependency {
  const data = node ? JSON.parse(node.data_json) : {};
  const success: string[] = successJson ? JSON.parse(successJson) : [];
  const terminal: string[] = terminalJson ? JSON.parse(terminalJson) : [];
  const settled = !!node && success.includes(node.state);
  return {
    id,
    workflow: node?.workflow ?? workflow,
    version: node?.version ?? version,
    name: typeof data.title === 'string' ? data.title : (node?.workflow ?? workflow),
    state: node?.state ?? 'missing',
    settled,
    failed: !!node && successJson !== undefined && terminal.includes(node.state) && !settled,
  };
}

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
      dependencies.push(
        classify(
          target,
          edge.target_id,
          edge.target_workflow,
          edge.target_version,
          edge.target_success_json,
          edge.target_terminal_json,
        ),
      );
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
      dependents.push(
        classify(
          source,
          source.id,
          source.workflow,
          source.version,
          semantics?.success_json,
          graph
            ? canonical((JSON.parse(graph.definition_json) as WorkflowDefinition).terminal)
            : undefined,
        ),
      );
    }
  }
  return { dependencies, dependents };
}

export function requireDependencies(dependencies: WorkflowDependency[]): void {
  const pending = dependencies.filter((item) => !item.settled);
  if (!pending.length) return;
  const failed = pending.filter((item) => item.failed);
  const names = (failed.length ? failed : pending)
    .map((item) => `${item.workflow} ${item.name || item.id} (${item.state})`)
    .join(', ');
  check(
    false,
    failed.length ? 'dependency_failed' : 'dependencies_pending',
    failed.length
      ? `A dependency has ended without succeeding: ${names}. End this work or replan its dependencies.`
      : `Work is waiting on unfinished dependencies: ${names}.`,
    409,
  );
}

/** Called only inside the owner's transaction. Existing edges keep their original success contract. */
export async function attachDependencies(
  tx: Transaction,
  source: WorkflowSnapshot,
  ids: string[],
): Promise<string[]> {
  const added: string[] = [];
  for (const targetId of ids) {
    check(targetId !== source.id, 'dependency_cycle', 'A workflow cannot depend on itself', 409);
    const existing = await tx.get(
      'SELECT 1 FROM wf_dependencies WHERE project_id=? AND source_id=? AND target_id=?',
      source.projectId,
      source.id,
      targetId,
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
      success,
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
      'INSERT INTO wf_dependencies (project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
      source.projectId,
      source.id,
      targetId,
      target.workflow,
      target.version,
      success.success_json,
      canonical((JSON.parse(definition.definition_json) as WorkflowDefinition).terminal),
      now(),
    );
    added.push(targetId);
  }
  return added;
}
