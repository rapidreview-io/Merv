/** Portable session, runner and agent read models, shared by the server and the browser. */
import type { WorkflowDispatchCandidate } from './workflow-models.js';

/** Frozen plan and checkpoint metadata, carried only by a merge-capable workspace driver. */
export type CodePendingMerge = {
  plan: string;
  firstParent: string;
  secondParent: string;
  checkpoint: string;
  firstMerge: string | null;
};

/** Source-authenticated runner observations; the server does not verify Git objects. */
export interface SessionWorkspace {
  repositoryId: string;
  workspaceId: string;
  mode: 'ephemeral' | 'persistent';
  branch: string | null;
  baseOid: string;
  headOid: string;
  /** Observed Git tree; absent on older reports, never inferred by the server. */
  treeOid?: string;
  pendingMerge?: CodePendingMerge;
  stats: { commitCount: number; filesChanged: number; insertions: number; deletions: number };
}
export interface SessionWorkspaceRecord {
  attachment: SessionWorkspace;
  result: SessionWorkspace | null;
}

export type SessionRole = 'producer' | 'reviewer' | 'reader';
export type SessionStatus = 'offered' | 'active' | 'released' | 'expired';
export type SessionOutcome =
  | 'released'
  | 'expired'
  | 'halted'
  | 'completed'
  | 'host_failed'
  | 'launch_failed'
  | 'workspace_failed'
  /**
   * The machine could not prepare a checkout yet although nothing about the launch was wrong:
   * where the history lives is away, busy or full. It is never counted against the work.
   */
  | 'preparation_deferred'
  | 'crash_loop';
/** What a machine may report a launch ended as; only a worker's own handoff records completion. */
export type SessionReleaseOutcome =
  | 'completed'
  | 'host_failed'
  | 'launch_failed'
  | 'workspace_failed'
  | 'preparation_deferred'
  | 'crash_loop';
/** Why a preparation was put off, in the words of whatever prepares checkouts. */
export interface SessionDeferral {
  cause: string;
  code: string;
}

