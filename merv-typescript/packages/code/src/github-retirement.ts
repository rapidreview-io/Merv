import type { State } from '@merv/contracts';

// Published migration SQL is retained verbatim. No GitHub client or credential reader remains.
const schema = `
CREATE TABLE code_github (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  user_json TEXT,
  repository_json TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  credentials TEXT,
  refresh_id TEXT,
  refresh_until TEXT
);
CREATE TABLE code_github_flows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('pending','ready','exchanging','complete')),
  payload TEXT NOT NULL
);
CREATE INDEX code_github_flows_project ON code_github_flows(project_id);
`;

const automation = `ALTER TABLE code_github ADD COLUMN owner_source TEXT;
ALTER TABLE code_github ADD COLUMN automation TEXT NOT NULL DEFAULT 'off' CHECK (automation IN ('off','read','write'));
ALTER TABLE code_github ADD COLUMN base_branch TEXT;`;

export const githubConnectionMigrations = [
  { version: 1, sql: schema },
  { version: 2, sql: automation },
  { version: 3, sql: `DROP TABLE code_github_flows; DROP TABLE code_github;` },
];

export async function retireGitHubConnections(state: State): Promise<void> {
  await state.migrate('code_github', githubConnectionMigrations);
  // An admitted import already owns its bytes and finishes through the local journal. A
  // receiving import has no retained result, and is retired without any external request.
  await state.migrate('code_github_retirement', [
    {
      version: 1,
      sql: `
UPDATE code_operations SET status='failed',error='github_integration_retired',
 completed_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 updated_at=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),phase='retired',claim_id=NULL,claim_until=NULL
WHERE status='prepared' AND (kind IN ('mirror-work','mirror-base','mirror-retained')
 OR (kind='import' AND payload_json::jsonb->>'source'='github' AND phase='receiving'));
`,
    },
  ]);
}
