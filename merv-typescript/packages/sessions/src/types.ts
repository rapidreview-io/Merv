import type {
  Caller,
  Data,
  DelegationSource,
  WorkflowAssignment,
  WorkflowExecution,
  WorkflowLease,
  SessionWorkspace,
  SessionWorkspaceRecord,
  Transaction,
} from '@merv/contracts';
import type {} from 'cordis';
export type { SessionWorkspace, SessionWorkspaceRecord } from '@merv/contracts';

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

export type SessionOutcome =
  | 'released'
  | 'expired'
  | 'halted'
  | 'completed'
  | 'host_failed'
  | 'launch_failed'
  | 'workspace_failed'
  | 'crash_loop';
export type SessionStatus = 'offered' | 'active' | 'released' | 'expired';
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
  role: 'producer' | 'reviewer' | 'reader';
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
  source: DelegationSource;
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
  workspace: SessionWorkspaceRecord | null;
  observedAt: string | null;
  eventId: number | null;
}
export interface Sessions {
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
      outcome?: 'completed' | 'host_failed' | 'launch_failed' | 'workspace_failed' | 'crash_loop';
    },
  ): Promise<Session>;
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
export interface SessionsConfig {
  sweepIntervalMs?: number;
}
declare module 'cordis' {
  interface Context {
    sessions: Sessions;
  }
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
export interface RunnerPresence extends RunnerHeartbeat {
  id: string;
  lastSeenAt: string;
  live: boolean;
  desiredVersion: number;
  desiredSettings: RunnerSettings;
}
export interface AutomaticLease {
  runnerId: string;
  requestId: string;
  secret: string;
  platform: Pick<RunnerPlatform, 'name' | 'harness' | 'model' | 'effort'>;
  hardDeadlineSeconds?: number;
}
export interface SessionSummary {
  agentId?: string;
  agentSessionId?: string;
  actorId?: string;
  id: string;
  instanceId: string;
  expectedRevision: number;
  role: Session['role'];
  status: SessionStatus;
  label: string;
  runnerRef: string | null;
  hostRef: string | null;
  platform: AutomaticLease['platform'] | null;
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
  status: Agent['status'];
  contextEpoch: number;
  persistent: boolean;
  currentExecutionId: string | null;
  currentAssignment: { label: string; role: Session['role'] } | null;
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
    role: Session['role'];
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
export interface SessionsProjectStatus {
  agents?: AgentSummary[];
  liveSessionCount: number;
  sessionTotal: number;
  canManage: boolean;
  dispatch: DispatchState;
  runners: RunnerPresence[];
  sessions: SessionSummary[];
  /** Candidates currently admissible for the authenticated caller. */
  queue: import('@merv/contracts').WorkflowDispatchCandidate[];
  queueTotal: number;
}
