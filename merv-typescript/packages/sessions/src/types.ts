import type {
  AgentObservation,
  BudgetStatus,
  Caller,
  Data,
  DelegationSource,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPresence,
  RunnerSettings,
  SessionDeferral,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionStatus,
  SessionUsageReport,
  SessionsProjectStatus,
  StuckReport,
  UsageRollup,
  WorkflowAssignment,
  WorkflowExecution,
  WorkflowLease,
  SessionPlatform,
  SessionRole,
  SessionWorkspace,
  SessionWorkspaceRecord,
  Transaction,
} from '@merv/contracts';
import type {} from 'cordis';
export type {
  AgentObservation,
  AgentSummary,
  AgentToolCall,
  BudgetStatus,
  DispatchDecision,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPlatform,
  RunnerPresence,
  RunnerSettings,
  SessionDeferral,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionPlatform,
  SessionRole,
  SessionStatus,
  SessionSummary,
  SessionUsageReport,
  SessionWorkspace,
  SessionWorkspaceRecord,
  SessionsProjectStatus,
  StuckItem,
  StuckKind,
  StuckReport,
  UsageRollup,
  UsageTotals,
} from '@merv/contracts';

/** A continuing agent instance and its authenticated session, independent of assignments. */
export interface Agent {
  id: string;
  sessionId: string;
  actorId: string;
  projectId: string;
  source: DelegationSource;
  runnerId: string;
  name: string;
  persistent: boolean;
  status: 'active' | 'retired';
  contextEpoch: number;
  createdAt: string;
  retiredAt: string | null;
}
export interface AgentRegistration {
  name: string;
  runnerId: string;
  requestId: string;
  secret: string;
}
export interface AgentStatus {
  agent: Agent;
  current: Session | null;
  assignments: Session[];
}
export interface AgentAssignment {
  instanceId: string;
  expectedRevision: number;
  requestId: string;
  hardDeadlineSeconds?: number;
}

/** A durable lease's public metadata. The bearer secret is never retained or returned. */
/** Assignment execution. Its id remains fixed for evidence and late-call fencing. */
export interface Session {
  id: string;
  agentId?: string;
  agentSessionId?: string;
  contextEpoch?: number;
  projectId: string;
  actorId: string;
  source: DelegationSource;
  instanceId: string;
  expectedRevision: number;
  role: SessionRole;
  status: SessionStatus;
  runnerId: string;
  hostRef: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  hardDeadline: string;
  closedAt: string | null;
  closeReason: string | null;
  outcome?: SessionOutcome | null;
  /** Why a `preparation_deferred` close was put off; absent on every other outcome. */
  deferral?: SessionDeferral | null;
  /** Set by the sweep while the session is alive without progressing; cleared when it moves. */
  quietSince?: string | null;
  assignment: WorkflowAssignment;
  execution: WorkflowExecution;
  lease: WorkflowLease;
  workspace?: SessionWorkspaceRecord;
}
export interface SessionOffer {
  agentId?: string;
  instanceId: string;
  expectedRevision: number;
  runnerId: string;
  requestId: string;
  /** Caller-generated ms_ + 43 base64url characters. Only its digest is retained. */
  secret: string;
  hardDeadlineSeconds?: number;
}
export interface SessionControl {
  sessionId: string;
  runnerId: string;
}
/** Opaque server-owned preparation; constructing a matching object does not confer authority. */
export interface SessionInvocation {
  readonly caller: Caller;
  readonly tool: string;
  readonly input: Data;
}
/** Immutable execution attribution plus current attachment/final-observation availability. */
export interface SessionObservationProvenance {
  projectId: string;
  sessionId: string;
  actorId: string;
  /** Who delegated the work; the credential they held stays with the session's owner. */
  source: Pick<DelegationSource, 'kind' | 'actorId' | 'projectId'>;
  instanceId: string;
  revision: number;
  workflow: {
    name: string;
    version: number;
    state: string;
    policyHash: string;
    registrationId: string;
  };
  runnerId: string;
  hostRef: string | null;
  readOnly: boolean;
}
export interface SessionWorkspaceObservation {
  provenance: SessionObservationProvenance;
  workspaceMode: 'none' | 'ephemeral' | 'persistent';
  /** Whether the session can still deliver a workspace result. */
  live: boolean;
  workspace: SessionWorkspaceRecord | null;
  observedAt: string | null;
  eventId: number | null;
}
/** A server provider reserves one physical execution; no worker credential is created. */
export interface ServiceWorkInput {
  provider: string;
  operationId: string;
  executionEpoch: number;
  projectId: string;
  sponsors: string[];
  deadline: string;
}
export interface ServiceWork {
  admit(
    tx: Transaction,
    input: ServiceWorkInput,
  ): Promise<
    | { admitted: true; startedAt: string; deadline: string; settled: boolean }
    | {
        admitted: false;
        reason: 'dispatch_disabled' | 'capacity_full' | 'budget_exceeded' | 'usage_unavailable';
      }
  >;
  settle(
    tx: Transaction,
    input: ServiceWorkInput,
    outcome: 'completed' | 'failed' | 'expired' | 'cancelled',
  ): Promise<void>;
}

export interface Sessions {
  /** Server-only admission. Older providers may omit it; callers must then wait. */
  readonly serviceWork?: ServiceWork;
  /** Retained producers only; their delegation is historical, never current authority. */
  contributors(
    projectId: string,
    instanceId: string,
    beforeRevision: number | null,
    tx: Transaction,
  ): Promise<{ ref: string; actorId: string; authorityId: string }[]>;

