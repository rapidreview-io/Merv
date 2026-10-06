import { z } from 'zod';
import { recorded, check, type Caller, type Transaction } from '@merv/contracts';
import type { DispatchState, Session, SessionBudgetInput, BudgetStatus } from './types.js';
import { budgetStatuses, publicBudget } from './usage.js';
import { isoNow } from './common.js';
import { label } from './rules.js';
import type { DispatchContext, SessionRow } from './dispatch.js';

// The project's dispatch switch, its budgets and halt. SessionDispatch (dispatch.ts) runs these
// with itself as their context.
export const budgetSchema = z
  .object({
    instanceId: z.string().min(1).max(200).optional(),
    maxWallMinutes: z.number().int().min(1).max(5_256_000).nullable().optional(),
    maxTokens: z.number().int().min(1).max(1e13).nullable().optional(),
  })
  .strict()
  .refine((input) => input.maxWallMinutes !== undefined || input.maxTokens !== undefined);
/**
 * A budget stops new automatic offers when a bound is reached, and also when a token
 * bound cannot be judged: spending nobody reported must not pass as spending that stayed low.
 */
export const withholds = (budget: { exceeded: unknown[]; unavailable: unknown[] }) =>
  budget.exceeded.length > 0 || budget.unavailable.length > 0;
/** session.dispatch: whether automatic work runs, and whether only on the project's own machines. */
export const dispatchSchema = z
  .object({ enabled: z.boolean().optional(), ownMachines: z.boolean().optional() })
  .strict()
  .refine((input) => input.enabled !== undefined || input.ownMachines !== undefined);
export type DispatchChange = z.infer<typeof dispatchSchema>;
/** session.halt: one session, or every one in the project with automatic dispatch off. */
export const haltSchema = z
  .object({ sessionId: label.optional(), reason: label.optional() })
  .strict();
interface DispatchRow {
  enabled: number;
  own_machines: number;
  updated_at: string;
  updated_by: string;
}
export async function dispatch(
  ctx: DispatchContext,
  projectId: string,
  tx: Transaction,
): Promise<DispatchState> {
  const row = await tx.get<DispatchRow>(
    'SELECT * FROM project_session_dispatch WHERE project_id=?',
    projectId,
  );
  return {
    enabled: row ? !!row.enabled : ctx.hooks.byDefault,
    ownMachines: !!row?.own_machines,
    fleet: ctx.hooks.managed.validating,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}
async function set(
  ctx: DispatchContext,
  caller: Caller,
  to: DispatchChange,
  tx: Transaction,
): Promise<DispatchState> {
  const old = await dispatch(ctx, caller.projectId, tx);
  const next = {
    enabled: to.enabled ?? old.enabled,
    ownMachines: to.ownMachines ?? old.ownMachines,
  };
  if (next.enabled === old.enabled && next.ownMachines === old.ownMachines) return old;
  const time = isoNow(ctx.clock);
  await tx.run(
    'INSERT INTO project_session_dispatch(project_id,enabled,own_machines,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled,own_machines=excluded.own_machines,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
    caller.projectId,
    next.enabled ? 1 : 0,
    next.ownMachines ? 1 : 0,
    time,
    caller.actorId,
  );
  // Switching dispatch off and on is the human go-ahead for the whole project: every
  // count starts afresh, where session.release_hold restarts one target.
  if (next.enabled !== old.enabled)
    await tx.run(
      'UPDATE session_dispatch_holds SET attempts=0,held_at=NULL WHERE project_id=?',
      caller.projectId,
    );
  await recorded(ctx.state, tx, caller, 'session.dispatch_changed', caller.projectId, next);
  return { ...next, fleet: old.fleet, updatedAt: time, updatedBy: caller.actorId };
}
export async function setDispatch(
  ctx: DispatchContext,
  caller: Caller,
  input: DispatchChange,
): Promise<DispatchState> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  const parsed = dispatchSchema.safeParse(input);
  check(parsed.success, 'invalid_dispatch', 'Dispatch accepts enabled, ownMachines or both');
  return await ctx.state.transaction(async (tx) => {
    await ctx.ordinary(caller, 'admin', tx);
    return await set(ctx, caller, parsed.data, tx);
  });
}
export async function budgets(
  ctx: DispatchContext,
  caller: Caller,
  tx: Transaction,
  only?: string[],
) {
  return await budgetStatuses(
    tx,
    caller.projectId,
    async (instanceId) => await ctx.workflows.dependencyClosure(caller, instanceId, tx),
    only,
  );
}
/**
 * A state-set command like the dispatch switch: it is idempotent by value, not by a
 * request id, so setting what is already set records nothing and answers the same.
 */
