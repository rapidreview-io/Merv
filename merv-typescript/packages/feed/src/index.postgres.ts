/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE feed_posts (
        sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, author_id TEXT NOT NULL,
        body TEXT NOT NULL, artifact_ids TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX feed_posts_project_sequence ON feed_posts(project_id, sequence);
      CREATE TABLE feed_requests (
        project_id TEXT NOT NULL, author_id TEXT NOT NULL, request_id TEXT NOT NULL,
        input_hash TEXT NOT NULL, response_json TEXT NOT NULL,
        PRIMARY KEY(project_id, author_id, request_id)
      );
      CREATE OR REPLACE FUNCTION feed_posts_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Feed posts are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER feed_posts_no_update BEFORE UPDATE ON feed_posts
FOR EACH ROW EXECUTE FUNCTION feed_posts_no_update_guard();
      CREATE OR REPLACE FUNCTION feed_posts_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Feed posts are immutable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER feed_posts_no_delete BEFORE DELETE ON feed_posts
FOR EACH ROW EXECUTE FUNCTION feed_posts_no_delete_guard();
      CREATE OR REPLACE FUNCTION feed_requests_no_update_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Feed request records are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER feed_requests_no_update BEFORE UPDATE ON feed_requests
FOR EACH ROW EXECUTE FUNCTION feed_requests_no_update_guard();
      CREATE OR REPLACE FUNCTION feed_requests_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Feed request records are immutable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER feed_requests_no_delete BEFORE DELETE ON feed_requests
FOR EACH ROW EXECUTE FUNCTION feed_requests_no_delete_guard();
`,
};
