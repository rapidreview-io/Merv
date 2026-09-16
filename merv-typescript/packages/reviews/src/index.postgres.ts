/** Native PostgreSQL migrations. SQLite migration text remains unchanged in the owner. */
export const postgresMigrations: Record<number, string> = {
  1: `
CREATE TABLE reviews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject_id TEXT NOT NULL,
        subject_revision BIGINT NOT NULL CHECK(subject_revision >= 0), producer_id TEXT NOT NULL,
        artifact_ids TEXT NOT NULL, criteria TEXT NOT NULL, manifest TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('requested','started','submitted','superseded')),
        reviewer_id TEXT, verdict TEXT CHECK(verdict IN ('pass','needs_changes','fail')),
        notes TEXT, created_at TEXT NOT NULL,
        CHECK(reviewer_id IS NULL OR reviewer_id != producer_id)
      );
      CREATE INDEX reviews_project ON reviews(project_id, created_at);
      CREATE TABLE review_commands (
        project_id TEXT NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL,
        operation TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(project_id, actor_id, request_id)
      );
`,
  2: `
CREATE OR REPLACE FUNCTION reviews_snapshot_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'A review snapshot is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_snapshot_immutable BEFORE UPDATE OF project_id, subject_id, subject_revision, producer_id, artifact_ids, criteria, manifest, snapshot_hash, created_at ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_snapshot_immutable_guard();
      CREATE OR REPLACE FUNCTION reviews_verdict_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF OLD.status = 'submitted' THEN
    RAISE EXCEPTION USING MESSAGE = 'A submitted verdict is immutable', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_verdict_immutable BEFORE UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_verdict_immutable_guard();
      CREATE OR REPLACE FUNCTION reviews_no_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Review records are durable', ERRCODE = '23514';
  RETURN OLD;
END;
$merv$;
CREATE TRIGGER reviews_no_delete BEFORE DELETE ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_no_delete_guard();
`,
  3: `
ALTER TABLE reviews ADD COLUMN claim_id TEXT;
        ALTER TABLE reviews ADD COLUMN claim_generation BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE reviews ADD COLUMN recovery_json TEXT;
        UPDATE reviews SET claim_id='legacy:' || id, claim_generation=1 WHERE status='started';
        CREATE INDEX reviews_open_claims ON reviews(project_id,reviewer_id) WHERE status='started';
`,
  4: `
ALTER TABLE reviews ADD COLUMN format_version BIGINT NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
        ALTER TABLE reviews ADD COLUMN synopsis TEXT;
        ALTER TABLE reviews ADD COLUMN findings_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE reviews ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
        CREATE OR REPLACE FUNCTION reviews_format_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'A review snapshot is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_format_immutable BEFORE UPDATE OF format_version ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_format_immutable_guard();
`,
  5: `
ALTER TABLE reviews ADD COLUMN administrative_actor_id TEXT;
        ALTER TABLE reviews ADD COLUMN pinned_input_ids TEXT NOT NULL DEFAULT '[]';
        CREATE OR REPLACE FUNCTION reviews_provenance_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Review provenance is immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_provenance_immutable BEFORE UPDATE OF administrative_actor_id,pinned_input_ids ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_provenance_immutable_guard();
`,
  6: `
ALTER TABLE reviews ADD COLUMN return_to TEXT CHECK(
          return_to IS NULL OR (
            length(return_to) BETWEEN 1 AND 128 AND
            substring(return_to,1,1) ~ '^[A-Za-z]$' AND
            return_to !~ '[^A-Za-z0-9_.-]'
          )
        );
`,
  7: `
ALTER TABLE reviews ADD COLUMN excluded_actor_ids TEXT CHECK(
          excluded_actor_ids IS NULL OR ((excluded_actor_ids IS JSON) AND jsonb_typeof(excluded_actor_ids::jsonb)='array')
        );
        CREATE OR REPLACE FUNCTION reviews_contributors_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Review contributor exclusions are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_contributors_immutable BEFORE UPDATE OF excluded_actor_ids ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_contributors_immutable_guard();
        CREATE OR REPLACE FUNCTION reviews_contributors_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.reviewer_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.excluded_actor_ids,'[]')::jsonb) AS excluded(value) WHERE value=NEW.reviewer_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'A contributor cannot review their submission', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_contributors_insert BEFORE INSERT ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_contributors_insert_guard();
        CREATE OR REPLACE FUNCTION reviews_contributors_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NEW.reviewer_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.excluded_actor_ids,'[]')::jsonb) AS excluded(value) WHERE value=NEW.reviewer_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'A contributor cannot review their submission', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_contributors_claim BEFORE UPDATE OF reviewer_id ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_contributors_claim_guard();
`,
};