export async function setBudget(
  ctx: DispatchContext,
  caller: Caller,
  input: SessionBudgetInput,
): Promise<BudgetStatus> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  const parsed = budgetSchema.safeParse(input);
  check(
    parsed.success,
    'invalid_budget',
    'A budget names at least one of maxWallMinutes and maxTokens, each a positive bound or null',
  );
  const { instanceId, maxWallMinutes, maxTokens } = parsed.data;
  return await ctx.state.transaction(async (tx) => {
    await ctx.ordinary(caller, 'admin', tx);
    if (instanceId !== undefined) await ctx.workflows.get(caller, instanceId, tx);
    const scopeId = instanceId ?? caller.projectId;
    const old = await tx.get<{ max_wall_ms: number | null; max_tokens: number | null }>(
      'SELECT max_wall_ms,max_tokens FROM session_budgets WHERE project_id=? AND scope_id=?',
      caller.projectId,
      scopeId,
    );
    const next = {
      maxWallMs:
        maxWallMinutes === undefined
          ? (old?.max_wall_ms ?? null)
          : maxWallMinutes === null
            ? null
            : maxWallMinutes * 60_000,
      maxTokens: maxTokens === undefined ? (old?.max_tokens ?? null) : maxTokens,
    };
    check(
      old || Object.values(next).some((value) => value !== null),
      'budget_not_found',
      'There is no budget here to clear',
      404,
    );
    if (
      !old ||
      Number(old.max_wall_ms ?? -1) !== (next.maxWallMs ?? -1) ||
      Number(old.max_tokens ?? -1) !== (next.maxTokens ?? -1)
    ) {
      await tx.run(
        'INSERT INTO session_budgets(project_id,scope_id,max_wall_ms,max_tokens,updated_at,updated_by) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,scope_id) DO UPDATE SET max_wall_ms=excluded.max_wall_ms,max_tokens=excluded.max_tokens,updated_at=excluded.updated_at,updated_by=excluded.updated_by',
        caller.projectId,
        scopeId,
        next.maxWallMs,
        next.maxTokens,
        isoNow(ctx.clock),
        caller.actorId,
      );
      await recorded(ctx.state, tx, caller, 'session.budget_changed', scopeId, {
        scopeId,
        ...next,
      });
    }
    return publicBudget((await budgets(ctx, caller, tx, [scopeId]))[0]!);
  });
}
/** Budgets a usage read shows: the project's, and the one on the instance it asked about. */
export async function budgetsFor(
  ctx: DispatchContext,
  caller: Caller,
  tx: Transaction,
  instanceId?: string,
): Promise<BudgetStatus[]> {
  return (
    await budgets(ctx, caller, tx, [caller.projectId, ...(instanceId ? [instanceId] : [])])
  ).map(publicBudget);
}
export async function halt(
  ctx: DispatchContext,
  caller: Caller,
  input: { sessionId?: string; reason?: string } = {},
): Promise<{ halted: number }> {
  ctx.enter(caller);
  caller = structuredClone(caller);
  const parsed = haltSchema.safeParse(input);
  check(parsed.success, 'invalid_halt', 'Halt accepts an optional session and bounded reason');
  input = parsed.data;
  return await ctx.state.transaction(async (tx) => {
    await ctx.ordinary(caller, 'admin', tx);
    if (!input.sessionId) await set(ctx, caller, { enabled: false }, tx);
    const rows = input.sessionId
      ? await tx.all<SessionRow>(
          'SELECT id,session_json FROM worker_sessions WHERE project_id=? AND id=?',
          caller.projectId,
          input.sessionId,
        )
      : await tx.all<SessionRow>(
          "SELECT id,session_json FROM worker_sessions WHERE project_id=? AND status IN ('offered','active')",
          caller.projectId,
        );
    if (input.sessionId)
      check(rows.length, 'session_not_found', 'Session not found in this project', 404);
    let halted = 0;
    for (const row of rows) {
      const session: Session = JSON.parse(row.session_json);
      if (session.status !== 'offered' && session.status !== 'active') continue;
      if (!(await ctx.hooks.close(session, input.reason ?? 'operator_halt', tx))) continue;
      halted++;
      await recorded(ctx.state, tx, caller, 'session.halted', session.id, {
        sessionId: session.id,
        reason: input.reason ?? 'operator_halt',
      });
    }
    return { halted };
  });
}
