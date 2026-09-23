import { canonical, check, mapAsync, now, visible } from '@merv/contracts';
import type {
  Sql,
  Transaction,
  WorkflowDefinition,
  WorkflowDependency,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowProviderDependency,
  WorkflowProviderRelations,
  WorkflowReference,
} from '@merv/contracts';
import { instanceName, relations } from './dependencies.js';

interface BlockerRow {
  instance_id: string;
  provider: string;
  blocker_key: string;
  code: string;
  message: string;
  status: number;
  next: string;
  related_json: string;
  since: string;
  updated_at: string;
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && visible(value) && value.length <= max;
}

function related(value: unknown): WorkflowReference[] {
  const items = value ?? [];
  check(
    Array.isArray(items) &&
      items.length <= 50 &&
      items.every(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          text(item.kind, 100) &&
          text(item.id, 200) &&
          text(item.label, 500),
      ),
    'invalid_blocker',
    'Related records need a kind, an ID and a label',
    500,
  );
  return (items as WorkflowReference[]).map(({ kind, id, label }) => ({ kind, id, label }));
}

/**
 * The rows are a projection of what a provider thinks now, which is why this table alone may
 * be rewritten and cleared: a provider that is unloaded cannot withdraw its opinion, so work
 * that ends loses its rows at that transition rather than waiting for it. A provider may
 * still speak about work that has ended, and one does: a unit whose accepted code is waiting
 * to reach main is done, and where that wait stands is a fact about it, not work to take.
 */
export async function replaceBlockers(
  tx: Transaction,
  input: {
    projectId: string;
    instanceId: string;
    provider: string;
    blockers: WorkflowProvidedBlockerInput[];
  },
): Promise<void> {
  check(text(input.provider, 100), 'invalid_blocker', 'A blocker names its provider', 500);
  const blockers = input.blockers;
  check(
    blockers.every(
      (item) =>
        text(item.key, 300) &&
        text(item.code, 100) &&
        text(item.message, 4000) &&
        text(item.next, 4000) &&
        Number.isInteger(item.status) &&
        item.status >= 400 &&
        item.status <= 599,
    ) && new Set(blockers.map((item) => item.key)).size === blockers.length,
    'invalid_blocker',
    'A blocker needs a distinct key, a code, a message, a status and a recovery action',
    500,
  );
  const existing = await tx.all<BlockerRow>(
    'SELECT * FROM wf_blockers WHERE instance_id=? AND provider=?',
    input.instanceId,
    input.provider,
  );
  for (const row of existing)
    if (!blockers.some((item) => item.key === row.blocker_key))
      await tx.run(
        'DELETE FROM wf_blockers WHERE instance_id=? AND provider=? AND blocker_key=?',
        input.instanceId,
        input.provider,
        row.blocker_key,
      );
  const at = now();
  for (const item of blockers) {
    const previous = existing.find((row) => row.blocker_key === item.key);
    const links = canonical(related(item.related));
    if (!previous) {
      await tx.run(
        'INSERT INTO wf_blockers (project_id,instance_id,provider,blocker_key,code,message,status,next,related_json,since,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        input.projectId,
        input.instanceId,
        input.provider,
        item.key,
        item.code,
        item.message,
        item.status,
        item.next,
        links,
        at,
        at,
      );
      continue;
    }
    // An unchanged opinion is not rewritten, so a reconcile that finds nothing new leaves
    // `updatedAt` as the moment the opinion last moved.
    if (
      previous.code === item.code &&
      previous.message === item.message &&
      Number(previous.status) === item.status &&
      previous.next === item.next &&
      previous.related_json === links
    )
      continue;
    await tx.run(
      'UPDATE wf_blockers SET code=?,message=?,status=?,next=?,related_json=?,since=?,updated_at=? WHERE instance_id=? AND provider=? AND blocker_key=?',
      item.code,
      item.message,
      item.status,
      item.next,
      links,
      previous.code === item.code ? previous.since : at,
      at,
      input.instanceId,
      input.provider,
      item.key,
    );
  }
}

export async function clearBlockers(tx: Transaction, instanceId: string): Promise<void> {
  await tx.run('DELETE FROM wf_blockers WHERE instance_id=?', instanceId);
}