  registerAgent(caller: Caller, input: AgentRegistration): Promise<Agent>;
  agents(caller: Caller): Promise<AgentStatus[]>;
  agent(caller: Caller, agentId: string): Promise<AgentStatus>;
  retireAgent(caller: Caller, agentId: string): Promise<Agent>;
  agentSelf(
    token: string,
  ): Promise<AgentStatus & { available: import('@merv/contracts').WorkflowDispatchCandidate[] }>;
  assignAgent(token: string, input: AgentAssignment): Promise<Session>;
  releaseAgentAssignment(token: string, executionId: string): Promise<Session>;
  resetAgentContext(token: string, reason: string): Promise<Agent>;

  /** Project-scoped historical metadata only; never activates, reconciles or impersonates its source. */
  workspaceObservation(
    caller: Caller,
    sessionId: string,
    tx?: Transaction,
  ): Promise<SessionWorkspaceObservation>;
  projectStatus(caller: Caller): Promise<SessionsProjectStatus>;
  /** The rail's one number, read on its own rather than by computing a whole status. */
  liveSessionCount(caller: Caller): Promise<number>;
  /**
   * The live sessions of a project whose execution policy holds a workspace on `driver`,
   * whoever offered them. It is scoped by the project rather than by a caller's delegation
   * source, because what a rebind has to refuse for is what the project holds, not what the
   * administrator asking for it happens to own.
   */
  holdingWorkspace(projectId: string, driver: string, tx: Transaction): Promise<string[]>;
  agentObservation(caller: Caller, agentId: string): Promise<AgentObservation>;
  setDispatch(caller: Caller, input: { enabled: boolean }): Promise<DispatchState>;
  halt(
    caller: Caller,
    input?: { sessionId?: string; reason?: string },
  ): Promise<{ halted: number }>;
  lease(
    caller: Caller,
    input: AutomaticLease,
  ): Promise<{ session: Session | null; reason: string }>;
  heartbeatRunner(caller: Caller, input: RunnerHeartbeat): Promise<RunnerPresence>;
  setRunnerSettings(
    caller: Caller,
    input: { runnerId: string; settings: RunnerSettings },
  ): Promise<RunnerPresence>;
  offer(caller: Caller, input: SessionOffer): Promise<Session>;
  list(caller: Caller): Promise<Session[]>;
  get(caller: Caller, sessionId: string): Promise<Session>;
  attach(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace?: SessionWorkspace },
  ): Promise<Session>;
  workspaceResult(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace: SessionWorkspace },
  ): Promise<Session>;
  heartbeat(caller: Caller, input: SessionControl): Promise<Session>;
  release(
    caller: Caller,
    input: SessionControl & {
      reason?: string;
      outcome?: SessionReleaseOutcome;
      /** Required with `preparation_deferred`, and refused with every other outcome. */
      deferral?: SessionDeferral;
      /** The runner's unverified self-report; the first one stored for a session is kept. */
      usage?: SessionUsageReport;
    },
  ): Promise<Session>;
  /** Open to leased workers too: a reflection lens reads what the cycle it reflects on cost. */
  usage(caller: Caller, input?: UsageQuery): Promise<UsageRollup>;
  /** Everything that stopped moving and why, for anyone who may read the project but no leased worker. */
  stuck(caller: Caller): Promise<StuckReport>;
  /** Only a project admin who is not a leased worker lets a held target be offered again. */
  releaseHold(
    caller: Caller,
    input: { instanceId: string; expectedRevision: number; reason: string; requestId: string },
  ): Promise<DispatchHold>;
  /** Only a project admin who is not a leased worker sets what pauses automatic dispatch. */
  setBudget(caller: Caller, input: SessionBudgetInput): Promise<BudgetStatus>;
  /** First MCP authentication activates the offered lease using metadata only. */
  authenticate(token: string): Promise<Caller>;
  /** Rechecks a worker credential without activating an offer. */
  describe(caller: Caller): Promise<Session>;
  allowsTool(caller: Caller, name: string): Promise<boolean>;
  validate(caller: Caller, tool: string, input: Data): Promise<void>;
  cancel(invocation: SessionInvocation): Promise<void>;
  prepare(caller: Caller, tool: string, input: Data): Promise<SessionInvocation>;
  run<T>(
    invocation: SessionInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T>;
  sweep(): Promise<void>;
}
export interface UsageQuery {
  instanceId?: string;
  /** Defaults to true: an instance is read with everything it depends on and fans out to. */
  includeDependencies?: boolean;
}
/** A dimension left out keeps its value and null clears it; the project is the scope when no instance is named. */
export interface SessionBudgetInput {
  instanceId?: string;
  maxWallMinutes?: number | null;
  maxCostUsd?: number | null;
  maxTokens?: number | null;
}
export interface SessionsConfig {
  /** Maximum simultaneous server executions in one project, across every provider. */
  serviceConcurrency?: number;
  sweepIntervalMs?: number;
  /** Failed launches of one instance revision after which automatic dispatch stops offering it. */
  maxLaunchFailures?: number;
  /** Seconds without a tool call before an active session is reported as quiet; nothing is closed for it. */
  idleNoticeSeconds?: number;
  /** Seconds a dispatchable target may wait on one revision before it is reported as quiet. */
  quietReadySeconds?: number;
  /** Seconds a live runner may repeat one refusal before it is reported as refusing. */
  refusalSeconds?: number;
}
declare module 'cordis' {
  interface Context {
    sessions: Sessions;
  }
}

export interface AutomaticLease {
  runnerId: string;
  requestId: string;
  secret: string;
  platform: SessionPlatform;
  hardDeadlineSeconds?: number;
}
