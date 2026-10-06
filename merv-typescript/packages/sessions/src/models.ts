/** Portable session, runner and agent read models, shared by the server and the browser. */
import type {
  RunnerPlatform,
  SessionWorkspace,
  WorkflowDispatchCandidate,
} from '@merv/contracts/types';
import type { RunningPhrase } from '@merv/contracts/running';

export interface SessionWorkspaceRecord {
  attachment: SessionWorkspace;
  result: SessionWorkspace | null;
}

export type SessionRole = 'producer' | 'reviewer' | 'reader';

export type SessionStatus = 'offered' | 'active' | 'released' | 'expired';

/**
 * A lease's behaviour as the read that sent it saw it (`leaseLiveness` in rules.ts): its
 * verdict, the only word that takes colour, and the rest of the line, which stays quiet.
 */
export interface LeaseLiveness {
  verdict: SessionStatus | 'lapsed';
  tone: 'ok' | 'warn' | 'bad' | 'dim';
  rest: RunningPhrase;
}

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
  /** A release retired the machine's image mid-step: nothing about the work was wrong. */
  | 'machine_retired'
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
  /** Automatic work goes only to the project's own runners, never to a machine Fleet rents. */
  ownMachines: boolean;
  /** Whether Fleet rents machines for automatic work on this server, so the choice means anything. */
  fleet: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
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
    /** Seconds without a tool call before an active session is reported quiet; nothing closes it. */
    idleNoticeSeconds: number;
    /** Failed launches of one instance revision after which automatic dispatch stops offering it. */
    maxLaunchFailures: number;
    /** Seconds a dispatchable target may wait on one revision before it is reported quiet. */
    quietReadySeconds: number;
    /** Seconds a live runner may repeat one refusal before it is reported as refusing. */
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
  /** The workflow of the record this lease works on, from its frozen execution. */
  workflow?: string;
  expectedRevision: number;
  role: SessionRole;
  status: SessionStatus;
  label: string;
  /** The record's own name for a person, or the label where an older lease has none. */
  name: string;
  runnerRef: string | null;
  hostRef: string | null;
  platform: SessionPlatform | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  outcome?: SessionOutcome | null;
  liveness: LeaseLiveness;
  /** An active session's activation or latest tool call, whichever is later; null otherwise. */
  lastActivityAt: string | null;
  /** When an active session's idle clock passed `idleNoticeSeconds`; null while it moves. */
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
  currentAssignment: { label: string; name: string; role: SessionRole } | null;
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
    name: string;
    role: SessionRole;
    status: SessionStatus;
    createdAt: string;
    activatedAt: string | null;
    expiresAt: string;
    closedAt: string | null;
    closeReason: string | null;
    outcome?: SessionOutcome | null;
    liveness: LeaseLiveness;
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

export interface UsageTotals {
  sessions: number;
  /** How many of `sessions` carry a runner report; the token sums cover only these. */
  reportedSessions: number;
  /** Lease wall-clock, activation to close. A close may lag the death of the process. */
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolPayloadTokensEstimate: number;
}

/**
 * A budget only pauses automatic dispatch; nothing running is stopped. Wall-clock is the
 * dimension Merv measures itself. Tokens trust whatever wrote the runner's report.
 */
export interface BudgetStatus {
  /** The project id for the project budget, otherwise a workflow instance id. */
  scopeId: string;
  kind: 'project' | 'instance';
  maxWallMs: number | null;
  maxTokens: number | null;
  /**
   * Wall-clock is measured by Merv. Tokens are only what runners reported: null
   * while sessions in scope were activated and none reported, never a zero that was not measured.
   * They cover worker sessions alone; a remote job's own charges are not in them.
   */
  used: { wallMs: number; tokens: number | null };
  exceeded: ('wall' | 'tokens')[];
  /** Closed sessions in scope that were activated and reported no usage. */
  unreportedSessions: number;
  /**
   * Bounds that cannot be judged because of them: a token bound is enforced only
   * on complete accounting, so it withholds new automatic offers until the usage arrives
   * or the bound is cleared, rather than letting unreported spending pass as none. An
   * instance whose dependency closure is too large to walk leaves every bound unjudged.
   */
  unavailable: ('wall' | 'tokens')[];
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
