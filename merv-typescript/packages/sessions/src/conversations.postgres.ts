/**
 * Published PostgreSQL migrations. Production pins each text by its digest: never edit one.
 * One row per continuity key: the latest closed session of the key, its agent, and the
 * conversation it kept once its runner declares one. The objects it names stay in the store.
 */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE session_conversations (
  project_id TEXT NOT NULL REFERENCES projects(id),
  continuity_key TEXT NOT NULL CHECK(length(continuity_key) BETWEEN 1 AND 512),
  session_id TEXT NOT NULL REFERENCES worker_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  harness TEXT CHECK(harness IN ('claude','codex')),
  conversation_id TEXT,
  sha256 TEXT CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  size BIGINT CHECK(size > 0 AND size <= 67108864),
  updated_at TEXT NOT NULL,
  uploaded_at TEXT,
  PRIMARY KEY(project_id, continuity_key),
  CHECK((harness IS NULL) = (sha256 IS NULL) AND (sha256 IS NULL) = (size IS NULL) AND
        (size IS NULL) = (conversation_id IS NULL) AND (uploaded_at IS NULL OR sha256 IS NOT NULL))
);
CREATE INDEX session_conversations_session ON session_conversations(session_id);
CREATE INDEX session_conversations_updated ON session_conversations(updated_at);
`,
};
