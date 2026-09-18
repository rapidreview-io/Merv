export { mapAsync, filterAsync, someAsync, everyAsync, findAsync, forEachAsync } from './async.js';
import type { ToolPolicy } from './tool-policy.js';
export type {
  ToolPolicy,
  ToolGrant,
  SessionToolPolicy,
  SessionToolInvocation,
} from './tool-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import 'cordis';

export type { Json, Data } from './data.js';
export { sessionWorkspaceSchema } from './workspace.js';
export { codePublicationIdSchema, codePublicationMergeSchema } from './code-publications.js';
export type {
  CodePublication,
  CodePublicationMerge,
  CodePublicationApi,
} from './code-publications.js';
export { codeTransportInputSchema, codeTransportGrantSchema } from './code-transport.js';
export type { CodeTransportInput, CodeTransportGrant } from './code-transport.js';
export type {
  UiManifest,
  UiManifestRow,
  UiManifestGroup,
  UiCollectionSpec,
  UiColumn,
  UiPhrasePart,
  UiLivenessSpec,
  UiRecordSpec,
  UiAction,
  UiSection,
  UiDetail,
} from './ui-manifest.js';
export type * from './sessions-models.js';
export {
  codeCommitInputSchema,
  codeCommandControlSchema,
  codeCommitCommandSchema,
  codeCommitReceiptSchema,
  codeCommandCompletionSchema,
  codeCommandRecordSchema,
} from './code.js';
export type {
  CodeCommitInput,
  CodeCommitCommand,
  CodeCommitReceipt,
  CodeCommandRecord,
  CodeCommandControl,
  CodeCommandCompletion,
} from './code.js';
import type { Data, Json } from './data.js';
import type {
  Role,
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
  WorkflowWorkspacePolicy,
} from './workflow-models.js';
export type {
  Role,
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowSnapshot,
  WorkflowWorkspaceBase,
  WorkflowWorkspacePolicy,
} from './workflow-models.js';
export type {
  WorkflowReference,
  WorkflowBlocker,
  WorkflowActionStatus,
  WorkflowDecision,
  WorkflowOverview,
  WorkflowDependency,
  WorkflowWorkStart,
  ProcessTraversal,
  ProcessNode,
  ProcessEdge,
  ProcessDependencyEdge,
  ProcessGraph,
} from './workflow-guidance.js';
import type {
  WorkflowReference,
  WorkflowDecision,
  WorkflowOverview,
  WorkflowDependency,
  WorkflowWorkStart,
  ProcessGraph,
} from './workflow-guidance.js';
export class MervError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'MervError';
  }
}
export function check(
  condition: unknown,
  code: string,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new MervError(code, message, status);
}
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const now = () => new Date().toISOString();
/** Input that can be stored as written: every text well-formed Unicode, nesting shallow. */
export function sound<T>(value: T, depth = 0): T {
  if (typeof value === 'string')
    check(!/\p{Surrogate}/u.test(value), 'invalid_input', 'Text must be well-formed Unicode');
  else if (value && typeof value === 'object') {
    check(depth < 64, 'invalid_input', 'Input nests too deeply');
    for (const item of Array.isArray(value) ? value : Object.values(value)) sound(item, depth + 1);
  }
  return value;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}
