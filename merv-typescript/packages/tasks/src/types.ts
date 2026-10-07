import type {
  Caller,
  ContextPackage,
  ContextRecipeDefinition,
  ReviewApplication,
  RunningNode,
  RunningPanelPart,
  RunningUnitEntry,
  Transaction,
  WorkRoute,
} from '@merv/contracts';
import type { ProcessGraph } from '@merv/workflows/models';
import type {} from 'cordis';
import type { Task, TaskConfirmation, TaskRecord } from './models.js';
import type { CodeUnit } from '@merv/code-work/models';
export type * from './models.js';

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
export interface TaskReview extends ReviewApplication {}
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
export interface Tasks {
  registerType(definition: ContextRecipeDefinition): Promise<() => void>;
  context(caller: Caller, input: TaskContext): Promise<ContextPackage>;
  checkpoint(caller: Caller, input: TaskCheckpointInput): Promise<TaskCheckpoint>;
  create(caller: Caller, input: TaskCreate, transaction?: Transaction): Promise<Task>;
  get(caller: Caller, taskId: string): Promise<Task>;
  /** One saved checkpoint of the task, as a context names it. */
  savedCheckpoint(caller: Caller, taskId: string, checkpointId: string): Promise<TaskCheckpoint>;
  list(caller: Caller): Promise<TaskRecord[]>;
  /** How many tasks are still open, for the navigation badge, without reading each one. */
  active(caller: Caller): Promise<number>;
  /** The derived process graph, so a record page reads its gate with the record. */
  process(caller: Caller, taskId: string): Promise<ProcessGraph>;
  /** What the optional Code plugin holds for a Git task; null without it. */
  codeUnit(caller: Caller, taskId: string): Promise<CodeUnit | null>;
  record(caller: Caller, taskId: string, tx?: Transaction): Promise<TaskRecord>;
  records(caller: Caller, tx?: Transaction): Promise<TaskRecord[]>;
  submitDelivery(caller: Caller, input: TaskDelivery): Promise<Task>;
  submitReview(caller: Caller, input: TaskReview, tx?: Transaction): Promise<Task>;
  markFailed(caller: Caller, input: TaskMarkFailed, tx?: Transaction): Promise<Task>;
  /**
   * Fails a task of this project that nobody started (still in progress, no work started), with
   * this reason; true when it did. False, with nothing changed, for anything else.
   */
  closeUnstarted(
    caller: Caller,
    taskId: string,
    reason: string,
    requestId: string,
    tx: Transaction,
  ): Promise<boolean>;
  /** The owner capability another plugin creates service tasks with, under its own provider name. */
  serviceTasks(provider: string): ServiceTaskCreator;
  /**
   * The Running page's work lane: a node for every task still in flight, and for each ended
   * one whose key another owner holds there (`include`, as Running keys). Reads only.
   */
  running(caller: Caller, include?: Iterable<string>): Promise<RunningNode[]>;
  /** A task's sidebar on the Running page; null when no task of this project has the id. Reads only. */
  runningPanel(caller: Caller, taskId: string, route?: WorkRoute): Promise<RunningPanelPart | null>;
  /** Its history alone, as its sidebar tells it, for its record page; empty for another id. */
  history(caller: Caller, taskId: string): Promise<RunningUnitEntry[]>;
}

declare module 'cordis' {
  interface Context {
    tasks: Tasks;
  }
}
