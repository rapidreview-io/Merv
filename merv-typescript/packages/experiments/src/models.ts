import type { CodeCaptureRef, WorkflowSnapshot } from '@merv/contracts/types';

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
  /** The workflow revision the transition is made from; any other revision is refused. */
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
  workflow: WorkflowSnapshot;
  attempt: ExperimentAttempt;
  attempts: ExperimentAttempt[];
  evidence: ExperimentEvidence[];
  submissions: ExperimentSubmission[];
  reviewId: string | null;
  conclusion: string | null;
  captureArtifactIds?: string[];
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
