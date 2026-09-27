import type { Caller } from '@merv/contracts';
import type { Fleet } from '@merv/fleet/types';
import type { Sessions } from './types.js';

type ModelBudget = {
  blocked: boolean;
  blockReason: string | null;
  resetsAt: string;
};
const modelWait = (budget: ModelBudget | null) =>
  budget
    ? {
        blocked: budget.blocked,
        reason: budget.blockReason,
        resetsAt: budget.resetsAt,
        ...(budget.blocked
          ? { next: 'Raise the Fleet daily token limit in Settings or wait for the UTC reset.' }
          : {}),
      }
    : null;

/** Provider/runner diagnostics can embed private endpoints; a status overview never needs one. */
const safe = (value: string) => value.replace(/https?:\/\/[^\s]+/gi, '[URL omitted]');

/** A compact operational read. Sessions enforces the caller's authority for each view. */
export async function systemStatus(
  caller: Caller,
  sessions: Sessions,
  fleet?: Fleet,
  modelBudget?: () => Promise<ModelBudget | null>,
) {
  if (caller.session) {
    const session = await sessions.describe(caller);
    return {
      scope: 'session' as const,
      projectId: session.projectId,
      session: {
        id: session.id,
        instanceId: session.instanceId,
        expectedRevision: session.expectedRevision,
        role: session.role,
        status: session.status,
        label: session.assignment.label,
        createdAt: session.createdAt,
        activatedAt: session.activatedAt,
        expiresAt: session.expiresAt,
        closedAt: session.closedAt,
        closeReason: session.closeReason,
        outcome: session.outcome ?? null,
      },
      modelBudget: modelWait((await modelBudget?.()) ?? null),
    };
  }
  const [project, blockers, allocations, budget] = await Promise.all([
    sessions.projectStatus(caller),
    sessions.stuck(caller),
    fleet?.list(caller, 0) ?? Promise.resolve(null),
    modelBudget?.() ?? Promise.resolve(null),
  ]);
  return {
    scope: 'project' as const,
    projectId: caller.projectId,
    observedAt: project.observedAt,
    dispatch: {
      enabled: project.dispatch.enabled,
      state: project.dispatch.enabled ? 'running' : 'paused',
      ownMachines: project.dispatch.ownMachines,
      fleet: project.dispatch.fleet,
    },
    workers: {
      registered: project.runnerTotal,
      liveShown: project.runners.filter((runner) => runner.live).length,
      truncated: project.runnerTotal > project.runners.length,
      runners: project.runners.map((runner) => ({
        id: runner.runnerId,
        live: runner.live,
        capacity: runner.capacity,
        lastSeenAt: runner.lastSeenAt,
        lastDecision: runner.lastDecision,
      })),
    },
    fleet: {
      available: allocations !== null,
      modelBudget: modelWait(budget),
      allocations: (allocations ?? [])
        .filter((allocation) => allocation.phase !== 'released')
        .map((allocation) => ({
          id: allocation.id,
          owner: allocation.owner.kind,
          phase: allocation.phase,
          intent: allocation.intent,
          error: allocation.error,
          createdAt: allocation.createdAt,
        })),
    },
    sessions: {
      live: project.liveSessionCount,
      total: project.sessionTotal,
      truncated: project.sessionTotal > project.sessions.length,
      recent: project.sessions.map((session) => ({
        id: session.id,
        instanceId: session.instanceId,
        role: session.role,
        status: session.status,
        label: session.label,
        runnerRef: session.runnerRef,
        lastActivityAt: session.lastActivityAt,
      })),
    },
    waiting: {
      scope: 'caller_admissible',
      total: project.queueTotal,
      items: project.queue.map((item) => ({
        instanceId: item.instanceId,
        expectedRevision: item.expectedRevision,
        workflow: item.workflow,
        label: item.label,
        role: item.role,
        updatedAt: item.updatedAt,
        workspace: {
          mode: item.workspace.mode,
          driver: 'driver' in item.workspace ? (item.workspace.driver ?? null) : null,
        },
      })),
      truncated: project.queueTotal > project.queue.length,
    },
    blockers: {
      total: blockers.total,
      counts: blockers.counts,
      items: blockers.items.map((item) => ({
        kind: item.kind,
        instanceId: item.instanceId,
        expectedRevision: item.expectedRevision,
        sessionId: item.sessionId,
        runnerRef: item.runnerRef,
        label: item.label,
        since: item.since,
        forSeconds: item.forSeconds,
        code: safe(item.code),
        attempts: item.attempts,
        why:
          item.kind === 'dispatch_held' || item.kind === 'dispatch_failing'
            ? 'An automatic launch failed. Read session.stuck for the detailed failure.'
            : item.kind === 'work_deferred'
              ? 'Repeated machines could not prepare this workspace.'
              : safe(item.why),
        next: safe(item.next),
      })),
      truncated: blockers.truncated,
    },
  };
}
