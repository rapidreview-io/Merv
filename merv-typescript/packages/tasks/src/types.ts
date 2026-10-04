import type {
  Caller,
  CodeUnit,
  ContextPackage,
  ContextRecipeDefinition,
  ProcessGraph,
  ReviewApplication,
  RunningNode,
  RunningPanelPart,
  Transaction,
  WorkComputeAccess,
  WorkflowDecision,
  WorkflowDependency,
  WorkflowSnapshot,
  WorkflowWorkStart,
} from '@merv/contracts';
import type {} from 'cordis';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  checks: string[];
  evidenceVersion: 2;
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
  /** Present only on a Git task, so every earlier record reads back unchanged. */
  workspace?: 'git';
  /** The accepted Git task whose delivered commit is the base of this task's checkout. */
  baseTaskId?: string;
  /** The commit the current delivery names; the review pins its rendered record. */
  deliveryCode?: TaskDeliveryCode;
  deliveryCodeArtifactId?: string;
  /** Recent compact managed GPU run summaries across work revisions, when ML is available. */
  compute?: { key: string; runId: string; generation: number; state: string; cost: unknown }[];
}
/**
 * The commit a Git task delivered. The receipt stays resolvable through its ref, so the record
 * keeps only what a later check compares: who produced it, at which revision, and what it is.
 */
export interface TaskDeliveryCode {
  ref: { kind: 'code-commit'; commandId: string };
  sessionId: string;
  /** The task revision the commit was produced at; later revisions never move it. */
  revision: number;
  headOid: string;
  treeOid: string | null;
}
export interface TaskFailure {
  reason: string;
  actorId: string;
  createdAt: string;
  reviewId: string | null;
}
/** Domain metadata only; safe to compose without evaluating interactive guidance. */
export type TaskRecord = Omit<Task, 'guidance'>;
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
  /** New tasks always use Git. Retired values remain typed for historical request replay. */
  workspace?: 'none' | 'git';
  /** Historical request replay only; new work derives its base from dependsOn. */
  baseTaskId?: string;
}
export interface TaskDelivery {
  taskId: string;
  /** May be empty for a Git task, which delivers its commit. */
  artifactIds: string[];
  /** A Git task only: this worker's own succeeded code.commit operation. */
  commandId?: string;
  /** Required: one per acceptance check. These are producer claims. */
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
/** An owner capability passed between server plugins; no public task input selects it. */
export interface ServiceTaskCreator {
  create(
    input: {
      projectId: string;
      requestId: string;
      title: string;
      goal: string;
      checks: string[];
    } & (
      | { baseReference: string; dependsOn?: never }
      /** Prerequisites of the same project; Code derives the base from them as for a public task. */
      | { dependsOn: string[]; baseReference?: never }
    ),
    tx: Transaction,
  ): Promise<{ id: string }>;
}
export interface Tasks extends WorkComputeAccess {
  computeOffers(caller: Caller): Promise<unknown>;
  computeStatus(
    caller: Caller,
    taskId: string,
    runId?: string,
    generation?: number,
  ): Promise<unknown>;
  computeRun(
    caller: Caller,
    input: {
      taskId: string;
      expectedRevision: number;
      key: string;
      provider?: string;
      offerId?: string;
      rentalKey?: string;
      purpose?: 'check';
      command: string;
      minutes: number;
      maxUsd: number;
      commandId?: string;
      outputs?: { files: { name: string; path: string }[]; maxBytes: number };
    },
  ): Promise<unknown>;
  computeCancel(caller: Caller, taskId: string, runId: string): Promise<unknown>;
  computeLogs(caller: Caller, taskId: string, runId: string, generation?: number): Promise<unknown>;
  computeOutput(
    caller: Caller,
    taskId: string,
    runId: string,
    name: string,
    generation?: number,
  ): Promise<unknown>;
  computeTick(): Promise<void>;
  registerType(definition: ContextRecipeDefinition): Promise<() => void>;
  context(caller: Caller, input: TaskContext): Promise<ContextPackage>;
  checkpoint(caller: Caller, input: TaskCheckpointInput): Promise<TaskCheckpoint>;
  create(caller: Caller, input: TaskCreate, transaction?: Transaction): Promise<Task>;
  get(caller: Caller, taskId: string): Promise<Task>;
  list(caller: Caller): Promise<TaskRecord[]>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, taskId: string): Promise<ProcessGraph>;
  /** What the optional Code plugin holds for a Git task; null without it. */
  codeUnit(caller: Caller, taskId: string): Promise<CodeUnit | null>;
  record(caller: Caller, taskId: string, tx?: Transaction): Promise<TaskRecord>;
  records(caller: Caller, tx?: Transaction): Promise<TaskRecord[]>;
  submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task>;
  submitReview(caller: Caller, input: TaskReview, tx?: Transaction): Promise<Task>;
  reissueReview(caller: Caller, input: TaskReissue): Promise<Task>;
  markFailed(caller: Caller, input: TaskMarkFailed, tx?: Transaction): Promise<Task>;
  /** The owner capability another plugin creates service tasks with, under its own provider name. */
  serviceTasks(provider: string): ServiceTaskCreator;
  /**
   * The Running page's work lane: a node for every task still in flight, and for each ended
   * one whose key another owner holds there (`include`, as Running keys). Reads only.
   */
  running(caller: Caller, include?: Iterable<string>): Promise<RunningNode[]>;
  /** A task's sidebar on the Running page; null when no task of this project has the id. Reads only. */
  runningPanel(caller: Caller, taskId: string): Promise<RunningPanelPart | null>;
}

declare module 'cordis' {
  interface Context {
    tasks: Tasks;
  }
}
