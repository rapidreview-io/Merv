import { check, type Transaction } from '@merv/contracts';
import type {
  BudgetStatus,
  Session,
  SessionUsageReport,
  UsageRollup,
  UsageTotals,
} from './types.js';

/** SQLite bounds the parameters of one statement; a closure is read in slices of this many. */
const chunk = 500;
const topInstances = 50;

export const accountingMethod =
  'Wall-clock is lease wall-clock: Merv measures it from activation to close of each closed session, and a close may lag the death of the process by up to the expiry window; live sessions are not yet counted. Tokens, cost and model are reported by the runner that launched the process, or by the process itself, and are not verified; reportedSessions of sessions says how many reported. Model context, reasoning, provider billing and anything done outside a Merv-launched process are unknown to Merv. Counting began when this feature was installed.';

/** PostgreSQL SUM(bigint) is numeric and arrives as text; every public sum is normalised here. */
function sum(value: number | string | null): number {
  const number = Number(value ?? 0);
  check(
    Number.isSafeInteger(number) && number >= 0,
    'usage_overflow',
    'Usage totals exceed the supported numeric range',
    500,
  );
  return number;
}

interface GroupRow {
  instance_id: string;
  workflow: string;
  sessions: number | string;
  reported: number | string;
  wall_ms: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cost_micros: number | string;
  since: string | null;
}
interface BudgetRow {
  scope_id: string;
  max_wall_ms: number | null;
  max_cost_micros: number | null;
  max_tokens: number | null;
  updated_at: string;
  updated_by: string;
}

const empty = (): UsageTotals => ({
  sessions: 0,
  reportedSessions: 0,
  wallMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  toolCalls: 0,
  toolPayloadTokensEstimate: 0,
});
function add(into: UsageTotals, item: UsageTotals): void {
  for (const key of Object.keys(into) as (keyof UsageTotals)[]) into[key] += item[key];
}

/**
 * What one closed session cost in lease wall-clock, written in the transaction that closes it.
 * The row is inserted once and never replaced, so a second close of the same session, which
 * closeSession already refuses, could not move the figure either.
 */
export async function recordUsage(tx: Transaction, session: Session): Promise<void> {
  const receipt = await tx.get<{ platform_json: string | null }>(
    'SELECT platform_json FROM session_dispatch_receipts WHERE session_id=?',
    session.id,
  );
  const platform: { harness?: string; model?: string } = receipt?.platform_json
    ? JSON.parse(receipt.platform_json)
    : {};
  const closedAt = session.closedAt!;
  await tx.run(
    'INSERT INTO session_usage(session_id,project_id,instance_id,revision,workflow,state,role,outcome,started_at,closed_at,wall_ms,harness,model) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING',
    session.id,
    session.projectId,
    session.instanceId,
    session.expectedRevision,
    session.execution.workflow,
    session.execution.state,
    session.role,
    session.outcome ?? 'released',
    session.activatedAt,
    closedAt,
    session.activatedAt ? Math.max(0, Date.parse(closedAt) - Date.parse(session.activatedAt)) : 0,
    platform.harness ?? null,
    platform.model ?? null,
  );
}

/**
 * The first report wins and a later one is dropped without an error: a runner retries a
 * release it never saw answered, and it must never be left unable to release.
 */
export async function reportUsage(
  tx: Transaction,
  sessionId: string,
  usage: SessionUsageReport,
  time: string,
): Promise<{ costMicros: number | null } | undefined> {
  const costMicros = usage.costUsd === undefined ? null : Math.round(usage.costUsd * 1e6);
  const result = await tx.run(
    'UPDATE session_usage SET input_tokens=?,output_tokens=?,cost_micros=?,reported_model=?,reported_at=? WHERE session_id=? AND reported_at IS NULL',
    usage.inputTokens,
    usage.outputTokens,
    costMicros,
    usage.model ?? null,
    time,
    sessionId,
  );
  return result.changes === 1 ? { costMicros } : undefined;
}

