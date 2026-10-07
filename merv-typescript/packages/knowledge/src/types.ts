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
  records(caller: Caller, tx?: Transaction): Promise<KnowledgeRecords>;
  /** IDs or explicit kind:id refs; missing scoped records never reveal another project. */
  resolve(caller: Caller, refs: string[], tx?: Transaction): Promise<KnowledgeReference[]>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    knowledge: Knowledge;
  }
}
