/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE event_consumers (
        id TEXT PRIMARY KEY, definition_hash TEXT NOT NULL, cursor BIGINT NOT NULL,
        attempts BIGINT NOT NULL DEFAULT 0, error TEXT, retry_at BIGINT NOT NULL DEFAULT 0
      );
`,
};
