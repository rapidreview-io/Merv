import { check } from '@merv/contracts';
import type {
  Sql,
  WorkflowDefinition,
  WorkflowLimitStatus,
  WorkflowLoopLimit,
  WorkflowPolicy,
  WorkflowSnapshot,
} from '@merv/contracts';

const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;

/**
 * The engine writes these into wf_history beside the state it found, and a limit is counted
 * by state and action, so a limit over one of them would count the engine's own bookkeeping.
 */
const engineActions = ['start', 'add_dependencies', 'replan_dependencies'];

/**
 * A limit caps an edge that returns work to an earlier state. An edge that stays where it is
 * cannot be capped: refusing it would stop the very step it allows, with nowhere to escalate.
 */
export function validateLimits(
  definition: WorkflowDefinition,
  limits: WorkflowLoopLimit[],
): WorkflowLoopLimit[] {
  check(Array.isArray(limits), 'invalid_workflow_policy', 'Limits must be an array');
  const names = new Set<string>();
  const capped = new Set<string>();
  return limits.map((limit) => {
    check(
      limit &&
        typeof limit.name === 'string' &&
        identifier.test(limit.name) &&
        !names.has(limit.name),
      'invalid_workflow_policy',
      'Limit names must be unique identifiers',
    );
    names.add(limit.name);
    check(
      definition.states.includes(limit.from) && !definition.terminal.includes(limit.from),
      'invalid_workflow_policy',
      `Limit ${limit.name} must leave a declared nonterminal state`,
    );
    check(
      Number.isSafeInteger(limit.max) && limit.max >= 1 && limit.max <= 1000,
      'invalid_workflow_policy',
      `Limit ${limit.name} must allow between 1 and 1000 traversals`,
    );
    check(
      Array.isArray(limit.actions) &&
        limit.actions.length > 0 &&
        new Set(limit.actions).size === limit.actions.length,
      'invalid_workflow_policy',
      `Limit ${limit.name} must name distinct actions`,
    );
    for (const action of limit.actions) {
      const edge = definition.edges.find(
        (edge) => edge.from === limit.from && edge.action === action,
      );
      check(
        edge && edge.to !== limit.from && !engineActions.includes(action),
        'invalid_workflow_policy',
        `Limit ${limit.name} may only cap an edge that leaves ${limit.from} for another state`,
      );
      const key = `${limit.from}:${action}`;
      check(!capped.has(key), 'invalid_workflow_policy', `Multiple limits cap ${key}`);
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

/**
 * Counted from the history the engine already writes, so there is no counter to keep in
 * step and a cap deployed today covers rounds taken before it existed.
 */
export async function limitStatus(
  sql: Sql,
  limit: WorkflowLoopLimit,
  instanceId: string,
): Promise<WorkflowLimitStatus> {
  const taken = await sql.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM wf_history WHERE instance_id=? AND from_state=? AND action IN (${limit.actions.map(() => '?').join(',')})`,
    instanceId,
    limit.from,
    ...limit.actions,
  );
  const grants = await sql.get<{ n: number | string }>(
    'SELECT COALESCE(SUM(additional),0) AS n FROM wf_limit_grants WHERE instance_id=? AND limit_name=?',
    instanceId,
    limit.name,
  );
  // PostgreSQL SUM(bigint) is numeric and arrives as text; a sum of two caps must stay a number.
  const granted = Number(grants?.n ?? 0);
  const used = Number(taken?.n ?? 0);
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

/** The limits leaving the instance's current state. Reads only, so guards stay pure. */
export async function limitStatuses(
  sql: Sql,
  policy: WorkflowPolicy | undefined,
  snapshot: WorkflowSnapshot,
): Promise<WorkflowLimitStatus[]> {
  const statuses: WorkflowLimitStatus[] = [];
  for (const limit of policy?.limits ?? [])
    if (limit.from === snapshot.state) statuses.push(await limitStatus(sql, limit, snapshot.id));
  return statuses;
}

export function limitMessage(status: WorkflowLimitStatus, workflow: string): string {
  return `${status.name} is exhausted on this ${workflow} (${status.used}/${status.max}). The work is not failed and waits for a human, who may review it by hand or end it; a project admin may allow more rounds with workflow.extend_limit.`;
}
