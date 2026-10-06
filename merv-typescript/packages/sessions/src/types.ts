import type { AgentEvent, AgentStreamEvent, NativeMcpConnection } from '@merv/contracts';
export type { NativeMcpConnection } from '@merv/contracts';
import type { HuggingFaceAccess } from '@merv/secrets/types';
import type {
  AgentObservation,
  BudgetStatus,
  Caller,
  Data,
  DelegationSource,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPlatform,
  RunnerPresence,
  RunnerSettings,
  RunningMark,
  RunningNodes,
  RunningPanelPart,
  RunningSection,
  RunningSummary,
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
  WorkRoute,
} from '@merv/contracts';
import type {} from 'cordis';
import type {
  ManagedEnrollmentInput,
  ManagedModelGrant,
  ManagedRunnerBindingIdentity,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from './managed-types.js';
export type {
  ManagedEnrollmentInput,
  ManagedModelGrant,
  ManagedRunnerBindingIdentity,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from './managed-types.js';
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
  assignment: WorkflowAssignment;
  execution: WorkflowExecution;
  lease: WorkflowLease;
  workspace?: SessionWorkspaceRecord;
  /** Set at the offer and frozen with it, where the session's conversation may be continued. */
  continuity?: SessionContinuity;
}
/** The conversation a session continues: the one its key's latest closed session kept. */
export interface SessionResume {
  sessionId: string;
  harness: 'claude' | 'codex';
  /** Claude's session id or Codex's thread id. */
  conversationId: string;
  sha256: string;
  size: number;
}
/** Which earlier work a session continues: an opaque key, and the conversation it resumes. */
export interface SessionContinuity {
  key: string;
  resume?: SessionResume;
}
/** What a continuity provider is shown of the work a session is offered. */
export interface ContinuityUnit {
  instanceId: string;
  workflow: string;
  state: string;
  data: Data;
  role: SessionRole;
}
/** A workflow's continuity key for the work, or null where no session continues another. */
export type ContinuityProvider = (unit: Readonly<ContinuityUnit>) => string | null;
/** Project-visible address for a worker, without its delegation or frozen assignment. */
export type SessionLookup = Pick<
  Session,
  | 'id'
  | 'agentId'
  | 'actorId'
  | 'instanceId'
  | 'expectedRevision'
  | 'role'
  | 'status'
  | 'createdAt'
  | 'closedAt'
>;
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
/** What a runner says about the transcript file it holds; Sessions derives every other column. */
export interface SessionTranscriptDeclaration {
  hostRef: string;
  sha256: string;
  size: number;
  /** The log's own size before truncation. */
  logBytes: number;
  truncated: boolean;
  /** Ready to deliver: Sessions HEADs the store and records the upload once the bytes are there, else signs one PUT. */
  deliver?: true;
}
/** What a runner says about the conversation file it kept: the harness's own, redacted. */
export interface SessionConversationDeclaration {
  hostRef: string;
  harness: 'claude' | 'codex';
  conversationId: string;
  sha256: string;
  size: number;
  deliver?: true;
}
export interface SessionTranscript {
  sessionId: string;
  sha256: string;
  size: number;
  uploadedAt: string | null;
  /** On a delivery with nothing stored: the store's signed PUT (1 h, exact size, x-amz-checksum-sha256, If-None-Match:*). */
  upload?: { url: string; headers: Record<string, string>; expiresAt: string };
}
export interface SessionMessage {
  id: string;
  sessionId: string;
  instanceId: string;
  expectedRevision: number;
  senderActorId: string;
  body: string;
  createdAt: string;
  acknowledgedAt: string | null;
  reply: string | null;
}
export interface SessionMessageInput {
  sessionId: string;
  body: string;
  requestId: string;
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

/** Another plugin's part of `system.status`: `project` is the project view's status, null in a
 * leased worker's view. An undefined answer leaves the key out; a failure fails the read. */
export type StatusSection = (
  caller: Caller,
  project: SessionsProjectStatus | null,
) => Promise<unknown>;

export type LaunchConnectionsProvider = (
  session: Readonly<Session>,
) => Promise<NativeMcpConnection[]>;

export interface Sessions {
  /** One private launch provider; issuance runs outside state transactions. */
  registerLaunchConnections(provider: LaunchConnectionsProvider): () => void;
  launchConnections(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ connections: NativeMcpConnection[] }>;

  /** Server-only admission. */
  readonly serviceWork: ServiceWork;
  /** Adds a section to `system.status` under `key`, one plugin per key, until disposed. */
  contributeStatus(key: string, section: StatusSection): () => void;
  /** Every contributed section, read in parallel and keyed as contributed. */
  statusSections(
    caller: Caller,
    project: SessionsProjectStatus | null,
  ): Promise<Record<string, unknown>>;
  registerManagedValidator(validator: ManagedRunnerValidator): () => void;
  ensureManagedEnrollment(input: ManagedEnrollmentInput): Promise<{ enrollmentToken: string }>;
  /** `projectId`: the runner's selected project, refused unless it is the binding's. */
  enrollManaged(
    token: string,
    input: unknown,
    projectId?: unknown,
  ): Promise<{ controlToken: string }>;
  authenticateManaged(token: string): Promise<Caller>;
  /** Server-only: a hosted session's model authority for Main's relay, by bearer or session id. */
  managedModelGrant(tokenOrSessionId: string): Promise<ManagedModelGrant>;
  /** Server-only allocation observation for Fleet; never an agent endpoint or tool. */
  inspectManaged(
    allocationId: string,
    epoch: number,
    tx?: Transaction,
  ): Promise<ManagedRunnerInspection | null>;
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
  /** Owner-authorized replacement of a continuing agent's 30-day credential. */
  rotateAgent(
    caller: Caller,
    agentId: string,
  ): Promise<{ agent: Agent; token: string; expiresAt: string }>;
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
  /** With `report`, `stuck` carries the whole of what `stuck` would read, at the same moment. */
  projectStatus(caller: Caller, report?: boolean): Promise<SessionsProjectStatus>;
  /**
   * The Running page's Sessions lane: a node for every offered or active lease of the project,
   * whoever offered it, with where it runs and the work it is on. Read-only, never for a
   * leased worker or a managed runner, like every read below.
   */
  running(caller: Caller): Promise<RunningNodes>;
  /**
   * What dispatch holds back, as marks on that work, and the lane's own line about dispatch
   * and machines. A narrow reading of the stuck rules, never the whole analysis: a hold is
   * marked for every reader, and what the queue holds is told to an operator only.
   */
  runningMarks(caller: Caller): Promise<{ marks: RunningMark[]; summary: RunningSummary }>;
  /** A lease's sidebar, any status; null for a lease the project does not hold. */
  runningPanel(
    caller: Caller,
    sessionId: string,
    route?: WorkRoute,
  ): Promise<RunningPanelPart | null>;
  /** The Sessions section of the given work's sidebar: the live leases on those instances. */
  runningWork(caller: Caller, instanceIds: readonly string[]): Promise<RunningSection[]>;
  /**
   * The live sessions of a project whose execution policy holds a workspace on `driver`,
   * whoever offered them. It is scoped by the project rather than by a caller's delegation
   * source, because what a rebind has to refuse for is what the project holds, not what the
   * administrator asking for it happens to own.
   */
  holdingWorkspace(projectId: string, driver: string, tx: Transaction): Promise<string[]>;
  agentObservation(caller: Caller, agentId: string): Promise<AgentObservation>;
  /** Operator messages to a live session, read and acknowledged by its worker. */
  readonly messaging: SessionMessaging;
  findSession(
    caller: Caller,
    instanceId: string,
  ): Promise<{ current: SessionLookup | null; latest: SessionLookup | null }>;
  setDispatch(
    caller: Caller,
    input: Partial<Pick<DispatchState, 'enabled' | 'ownMachines'>>,
  ): Promise<DispatchState>;
  halt(
    caller: Caller,
    input?: { sessionId?: string; reason?: string },
  ): Promise<{ halted: number }>;
  lease(
    caller: Caller,
    input: AutomaticLease,
  ): Promise<{ session: Session | null; reason: string }>;
  /** Server-only: every project with dispatch on Fleet's machines, as its owner. The billing
   * rule: Fleet acts as, and charges the person-day budget of, the project's owner
   * (`Scope.projectOwners`), never whoever switched dispatch; a project without one is not
   * served, and its queued work shows `no_live_runner`. */
  servedSources(): Promise<{ projectId: string; source: DelegationSource }[]>;
  /** Advisory, source-scoped automatic work for a prospective profile; no runner is required. */
  dispatchDemand(caller: Caller, input: DispatchDemandInput): Promise<DispatchDemand>;
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
  /** Private hosted supervisor control; never available to agents or account APIs. */
  huggingfaceAccess(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ access: HuggingFaceAccess | null }>;
  huggingface(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ hfToken: string | null }>;
  workspaceResult(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace: SessionWorkspace },
  ): Promise<Session>;
  /** Runner-only, live or closed session. Backend only: nothing reads a transcript back. */
  transcript(
    caller: Caller,
    input: SessionControl & SessionTranscriptDeclaration,
  ): Promise<SessionTranscript>;
  /** Runner-only, live or just closed: one batch of what its agent printed (SessionStreamBatch). */
  stream(caller: Caller, input: unknown): Promise<{ until: number; seq: number }>;
  /** What the events route reads of agents' live streams: operator authority, events, wakes. */
  readonly streams: SessionStreamReads;
  /** Runner-only: the conversation the session kept, declared and delivered as a transcript is. */
  conversation(
    caller: Caller,
    input: SessionControl & SessionConversationDeclaration,
  ): Promise<SessionTranscript>;
  /** Runner-only, live session: a signed GET of the conversation the session resumes. */
  resume(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ url: string; expiresAt: string }>;
  /** Keys `workflow`'s sessions for continuity, one provider per workflow, until disposed. */
  registerContinuity(workflow: string, provider: ContinuityProvider): () => void;
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
  /** Open to leased workers too: a worker may read what the work it is on cost. */
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
  /** The caller's own session, rechecking its credential without activating an offer. */
  session(caller: Caller, tx?: Transaction): Promise<Session>;
  /** The tool policy the registry admits each leased worker's MCP call through. */
  readonly invocations: SessionInvocationPolicy;
  sweep(): Promise<void>;
}
export interface SessionMessaging {
  message(caller: Caller, input: SessionMessageInput): Promise<SessionMessage>;
  messages(caller: Caller, sessionId?: string): Promise<SessionMessage[]>;
  acknowledgeMessage(
    caller: Caller,
    input: { messageId: string; reply?: string; requestId: string },
  ): Promise<SessionMessage>;
  /** Refuses while a queued message waits for the worker's acknowledgement. */
  requireMessagesAcknowledged(sessionId: string, tx: Transaction): Promise<void>;
}
export interface SessionInvocationPolicy {
  readonly instructions: string;
  allowsTool(caller: Caller, name: string): Promise<boolean>;
  validate(caller: Caller, tool: string, input: Data): Promise<void>;
  cancel(invocation: SessionInvocation): Promise<void>;
  prepare(caller: Caller, tool: string, input: Data): Promise<SessionInvocation>;
  run<T>(
    invocation: SessionInvocation,
    handler: (caller: Caller, input: Data) => T | Promise<T>,
  ): Promise<T>;
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
  maxTokens?: number | null;
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
export interface DispatchDemandInput {
  platform: RunnerPlatform;
  capabilities?: string[];
}
export interface DispatchDemand {
  candidates: { instanceId: string; expectedRevision: number }[];
}

/** What the events route reads of agents' live streams: operator authority, events, wakes. */
export interface SessionStreamReads {
  authorize(caller: Caller, sessionId: string): Promise<{ growing: boolean }>;
  /** Whether a session `authorize` admitted may still grow, without reading authority again. */
  growing(sessionId: string, projectId: string): Promise<boolean>;
  after(sessionId: string, after: number, limit: number): Promise<AgentStreamEvent[]>;
  snapshot(sessionId: string): Promise<AgentStreamEvent[]>;
  subscribe(sessionId: string, wake: () => void): () => void;
}

/** What a runner sends of its agent's output: the events read from the log's bytes [from, to). */
export interface SessionStreamBatch {
  from: number;
  to: number;
  events: AgentEvent[];
}
