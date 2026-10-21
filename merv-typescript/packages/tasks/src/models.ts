import type {
  WorkflowDecision,
  WorkflowDependency,
  WorkflowSnapshot,
  WorkflowWorkStart,
} from '@merv/workflows/models';

/** A task as Tasks keeps it and every reader reads it: portable, with no server code. */
export interface Task {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  checks: string[];
  evidenceVersion: 2;
  acceptanceChecks: { number: number; text: string }[];
  deliveryConfirmations: TaskConfirmation[];
  deliveryAssessmentId: string | null;
  producerId: string;
  briefId: string;
  deliveryIds: string[];
  reviewId: string | null;
  workflow: WorkflowSnapshot;
  /** Ended done, or ended any other way: Workflows' word for its own end, never read from a state name. */
  settled: boolean;
  failed: boolean;
  guidance: WorkflowDecision;
  failure: TaskFailure | null;
  dependencies: WorkflowDependency[];
  dependents: WorkflowDependency[];
  workStarts: WorkflowWorkStart[];
  createdAt: string;
  type: string;
  typeVersion: number;
  contextInputs: Record<string, string[]>;
  /** Present only on a Git task, so every earlier record reads back unchanged. */
  workspace?: 'git';
  /** The accepted Git task whose delivered commit is the base of this task's checkout. */
  baseTaskId?: string;
  /** The immutable code evidence the current delivery names; the review pins its rendered record. */
  deliveryCode?: TaskDeliveryCode;
  deliveryCodeArtifactId?: string;
  /**
   * The brief is the one Tasks composed from the title, the goal and the checks, so it says
   * nothing the record does not. Work contexts embed the record without it. Absent on a
   * receipt kept before Tasks sent it, which reads as not composed.
   */
  composed?: boolean;
}
/**
 * Submission content is resolved from its immutable receipt after the producer stops. Never
 * label attachment-time OIDs as submitted content. Historical commit deliveries retain theirs.
 */
export type TaskDeliveryCode = {
  sessionId: string;
  /** The producing task revision; later revisions never move it. */
  revision: number;
} & (
  | {
      ref: { kind: 'code-commit'; commandId: string };
      headOid: string;
      treeOid: string | null;
    }
  | {
      ref: { kind: 'submission'; sessionId: string };
    }
);
export interface TaskFailure {
  reason: string;
  actorId: string;
  createdAt: string;
  reviewId: string | null;
}
/** Domain metadata only; safe to compose without evaluating interactive guidance. */
export type TaskRecord = Omit<Task, 'guidance'>;
export type TaskConfirmation = {
  checkNumber: number;
  status: 'met' | 'not_met';
  evidenceIds: string[];
  notes: string;
};
