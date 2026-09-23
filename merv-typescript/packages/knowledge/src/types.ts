import type { Caller, Project, TaskRecord, Transaction } from '@merv/contracts';
import type { Experiment } from '@merv/experiments/types';
import type { CodeCapture } from '@merv/code-research/types';
import type {} from 'cordis';

/** No publication writer exists yet. */
export interface KnowledgePublication {
  status: 'none';
  reflection: null;
  lenses: [];
}
export interface KnowledgeRecords {
  formatVersion: 1;
  /** Current Scope facts, including introduction when configured; independent of publication. */
  project: Project;
  tasks: TaskRecord[];
  experiments: Experiment[];
  publication: KnowledgePublication;
}
export type KnowledgeReferenceKind =
  | 'task'
  | 'experiment'
  | 'artifact'
  | 'review'
  | 'code-proposal'
  | 'code-capture'
  | 'published-reflection'
  | 'published-lens';
export interface KnowledgeReference {
  ref: string;
  status: 'resolved' | 'missing' | 'unsupported' | 'unpublished' | 'unavailable';
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