async function groups(
  tx: Transaction,
  projectId: string,
  instanceIds: string[] | null,
): Promise<{ row: GroupRow; totals: UsageTotals }[]> {
  const select =
    'SELECT u.instance_id,u.workflow,COUNT(*) AS sessions,COALESCE(SUM(CASE WHEN u.reported_at IS NULL THEN 0 ELSE 1 END),0) AS reported,COALESCE(SUM(u.wall_ms),0) AS wall_ms,COALESCE(SUM(u.input_tokens),0) AS input_tokens,COALESCE(SUM(u.output_tokens),0) AS output_tokens,COALESCE(SUM(u.cost_micros),0) AS cost_micros,MIN(u.closed_at) AS since FROM session_usage u WHERE u.project_id=?';
  const calls =
    'SELECT u.instance_id,COUNT(*) AS calls,COALESCE(SUM(c.input_tokens),0)+COALESCE(SUM(c.output_tokens),0) AS payload FROM session_tool_calls c JOIN session_usage u ON u.session_id=c.execution_id WHERE u.project_id=?';
  const slices: (string[] | null)[] = [];
  if (instanceIds === null) slices.push(null);
  else
    for (let index = 0; index < instanceIds.length; index += chunk)
      slices.push(instanceIds.slice(index, index + chunk));
  const result: { row: GroupRow; totals: UsageTotals }[] = [];
  for (const slice of slices) {
    const within = slice ? ` AND u.instance_id IN (${slice.map(() => '?').join(',')})` : '';
    const observed = new Map(
      (
        await tx.all<{ instance_id: string; calls: number | string; payload: number | string }>(
          `${calls}${within} GROUP BY u.instance_id`,
          projectId,
          ...(slice ?? []),
        )
      ).map((row) => [row.instance_id, row]),
    );
    for (const row of await tx.all<GroupRow>(
      `${select}${within} GROUP BY u.instance_id,u.workflow`,
      projectId,
      ...(slice ?? []),
    )) {
      // An instance has one workflow, so the tool calls joined by instance belong to this row.
      const tools = observed.get(row.instance_id);
      result.push({
        row,
        totals: {
          sessions: sum(row.sessions),
          reportedSessions: sum(row.reported),
          wallMs: sum(row.wall_ms),
          inputTokens: sum(row.input_tokens),
          outputTokens: sum(row.output_tokens),
          costMicros: sum(row.cost_micros),
          toolCalls: sum(tools?.calls ?? 0),
          toolPayloadTokensEstimate: sum(tools?.payload ?? 0),
        },
      });
    }
  }
  return result;
}

/** Totals over a project (`instanceIds` null) or over the given instances of it. */
export async function usageTotals(
  tx: Transaction,
  projectId: string,
  instanceIds: string[] | null,
): Promise<Pick<UsageRollup, 'totals' | 'byWorkflow' | 'byInstance'> & { since: string | null }> {
  const totals = empty(),
    workflows = new Map<string, UsageTotals>(),
    byInstance: UsageRollup['byInstance'] = [];
  let since: string | null = null;
  for (const { row, totals: item } of await groups(tx, projectId, instanceIds)) {
    add(totals, item);
    if (!workflows.has(row.workflow)) workflows.set(row.workflow, empty());
    add(workflows.get(row.workflow)!, item);
    byInstance.push({ ...item, instanceId: row.instance_id, workflow: row.workflow });
    if (row.since && (since === null || row.since < since)) since = row.since;
  }
  return {
    totals,
    byWorkflow: [...workflows]
      .map(([workflow, item]) => ({ ...item, workflow }))
      .sort((a, b) => b.wallMs - a.wallMs || a.workflow.localeCompare(b.workflow)),
    byInstance: byInstance
      .sort((a, b) => b.wallMs - a.wallMs || a.instanceId.localeCompare(b.instanceId))
      .slice(0, topInstances),
    since,
  };
}

/**
 * Every budget of the project, measured now. Nothing about being over a budget is stored:
 * raising or clearing one resumes dispatch on the next poll, with no flag to forget to clear.
 * `closure` resolves an instance scope to the instances it covers.
 */
export async function budgetStatuses(
  tx: Transaction,
  projectId: string,
  closure: (instanceId: string) => Promise<string[]>,
  only?: string[],
): Promise<(BudgetStatus & { instanceIds: string[] | null })[]> {
  const rows = (
    await tx.all<BudgetRow>(
      'SELECT scope_id,max_wall_ms,max_cost_micros,max_tokens,updated_at,updated_by FROM session_budgets WHERE project_id=? ORDER BY scope_id',
      projectId,
    )
  ).filter((row) => !only || only.includes(row.scope_id));
  const result: (BudgetStatus & { instanceIds: string[] | null })[] = [];
  for (const row of rows) {
    const instanceIds = row.scope_id === projectId ? null : await closure(row.scope_id);
    const { totals } = await usageTotals(tx, projectId, instanceIds);
    const used = {
      wallMs: totals.wallMs,
      costMicros: totals.costMicros,
      tokens: totals.inputTokens + totals.outputTokens,
    };
    const exceeded: BudgetStatus['exceeded'] = [];
    if (row.max_wall_ms !== null && used.wallMs >= Number(row.max_wall_ms)) exceeded.push('wall');
    if (row.max_cost_micros !== null && used.costMicros >= Number(row.max_cost_micros))
      exceeded.push('cost');
    if (row.max_tokens !== null && used.tokens >= Number(row.max_tokens)) exceeded.push('tokens');
    result.push({
      scopeId: row.scope_id,
      kind: instanceIds === null ? 'project' : 'instance',
      maxWallMs: row.max_wall_ms === null ? null : Number(row.max_wall_ms),
      maxCostMicros: row.max_cost_micros === null ? null : Number(row.max_cost_micros),
      maxTokens: row.max_tokens === null ? null : Number(row.max_tokens),
      used,
      exceeded,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      instanceIds,
    });
  }
  return result;
}

export const publicBudget = ({
  instanceIds: _instanceIds,
  ...budget
}: BudgetStatus & { instanceIds: string[] | null }): BudgetStatus => budget;
