import type { WorkflowSnapshot } from '@merv/contracts/types';
import type { PaperRevision } from '@merv/paper/models';

export interface ResearchCreate {
  name: string;
  /** Existing project work selected by the coordinator, not automatically invented. */
  dependsOn?: string[];
  /** New cycles: none finishes after reflection; git adds implementation and review. */
  consolidationWorkspace?: 'none' | 'git';
  consolidationDependsOn?: string[];
  requestId: string;
}
export interface ResearchAdvance {
  researchId: string;
  expectedRevision: number;
  requestId: string;
}
/** The cycle's selected work, reselected whole: what is missing is added, what is left out is dropped. */
/** Ending a cycle that cannot reach an answer. Terminal; the reason is recorded. */
export interface ResearchEnd extends ResearchAdvance {
  outcome: 'abandoned' | 'failed';
  reason: string;
}
export interface ResearchReplan extends ResearchAdvance {
  dependsOn: string[];
}
/** Where a cycle opened from an approved reflection plan came from, pinned when it was created. */
export interface ResearchOrigin {
  /** The cycle whose completion created this one. */
  researchId: string;
  reflectionId: string;
  reviewId: string;
  changeSpec: { id: string; hash: string };
  /** The plan's items as the records they became. */
  items: { key: string; kind: 'task' | 'experiment'; id: string }[];
  carriedOver: string[];
}
export interface ResearchRecord {
  id: string;
  projectId: string;
  ownerId: string;
  name: string;
  createdAt: string;
  researchDependencies: string[];
  consolidationWorkspace: 'none' | 'git';
  consolidationDependencies: string[];
  workflow: WorkflowSnapshot;
  /** Exact definition accepted on leaving the defining stage. */
  problem: PaperRevision | null;
  reflectionId: string | null;
  consolidationId: string | null;
  /** Null for a cycle somebody created by hand. */
  origin: ResearchOrigin | null;
  /** The cycle this one's approved plan opened, if it did. */
  successorId: string | null;
}
