/** Workflows' contract: definitions, policies, leases and the service other units call. */
import type { Transaction } from './index.js';
import type { ContextPreview } from './context.js';
import type {
  ProcessGraph,
  WorkflowDecision,
  WorkflowDependency,
  WorkflowDispatchCandidate,
  WorkflowExecutionTarget,
  WorkflowHistoryEntry,
  WorkflowLimitStatus,
  WorkflowOverview,
  WorkflowProvidedBlocker,
  WorkflowProvidedBlockerInput,
  WorkflowReference,
  WorkflowRelations,
  WorkflowSnapshot,
  WorkflowTransitionCount,
  WorkflowWorkStart,
} from '@merv/workflows/models';
import type { Caller, Role } from './scope-models.js';
import type { Data, Json } from './data.js';
import type { WorkflowWorkspacePolicy } from './sessions-models.js';
export interface WorkflowDefinition {
  name: string;
  version: number;
  initial: string;
  states: string[];
  terminal: string[];
  edges: { from: string; action: string; to: string }[];
  /** Every graph is managed: only its program's handle changes an instance. */
  managed?: true;
  /** While an instance is nonterminal, pause creation of these workflow types in its project. */
  blocksStarts?: string[];
}
/** A deployed definition as the catalog reads it: each edge with the tool that takes it, if any. */
export interface WorkflowCatalogEntry extends Omit<WorkflowDefinition, 'edges'> {
  edges: (WorkflowDefinition['edges'][number] & { tool: string | null })[];
}
/** The immutable contract of one name@version, whether or not a program has it loaded. */
export interface WorkflowPinned {
  definition: WorkflowDefinition;
  /** Null pins their absence. */
  successStates: string[] | null;
  /**
   * Each nonterminal state's fixed execution manifest; null pins that it has none. Only a contract
   * that is not final can lack a state.
   */
  execution: Record<string, WorkflowExecutionPolicy | null>;
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
  /** Edges to remove in the same change: an owner reselecting the work it depends on. */
  drop?: string[] | string | null;
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
/**
 * A cap on how often one instance may take a returning edge. `max` is the sum of recorded
 * traversals allowed across `actions`, every one of which leaves `from` for another state.
 */
export interface WorkflowLoopLimit {
  name: string;
  from: string;
  actions: string[];
  max: number;
}
/** An admin's append-only allowance; an owner's resume hook may also advance suspended work. */
export interface WorkflowExtendLimit {
  instanceId: string;
  limit: string;
  additional: number;
  reason: string;
  requestId: string;
}
export interface WorkflowPolicy {
  actions: WorkflowActionRule[];
  assignments?: WorkflowAssignmentRule[];
  /**
   * Not fingerprinted with the graph: a cap is deployed policy, a number operators tune, and
   * it governs every live instance of the version at once, counted from its whole history.
   */
  limits?: WorkflowLoopLimit[];
  /** The owner may resume suspended work in the same transaction as a human's allowance. */
  limitExtended?(context: WorkflowCheckContext, status: WorkflowLimitStatus): Promise<void>;
  /**
   * Immutable per version, their absence included: the first registration of a version pins
   * them, or pins that there are none. Only these terminal states satisfy downstream work, and
   * work of a version without them cannot be depended on.
   */
  successStates?: string[];
  /** Optional explicit recovery action suggested when a required prerequisite fails. */
  dependencyFailureAction?: string;
  /**
   * The instances each of `instanceIds` fans work out to without a dependency edge, such as a
   * reflection's lenses, by instance id; one left out has none. A usage rollup over a
   * dependency closure unions them in, so the sessions they cost are not lost from the figure
   * of the cycle that caused them. It is asked for up to 1,000 instances at once, never an
   * empty list, on behalf of no caller, and only reads.
   */
  children?(context: {
    projectId: string;
    instanceIds: readonly string[];
    tx: Transaction;
  }): Record<string, string[]> | Promise<Record<string, string[]>>;
  describe?(context: WorkflowCheckContext): WorkflowDescription | Promise<WorkflowDescription>;
  /**
   * Before a read decides many instances of this version at once (guidance, an overview, a
   * dispatch scan), the program may read in one pass what its callbacks will ask of each, kept
   * where they look for it (`state.remember`), so they need not read it one instance at a time.
   * It only spares reads: it never changes an answer, and a refusal here is none, since each
   * instance's callbacks still answer for it. Read-only, in the read's own transaction.
   */
  prepare?(context: {
    caller: Caller;
    tx: Transaction;
    snapshots: readonly WorkflowSnapshot[];
  }): void | Promise<void>;
}
export interface WorkflowDescription {
  label: string;
  references: WorkflowReference[];
  gate?: string;
  waiting?: string;
  /** Whose own move the record is, which a decision answers for its reader as `yours`. */
  owner?: WorkflowOwner;
}
/**
 * Whose record an instance is, as its program says: the actor it belongs to; the actions that
 * are their move even where the gate refuses nothing, each with the sentence asking it of them
 * (`asks`); and the actions only a leased worker makes, which are never theirs (`leased`).
 */
export interface WorkflowOwner {
  actorId: string;
  asks?: Record<string, string>;
  leased?: string[];
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
    /** Whether this worker actor would be refused the assignment, so it is never offered it. */
    excludes?(context: WorkflowCheckContext, actorId: string): boolean | Promise<boolean>;
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
export interface WorkflowAssignmentContent {
  role: string;
  /** For the agent, saying the purpose (`Work: …`); `name` is the record's own, for a person. */
  label: string;
  name?: string;
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
/** An instance as get() reads it, with its workStarts() and both directions of its edges. */
export interface WorkflowRecord {
  snapshot: WorkflowSnapshot;
  workStarts: WorkflowWorkStart[];
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
}
export interface Workflows {
  /** Candidates a source may dispatch; with `worker`, only those that worker may take. */
  dispatchCandidates(
    source: Caller,
    tx?: Transaction,
    worker?: string,
  ): Promise<WorkflowDispatchCandidate[]>;
  leaseRole(source: Caller, target: WorkflowExecutionTarget, tx?: Transaction): Promise<Role>;
  offerLease(
    source: Caller,
    worker: Caller,
    target: WorkflowExecutionTarget & { leaseId: string },
    tx?: Transaction,
  ): Promise<WorkflowLeaseOffer>;
  /**
   * The lease still holds, under the returned registration generation. With `frozen`, the
   * execution the lease was offered, it also returns the references that execution grants
   * now: the frozen ones, extended by the lease's own outputs.
   */
  checkLease(
    worker: Caller,
    lease: WorkflowLease,
    tx?: Transaction,
    frozen?: WorkflowExecution,
  ): Promise<{ registrationId: string; references?: WorkflowExecutionReferences }>;
  activateLease(worker: Caller, lease: WorkflowLease, tx?: Transaction): Promise<WorkflowWorkStart>;
  /** Trusted exact resource cleanup; deliberately independent of caller's expired authority. */
  releaseLease(lease: WorkflowLease, input: { reason: string }, tx?: Transaction): Promise<void>;
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
    /** Program-owned additive DAG composition; not an agent-facing mutation. */
    addDependencies(
      caller: Caller,
      input: WorkflowAddDependencies,
      tx?: Transaction,
    ): Promise<WorkflowSnapshot>;
  }>;
  get(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowSnapshot>;
  /** get() for several instances in one read; an id the project does not hold is left out. */
  find(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowSnapshot>>;
  /** The project's instances, oldest first; with `workflow`, only that workflow's. */
  list(caller: Caller, tx?: Transaction, workflow?: string): Promise<WorkflowSnapshot[]>;
  history(caller: Caller, instanceId: string, tx?: Transaction): Promise<WorkflowHistoryEntry[]>;
  /**
   * System reads for a caller already authorized for what it asks. `open`: the instances of
   * `workflow` in a nonterminal state of their own pinned version, in one project or (null)
   * every project, oldest first. `movedBy`: who moved an instance to `revision`, if anyone.
   * `revisions`: where each named instance of the project stands, without its data; an id the
   * project does not hold is left out. `moves`: how many moves by `action` in the project
   * recorded one of `values` under one of `keys` of their data.
   */
  open(workflow: string, projectId: string | null, tx?: Transaction): Promise<WorkflowSnapshot[]>;
  movedBy(instanceId: string, revision: number, tx?: Transaction): Promise<string | null>;
  revisions(
    projectId: string,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, Omit<WorkflowSnapshot, 'data'>>>;
  /** How often each instance made each move, without the moves' data, in one read per batch. */
  transitionCounts(
    projectId: string,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowTransitionCount[]>>;
  moves(
    projectId: string,
    match: { action: string; keys: readonly string[]; values: readonly string[] },
    tx?: Transaction,
  ): Promise<number>;
  catalog(): WorkflowCatalogEntry[];
  /**
   * The stored contract of a version, loaded or not, or null when none is stored. It never
   * changes, so it needs no caller. The object returned is shared and deeply frozen: a caller
   * that needs to change it copies it first.
   */
  pinned(workflow: string, version: number, tx?: Transaction): Promise<WorkflowPinned | null>;
  /**
   * How each instance stands against its own pinned contract, as a prerequisite's edge says it:
   * `settled` in one of its success states, `failed` in a terminal state outside them. Without
   * declared success states neither holds. Reads contracts only, so it needs no caller.
   */
  ends(
    instances: readonly Pick<WorkflowSnapshot, 'workflow' | 'version' | 'state'>[],
    tx?: Transaction,
  ): Promise<{ settled: boolean; failed: boolean }[]>;
  /**
   * Derived on read from the definition and the record; never pinned, never authored. With
   * `checks: false` no program callback runs, so no edge carries a status: for a view that
   * draws only where the work stands.
   */
  process(
    caller: Caller,
    instanceId: string,
    options?: { checks?: boolean },
    tx?: Transaction,
  ): Promise<ProcessGraph>;
  evaluate(
    caller: Caller,
    instanceId: string,
    input?: WorkflowEvaluationInput,
    tx?: Transaction,
  ): Promise<WorkflowDecision>;
  /** With `open`, only unended work and ended work a provider still holds with a blocker. */
  overview(
    caller: Caller,
    tx?: Transaction,
    options?: { open?: boolean },
  ): Promise<WorkflowOverview>;
  /**
   * Open work whose current state's loop limit is used up, or that waits in a state only
   * another round moves on (a rule there whose tool is workflow.extend_limit), with that limit,
   * and whether this reader may allow another round (a project admin who is not a leased worker).
   */
  escalated(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{
    admin: boolean;
    items: { instanceId: string; revision: number; limit: WorkflowLimitStatus }[];
  }>;
  /** Only a project admin who is not a leased worker may allow a capped loop more rounds. */
  extendLimit(
    caller: Caller,
    input: WorkflowExtendLimit,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus>;
  /**
   * get(), workStarts(), prerequisites() and what depends on each of several instances, for a
   * list of records, in a fixed number of reads however many. An id the project does not hold
   * is left out.
   */
  records(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowRecord>>;
  /**
   * What each of several instances depends on, without what depends on it, in a fixed number
   * of reads. An id the project does not hold depends on nothing; `requireDependencies` from
   * `@merv/workflows/rules` refuses work whose prerequisites have not all settled.
   */
  prerequisites(
    caller: Caller,
    instanceIds: readonly string[],
    tx?: Transaction,
  ): Promise<Map<string, WorkflowDependency[]>>;
  /**
   * Where one named loop limit stands for each of several instances, in a fixed number of reads
   * per definition. An instance whose definition has no such limit is left out, not refused.
   */
  limitStatusOf(
    caller: Caller,
    instanceIds: readonly string[],
    name: string,
    tx?: Transaction,
  ): Promise<Map<string, WorkflowLimitStatus>>;
  /**
   * The used-up limit leaving the instance's current state, if any: where nothing returns the
   * work again, so an owner rules out what would (a review's rejecting verdicts).
   */
  exhaustedLimit(
    caller: Caller,
    instanceId: string,
    tx?: Transaction,
  ): Promise<WorkflowLimitStatus | undefined>;
  /**
   * The instance (or each of several), everything it transitively depends on, and the children
   * their policies declare: the grouping a research cycle's usage and budget are read over.
   */
  dependencyClosure(
    caller: Caller,
    instanceIds: string | readonly string[],
    tx?: Transaction,
  ): Promise<string[]>;
  /** Roots whose current dependency or child closure contains this work, frozen by its provider. */
  sponsoringRoots(projectId: string, instanceIds: string[], tx: Transaction): Promise<string[]>;
  /**
   * A provider's whole current opinion of one instance: the keys given are written, its other
   * keys for that instance are removed. Transaction-only, like releaseLease, so no tool route
   * reaches it; an ended instance keeps none.
   */
  replaceBlockers(
    input: {
      projectId: string;
      instanceId: string;
      provider: string;
      blockers: WorkflowProvidedBlockerInput[];
    },
    tx: Transaction,
  ): Promise<void>;
  /** Published blockers of one instance, or of the whole project when it is left out. */
  blockers(
    caller: Caller,
    instanceId?: string,
    tx?: Transaction,
  ): Promise<WorkflowProvidedBlocker[]>;
  /**
   * Internal provider capability; never exposed through a tool or a lease. `replace` makes the
   * provider's edges from the instance exactly `dependencies`: replacing with the set already
   * held changes nothing, so a repeat is safe without a request id.
   */
  systemPrerequisites(provider: string): {
    replace(
      input: { projectId: string; instanceId: string; dependencies: string[] },
      tx: Transaction,
    ): Promise<void>;
  };
  /**
   * The instance and the dependency edges a provider derives from, read inside its caller's
   * transaction and under that caller's already-checked authority. Null when the project holds
   * no such instance.
   */
  relations(
    projectId: string,
    instanceId: string,
    tx: Transaction,
  ): Promise<WorkflowRelations | null>;
}
