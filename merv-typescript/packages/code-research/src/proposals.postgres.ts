import { postgresGuard } from '@merv/code/postgres-guard';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE code_proposals (
 _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK(revision>0),
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  UNIQUE(project_id,instance_id,revision),
  UNIQUE(project_id,session_id,request_id)
);
CREATE INDEX code_proposals_project ON code_proposals(project_id,instance_id,revision);
${postgresGuard('code_proposals', 'no_update', 'UPDATE', 'Code proposals are immutable')}
${postgresGuard('code_proposals', 'no_delete', 'DELETE', 'Code proposals are retained')}
`,
};
