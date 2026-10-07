/** Only bindings and unfinished transition intents. Native resource records stay
 * in Sandboxes; this is not another machine/job ledger. */
export const nativeMigrations = [
  {
    version: 1,
    sql: `
CREATE TABLE sandbox_native_connections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  credentials TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_pending BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE sandbox_native_projects (
  project_id TEXT PRIMARY KEY,
  connection_id TEXT REFERENCES sandbox_native_connections(id)
);
CREATE TABLE sandbox_native_flows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  operator_ref TEXT NOT NULL,
  previous_connection_id TEXT,
  browser_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  code TEXT,
  completed_at TEXT,
  reconcile_after TEXT
);
CREATE TABLE sandbox_native_work (
  project_id TEXT NOT NULL,
  work_kind TEXT NOT NULL CHECK (work_kind IN ('task','experiment')),
  work_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES sandbox_native_connections(id),
  native_grant_id TEXT,
  namespace TEXT,
  desired_attempt TEXT,
  closed_at TEXT,
  transition_pending BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_checked_at TEXT,
  last_error TEXT,
  PRIMARY KEY (project_id,work_kind,work_id)
);
CREATE TABLE sandbox_native_revoked_leases (
  lease_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL
);
CREATE TABLE sandbox_native_assignments (
  lease_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  work_kind TEXT NOT NULL,
  work_id TEXT NOT NULL,
  attempt_ref TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('execute','check')),
  expires_at TEXT NOT NULL,
  credentials TEXT NOT NULL,
  native_token_id TEXT,
  revoke_pending BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TEXT,
  FOREIGN KEY (project_id,work_kind,work_id)
    REFERENCES sandbox_native_work(project_id,work_kind,work_id)
);
CREATE INDEX sandbox_native_assignment_work ON sandbox_native_assignments(project_id,work_kind,work_id);
CREATE INDEX sandbox_native_work_reconcile ON sandbox_native_work(transition_pending,evidence_checked_at);
CREATE TABLE sandbox_native_captures (
  connection_id TEXT NOT NULL REFERENCES sandbox_native_connections(id),
  namespace TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(connection_id,namespace,workflow_id,node_id)
);
`,
  },
  {
    version: 2,
    sql: `
ALTER TABLE sandbox_native_connections ADD COLUMN billing_subject TEXT;
ALTER TABLE sandbox_native_flows ADD COLUMN billing_subject TEXT;
CREATE UNIQUE INDEX sandbox_native_managed_flow ON sandbox_native_flows(project_id)
 WHERE billing_subject IS NOT NULL AND completed_at IS NULL;
`,
  },
  {
    // Compute is a capability of any workflow's assignment: work_kind now holds the workflow
    // name. epoch_revision is the instance revision desired_attempt was last derived at, so an
    // epoch only ever moves forward; existing rows take their instance's current revision.
    version: 3,
    sql: `
ALTER TABLE sandbox_native_work DROP CONSTRAINT sandbox_native_work_work_kind_check;
ALTER TABLE sandbox_native_work ADD CONSTRAINT sandbox_native_work_workflow
  CHECK (work_kind ~ '^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$');
ALTER TABLE sandbox_native_work ADD COLUMN epoch_revision INTEGER;
DO $$
BEGIN
  IF to_regclass('wf_instances') IS NOT NULL THEN
    UPDATE sandbox_native_work w SET epoch_revision=i.revision FROM wf_instances i
    WHERE i.id=w.work_id AND i.project_id=w.project_id AND i.workflow=w.work_kind;
  END IF;
END $$;
`,
  },
  {
    // The compute epoch a capture was taken under, so an owner can keep one attempt's.
    version: 4,
    sql: `ALTER TABLE sandbox_native_captures ADD COLUMN attempt_ref TEXT;`,
  },
  {
    // The native work kind the owner declares when it binds compute, kept for the background
    // reconcile, which has no session. Existing rows take the kind they were sent until now.
    version: 5,
    sql: `ALTER TABLE sandbox_native_work ADD COLUMN native_kind TEXT;
UPDATE sandbox_native_work SET native_kind=CASE WHEN work_kind IN ('task','experiment') THEN work_kind ELSE 'task' END;`,
  },
  {
    // A Capture that can never register is recorded as refused, with its error and no collection,
    // so its work rests. Every existing row is a registered collection. Read-only prod check, before
    // (expect 0) and the work this lets rest after five passes:
    //   SELECT count(*) FROM sandbox_native_captures WHERE artifact_id IS NULL;
    //   SELECT count(*) FROM sandbox_native_work WHERE last_error='Native evidence registration is pending';
    version: 6,
    sql: `ALTER TABLE sandbox_native_captures ALTER COLUMN artifact_id DROP NOT NULL;
ALTER TABLE sandbox_native_captures ADD COLUMN error TEXT;
ALTER TABLE sandbox_native_captures ADD CONSTRAINT sandbox_native_captures_outcome
  CHECK ((artifact_id IS NULL) <> (error IS NULL));`,
  },
];

export interface NativeConnectionRow {
  id: string;
  project_id: string;
  root_id: string;
  billing_subject: string | null;
  account_id: string;
  member_id: string;
  credentials: string;
  connected_at: string;
  revoked_at: string | null;
  revoke_pending: boolean;
}
export interface NativeWorkRow {
  project_id: string;
  /** The workflow name. */
  work_kind: string;
  work_id: string;
  connection_id: string;
  native_grant_id: string | null;
  namespace: string | null;
  desired_attempt: string | null;
  closed_at: string | null;
  epoch_revision: number | null;
  transition_pending: boolean;
  evidence_checked_at: string | null;
  last_error: string | null;
  /** The native work kind its owner declared when it bound compute. */
  native_kind: string | null;
}
export interface NativeAssignmentRow {
  lease_id: string;
  session_id: string;
  project_id: string;
  work_kind: string;
  work_id: string;
  attempt_ref: string;
  profile: 'execute' | 'check';
  expires_at: string;
  credentials: string;
  native_token_id: string | null;
  revoke_pending: boolean;
  revoked_at: string | null;
}
