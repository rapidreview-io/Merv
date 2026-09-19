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
}
