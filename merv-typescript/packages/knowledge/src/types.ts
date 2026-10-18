import type { TaskRecord } from '@merv/tasks/types';
import type { Caller, Project, Transaction } from '@merv/contracts';
import type { Experiment } from '@merv/experiments/types';
import type { CodeCapture } from '@merv/code-work/types';
import type {} from 'cordis';

export interface KnowledgeRecords {
  formatVersion: 1;
  /** Current Scope facts; Paper serves the Introduction. */
  project: Project;
  tasks: TaskRecord[];
  experiments: Experiment[];
}
/** A task as the project index lists it: what it is and where it stands, not its evidence. */
export interface KnowledgeTaskEntry {
  id: string;
  title: string;
  type: string;
  state: string;
  revision: number;
  settled: boolean;
  failed: boolean;
  failure: string | null;
  reviewId: string | null;
  deliveryIds: string[];
  dependencies: string[];
  createdAt: string;
  updatedAt: string;
}
/** An experiment as the project index lists it: its question, standing and conclusion. */
export interface KnowledgeExperimentEntry {
  id: string;
  name: string;
  intent: string;
  state: string;
  revision: number;
  settled: boolean;
  failed: boolean;
  attempt: number;
  reviewId: string | null;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
}
/** One entry per task and experiment, whatever the project's size; ids read records whole. */
export interface KnowledgeIndex {
  formatVersion: 1;
  project: Project;
  tasks: KnowledgeTaskEntry[];
  experiments: KnowledgeExperimentEntry[];
}
/** The whole records of the ids asked for; an id that is neither is missing. */
export interface KnowledgeSelection extends KnowledgeRecords {
  missing: string[];
}
export type KnowledgeReferenceKind =
  'task' | 'experiment' | 'artifact' | 'review' | 'code-capture' | 'reflection' | 'research';
export interface KnowledgeReference {
  ref: string;
  status: 'resolved' | 'missing' | 'unsupported' | 'unavailable';
  kind: KnowledgeReferenceKind | null;
  id: string | null;
  label?: string;
  revision?: number;
  state?: string;
  hash?: string;
  /** Exact source observation, never an inferred or mutable latest Git head. */
  capture?: CodeCapture;
}
export interface Knowledge {
  /** Every task and experiment whole, for in-process readers; tools read through `read`. */
  records(caller: Caller, tx?: Transaction): Promise<KnowledgeRecords>;
  /** The project index, or with ids the whole records they name. */
  read(
    caller: Caller,
    input?: { ids?: string[] },
    tx?: Transaction,
  ): Promise<KnowledgeIndex | KnowledgeSelection>;
  /** IDs or explicit kind:id refs; missing scoped records never reveal another project. */
  resolve(caller: Caller, refs: string[], tx?: Transaction): Promise<KnowledgeReference[]>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    knowledge: Knowledge;
  }
}
