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
import type { CodeCapture, CodeCaptureRef } from '@merv/code/types';
import type {} from 'cordis';

/** No publication writer exists yet. A corpus snapshot is not a published reflection. */
export interface KnowledgePublication {
  status: 'none';
  graph: null;
  reflection: null;
  lenses: [];
}
export interface KnowledgeRecords {
  formatVersion: 1;
  /** Current Scope facts, including introduction when configured; independent of publication. */
  project: Project;
  claims: Claim[];
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
  | 'published-graph'
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
/** Complete terminal source selection, with exact domain metadata and retained associations. */
export interface KnowledgeSelection {
  /** Deliberate TS addition: capture exact project facts as well as research sources. */
  projectFacts: 'pinned-at-capture';
  project: Project;
  claims: Claim[];
  tasks: TaskRecord[];
  experiments: Experiment[];
  assessments: KnowledgeAssessment[];
  artifacts: KnowledgeArtifact[];
  captures: KnowledgeCapture[];
  publication: KnowledgePublication;
  /** Current task pointers, not a claim that every earlier task review round was recovered. */
  taskReviewCoverage: 'current-record-references';
}
export interface KnowledgeSnapshot {
  id: string;
  projectId: string;
  formatVersion: 1;
  createdBy: string;
  createdAt: string;
  /** Last committed/in-transaction event visible before this capture event. */
  sourceEventHead: number;
  selection: KnowledgeSelection;
  /** SHA-256 of formatVersion + selection, excluding capture identity/time/event cursor. */
  manifestHash: string;
}
export interface Knowledge {
  /** Current research-linked evidence; never includes unattached artifacts or reflection outputs. */
  researchReferences(
    caller: Caller,
    tx?: Transaction,
  ): Promise<{ artifacts: string[]; reviews: string[]; experiments: string[] }>;
  records(caller: Caller, tx?: Transaction): Promise<KnowledgeRecords>;
  /** Trusted program integration; intentionally not exposed as an agent tool. */
  capture(
    caller: Caller,
    input: { requestId: string },
    tx?: Transaction,
  ): Promise<KnowledgeSnapshot>;
  get(caller: Caller, snapshotId: string, tx?: Transaction): Promise<KnowledgeSnapshot>;
  /** IDs or explicit kind:id refs; missing scoped records never reveal another project. */
  resolve(caller: Caller, refs: string[], tx?: Transaction): Promise<KnowledgeReference[]>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    knowledge: Knowledge;
  }
}
