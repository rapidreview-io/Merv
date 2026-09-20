import type { PaperProposal } from '@merv/paper/models';
import type { CodeCaptureRef, WorkflowSnapshot } from '@merv/contracts/types';

export type ExperimentRole = 'plan' | 'result' | 'report' | 'feasibility' | 'exhibit';
/** Retired roles stay readable: stored rows predate the 2026-09-16 graph retirement. */
export type StoredExperimentRole = ExperimentRole | 'graph';
export type ExperimentTransitionName =
  'submit_design' | 'submit_results' | 'retry_running' | 'abandon' | 'mark_failed';
export interface ExperimentCreate {
  name: string;
  intent: string;
  details?: string;
  testedClaimIds?: string[];
  dependsOn?: string[];
  /** Omission preserves the original scratch program and command hashes. */
  workspace?: 'none' | 'git';
  requestId: string;
}
export interface ExperimentAttach {
  experimentId: string;
  artifactId: string;
  role: Exclude<ExperimentRole, 'exhibit'>;
  path: string;
  attemptIndex: number;
  expectedRevision: number;
  resultFormat?: 'json' | 'qualitative';
  requestId: string;
}
export interface ExperimentTransition {
  experimentId: string;
  transition: ExperimentTransitionName;
  /** JSON document changes reviewed with this result submission. */
  paperChangesArtifactId?: string;
  expectedRevision: number;
  evidence?: { reason?: string; detail?: string };
  requestId: string;
}
export interface ExperimentEvidence {
  id: string;
  experimentId: string;
  attemptIndex: number;
  role: StoredExperimentRole;
  path: string;
  artifactId: string;
  hash: string;
  /** Retained image references resolved when attaching a plan or report. */
  figureIds: string[];
  createdBy: string;
  sessionId: string | null;
  createdAt: string;
  sequence: number;
  current: boolean;
  resultFormat?: 'json' | 'qualitative';
  systemGenerated: boolean;
}
export interface ExperimentSubmission {
  paperProposal?: PaperProposal;
  id: string;
  experimentId: string;
  attemptIndex: number;
  stage: 'design' | 'results';
  /** Exact future final observation, fixed before the producing session hands off. */
  codeCaptureRef?: CodeCaptureRef;
  round: number;
  subjectRevision: number;
  producerId: string;
  sessionId: string | null;
  evidence: ExperimentEvidence[];
  /** Verified image inputs referenced by the selected plan/report. */
  figureIds: string[];
  manifestHash: string;
  reviewId: string;
  createdAt: string;
}
export interface ExperimentAttempt {
  index: number;
  startedRevision: number;
  endedRevision: number | null;
  previousIndex: number | null;
  feedback: string[];
  /** Exact rejected assessments retained as context, never substitutes for new outputs. */
  feedbackReviewIds: string[];
  approvedSubmissionId: string | null;
  approvedReviewId: string | null;
  /** Derived from the first actual running work-start in this attempt's revision interval. */
  startedAt: string | null;
  createdAt: string;
}
/** All fields here are metadata; artifact bytes and the exhibit document use separate reads. */
export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  intent: string;
  details: string;
  ownerId: string;
  createdBy: string;
  createdAt: string;
  testedClaimIds: string[];
  /** Present only when explicitly created with the Git program. */
  workspace?: 'git';
  workflow: WorkflowSnapshot;
  attempt: ExperimentAttempt;
  attempts: ExperimentAttempt[];
  evidence: ExperimentEvidence[];
  submissions: ExperimentSubmission[];
  reviewId: string | null;
  conclusion: string | null;
}
export interface ExperimentExhibit {
  experimentId: string;
  attemptIndex: number;
  path: string;
  content: string;
  hash: string;
  willPin: boolean;
  sources: ExperimentEvidence[];
  startedAt: string | null;
}
