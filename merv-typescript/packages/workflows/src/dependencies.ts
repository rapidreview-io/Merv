import { canonical, check, now } from '@merv/contracts';
import type {
  Data,
  Sql,
  Transaction,
  WorkflowDependency,
  WorkflowPinned,
  WorkflowRelations,
  WorkflowSnapshot,
} from '@merv/contracts';
import type { PinnedContracts } from './pinned.js';

/**
 * The most distinct ids one call may name. Every id is bound in each statement that reads or
 * writes the set, ten per edge written, so this keeps them all inside PostgreSQL's 65,535.
 */
const MAX_DEPENDENCIES = 1000;

export function normalizeDependencies(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = typeof value === 'string' ? [value] : value;
  check(
    Array.isArray(values) && values.every((item) => typeof item === 'string'),
    'invalid_dependencies',
    'Dependencies must be a workflow id or an array of workflow ids',
  );
  const ids = [...new Set((values as string[]).map((item) => item.trim()).filter(Boolean))];
  check(
    ids.length <= MAX_DEPENDENCIES,
    'invalid_dependencies',
    `A call can name at most ${MAX_DEPENDENCIES} dependencies`,
  );
  return ids;
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
  revision: number;
  data_json: string;
}

const NODE = 'id,workflow,version,state,revision,data_json';
const marks = (values: readonly unknown[]) => values.map(() => '?').join(',');

/** What an instance is called: its title, else its name, else the workflow it runs. */
const instanceName = (data: { title?: unknown; name?: unknown }, workflow: string) =>
  [data.title, data.name].find((item): item is string => typeof item === 'string') ?? workflow;

/**
 * An instance judged against a contract; one the project no longer holds has only its id and
 * what its edge recorded. Without declared success states it never settles, so never fails.
 */
function classify(
  node: Pick<NodeRow, 'id' | 'workflow' | 'version'> & Partial<NodeRow>,
  success: readonly string[] | null | undefined,
  terminal: readonly string[],
): WorkflowDependency {
  const { state } = node;
  const settled = !!state && !!success?.includes(state);
  const ended = !!state && terminal.includes(state);
  return {
    id: node.id,
    workflow: node.workflow,
    version: Number(node.version),
    name: instanceName(node.data_json ? JSON.parse(node.data_json) : {}, node.workflow),
    state: state ?? 'missing',
    revision: Number(node.revision ?? 0),
    settled,
    terminal: ended,
    failed: ended && !!success && !settled,
  };
}

/** The edges of `column` naming any of `ids`, in the order they were made. */
const edgesOf = async (
  sql: Sql,
  projectId: string,
  column: 'source_id' | 'target_id',
  ids: readonly string[],
) =>
  await sql.all<EdgeRow>(
    `SELECT * FROM wf_dependencies WHERE project_id=? AND ${column} IN (${marks(ids)}) ORDER BY created_at,target_id,source_id`,
    projectId,
    ...ids,
  );

