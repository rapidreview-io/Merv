import type { PaperProposal } from '@merv/paper/models';
import type { CodeCaptureRef, WorkflowSnapshot } from '@merv/contracts/types';
import type { SandboxComputeOutput } from '@merv/sandboxes/models';

export type ExperimentRole = 'plan' | 'result' | 'report' | 'feasibility' | 'exhibit';
export type ExperimentTransitionName =
  'submit_design' | 'submit_results' | 'retry_running' | 'abandon' | 'mark_failed';
/** What creating another experiment is checked against. */
export interface ExperimentOccupancy {
  names: string[];
  active: number;
}
export interface ExperimentCreate {
  name: string;
  intent: string;
  details?: string;
  dependsOn?: string[];
  /** New experiments always use Git. Retired values remain typed for historical request replay. */
  workspace?: 'none' | 'git';
  /** Historical request replay only; new work derives its base from dependsOn. */
  baseTaskId?: string;
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
  expectedRevision: number;
  evidence?: { reason?: string; detail?: string };
  requestId: string;
}
export interface ExperimentEvidence {
  id: string;
  experimentId: string;
  attemptIndex: number;
  role: ExperimentRole;
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
  /** Present only when explicitly created with the Git program. */
  workspace?: 'git';
  /** Present only when the Git checkout starts from that task's delivered commit. */
  baseTaskId?: string;
  workflow: WorkflowSnapshot;
  attempt: ExperimentAttempt;
  attempts: ExperimentAttempt[];
  evidence: ExperimentEvidence[];
  submissions: ExperimentSubmission[];
  reviewId: string | null;
  conclusion: string | null;
  machines?: import('@merv/contracts/types').Json[];
  captureArtifactIds?: string[];
  compute?: {
    key: string;
    runId: string;
    attemptIndex: number;
    state: string;
    cost: unknown;
    result?: unknown;
    outputs?: SandboxComputeOutput[];
    outputState?: string;
    failureStage?: string;
    reason?: string;
    commit?: string;
    artifactId?: string;
  }[];
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