export async function readBlockers(
  sql: Sql,
  projectId: string,
  instanceId?: string,
): Promise<WorkflowProvidedBlocker[]> {
  const rows = await sql.all<BlockerRow>(
    `SELECT * FROM wf_blockers WHERE project_id=?${instanceId === undefined ? '' : ' AND instance_id=?'} ORDER BY since,instance_id,provider,blocker_key`,
    projectId,
    ...(instanceId === undefined ? [] : [instanceId]),
  );
  return rows.map((row) => ({
    instanceId: row.instance_id,
    provider: row.provider,
    key: row.blocker_key,
    code: row.code,
    message: row.message,
    status: Number(row.status),
    next: row.next,
    related: JSON.parse(row.related_json) as WorkflowReference[],
    since: row.since,
    updatedAt: row.updated_at,
  }));
}

/**
 * Whether a workflow version ever declared a workspace is read from the execution manifests
 * persisted at registration, never from a loaded plugin: a provider classifying a finished
 * dependency must reach the same answer while that dependency's owner is unloaded.
 */
async function declaredWorkspaces(
  sql: Sql,
  known: Map<string, boolean>,
  workflow: string,
  version: number,
): Promise<boolean> {
  const key = `${workflow}@${version}`;
  if (!known.has(key)) {
    const rows = await sql.all<{ manifest_json: string }>(
      'SELECT manifest_json FROM wf_execution_policies WHERE workflow=? AND version=?',
      workflow,
      version,
    );
    const workspaces = rows
      .map(
        (row) =>
          (
            JSON.parse(row.manifest_json) as {
              workspace?: { mode?: string };
            } | null
          )?.workspace,
      )
      .filter((workspace) => (workspace?.mode ?? 'none') !== 'none');
    known.set(key, workspaces.length > 0);
  }
  return known.get(key)!;
}

export async function providerRelations(
  sql: Sql,
  projectId: string,
  instanceId: string,
): Promise<WorkflowProviderRelations | null> {
  const row = await sql.get<{
    id: string;
    workflow: string;
    version: number;
    state: string;
    revision: number;
    data_json: string;
  }>(
    'SELECT id,workflow,version,state,revision,data_json FROM wf_instances WHERE id=? AND project_id=?',
    instanceId,
    projectId,
  );
  if (!row) return null;
  const known = new Map<string, boolean>();
  const facts = new Map<string, { revision: number; terminal: boolean }>();
  const extend = async (item: WorkflowDependency): Promise<WorkflowProviderDependency> => {
    if (!facts.has(item.id)) {
      const node = await sql.get<{ revision: number }>(
        'SELECT revision FROM wf_instances WHERE id=? AND project_id=?',
        item.id,
        projectId,
      );
      const graph = await sql.get<{ definition_json: string }>(
        'SELECT definition_json FROM wf_definitions WHERE name=? AND version=?',
        item.workflow,
        item.version,
      );
      facts.set(item.id, {
        revision: Number(node?.revision ?? 0),
        terminal:
          !!node &&
          !!graph &&
          (JSON.parse(graph.definition_json) as WorkflowDefinition).terminal.includes(item.state),
      });
    }
    const declared = await declaredWorkspaces(sql, known, item.workflow, item.version);
    return {
      ...item,
      ...facts.get(item.id)!,
      declaresWorkspace: declared,
    };
  };
  const success = await sql.get<{ success_json: string }>(
    'SELECT success_json FROM wf_success_states WHERE workflow=? AND version=?',
    row.workflow,
    Number(row.version),
  );
  const data = JSON.parse(row.data_json) as { title?: unknown; name?: unknown; goal?: unknown };
  const settled = !!success && (JSON.parse(success.success_json) as string[]).includes(row.state);
  const edges = await relations(sql, projectId, instanceId);
  const instance = await extend({
    id: row.id,
    workflow: row.workflow,
    version: Number(row.version),
    name: instanceName(data, row.workflow),
    state: row.state,
    settled,
    failed: false,
  });
  return {
    instance: {
      ...instance,
      ...(typeof data.goal === 'string' ? { goal: data.goal } : {}),
      failed: instance.terminal && !settled,
    },
    dependencies: await mapAsync(edges.dependencies, extend),
    dependents: await mapAsync(edges.dependents, extend),
  };
}