export const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export type SqlValue = string | number | bigint | null | Uint8Array;
/** Await initialization before publishing a storage-backed service. */
export async function createService<T extends { initialize(): Promise<void> }>(
  service: T,
): Promise<T> {
  await service.initialize();
  return service;
}
export interface Sql {
  readonly dialect: 'sqlite' | 'postgres';
  run(
    sql: string,
    ...params: SqlValue[]
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}
export interface Transaction extends Sql {
  readonly transactionId: symbol;
}
export interface Migration {
  /** Rebuild tables transactionally, checking all foreign keys before commit. */
  rebuild?: boolean;
  version: number;
  sql: string;
  /** Native PostgreSQL migration; SQLite history remains unchanged. */
  postgres?: string;
}
export interface StoredEvent {
  id: number;
  projectId: string;
  actorId: string;
  type: string;
  subjectId: string;
  data: Data;
  createdAt: string;
}
export interface State {
  readonly dialect: 'sqlite' | 'postgres';
  transaction<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T>;
  read<T>(fn: (sql: Sql) => T | Promise<T>): Promise<T>;
  /** A read-only snapshot scope: nested component transactions never take the writer lock. */
  snapshot<T>(fn: () => T | Promise<T>): Promise<T>;
  assertTransaction(tx: Transaction): void;
  migrate(component: string, migrations: Migration[]): Promise<void>;
  appendEvent(tx: Transaction, event: Omit<StoredEvent, 'id' | 'createdAt'>): Promise<StoredEvent>;
  events(projectId: string, after?: number): Promise<StoredEvent[]>;
  eventBatch(after: number, limit: number, tx?: Transaction): Promise<StoredEvent[]>;
  eventHead(tx?: Transaction): Promise<number>;
  onEventsCommitted(listener: () => void): () => void;
}
export interface EventConsumer {
  id: string;
  types: string[];
  from: 'beginning' | 'now';
  handle(event: StoredEvent, tx: Transaction): void | Promise<void>;
}
export interface ConsumerStatus {
  id: string;
  cursor: number;
  active: boolean;
  attempts: number;
  error: string | null;
  retryAt: number;
}
export interface DomainEvents {
  subscribe(consumer: EventConsumer): Promise<() => void | Promise<void>>;
  drain(): Promise<void>;
  status(): Promise<ConsumerStatus[]>;
}
export async function inTransaction<T>(
  state: State,
  tx: Transaction | undefined,
  fn: (tx: Transaction) => T | Promise<T>,
): Promise<T> {
  if (tx) {
    state.assertTransaction(tx);
    return await fn(tx);
  }
  return await state.transaction(fn);
}
export interface Blobs {
  put(namespace: string, bytes: Uint8Array): Promise<{ hash: string; size: number }>;
  get(namespace: string, hash: string): Promise<Buffer>;
  /** Optional direct transfer capability; never expands the inline content limit. */
  download?(
    namespace: string,
    hash: string,
    expectedSize: number,
  ): Promise<{ url: string; expiresAt: string }>;
}
export type Permission = 'read' | 'write' | 'review' | 'admin';
export interface Caller {
  actorId: string;
  projectId: string;
  /** Transport-authenticated credential identity; never accepted from tool arguments. */
  credentialId?: string;
  /** Verified human authority attached by the transport, never by tool arguments. */
  human?: {
    issuer: string;
    subject: string;
    expiresAt: string;
    membershipId: string;
  };
  /** User-owned machine authority, distinct from human login and actor credentials. */
  key?: { id: string; membershipId: string };
  /** Server-authenticated leased worker. Invocation ids are minted by Sessions, never tools. */
  session?: { id: string; agentSessionId?: string; invocationId?: string };
}
/** Immutable source of a lease; a shared login's short JWT lifetime is not the user lifetime. */
export type DelegationSource = { actorId: string; projectId: string } & (
  | { kind: 'actor'; credentialId: string; expiresAt: string | null }
  | { kind: 'human'; issuer: string; subject: string; membershipId: string }
  | { kind: 'key'; keyId: string; membershipId: string; expiresAt: string | null }
);
/** One installed session manager owns the authority of credentialless worker actors. */
export interface SessionAuthority {
  require(caller: Caller, tx: Transaction): Promise<DelegationSource>;
}
/** Audit provenance only. Authority is still rechecked by Scope inside the operation. */
export function eventSource(caller: Caller): Data {
  return caller.session
    ? { source: { kind: 'session', sessionId: caller.session.id } }
    : caller.key
      ? {
          source: { kind: 'user-key', keyId: caller.key.id, membershipId: caller.key.membershipId },
        }
      : {};
}
export interface Actor {
  id: string;
  projectId: string;
  name: string;
  role: Role;
  active: boolean;
  /** Present only for the persistent actor representing a project member. */
  user?: { issuer: string; subject: string };
  /** Credentialless actor owned by an agent session (or a historical assignment). */
  agentId?: string;
  sessionId?: string;
}
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  /** Current Scope reads always include these; optional for legacy frozen snapshots. */
  summary?: string;
  contextRevision?: number;
}
export interface ProjectContextUpdate {
  summary: string;
  /** Exact previously observed Introduction; whitespace is significant. */
  expectedSummary: string;
  requestId: string;
}
/** Project-bound actor credentials are distinct from human login and future worker leases. */
export interface ActorCredential {
  id: string;
  actorId: string;
  projectId: string;
  kind: 'actor';
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface AuthenticatedActor extends Actor {
  credential: ActorCredential;
}
export interface IssuedActorCredential {
  actor: Actor;
  credential: ActorCredential;
  /** Returned once; only its digest is stored. */
  token: string;
}
export interface Credentials extends IssuedActorCredential {
  project: Project;
}
/** Verified by an identity provider outside any State transaction. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  expiresAt: string;
}
export interface SharedUser {
  issuer: string;
  subject: string;
  createdAt: string;
}
export interface HumanPrincipal {
  kind: 'user';
  user: SharedUser;
  expiresAt: string;
}
/** A machine bearer owned by a verified user; projectId is its immutable issuance project. */
export interface UserKey {
  id: string;
  owner: { issuer: string; subject: string };
  projectId: string;
  grantScope: 'project' | 'account';
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  previousId: string | null;
}
export interface IssuedUserKey {
  key: UserKey;
  /** Returned once; only its digest is stored. */
  token: string;
}
export type Principal =
  HumanPrincipal | { kind: 'actor'; actor: AuthenticatedActor } | { kind: 'key'; key: UserKey };
export interface ProjectMembership {
  id: string;
  projectId: string;
  issuer: string;
  subject: string;
  actorId: string;
  role: Role;
  active: boolean;
  createdAt: string;
  revokedAt: string | null;
}
export interface Scope {
  readonly toolPolicy: ToolPolicy;
  delegationSource(caller: Caller, tx?: Transaction): Promise<DelegationSource>;
  requireDelegation(
    source: DelegationSource,
    permission: Permission,
    tx?: Transaction,
  ): Promise<Actor>;
  registerSessionAuthority(authority: SessionAuthority): () => void;
  createSessionActor(
    source: DelegationSource,
    input: { sessionId: string; agentId?: string; role: Exclude<Role, 'operator'>; name: string },
    tx: Transaction,
  ): Promise<Actor>;
  setAgentRole(
    source: DelegationSource,
    actorId: string,
    role: Exclude<Role, 'operator'>,
    tx: Transaction,
  ): Promise<void>;
  retireSessionActor(actorId: string, reason: string, tx: Transaction): Promise<void>;
  /** Verified delegation owner for scoped remote grants; does not change request attribution. */
  authorityActor(caller: Caller, tx?: Transaction): Promise<Actor>;
  bootstrap(input: { projectName: string; actorName: string }): Promise<Credentials>;
  authenticate(token: string): Promise<AuthenticatedActor>;
  authenticateKey(token: string): Promise<UserKey>;
  /** Recognize any issued local digest, including revoked/expired credentials. */
  recognizesCredential(token: string): Promise<boolean>;
  /** Verified owners can inspect/revoke their own keys even after losing project membership. */
  keys(principal: Principal, projectId?: string): Promise<UserKey[]>;
  createKey(
    principal: Principal,
    input: {
      projectId: string;
      grantScope?: 'project' | 'account';
      label?: string | null;
      expiresAt?: string | null;
    },
  ): Promise<IssuedUserKey>;
  /** Rotation preserves owner/grant/project; it requires a current membership within that grant. */
  rotateKey(
    principal: Principal,
    input: { keyId: string; expiresAt?: string | null },
  ): Promise<IssuedUserKey>;
  /** Revoke the selected key and all of its rotation descendants atomically. */
  revokeKey(principal: Principal, keyId: string): Promise<void>;
  /** Trusted provider output only; accepting an invitation does not verify an identity. */
  acceptVerifiedIdentity(identity: VerifiedIdentity): Promise<HumanPrincipal>;
  caller(principal: Principal, projectId?: string): Promise<Caller>;
  projects(principal: Principal): Promise<Project[]>;
  createProject(principal: Principal, input: { name: string; requestId: string }): Promise<Project>;
  memberships(principal: Principal, projectId: string): Promise<ProjectMembership[]>;
  addMember(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  changeMemberRole(
    principal: Principal,
    projectId: string,
    input: { subject: string; role: Role },
  ): Promise<ProjectMembership>;
  removeMember(principal: Principal, projectId: string, subject: string): Promise<void>;
  /** Local administrator migration only. This is deliberately absent from HTTP/MCP. */
  adoptProject(
    principal: HumanPrincipal,
    projectId: string,
    options?: { repairReason: string },
  ): Promise<ProjectMembership>;
  require(caller: Caller, permission: Permission, tx?: Transaction): Promise<Actor>;
  eligible(
    projectId: string,
    actorId: string,
    permission: Permission,
    tx?: Transaction,
  ): Promise<boolean>;
  project(caller: Caller, tx?: Transaction): Promise<Project>;
  updateProjectContext(
    caller: Caller,
    input: ProjectContextUpdate,
    tx?: Transaction,
  ): Promise<Project>;
  issueActor(
    caller: Caller,
    input: { name: string; role: Role; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  actorCredentials(caller: Caller, actorId?: string): Promise<ActorCredential[]>;
  issueActorCredential(
    caller: Caller,
    input: { actorId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  rotateCredential(
    caller: Caller,
    input: { credentialId: string; expiresAt?: string | null },
  ): Promise<IssuedActorCredential>;
  revokeCredential(caller: Caller, credentialId: string): Promise<void>;
  actors(caller: Caller): Promise<Actor[]>;
  revokeActor(caller: Caller, actorId: string): Promise<void>;
}
export interface Artifact {
  id: string;
  projectId: string;
  createdBy: string;
  title: string;
  mediaType: string;
  hash: string;
  size: number;
  createdAt: string;
}
export interface ArtifactInput {
  title: string;
  content: string;
  mediaType?: string;
  encoding?: 'utf8' | 'base64';
}
export interface Artifacts {
  readonly downloadSupported: boolean;
  download(
    caller: Caller,
    artifactId: string,
  ): Promise<{
    artifact: Artifact;
    download: { url: string; expiresAt: string };
  }>;
  /** Metadata-only output receipts for the authenticated session worker. */
  authored(caller: Caller, tx?: Transaction): Promise<Artifact[]>;
  create(caller: Caller, input: ArtifactInput, tx?: Transaction): Promise<Artifact>;
  get(caller: Caller, artifactId: string, tx?: Transaction): Promise<Artifact>;
  read(
    caller: Caller,
    artifactId: string,
  ): Promise<{ artifact: Artifact; content: string; encoding: 'utf8' | 'base64' }>;
  list(caller: Caller): Promise<Artifact[]>;
}
export interface WorkflowDefinition {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  edges: { from: string; action: string; to: string }[];
  managed?: boolean;
  /** While an instance is nonterminal, pause creation of these workflow types in its project. */
  blocksStarts?: string[];
}
export interface WorkflowStart {
  workflow: string;
  version?: number;
  requestId: string;
  data?: Data;
  dependsOn?: string[] | string | null;
}
export interface WorkflowAddDependencies {
  instanceId: string;
  dependsOn: string[] | string | null;
  expectedRevision: number;
  requestId: string;
}
export interface WorkflowTransition {
  instanceId: string;
  expectedRevision: number;
  action: string;
  requestId: string;
  data?: Data;
  /** Proposed command arguments for registered checks; not merged into workflow state. */
  input?: Data;
}
export interface WorkflowUpgrade {
  instanceId: string;
  fromVersion: number;
  expectedRevision: number;
  requestId: string;
}
export interface WorkflowCheckContext {
  caller: Caller;
  snapshot: WorkflowSnapshot;
  tx: Transaction;
  input?: Data;
  transition?: string;
  dependencies?: WorkflowDependency[];
}
/** Read-only domain rules; awaited inside the graph owner's transaction. */
export interface WorkflowActionRule {
  name: string;
  states: string[];
  tool: string;
  instruction: string;
  transitions?: string[];
  requiredInput?: string[] | ((context: WorkflowCheckContext) => string[] | Promise<string[]>);
  suggested?: boolean;
  requiresDependencies?: boolean;
  check(context: WorkflowCheckContext): void | Promise<void>;
  arguments?(context: WorkflowCheckContext): Data | Promise<Data>;
}
export interface WorkflowPolicy {
  actions: WorkflowActionRule[];
  assignments?: WorkflowAssignmentRule[];
  /** Immutable per version; only these terminal states satisfy downstream work. */
  successStates?: string[];
  /** Optional explicit recovery action suggested when a required prerequisite fails. */
  dependencyFailureAction?: string;
  describe?(context: WorkflowCheckContext):
    | {
        label: string;
        references: WorkflowReference[];
        gate?: string;
        waiting?: string;
      }
    | Promise<{
        label: string;
        references: WorkflowReference[];
        gate?: string;
        waiting?: string;
      }>;
}
export interface WorkflowAssignmentRule {
  state: string;
  requiresDependencies?: boolean;
  /** Admission to do node work, independent of exit-action readiness. */
  check(context: WorkflowCheckContext): void | Promise<void>;
  build(
    context: WorkflowCheckContext,
  ): WorkflowAssignmentContent | Promise<WorkflowAssignmentContent>;
  /** Fixed declared grants. Absence explicitly means no workflow dispatch authority. */
  execution?: WorkflowExecutionPolicy;
  /** Awaited metadata only; never render context or read artifact bytes here. */
  references?(
    context: WorkflowCheckContext,
  ): WorkflowExecutionReferences | Promise<WorkflowExecutionReferences>;
  /** Program-owned resource reservation for one credentialless session worker. */
  lease?: {
    /** Optional metadata-only queue label; never render assignment context here. */
    label?(context: WorkflowCheckContext): string | Promise<string>;
    role(context: WorkflowCheckContext): Role | Promise<Role>;
    acquire(
      context: WorkflowCheckContext & { source: Caller; leaseId: string },
    ): Data | Promise<Data>;
    check(context: WorkflowCheckContext, receipt: Data): void | Promise<void>;
    /** Program-owned worker outputs may extend declared resource arrays for this lease. */
    outputs?(
      context: WorkflowCheckContext,
      receipt: Data,
    ): Record<string, string[]> | Promise<Record<string, string[]>>;
    release(context: {
      lease: WorkflowLease;
      reason: string;
      tx: Transaction;
    }): void | Promise<void>;
  };
}
export type WorkflowExecutionBinding =
  | { kind: 'literal'; value: Json }
  | { kind: 'target'; field: 'instanceId' | 'revision' | 'projectId' }
  | { kind: 'reference'; name: string }
  | { kind: 'oneOf'; name: string }
  | { kind: 'subset'; name: string };
export type WorkflowExecutionReferences = Record<string, string | string[]>;
/** JSON declarations, separate from guidance and deployed callback implementations. */
export interface WorkflowExecutionPolicy {
  /** Describes the work environment; explicit protocol/checkpoint writes remain permitted. */
  readOnly: boolean;
  /** Omission preserves old manifest hashes and means scratch space with no repository. */
  workspace?: WorkflowWorkspacePolicy;
  tools: {
    name: string;
    /** A tool is admitted when one complete argument-binding alternative matches. */
    alternatives: Record<string, WorkflowExecutionBinding>[];
  }[];
}
/** Do not materialize this compatibility default into a persisted execution manifest. */
export function effectiveWorkspace(policy: WorkflowExecutionPolicy): WorkflowWorkspacePolicy {
  return structuredClone(policy.workspace ?? { mode: 'none' });
}
export interface WorkflowLease extends WorkflowExecutionTarget {
  leaseId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  policyHash: string;
  registrationId: string;
  receipt: Data;
}
export interface WorkflowLeaseOffer {
  lease: WorkflowLease;
  assignment: WorkflowAssignment;
  execution: WorkflowExecution;
}
export interface WorkflowExecution {
  instanceId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  /** Pins declared grants, not the implementation of trusted metadata callbacks. */
  policyHash: string;
  /** Opaque registration-generation fence. This is not a bearer credential. */
  registrationId: string;
  policy: WorkflowExecutionPolicy;
  references: WorkflowExecutionReferences;
}
export interface WorkflowExecutionDispatch extends WorkflowExecutionTarget {
  policyHash: string;
  registrationId: string;
  tool: string;
  input: Data;
  /** The tool only reads, so the project is its bound rather than the policy. */
  read?: boolean;
}
export interface WorkflowDispatchAdmission {
  tool: string;
  input: Data;
}
export interface WorkflowAssignmentContent {
  role: string;
  label: string;
  brief: string;
  references: WorkflowReference[];
  handoff: { instruction: string; tools: string[] };
  /** Assignment instructions; these do not mint a per-session capability. */
  execution: {
    readOnly: boolean;
    tools: { name: string; arguments: Data }[];
    policy?: WorkflowExecutionPolicy;
    policyHash?: string;
    registrationId?: string;
  };
  context: ContextPreview | null;
}
export interface WorkflowAssignment extends WorkflowAssignmentContent {
  instanceId: string;
  projectId: string;
  actorId: string;
  workflow: string;
  version: number;
  state: string;
  revision: number;
  workStart: WorkflowWorkStart | null;
}
export interface WorkflowBegin {
  instanceId: string;
  expectedRevision: number;
}
export interface WorkflowEvaluationInput {
  /** Optional preflight of one action against proposed command arguments. */
  action?: string;
  input?: Data;
}
export interface WorkflowReadReferences {
  id: string;
  /** Awaited, read-only domain lookup for denied evidence reads. Never called for writes or assignment/lease lifecycle. */
  resolve(
    context: WorkflowCheckContext,
    tool: string,
  ): WorkflowExecutionReferences | null | Promise<WorkflowExecutionReferences | null>;
}
export interface Workflows {
  registerReadReferences(provider: WorkflowReadReferences): () => void;
  /** Metadata-only, project-scoped readiness. Does not reserve work or render assignment bytes. */
  dispatchCandidates(source: Caller, tx?: Transaction): Promise<WorkflowDispatchCandidate[]>;
  leaseRole(source: Caller, target: WorkflowExecutionTarget, tx?: Transaction): Promise<Role>;
  offerLease(
    source: Caller,
    worker: Caller,
    target: WorkflowExecutionTarget & { leaseId: string },
    tx?: Transaction,
  ): Promise<WorkflowLeaseOffer>;
  checkLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowExecution>;
  authorizeLeaseDispatch(
    worker: Caller,
    lease: WorkflowLease,
    frozen: WorkflowExecution,
    input: { tool: string; input: Data; read?: boolean },
    tx?: Transaction,
  ): Promise<WorkflowDispatchAdmission>;
  activateLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowWorkStart>;
  /** Trusted exact resource cleanup; deliberately independent of caller's expired authority. */
  releaseLease(lease: WorkflowLease, input: { reason: string }, tx?: Transaction): Promise<void>;
  execution(
    caller: Caller,
    target: WorkflowExecutionTarget,
    tx?: Transaction,
  ): Promise<WorkflowExecution>;
  /** Internal dispatch admission; ordinary caller credentials remain unchanged. */
  authorizeDispatch(
    caller: Caller,
    dispatch: WorkflowExecutionDispatch,
    tx?: Transaction,
  ): Promise<WorkflowDispatchAdmission>;
  assignment(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowAssignment>;
  begin(caller: Caller, input: WorkflowBegin, tx?: Transaction): Promise<WorkflowAssignment>;
  workStarts(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowWorkStart[]>;
  register(
    definition: WorkflowDefinition,
    policy?: WorkflowPolicy,
  ): Promise<{
    dispose(): void;
    start(caller: Caller, input: WorkflowStart, tx?: Transaction): Promise<WorkflowSnapshot>;
    transition(
      caller: Caller,
      input: WorkflowTransition,
      tx?: Transaction,
    ): Promise<WorkflowSnapshot>;
    /** Explicit managed-program upgrade to this handle's additive definition; preserves state and data. */
    upgrade(caller: Caller, input: WorkflowUpgrade, tx?: Transaction): Promise<WorkflowSnapshot>;
    /** Program-owned additive DAG composition; not an agent-facing mutation. */
    addDependencies(
      caller: Caller,
      input: WorkflowAddDependencies,
      tx?: Transaction,
    ): Promise<WorkflowSnapshot>;
  }>;
  start(caller: Caller, input: WorkflowStart, tx?: Transaction): Promise<WorkflowSnapshot>;
  transition(
    caller: Caller,
    input: WorkflowTransition,
    tx?: Transaction,
  ): Promise<WorkflowSnapshot>;
  get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot>;
  list(caller: Caller): Promise<WorkflowSnapshot[]>;
  history(caller: Caller, instanceId: string): Promise<WorkflowHistoryEntry[]>;
  catalog(): WorkflowDefinition[];
  /** Derived on read from the definition and the record; never pinned, never authored. */
  process(caller: Caller, instanceId: string): Promise<ProcessGraph>;
  evaluate(
    caller: Caller,
    instanceId: string,
    input?: WorkflowEvaluationInput,
    tx?: Transaction,
  ): Promise<WorkflowDecision>;
  overview(caller: Caller): Promise<WorkflowOverview>;
  dependencies(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<{
    dependencies: WorkflowDependency[];
    dependents: WorkflowDependency[];
  }>;
  checkDependencies(caller: Caller, instanceId: string, tx?: Transaction): Promise<void>;
}
export type Verdict = 'pass' | 'needs_changes' | 'fail';
export type ReviewFinding = {
  criterionNumber: number;
  status: 'met' | 'not_met' | 'not_verified' | 'waived';
  evidenceIds: string[];
  notes: string;
};
export interface ReviewRequest {
  id: string;
  projectId: string;
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  pinnedInputIds?: string[];
  /** Immutable contributor exclusions in addition to the primary producer. Omitted for legacy reviews. */
  excludedActorIds?: string[];
  criteria: string[];
  formatVersion: 1 | 2;
  snapshotHash: string;
  status: 'requested' | 'started' | 'submitted' | 'superseded';
  reviewerId: string | null;
  claimId: string | null;
  claimGeneration: number;
  recovery: {
    eventId: number;
    previousActorId: string;
    previousClaimId: string | null;
    reason: string;
  } | null;
  verdict: Verdict | null;
  /** Explicit return route chosen and validated by the owning domain, when applicable. */
  returnTo?: string;
  notes: string | null;
  synopsis: string | null;
  findings: ReviewFinding[];
  evidence: Data;
  createdAt: string;
}
export interface ReviewInput {
  subjectId: string;
  subjectRevision: number;
  producerId: string;
  administrativeActorId?: string;
  artifactIds: string[];
  /** Explicit input provenance; all remaining evidence must be authored by producerId. */
  pinnedInputIds?: string[];
  /** Authors of pinned manifest evidence who must not claim or judge this review. */
  excludedActorIds?: string[];
  criteria: string[];
  /** The integrating program pins the verdict format when requesting review. */
  formatVersion?: 1 | 2;
  requestId: string;
}
export interface ReviewSubmit {
  reviewId: string;
  claimId: string;
  verdict: Verdict;
  /** Optional bounded identifier; the owning domain decides valid/required return routes. */
  returnTo?: string;
  notes: string;
  synopsis?: string;
  findings?: ReviewFinding[];
  /** Structured observations/metrics; evidence.outcome may name the resulting outcome. */
  evidence?: Data;
  requestId: string;
}
export interface ReviewApplication extends ReviewSubmit {
  expectedRevision: number;
}
/** Trusted synchronous domain callbacks; ownership checks read metadata only. */
export interface ReviewSubmitOwner {
  id: string;
  owns(review: Readonly<ReviewRequest>, tx: Transaction): boolean | Promise<boolean>;
  submit(caller: Caller, input: ReviewApplication, tx: Transaction): Promise<unknown>;
}
export interface Reviews {
  registerSubmitOwner(owner: ReviewSubmitOwner): () => void;
  /** Select one current domain owner and apply its verdict/transition in the same writer. */
  apply(caller: Caller, input: ReviewApplication, tx?: Transaction): Promise<unknown>;
  request(caller: Caller, input: ReviewInput, tx?: Transaction): Promise<ReviewRequest>;
  reissue(
    caller: Caller,
    input: { reviewId: string; subjectRevision: number; requestId: string },
    tx?: Transaction,
  ): Promise<ReviewRequest>;
  /** Trusted cleanup of exactly one worker claim, without reviving expired caller authority. */
  releaseClaim(
    input: {
      projectId: string;
      reviewId: string;
      claimId: string;
      actorId: string;
      reason: string;
    },
    tx: Transaction,
  ): Promise<void>;
  get(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  list(caller: Caller): Promise<ReviewRequest[]>;
  start(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  checkStart(caller: Caller, reviewId: string, tx?: Transaction): Promise<ReviewRequest>;
  checkSubmit(
    caller: Caller,
    reviewId: string,
    input?: Omit<ReviewSubmit, 'requestId'>,
    tx?: Transaction,
  ): Promise<ReviewRequest>;
  submit(caller: Caller, input: ReviewSubmit, tx?: Transaction): Promise<ReviewRequest>;
  supersede(caller: Caller, reviewId: string, tx?: Transaction): Promise<void>;
}
export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  checks: string[];
  evidenceVersion: 1 | 2;
  acceptanceChecks: { number: number; text: string }[];
  deliveryConfirmations: TaskConfirmation[];
  deliveryAssessmentId: string | null;
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  reviewId: string | null;
  workflow: WorkflowSnapshot;
  guidance: WorkflowDecision;
  failure: TaskFailure | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  workStarts: WorkflowWorkStart[];
  createdAt: string;
  type: string;
  typeVersion: number;
  contextInputs: Record<string, string[]>;
}
export interface TaskFailure {
  reason: string;
  actorId: string;
  createdAt: string;
  reviewId: string | null;
}
/** Domain metadata only; safe to compose without evaluating interactive guidance. */
export type TaskRecord = Omit<Task, 'guidance'>;
export interface ContextRecipe {
  instructions: string;
  sections: { key: string; title: string; required: boolean }[];
  outputInstructions: string;
  maxChars: number;
}
export interface TaskTypeDefinition {
  name: string;
  version: number;
  kind: 'work' | 'review';
  recipe: ContextRecipe;
}
export type ContextInput =
  | { text: string }
  | {
      artifactIds: string[];
      /** Text is strict UTF-8; auto retains binary references; references never embeds bytes. */
      mode?: 'text' | 'auto' | 'references';
    };
export interface ContextBuild {
  subject: { id: string; revision: number; claimId?: string };
  inputs: Record<string, ContextInput>;
  requestId: string;
}
export interface ContextPackage {
  id: string;
  projectId: string;
  actorId: string;
  type: string;
  typeVersion: number;
  recipeHash: string;
  subject: ContextBuild['subject'];
  prompt: string;
  sources: Artifact[];
  omitted: string[];
  hash: string;
  createdAt: string;
}
export type ContextPreview = Omit<ContextPackage, 'id' | 'createdAt'>;
export interface ContextRegistration {
  preview(
    caller: Caller,
    input: Omit<ContextBuild, 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPreview>;
  build(caller: Caller, input: ContextBuild, tx?: Transaction): Promise<ContextPackage>;
  /** Replay an existing assignment request before rebuilding its live inputs. */
  replay(
    caller: Caller,
    input: Pick<ContextBuild, 'subject' | 'requestId'>,
    tx?: Transaction,
  ): Promise<ContextPackage | null>;
  dispose(): void;
}
export interface ContextBuilder {
  register(definition: TaskTypeDefinition): Promise<ContextRegistration>;
  get(caller: Caller, contextId: string): Promise<ContextPackage>;
  /** Text documents are embedded while they leave the recipe `room` for the rest of the
   *  context; past that they are listed and the reader opens them itself. */
  mode(
    caller: Caller,
    ids: string[],
    room: number,
    tx: Transaction,
  ): Promise<'auto' | 'references'>;
}
export interface TaskContext {
  taskId: string;
  purpose: 'work' | 'review';
  expectedRevision: number;
  claimId?: string;
  requestId: string;
}
export interface TaskCheckpointInput extends TaskContext {
  notes: string;
  artifactIds?: string[];
}
export interface TaskCheckpoint {
  id: string;
  taskId: string;
  actorId: string;
  purpose: 'work' | 'review';
  revision: number;
  reviewId: string | null;
  claimId: string | null;
  notes: string;
  artifactIds: string[];
  createdAt: string;
}
export interface TaskCreate {
  title: string;
  goal: string;
  checks: string[];
  briefId?: string;
  requestId: string;
  type?: string;
  typeVersion?: number;
  contextInputs?: Record<string, string[]>;
  dependsOn?: string[] | string | null;
}
export interface TaskDelivery {
  taskId: string;
  artifactIds: string[];
  /** Required for tasks created with evidenceVersion 2. These are producer claims. */
  confirmations?: TaskConfirmation[];
  expectedRevision: number;
  requestId: string;
}
export type TaskConfirmation = {
  checkNumber: number;
  status: 'met' | 'not_met';
  evidenceIds: string[];
  notes: string;
};
export interface TaskReview extends ReviewApplication {}
export interface TaskReissue {
  taskId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
export interface TaskMarkFailed {
  taskId: string;
  expectedRevision: number;
  reason: string;
  requestId: string;
}
export interface Tasks {
  registerType(definition: TaskTypeDefinition): Promise<() => void>;
  context(caller: Caller, input: TaskContext): Promise<ContextPackage>;
  checkpoint(caller: Caller, input: TaskCheckpointInput): Promise<TaskCheckpoint>;
  create(caller: Caller, input: TaskCreate): Promise<Task>;
  get(caller: Caller, taskId: string): Promise<Task>;
  list(caller: Caller): Promise<Task[]>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, taskId: string): Promise<ProcessGraph>;
  record(caller: Caller, taskId: string, tx?: Transaction): Promise<TaskRecord>;
  records(caller: Caller, tx?: Transaction): Promise<TaskRecord[]>;
  submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task>;
  submitReview(caller: Caller, input: TaskReview, tx?: Transaction): Promise<Task>;
  reissueReview(caller: Caller, input: TaskReissue): Promise<Task>;
  markFailed(caller: Caller, input: TaskMarkFailed): Promise<Task>;
}
declare module 'cordis' {
  interface Context {
    state: State;
    domainEvents: DomainEvents;
    contextBuilder: ContextBuilder;
    blobs: Blobs;
    scope: Scope;
    artifacts: Artifacts;
    workflows: Workflows;
    reviews: Reviews;
    tasks: Tasks;
  }
}

export {
  githubRevisionSchema,
  githubRepositoryInputSchema,
  githubAutomationSchema,
  githubBranchSchema,
} from './code-github.js';
export type {
  CodeGitHub,
  GitHubRepository,
  GitHubRepositoryInput,
  GitHubStatus,
} from './code-github.js';
export type {
  GitHubBranch,
  GitHubCommit,
  GitHubPullRequest,
  GitHubChangedFile,
  GitHubCheck,
  GitHubReview,
  GitHubPullDetails,
  GitHubAutomationInput,
} from './github-models.js';
