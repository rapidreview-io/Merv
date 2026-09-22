import type { Artifact, Caller, Transaction, WorkflowSnapshot } from '@merv/contracts';
import type {
  CodeProposal,
  CodeCandidateSet,
  CodeCandidateDecision,
  CodeDecisionManifest,
  CodeReconciliation,
} from '@merv/code/types';
import type {} from 'cordis';

export interface ConsolidationDecision {
  experimentId: string;
  decision: 'retain' | 'adapt' | 'drop' | 'no_code';
  rationale: string;
}
/** What one consolidation may carry; the numbers live beside the schemas that enforce them. */
export interface ConsolidationLimits {
  sourceArtifactIds: number;
  experimentIds: number;
  dependsOn: number;
}
export interface ConsolidationCreate {
  sourceArtifactIds: string[];
  /** The decision scope selected by the originating workflow. */
  experimentIds?: string[];
  name: string;
  /** Explicit opt-in while version 5 is unreleased; default routing remains unchanged. */
  version?: 5;
  /** Tasks produced by the cycle, including those no selected experiment depends on. */
  taskIds?: string[];
  workspace?: 'none' | 'git';
  dependsOn?: string[];
  requestId: string;
}
export interface ConsolidationSubmit {
  consolidationId: string;
  expectedRevision: number;
  reportArtifactId: string;
  evidenceArtifactIds?: string[];
  decisions: (ConsolidationDecision | CodeCandidateDecision)[];
  reconciliations?: CodeReconciliation[];
  /** Required in Git mode; an exact successful code.commit receipt from this worker. */
  commandId?: string;
  requestId: string;
}
/** Ending a consolidation that cannot continue. Terminal; the reason is recorded. */
export interface ConsolidationEnd {
  consolidationId: string;
  expectedRevision: number;
  outcome: 'abandoned' | 'failed';
  reason: string;
  requestId: string;
}
export interface ConsolidationSubmission {
  id: string;
  revision: number;
  reviewId: string;
  producerId: string;
  sessionId: string | null;
  createdAt: string;
  report: Artifact;
  evidence: Artifact[];
  decisions: (ConsolidationDecision | CodeCandidateDecision)[];
  proposal: CodeProposal | null;
  manifest?: CodeDecisionManifest;
}
export interface ConsolidationRecord {
  id: string;
  projectId: string;
  name: string;
  ownerId: string;
  createdAt: string;
  workspace: 'none' | 'git';
  sources: Artifact[];
  experimentIds: string[];
  taskIds?: string[];
  candidates?: CodeCandidateSet;
  workflow: WorkflowSnapshot;
  reviewId: string | null;
  submissions: ConsolidationSubmission[];
  /** Immutable reviewed output. This does not claim a central Git branch was advanced. */
  completion: {
    submissionId: string;
    reviewId: string;
    completedAt: string;
    centralGit: 'not-published' | 'not-applicable';
  } | null;
}
export interface Consolidation {
  /** What one consolidation may carry, so a parent can check before it composes one. */
  readonly limits: ConsolidationLimits;
  create(
    caller: Caller,
    input: ConsolidationCreate,
    tx?: Transaction,
  ): Promise<ConsolidationRecord>;
  get(caller: Caller, id: string, tx?: Transaction): Promise<ConsolidationRecord>;
  list(caller: Caller, tx?: Transaction): Promise<ConsolidationRecord[]>;
  submit(
    caller: Caller,
    input: ConsolidationSubmit,
    tx?: Transaction,
  ): Promise<ConsolidationRecord>;
  end(caller: Caller, input: ConsolidationEnd, tx?: Transaction): Promise<ConsolidationRecord>;
  approved(caller: Caller, id: string, tx?: Transaction): Promise<ConsolidationRecord>;
  close(): void;
}
declare module 'cordis' {
  interface Context {
    consolidation: Consolidation;
  }
}
