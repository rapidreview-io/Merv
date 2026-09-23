import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';
import type { ExperimentAttempt, ExperimentSubmission } from './types.js';
export interface ExperimentRow {
  id: string;
  project_id: string;
  name: string;
  intent: string;
  details: string;
  owner_id: string;
  created_by: string;
  created_at: string;
  workspace: 'none' | 'git';
  attempt_index: number;
  review_id: string | null;
  conclusion: string | null;
}
export interface AttemptRow {
  experiment_id: string;
  attempt_index: number;
  started_revision: number;
  ended_revision: number | null;
  previous_index: number | null;
  feedback: string;
  feedback_review_ids: string;
  approved_submission_id: string | null;
  approved_review_id: string | null;
  created_at: string;
}
export const attemptMetadata = (r: AttemptRow): ExperimentAttempt => ({
  index: r.attempt_index,
  startedRevision: r.started_revision,
  endedRevision: r.ended_revision,
  previousIndex: r.previous_index,
  feedback: JSON.parse(r.feedback),
  feedbackReviewIds: JSON.parse(r.feedback_review_ids),
  approvedSubmissionId: r.approved_submission_id,
  approvedReviewId: r.approved_review_id,
  startedAt: null,
  createdAt: r.created_at,
});
export interface SubmissionRow {
  record: string;
}
export const submissionMetadata = (r: SubmissionRow): ExperimentSubmission => JSON.parse(r.record);
export async function migrateExperiments(state: State): Promise<void> {
  await state.migrate('experiments', [
    {
      version: 1,
      sql: postgresMigrations[1],
    },
    {
      version: 2,
      sql: postgresMigrations[2],
    },
    {
      version: 3,
      sql: postgresMigrations[3],
    },
    {
      version: 4,
      sql: postgresMigrations[4],
    },
  ]);
}
