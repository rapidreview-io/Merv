import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';

export async function migrateKnowledge(state: State): Promise<void> {
  await state.migrate('knowledge', [
    {
      version: 1,
      postgres: postgresMigrations[1],
      sql: `
CREATE TABLE knowledge_snapshots (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 format_version INTEGER NOT NULL CHECK(format_version=1), manifest_hash TEXT NOT NULL,
 record TEXT NOT NULL CHECK(json_valid(record))
);
CREATE INDEX knowledge_snapshots_project ON knowledge_snapshots(project_id,created_at,id);
CREATE TRIGGER knowledge_snapshots_no_update BEFORE UPDATE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'Knowledge snapshots are immutable'); END;
CREATE TRIGGER knowledge_snapshots_no_delete BEFORE DELETE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'Knowledge snapshots are retained'); END;
CREATE TABLE knowledge_commands (
 project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
 PRIMARY KEY(project_id,actor_id,request_id)
);
CREATE TRIGGER knowledge_commands_no_update BEFORE UPDATE ON knowledge_commands
BEGIN SELECT RAISE(ABORT,'Knowledge command receipts are immutable'); END;
CREATE TRIGGER knowledge_commands_no_delete BEFORE DELETE ON knowledge_commands
BEGIN SELECT RAISE(ABORT,'Knowledge command receipts are retained'); END;
`,
    },
  ]);
}