export interface DispatchState {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface RunnerPlatform {
  name: string;
  harness:
    | 'codex'
    | 'claude'
    | 'gemini'
    | 'cursor'
    | 'opencode'
    | 'copilot'
    | 'qwen'
    | 'hermes'
    | 'command';
  model?: string;
  effort?: string;
  enabled: boolean;
  parallelism: number;
}
/** What a lease was taken on: the platform named, without its local capacity. */
export type SessionPlatform = Pick<RunnerPlatform, 'name' | 'harness' | 'model' | 'effort'>;
export interface RunnerSettings {
  platforms: {
    name: string;
    enabled: boolean;
    model?: string;
    effort?: string;
    parallelism: number;
  }[];
}
export interface RunnerHeartbeat {
  runnerId: string;
  machine: { hostname: string; system: string; architecture: string };
  platforms: RunnerPlatform[];
  capacity: number;
  appliedVersion?: number;
  /**
   * What this machine can do beyond running a platform, as opaque names: a workspace policy
   * that names a driver is offered only to a runner that lists it. An older runner sends none.
   */
  capabilities?: string[];
}
/** Every answer an automatic lease request can receive, and the whole stored vocabulary. */
export type DispatchDecision =
  | 'offered'
  | 'replayed'
  | 'dispatch_disabled'
  | 'runner_offline'
  | 'platform_disabled'
  | 'settings_pending'
  | 'capacity_full'
  | 'retry_backoff'
  | 'budget_exceeded'
  | 'usage_unavailable'
  | 'retries_exhausted'
  /** Everything left in the queue needs a workspace driver this runner does not advertise. */
  | 'runner_incompatible'
  | 'no_candidates';
export interface RunnerPresence extends RunnerHeartbeat {
  id: string;
  lastSeenAt: string;
  live: boolean;
  desiredVersion: number;
  desiredSettings: RunnerSettings;
  /** What the runner's last lease request decided; one row per runner, never a log. */
  lastDecision: DispatchDecision | null;
  lastDecisionAt: string | null;
  /** When the current run of the same decision began, so a refusal says how long it has held. */
  decisionSince: string | null;
}
/**
 * Why automatic dispatch is spacing out or withholding one instance revision: one counter
 * per target, never a log. `lastSessionId` is null when the offer itself could not be built.
 */
export interface DispatchHold {
  instanceId: string;
  revision: number;
  attempts: number;
  lastCode: string;
  lastMessage: string;
  lastSessionId: string | null;
  firstAt: string;
  lastAt: string;
  /** Set once the attempts reach the cap; only a human's go-ahead clears it. */
  heldAt: string | null;
}
export type StuckKind =
  | 'session_idle'
  | 'dispatch_held'
  | 'dispatch_failing'
  | 'work_blocked'
  | 'work_deferred'
  | 'ready_quiet'
  | 'dispatch_disabled'
  | 'no_live_runner'
  | 'runner_refusing';
/** One thing that stopped moving. `why` and `next` are advice; every guard is a transaction's. */
export interface StuckItem {
  kind: StuckKind;
  instanceId?: string;
  expectedRevision?: number;
  sessionId?: string;
  runnerRef?: string;
  label?: string;
  since: string;
  forSeconds: number;
  code: string;
  attempts?: number;
  why: string;
  next: string;
}
export interface StuckReport {
  observedAt: string;
  thresholds: {
    idleNoticeSeconds: number;
    maxLaunchFailures: number;
    quietReadySeconds: number;
    refusalSeconds: number;
  };
  /** What needs someone: every item except `dispatch_failing`, which is still being retried. */
  total: number;
  /** Every item by kind, before the 200 cap. */
  counts: Record<StuckKind, number>;
  /** At most 200, in StuckKind order, then by `since` and instance. */
  items: StuckItem[];
  truncated: boolean;
}
export interface SessionSummary {
  agentId?: string;
  agentSessionId?: string;
  actorId?: string;
  id: string;
  instanceId: string;
  expectedRevision: number;
  role: SessionRole;
  status: SessionStatus;
  label: string;
  runnerRef: string | null;
  hostRef: string | null;
  platform: SessionPlatform | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  outcome?: SessionOutcome | null;
  /** An active session's activation or latest tool call, whichever is later; null otherwise. */
  lastActivityAt: string | null;
  /** When the sweep found the session alive without progressing; null while it moves. */
  quietSince: string | null;
  /** Frozen execution intent remains known before preparation or after a preparation failure. */
  workspaceMode: 'none' | 'ephemeral' | 'persistent';
  workspace?: SessionWorkspaceRecord;
}
export interface AgentSummary {
  id: string;
  sessionId: string;
  actorId: string;
  name: string;
  status: 'active' | 'retired';
  contextEpoch: number;
  persistent: boolean;
  currentExecutionId: string | null;
  currentAssignment: { label: string; role: SessionRole } | null;
  createdAt: string;
  runnerId: string;
}
export interface AgentToolCall {
  id: string;
  executionId: string;
  tool: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number | null;
}
export interface AgentObservation {
  agent: AgentSummary;
  assignments: {
    id: string;
    instanceId: string;
    label: string;
    role: SessionRole;
    status: SessionStatus;
    createdAt: string;
    activatedAt: string | null;
    expiresAt: string;
    closedAt: string | null;
    closeReason: string | null;
    outcome?: SessionOutcome | null;
    workflow: { name: string; state: string };
    revision: number;
    tools: string[];
  }[];
  /** Up to 100 executed Merv calls, with in-flight calls first. */
  toolCalls: AgentToolCall[];
  toolCallTotal: number;
  tokenStats: {
    inputTokens: number;
    outputTokens: number;
    completedCalls: number;
    totalCalls: number;
  };
  tokenAccounting: { kind: 'estimate'; method: string };
}
/** What the machine that launched a process says it spent. Merv cannot verify any of it. */
export interface SessionUsageReport {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  model?: string;
}
export interface UsageTotals {
  sessions: number;
  /** How many of `sessions` carry a runner report; the token and cost sums cover only these. */
  reportedSessions: number;
  /** Lease wall-clock, activation to close. A close may lag the death of the process. */
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  toolCalls: number;
  toolPayloadTokensEstimate: number;
}
/**
 * A budget only pauses automatic dispatch; nothing running is stopped. Wall-clock is the
 * dimension Merv measures itself. Cost and tokens trust whatever wrote the runner's report.
 */
export interface BudgetStatus {
  /** The project id for the project budget, otherwise a workflow instance id. */
  scopeId: string;
  kind: 'project' | 'instance';
  maxWallMs: number | null;
  maxCostMicros: number | null;
  maxTokens: number | null;
  /**
   * Wall-clock is measured by Merv. Cost and tokens are only what runners reported: null
   * while no closed session in scope has reported, never a zero that was not measured.
   * They cover worker sessions alone; a remote job's own charges are not in them.
   */
  used: { wallMs: number; costMicros: number | null; tokens: number | null };
  exceeded: ('wall' | 'cost' | 'tokens')[];
  /** Closed sessions in scope whose runner reported no usage. */
  unreportedSessions: number;
  /**
   * Bounds that cannot be judged because of them: a cost or token bound is enforced only
   * on complete accounting, so it withholds new automatic offers until the usage arrives
   * or the bound is cleared, rather than letting unreported spending pass as none.
   */
  unavailable: ('cost' | 'tokens')[];
  updatedAt: string;
  updatedBy: string;
}
export interface UsageRollup {
  scope:
    | { kind: 'project'; projectId: string }
    | {
        kind: 'instance';
        instanceId: string;
        includeDependencies: boolean;
        instanceCount: number;
      };
  totals: UsageTotals;
  byWorkflow: (UsageTotals & { workflow: string })[];
  /** The fifty instances with the most wall-clock. */
  byInstance: (UsageTotals & { instanceId: string; workflow: string })[];
  liveSessions: number;
  budgets: BudgetStatus[];
  accounting: {
    wallClock: 'measured';
    tokens: 'runner_reported';
    since: string | null;
    method: string;
  };
}
export interface SessionsProjectStatus {
  agents?: AgentSummary[];
  /** The server's own clock when this payload was measured; every duration anchors here. */
  observedAt: string;
  liveSessionCount: number;
  sessionTotal: number;
  /** Registered runners, of which `runners` carries the most recently seen. */
  runnerTotal: number;
  canManage: boolean;
  dispatch: DispatchState;
  runners: RunnerPresence[];
  sessions: SessionSummary[];
  /** Candidates currently admissible for the authenticated caller. */
  queue: WorkflowDispatchCandidate[];
  queueTotal: number;
  /** Every budget of the project, measured at `observedAt`. */
  budgets: BudgetStatus[];
  /** Queued work withheld from automatic dispatch because its launches kept failing. */
  retriesExhausted: number;
  /** What `session.stuck` lists, as counts; a target still being retried is not in `total`. */
  stuck: Pick<StuckReport, 'total' | 'counts'>;
}
