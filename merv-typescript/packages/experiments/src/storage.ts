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
      postgres: postgresMigrations[1],
      sql: `
CREATE TABLE experiments (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL COLLATE NOCASE,
 intent TEXT NOT NULL,details TEXT NOT NULL,owner_id TEXT NOT NULL,created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,tested_claim_ids TEXT NOT NULL,attempt_index INTEGER NOT NULL CHECK(attempt_index>0),
 review_id TEXT,conclusion TEXT,UNIQUE(project_id,name)
);
CREATE INDEX experiments_project ON experiments(project_id,created_at,id);
CREATE TRIGGER experiments_identity_immutable BEFORE UPDATE OF id,project_id,name,intent,details,owner_id,created_by,created_at,tested_claim_ids ON experiments BEGIN SELECT RAISE(ABORT,'Experiment definition is immutable'); END;
CREATE TRIGGER experiments_no_delete BEFORE DELETE ON experiments BEGIN SELECT RAISE(ABORT,'Experiments are retained'); END;
CREATE TABLE experiment_attempts (
 experiment_id TEXT NOT NULL,attempt_index INTEGER NOT NULL,started_revision INTEGER NOT NULL,
 ended_revision INTEGER,previous_index INTEGER,feedback TEXT NOT NULL,
 approved_submission_id TEXT,approved_review_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(experiment_id,attempt_index)
);
CREATE TRIGGER experiment_attempt_identity BEFORE UPDATE OF experiment_id,attempt_index,started_revision,previous_index,created_at ON experiment_attempts BEGIN SELECT RAISE(ABORT,'Attempt identity is immutable'); END;
CREATE TRIGGER experiment_attempt_approval BEFORE UPDATE OF approved_submission_id,approved_review_id ON experiment_attempts WHEN OLD.approved_submission_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Approved plan is immutable'); END;
CREATE TRIGGER experiment_attempt_no_delete BEFORE DELETE ON experiment_attempts BEGIN SELECT RAISE(ABORT,'Attempts are retained'); END;
CREATE TABLE experiment_evidence (
 id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,attempt_index INTEGER NOT NULL,
 role TEXT NOT NULL,path TEXT NOT NULL,sequence INTEGER NOT NULL,record TEXT NOT NULL,
 UNIQUE(experiment_id,sequence)
);
CREATE INDEX experiment_evidence_target ON experiment_evidence(experiment_id,attempt_index,role,path);
CREATE TRIGGER experiment_evidence_immutable BEFORE UPDATE ON experiment_evidence BEGIN SELECT RAISE(ABORT,'Evidence associations are immutable'); END;
CREATE TRIGGER experiment_evidence_no_delete BEFORE DELETE ON experiment_evidence BEGIN SELECT RAISE(ABORT,'Evidence associations are retained'); END;
CREATE TABLE experiment_slots (
 experiment_id TEXT NOT NULL,attempt_index INTEGER NOT NULL,role TEXT NOT NULL,path TEXT NOT NULL,evidence_id TEXT NOT NULL,
 PRIMARY KEY(experiment_id,attempt_index,role,path)
);
CREATE TABLE experiment_submissions (
 id TEXT PRIMARY KEY,experiment_id TEXT NOT NULL,attempt_index INTEGER NOT NULL,stage TEXT NOT NULL,
 round INTEGER NOT NULL,review_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,
 UNIQUE(experiment_id,attempt_index,stage,round)
);
CREATE TRIGGER experiment_submission_immutable BEFORE UPDATE ON experiment_submissions BEGIN SELECT RAISE(ABORT,'Submission snapshots are immutable'); END;
CREATE TRIGGER experiment_submission_no_delete BEFORE DELETE ON experiment_submissions BEGIN SELECT RAISE(ABORT,'Submission snapshots are retained'); END;
CREATE TABLE experiment_commands (
 project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result TEXT NOT NULL,
 PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE TRIGGER experiment_command_immutable BEFORE UPDATE ON experiment_commands BEGIN SELECT RAISE(ABORT,'Command receipts are immutable'); END;
CREATE TRIGGER experiment_command_no_delete BEFORE DELETE ON experiment_commands BEGIN SELECT RAISE(ABORT,'Command receipts are retained'); END;
`,
    },
    {
      version: 2,
      postgres: postgresMigrations[2],
      sql: `ALTER TABLE experiment_attempts ADD COLUMN feedback_review_ids TEXT NOT NULL DEFAULT '[]';`,
    },
    {
      version: 3,
      postgres: postgresMigrations[3],
      sql: `ALTER TABLE experiments ADD COLUMN workspace TEXT NOT NULL DEFAULT 'none' CHECK(workspace IN ('none','git'));
CREATE TRIGGER experiment_workspace_immutable BEFORE UPDATE OF workspace ON experiments BEGIN SELECT RAISE(ABORT,'Experiment workspace selection is immutable'); END;`,
    },
  ]);
}
