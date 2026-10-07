import { ENGINE_ACTIONS, identifier, valid } from './definition.js';
import type {
  Sql,
  WorkflowDefinition,
  WorkflowLimitStatus,
  WorkflowLoopLimit,
  WorkflowPolicy,
} from '@merv/contracts';

/**
 * A limit caps an edge that returns work to an earlier state. An edge that stays where it is
 * cannot be capped: refusing it would stop the very step it allows, with nowhere to escalate.
 */
export function validateLimits(
  definition: WorkflowDefinition,
  limits: WorkflowLoopLimit[],
): WorkflowLoopLimit[] {
  valid(Array.isArray(limits), 'Limits must be an array');
  const names = new Set<string>();
  const capped = new Set<string>();
  return limits.map((limit) => {
    valid(
      limit &&
        typeof limit.name === 'string' &&
        identifier.test(limit.name) &&
        !names.has(limit.name),
      'Limit names must be unique identifiers',
    );
    names.add(limit.name);
    valid(
      definition.states.includes(limit.from) && !definition.terminal.includes(limit.from),
      `Limit ${limit.name} must leave a declared nonterminal state`,
    );
    valid(
      Number.isSafeInteger(limit.max) && limit.max >= 1 && limit.max <= 1000,
      `Limit ${limit.name} must allow between 1 and 1000 traversals`,
    );
    valid(
      Array.isArray(limit.actions) &&
        limit.actions.length > 0 &&
        new Set(limit.actions).size === limit.actions.length,
      `Limit ${limit.name} must name distinct actions`,
    );
    for (const action of limit.actions) {
      const edge = definition.edges.find(
        (edge) => edge.from === limit.from && edge.action === action,
      );
      // A limit is counted in wf_history by state and action, so one over an engine action
      // would count the engine's own bookkeeping.
      valid(
        edge && edge.to !== limit.from && !ENGINE_ACTIONS.includes(action),
        `Limit ${limit.name} may only cap an edge that leaves ${limit.from} for another state`,
      );
      const key = `${limit.from}:${action}`;
      valid(!capped.has(key), `Multiple limits cap ${key}`);
      capped.add(key);
    }
    return Object.freeze({
      name: limit.name,
      from: limit.from,
      actions: Object.freeze([...limit.actions]) as unknown as string[],
      max: limit.max,
    });
  });
}

export function limitFor(
  policy: WorkflowPolicy | undefined,
  from: string,
  action: string,
): WorkflowLoopLimit | undefined {
  return policy?.limits?.find((limit) => limit.from === from && limit.actions.includes(action));
}

function statusOf(limit: WorkflowLoopLimit, used: number, granted: number): WorkflowLimitStatus {
  const max = limit.max + granted;
  return {
    name: limit.name,
    from: limit.from,
    actions: [...limit.actions],
    base: limit.max,
    granted,
    max,
    used,
    remaining: Math.max(0, max - used),
    exhausted: used >= max,
  };
}

/**
 * One limit's status for each of several instances, in two reads however many. Counted from the
 * history the engine already writes, so there is no counter to keep in step and a cap deployed
 * today covers rounds taken before it existed.
 */
export async function limitStatusOf(
  sql: Sql,
  limit: WorkflowLoopLimit,
  instanceIds: readonly string[],
): Promise<Map<string, WorkflowLimitStatus>> {
  if (!instanceIds.length) return new Map();
  const ids = instanceIds.map(() => '?').join(',');
  const counted = async (query: string, ...params: string[]) =>
    new Map(
      (await sql.all<{ instance_id: string; n: number | string }>(query, ...params)).map((row) => [
        row.instance_id,
        Number(row.n),
      ]),
    );
  const taken = await counted(
    `SELECT instance_id,COUNT(*) AS n FROM wf_history WHERE instance_id IN (${ids}) AND from_state=? AND action IN (${limit.actions.map(() => '?').join(',')}) GROUP BY instance_id`,
    ...instanceIds,
    limit.from,
    ...limit.actions,
  );
  const grants = await counted(
    `SELECT instance_id,COALESCE(SUM(additional),0) AS n FROM wf_limit_grants WHERE instance_id IN (${ids}) AND limit_name=? GROUP BY instance_id`,
    ...instanceIds,
    limit.name,
  );
  return new Map(
    instanceIds.map((id) => [id, statusOf(limit, taken.get(id) ?? 0, grants.get(id) ?? 0)]),
  );
}

/** limitStatusOf for one instance. */
export const limitStatus = async (sql: Sql, limit: WorkflowLoopLimit, instanceId: string) =>
  (await limitStatusOf(sql, limit, [instanceId])).get(instanceId)!;

/**
 * The limits leaving each instance's current state, or with `every` all its limits, two reads
 * per limit however many instances it counts for. Reads only, so guards stay pure.
 */
export async function limitStatusesOf(
  sql: Sql,
  instances: readonly { id: string; state: string; policy?: WorkflowPolicy }[],
  every = false,
): Promise<Map<string, WorkflowLimitStatus[]>> {
  const leaving = ({ state, policy }: (typeof instances)[number]) =>
    (policy?.limits ?? []).filter((limit) => every || limit.from === state);
  const read = new Map<WorkflowLoopLimit, Map<string, WorkflowLimitStatus>>();
  for (const limit of new Set(instances.flatMap(leaving)))
    read.set(
      limit,
      await limitStatusOf(
        sql,
        limit,
        instances.filter((instance) => leaving(instance).includes(limit)).map(({ id }) => id),
      ),
    );
  return new Map(
    instances.map((instance) => [
      instance.id,
      leaving(instance).map((limit) => read.get(limit)!.get(instance.id)!),
    ]),
  );
}

export function limitMessage(status: WorkflowLimitStatus, workflow: string): string {
  return `${status.name} is exhausted on this ${workflow} (${status.used}/${status.max}). The work is not failed and waits for a human, who may take the next step by hand or end it; a project admin may allow more rounds with workflow.extend_limit.`;
}
