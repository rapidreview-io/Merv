/**
 * Published PostgreSQL migrations. Production pins each text by its digest: never edit one.
 * A worker agent's live stream, kept as a backup of what the page showed: the sweep deletes a
 * session's events 30 days after it ended, and the transcript stays the permanent record.
 */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK(seq > 0),
  at TEXT NOT NULL,
  until BIGINT NOT NULL CHECK(until >= 0),
  event JSONB NOT NULL CHECK(jsonb_typeof(event) = 'object'),
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX session_events_at ON session_events(at);
`,
};
