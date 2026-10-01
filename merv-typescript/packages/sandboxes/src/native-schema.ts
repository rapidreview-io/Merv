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
];

export interface NativeConnectionRow {
  id: string;
  project_id: string;
  root_id: string;
  account_id: string;
  member_id: string;
  credentials: string;
  connected_at: string;
  revoked_at: string | null;
  revoke_pending: boolean;
}
export interface NativeWorkRow {
  project_id: string;
  work_kind: 'task' | 'experiment';
  work_id: string;
  connection_id: string;
  native_grant_id: string | null;
  namespace: string | null;
  desired_attempt: string | null;
  closed_at: string | null;
  transition_pending: boolean;
  evidence_checked_at: string | null;
  last_error: string | null;
}
export interface NativeAssignmentRow {
  lease_id: string;
  session_id: string;
  project_id: string;
  work_kind: 'task' | 'experiment';
  work_id: string;
  attempt_ref: string;
  profile: 'execute' | 'check';
  expires_at: string;
  credentials: string;
  native_token_id: string | null;
  revoke_pending: boolean;
  revoked_at: string | null;
}
