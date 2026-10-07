import type { NativeMcpConnection } from '@merv/contracts';
import type { AgentEvent, AgentStreamEvent } from '@merv/sessions/agent-stream';
export type { NativeMcpConnection } from '@merv/contracts';
import type { HuggingFaceAccess } from '@merv/secrets/types';
import type {
  Caller,
  Data,
  DelegationSource,
  RunnerPlatform,
  RunningMark,
  RunningNodes,
  RunningPanelPart,
  RunningSummary,
  SessionUsageReport,
  WorkflowAssignment,
  WorkflowExecution,
  WorkflowLease,
  SessionWorkspace,
  Transaction,
  WorkRoute,
} from '@merv/contracts';
import type {} from 'cordis';
import type {
  ManagedBoundSession,
  ManagedEnrollmentInput,
  ManagedRunnerBindingIdentity,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from './managed-types.js';
import type {
  BudgetStatus,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPresence,
  RunnerSettings,
  SessionDeferral,
  SessionMessage,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionStatus,
  SessionsProjectStatus,
  StuckReport,
  ProjectThreads,
  LiveFeedFrame,
  ThreadCalls,
  ThreadConversation,
  ThreadCounts,
  ThreadMessages,
  ThreadInquiry,
  ThreadQuestion,
  ThreadView,
  UsageRollup,
  SessionPlatform,
  SessionRole,
  SessionWorkspaceRecord,
} from './models.js';
export type {
  BudgetStatus,
  DispatchDecision,
  DispatchHold,
  DispatchState,
  RunnerHeartbeat,
  RunnerPresence,
  RunnerSettings,
  SessionDeferral,
  SessionOutcome,
  SessionReleaseOutcome,
  SessionPlatform,
  SessionRole,
  SessionStatus,
  SessionSummary,
  SessionWorkspaceRecord,
  SessionsProjectStatus,
  StuckItem,
  StuckKind,
  StuckReport,
  SessionMessage,
  ProjectThread,
  ProjectThreads,
  LiveFeedFrame,
  ThreadCounts,
  ThreadCall,
  ThreadCalls,
  ThreadConversation,
  ThreadMessages,
  InquiryStatus,
  MessageInquiry,
  ThreadInquiry,
  ThreadQuestion,
  ThreadView,
  UsageRollup,
  UsageTotals,
  VisitView,
} from './models.js';
export type {
  ManagedBoundSession,
  ManagedEnrollmentInput,
  ManagedRunnerBindingIdentity,
  ManagedRunnerInspection,
  ManagedRunnerValidator,
} from './managed-types.js';
export type { RunnerPlatform, SessionUsageReport, SessionWorkspace } from '@merv/contracts';

/** One visit of a thread. Its id remains fixed for evidence and late-call fencing. */
interface SessionVisit {
  id: string;
  /** The thread this session is a visit of: its `worker_sessions.thread_id`, never its JSON. */
  threadId: string;
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
  workspace?: SessionWorkspaceRecord;
  /** Set at the offer and frozen with it, where the session's conversation may be continued. */
  continuity?: SessionContinuity;
  /**
   * The model tokens this visit may spend, where it has a budget of its own: Fleet's model relay
   * charges each hosted call to it, and a machine of the owner's stops the visit once what its
   * agent printed of its spend passes it.
   */
  tokenBudget?: number;
}
/** A work visit: it holds the step's lease, under the execution its workflow froze for it. */
export interface WorkSession extends SessionVisit {
  kind: 'work';
  execution: WorkflowExecution;
  lease: WorkflowLease;
  inquiry?: undefined;
}
/**
 * An inquiry visit: a person's question to its thread's agent. It resumes the thread's
 * conversation (`continuity.resume`) read-only and never saves it back. It holds no lease on the
 * work and is bound to no workflow registration: its execution only names the step it asks of,
 * and runs read-only with no workspace and no tools.
 */
export interface InquirySession extends SessionVisit {
  kind: 'inquiry';
  execution: InquiryExecution;
  lease?: undefined;
  inquiry: SessionInquiryRef;
}
/** What an inquiry visit runs as: the step its conversation is of, and a read-only policy. */
export type InquiryExecution = Omit<
  WorkflowExecution,
  'policyHash' | 'registrationId' | 'references'
>;
/** A thread's visit, of its work or answering a question to it (`kind`). */
export type Session = WorkSession | InquirySession;
/** What an inquiry visit answers: its inquiry, the question's message and who asked. */
export interface SessionInquiryRef {
  id: string;
  messageId: string;
  askedBy: string;
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
  | 'threadId'
  | 'actorId'
  | 'instanceId'
  | 'expectedRevision'
  | 'role'
  | 'status'
  | 'createdAt'
  | 'closedAt'
>;
export interface SessionOffer {
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
/**
 * What a runner's tick reads of a session it supervises, once a second for the whole visit:
 * whether it still runs, until when, and how it ended. Never the assignment, which the attach
 * gave it once.
 */
export type SessionControlView = Pick<
  Session,
  | 'id'
  | 'projectId'
  | 'runnerId'
  | 'hostRef'
  | 'status'
  | 'expiresAt'
  | 'hardDeadline'
  | 'closeReason'
  | 'outcome'
>;
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
/**
 * A message to a thread (`threadId`). For one release a `sessionId` addresses that session's
 * thread instead; exactly one of them.
 */
export interface SessionMessageInput {
  sessionId?: string;
  threadId?: string;
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

/** What a work visit's launch is given; an inquiry visit reads the project through Merv alone. */
export type LaunchConnectionsProvider = (
  session: Readonly<WorkSession>,
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
  /** Project dispatch: its switch, budgets, holds, runners and the automatic leases they take. */
  readonly dispatch: SessionDispatchControls;
  /** The Running page's Sessions lane. */
  readonly running: SessionRunningReads;
  /** Fleet's managed runners: their enrollment, credentials and model authority. */
  readonly managed: ManagedRunners;
  /** What each thread's agent called, as metadata only. */
  readonly observations: {
    /** A thread's newest Merv calls and their totals, for anyone who may read the project. */
    calls(caller: Caller, threadId: string): Promise<ThreadCalls>;
  };
  /** The workers of each stage: continuity, and the threads a work item's page reads. */
  readonly threads: {
    /** Keys `workflow`'s sessions for continuity, one provider per workflow, until disposed. */
    register(workflow: string, provider: ContinuityProvider): () => void;
    /**
     * Every thread with a visit on the work item, or on any of up to 100 of them, oldest first,
     * for anyone who may read each; never a worker.
     */
    list(caller: Caller, instanceIds: string | readonly string[]): Promise<ThreadView[]>;
    /**
     * The project's threads that want attention, then its newest others, older than `before`, a
     * page at a time.
     */
    project(caller: Caller, before?: string): Promise<ProjectThreads>;
    /** How many of the project's threads are live and how many ask their owner. */
    counts(caller: Caller): Promise<ThreadCounts>;
    /** An operator's read of what the thread's agent did, visit by visit. */
    conversation(caller: Caller, threadId: string): Promise<ThreadConversation>;
  };
  /** Retained producers only; their delegation is historical, never current authority. */
  contributors(
    projectId: string,
    instanceId: string,
    beforeRevision: number | null,
    tx: Transaction,
  ): Promise<{ ref: string; actorId: string; authorityId: string }[]>;

  /** Project-scoped historical metadata only; never activates, reconciles or impersonates its source. */
  workspaceObservation(
    caller: Caller,
    sessionId: string,
    tx?: Transaction,
  ): Promise<SessionWorkspaceObservation>;
  /** workspaceObservation() for several sessions; one the project does not hold is left out. */
  workspaceObservations(
    caller: Caller,
    sessionIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, SessionWorkspaceObservation>>;
  /**
   * The live sessions of a project whose execution policy holds a workspace on `driver`,
   * whoever offered them. It is scoped by the project rather than by a caller's delegation
   * source, because what a rebind has to refuse for is what the project holds, not what the
   * administrator asking for it happens to own.
   */
  holdingWorkspace(projectId: string, driver: string, tx: Transaction): Promise<string[]>;
  /** Operator messages to a live session, read and acknowledged by its worker. */
  readonly messaging: SessionMessaging;
  /** A person's questions to any thread's agent, each answered by a read-only inquiry visit. */
  readonly inquiries: SessionInquiries;
  findSession(
    caller: Caller,
    instanceId: string,
  ): Promise<{ current: SessionLookup | null; latest: SessionLookup | null }>;
  offer(caller: Caller, input: SessionOffer): Promise<WorkSession>;
  list(caller: Caller): Promise<Session[]>;
  get(caller: Caller, sessionId: string): Promise<Session>;
  /** The session's control fields alone, read without its lease check: the sweep records a
   *  closure, and this read reports it. */
  control(caller: Caller, sessionId: string): Promise<SessionControlView>;
  attach(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace?: SessionWorkspace },
  ): Promise<Session>;
  /** Private hosted supervisor control; never available to agents or account APIs. */
  huggingfaceAccess(
    caller: Caller,
    input: SessionControl & { hostRef: string },
  ): Promise<{ access: HuggingFaceAccess | null }>;
  workspaceResult(
    caller: Caller,
    input: SessionControl & { hostRef: string; workspace: SessionWorkspace },
  ): Promise<Session>;
  /** Runner-only, live or closed session. Backend only: nothing reads a transcript back. */
  transcript(
    caller: Caller,
    input: SessionControl & SessionTranscriptDeclaration,
  ): Promise<SessionTranscript>;
  /** Agents' live streams: what the runner sends, and what the events route reads. */
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
  /** First MCP authentication activates the offered lease using metadata only. */
  authenticate(token: string): Promise<Caller>;
  /** The caller's own session, rechecking its credential without activating an offer. */
  session(caller: Caller, tx?: Transaction): Promise<Session>;
  /** The tool policy the registry admits each leased worker's MCP call through. */
  readonly invocations: SessionInvocationPolicy;
  sweep(): Promise<void>;
}
/** Sessions' project dispatch; every read and control but a runner's refuses a managed runner. */
export interface SessionDispatchControls {
  /** With `report`, `stuck` carries the whole of what `stuck` would read, at the same moment. */
  projectStatus(caller: Caller, report?: boolean): Promise<SessionsProjectStatus>;
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
  /** Everything that stopped moving and why, for anyone who may read the project but no leased worker. */
  stuck(caller: Caller): Promise<StuckReport>;
  /** Only a project admin who is not a leased worker lets a held target be offered again. */
  releaseHold(
    caller: Caller,
    input: { instanceId: string; expectedRevision: number; reason: string; requestId: string },
  ): Promise<DispatchHold>;
  /** Only a project admin who is not a leased worker sets what pauses automatic dispatch. */
  setBudget(caller: Caller, input: SessionBudgetInput): Promise<BudgetStatus>;
}
export interface SessionRunningReads {
  /**
   * The Running page's Sessions lane: a node for every offered or active lease of the project,
   * whoever offered it, with where it runs and the work it is on. Read-only, never for a
   * leased worker or a managed runner, like every read here.
   */
  nodes(caller: Caller): Promise<RunningNodes>;
  /**
   * What dispatch holds back, as marks on that work, and the lane's own line about dispatch
   * and machines. A narrow reading of the stuck rules, never the whole analysis: a hold is
   * marked for every reader, and what the queue holds is told to an operator only.
   */
  marks(caller: Caller): Promise<{ marks: RunningMark[]; summary: RunningSummary }>;
  /** A lease's sidebar, any status; null for a lease the project does not hold. */
  panel(caller: Caller, sessionId: string, route?: WorkRoute): Promise<RunningPanelPart | null>;
}
export interface ManagedRunners {
  registerValidator(validator: ManagedRunnerValidator): () => void;
  ensure(input: ManagedEnrollmentInput): Promise<{ enrollmentToken: string }>;
  /** `projectId`: the runner's selected project, refused unless it is the binding's. */
  enroll(token: string, input: unknown, projectId?: unknown): Promise<{ controlToken: string }>;
  authenticate(token: string): Promise<Caller>;
  /** Server-only: the session a managed runner holds, live or handed off, by bearer or session
   *  id, from which Fleet grants hosted Codex the model. */
  boundSession(tokenOrSessionId: string): Promise<ManagedBoundSession>;
  /** Server-only allocation observation for Fleet; never an agent endpoint or tool. */
  inspect(
    allocationId: string,
    epoch: number,
    tx?: Transaction,
  ): Promise<ManagedRunnerInspection | null>;
}
export interface SessionMessaging {
  message(caller: Caller, input: SessionMessageInput): Promise<SessionMessage>;
  messages(caller: Caller, sessionId?: string): Promise<SessionMessage[]>;
  /** A thread's messages and questions: anyone who may read its work, never a leased worker. */
  thread(caller: Caller, threadId: string): Promise<ThreadMessages>;
  /** The worker ends its visit asking its owner; the work waits for the answer. */
  ask(caller: Caller, input: { question: string }): Promise<ThreadQuestion>;
  acknowledgeMessage(
    caller: Caller,
    input: { messageId: string; reply?: string; requestId: string },
  ): Promise<SessionMessage>;
  /** Refuses while a queued message waits for the worker's acknowledgement. */
  requireMessagesAcknowledged(sessionId: string, tx: Transaction): Promise<void>;
}
/** The input of `session.ask_thread`: one question to one thread's agent. */
export interface ThreadInquiryInput {
  threadId: string;
  body: string;
  requestId: string;
}
export interface SessionInquiries {
  /**
   * Whoever may write in the project asks a thread's agent: an inquiry visit resumes its saved
   * conversation read-only, and its reply lands on the question's message in the thread.
   */
  ask(caller: Caller, input: ThreadInquiryInput): Promise<ThreadInquiry>;
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
  /**
   * Each target, and since when its revision has stood: what a renter counts its tries from.
   * `inquiry` marks one wanted only for a question to an agent of it, a short visit that holds no
   * lease, so a machine of the item that is busy with another visit cannot take it.
   */
  candidates: { instanceId: string; expectedRevision: number; since: string; inquiry?: true }[];
}

/** What the events route reads of agents' live streams: operator authority, events, wakes. */
export interface SessionStreamReads {
  /** Runner-only, live or just closed: one batch of what its agent printed (SessionStreamBatch). */
  append(caller: Caller, input: unknown): Promise<{ until: number; seq: number }>;
  /** An operator's read of the project's agents' streams; refuses everyone else. */
  authorize(caller: Caller): Promise<void>;
  /** Whether a session of the project may still grow, without reading authority again. */
  growing(sessionId: string, projectId: string): Promise<boolean>;
  after(sessionId: string, after: number, limit: number): Promise<AgentStreamEvent[]>;
  snapshot(sessionId: string): Promise<AgentStreamEvent[]>;
  subscribe(sessionId: string, wake: () => void): () => void;
  /** `wake` runs on each batch this process takes for any session of the project. */
  subscribeFeed(projectId: string, wake: () => void): () => void;
  /**
   * The feed's next frame after what `held` says the page holds (each live visit's newest seq),
   * which it updates; null when nothing changed.
   */
  feed(projectId: string, held: Map<string, number>): Promise<LiveFeedFrame | null>;
}

/** What a runner sends of its agent's output: the events read from the log's bytes [from, to). */
export interface SessionStreamBatch {
  from: number;
  to: number;
  events: AgentEvent[];
}
