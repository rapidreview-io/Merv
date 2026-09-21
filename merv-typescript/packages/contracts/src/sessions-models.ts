/** Portable session, runner and agent read models, shared by the server and the browser. */
import type { WorkflowDispatchCandidate } from './workflow-models.js';

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
  | 'crash_loop';

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
  | 'retries_exhausted'
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
  used: { wallMs: number; costMicros: number; tokens: number };
  exceeded: ('wall' | 'cost' | 'tokens')[];
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
}
