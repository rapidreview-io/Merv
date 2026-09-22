import type {
  Artifact,
  Caller,
  Project,
  ReviewRequest,
  TaskRecord,
  Transaction,
} from '@merv/contracts';
import type { Claim } from '@merv/claims/types';
import type { Experiment } from '@merv/experiments/types';
import type { CodeCapture, CodeCaptureRef } from '@merv/code-research/types';
import type {} from 'cordis';

/** No publication writer exists yet. A corpus snapshot is not a published reflection. */
export interface KnowledgePublication {
  status: 'none';
  reflection: null;
  lenses: [];
}
export interface KnowledgeRecords {
  formatVersion: 1;
  /** Current Scope facts, including introduction when configured; independent of publication. */
  project: Project;
  /** Read-only records retained from the retired claims feature. */
  archivedClaims: Claim[];
  tasks: TaskRecord[];
  experiments: Experiment[];
  publication: KnowledgePublication;
}
export type KnowledgeReferenceKind =
  | 'claim'
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
export type KnowledgeArtifact =
  { id: string; status: 'retained'; artifact: Artifact } | { id: string; status: 'missing' };
export type KnowledgeAssessment =
  { id: string; status: 'retained'; review: ReviewRequest } | { id: string; status: 'missing' };
export type KnowledgeCapture =
  | { ref: CodeCaptureRef; status: 'observed'; capture: CodeCapture }
  | { ref: CodeCaptureRef; status: 'missing' | 'unavailable' };
/** The research sources behind a project's current records, with their retained associations. */
export interface KnowledgeSelection {
  projectFacts: 'pinned-at-capture';
  project: Project;
  /** Present only in historical snapshots. */
  claims?: Claim[];
  tasks: TaskRecord[];
  experiments: Experiment[];
  assessments: KnowledgeAssessment[];
  artifacts: KnowledgeArtifact[];
  captures: KnowledgeCapture[];
  publication: KnowledgePublication;
  /** Current task pointers, not a claim that every earlier task review round was recovered. */
  taskReviewCoverage: 'current-record-references';
}
export interface Knowledge {
  /** Current research-linked evidence; never includes unattached artifacts or reflection outputs. */
  researchReferences(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{ artifacts: string[]; reviews: string[]; experiments: string[] }>;
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