/** The instances named, by id; one the project does not hold is left out. */
async function nodes(sql: Sql, projectId: string, ids: string[]): Promise<Map<string, NodeRow>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await sql.all<NodeRow>(
    `SELECT ${NODE} FROM wf_instances WHERE project_id=? AND id IN (${marks(wanted)})`,
    projectId,
    ...wanted,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * What each of several instances depends on, in two reads however many there are, each target
 * read as it stands now against the contract its edge pinned when it was made, whatever version
 * the target runs now. A provider's edge never fails its source: the provider re-plans it.
 */
export async function prerequisites(
  sql: Sql,
  projectId: string,
  instanceIds: readonly string[],
): Promise<Map<string, WorkflowDependency[]>> {
  const found = new Map(instanceIds.map((id) => [id, [] as WorkflowDependency[]]));
  if (!found.size) return found;
  const edges = await edgesOf(sql, projectId, 'source_id', [...found.keys()]);
  const targets = await nodes(
    sql,
    projectId,
    edges.map((edge) => edge.target_id),
  );
  for (const edge of edges)
    found.get(edge.source_id)!.push({
      ...classify(
        targets.get(edge.target_id) ?? {
          id: edge.target_id,
          workflow: edge.target_workflow,
          version: edge.target_version,
        },
        JSON.parse(edge.target_success_json) as string[],
        JSON.parse(edge.target_terminal_json) as string[],
      ),
      ...(edge.kind === 'system' ? { kind: edge.kind, owner: edge.owner, failed: false } : {}),
    });
  return found;
}

/** One instance's prerequisites(). */
export const prerequisitesOf = async (sql: Sql, projectId: string, instanceId: string) =>
  (await prerequisites(sql, projectId, [instanceId])).get(instanceId)!;

/**
 * What depends on each of several instances, in two reads however many there are, each source
 * read against its own pinned contract; one not yet kept is read once per version, not per edge.
 * A source the project no longer holds is left out.
 */
export async function dependents(
  sql: Sql,
  contracts: PinnedContracts,
  projectId: string,
  instanceIds: readonly string[],
): Promise<Map<string, WorkflowDependency[]>> {
  const found = new Map(instanceIds.map((id) => [id, [] as WorkflowDependency[]]));
  if (!found.size) return found;
  const edges = await edgesOf(sql, projectId, 'target_id', [...found.keys()]);
  const sources = await nodes(
    sql,
    projectId,
    edges.map((edge) => edge.source_id),
  );
  const read = new Map<string, WorkflowPinned | null>();
  for (const edge of edges) {
    const source = sources.get(edge.source_id);
    if (!source) continue;
    const key = `${source.workflow}@${source.version}`;
    if (!read.has(key))
      read.set(key, await contracts.get(sql, source.workflow, Number(source.version)));
    const pinned = read.get(key);
    found.get(edge.target_id)!.push({
      ...classify(source, pinned?.successStates, pinned?.definition.terminal ?? []),
      ...(edge.kind === 'system' ? { kind: edge.kind, owner: edge.owner } : {}),
    });
  }
  return found;
}

/** Both directions of one instance's edges, in four reads however many there are. */
export async function relations(
  sql: Sql,
  contracts: PinnedContracts,
  projectId: string,
  instanceId: string,
): Promise<{ dependencies: WorkflowDependency[]; dependents: WorkflowDependency[] }> {
  return {
    dependencies: await prerequisitesOf(sql, projectId, instanceId),
    dependents: (await dependents(sql, contracts, projectId, [instanceId])).get(instanceId)!,
  };
}

/**
 * One instance, classified against its own pinned contract, with both directions of its edges;
 * null when the project holds no such instance.
 */
export async function instanceRelations(
  sql: Sql,
  contracts: PinnedContracts,
  projectId: string,
  instanceId: string,
): Promise<WorkflowRelations | null> {
  const node = (await nodes(sql, projectId, [instanceId])).get(instanceId);
  if (!node) return null;
  const pinned = await contracts.get(sql, node.workflow, Number(node.version));
  const instance = classify(node, pinned?.successStates, pinned?.definition.terminal ?? []);
  return {
    instance: {
      ...instance,
      failed: instance.terminal && !instance.settled,
      data: JSON.parse(node.data_json) as Data,
    },
    ...(await relations(sql, contracts, projectId, instanceId)),
  };
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

/**
 * Called only inside the owner's transaction. Each id is refused in the order given when it is
 * the source, is not in the project or declares no success states; an edge already held is
 * kept as it is, with its original contract. Only then is the whole set checked for a cycle, in
 * one query: a `fresh` source was just minted, so nothing can lead back to it and no edge from
 * it can exist yet.
 */
export async function attachDependencies(
  tx: Transaction,
  contracts: PinnedContracts,
  source: WorkflowSnapshot,
  ids: string[],
  { owner, fresh = false }: { owner?: string; fresh?: boolean } = {},
): Promise<string[]> {
  if (!ids.length) return [];
  const kind = owner ? 'system' : 'declared';
  const held = new Set(
    fresh
      ? []
      : (
          await tx.all<{ target_id: string }>(
            `SELECT target_id FROM wf_dependencies WHERE project_id=? AND source_id=? AND kind=? AND owner=? AND target_id IN (${marks(ids)})`,
            source.projectId,
            source.id,
            kind,
            owner ?? '',
            ...ids,
          )
        ).map((row) => row.target_id),
  );
  const targets = await nodes(
    tx,
    source.projectId,
    ids.filter((id) => !held.has(id)),
  );
  const added: { id: string; target: NodeRow; pinned: WorkflowPinned }[] = [];
  for (const targetId of ids) {
    check(targetId !== source.id, 'dependency_cycle', 'A workflow cannot depend on itself', 409);
    if (held.has(targetId)) continue;
    const target = targets.get(targetId);
    check(target, 'not_found', 'Dependency not found in this project', 404);
    const pinned = await contracts.get(tx, target.workflow, Number(target.version));
    check(
      pinned?.successStates,
      'dependency_unsupported',
      `Workflow ${target.workflow}@${target.version} has no declared success states`,
      409,
    );
    added.push({ id: targetId, target, pinned });
  }
  if (!added.length) return [];
  if (!fresh)
    check(
      !(await tx.get(
        `WITH RECURSIVE reached(id) AS (
           SELECT id FROM (VALUES ${added.map(() => '(?::text)').join(',')}) AS given(id)
           UNION SELECT d.target_id FROM wf_dependencies d JOIN reached ON d.source_id = reached.id
           WHERE d.project_id = ?)
         SELECT 1 AS found FROM reached WHERE id = ? LIMIT 1`,
        ...added.map((item) => item.id),
        source.projectId,
        source.id,
      )),
      'dependency_cycle',
      'These dependencies would create a cycle',
      409,
    );
  const time = now();
  await tx.run(
    `INSERT INTO wf_dependencies (project_id,source_id,target_id,target_workflow,target_version,target_success_json,target_terminal_json,created_at,kind,owner) VALUES ${added.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    ...added.flatMap(({ id, target, pinned }) => [
      source.projectId,
      source.id,
      id,
      target.workflow,
      target.version,
      canonical(pinned.successStates),
      canonical(pinned.definition.terminal),
      time,
      kind,
      owner ?? '',
    ]),
  );
  return added.map((item) => item.id);
}
