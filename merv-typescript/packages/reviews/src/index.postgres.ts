import {
  retiredInstancesSql,
  retiredPlanTaskIds,
  retiredPlanTasksSql,
  withoutTriggers,
} from '@merv/contracts/retired-instances';

/** Published PostgreSQL migrations. Production pins each text by its digest: never edit one. */
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
  8: `
ALTER TABLE reviews ADD COLUMN required_criteria TEXT CHECK(
          required_criteria IS NULL OR ((required_criteria IS JSON) AND jsonb_typeof(required_criteria::jsonb)='array')
        );
        CREATE OR REPLACE FUNCTION reviews_required_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  RAISE EXCEPTION USING MESSAGE = 'Required review criteria are immutable', ERRCODE = '23514';
  RETURN NEW;
END;
$merv$;
CREATE TRIGGER reviews_required_immutable BEFORE UPDATE OF required_criteria ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_required_immutable_guard();
`,
  9: `ALTER TABLE reviews ADD COLUMN provenance_json TEXT CHECK(
    provenance_json IS NULL OR ((provenance_json IS JSON) AND COALESCE((provenance_json::jsonb ->> 'formatVersion')='1',false))
  );
  CREATE FUNCTION reviews_certificate_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION USING MESSAGE = 'Review provenance certificate is immutable', ERRCODE = '23514';
  END; $$;
  CREATE TRIGGER reviews_certificate_immutable BEFORE UPDATE OF provenance_json ON reviews
    FOR EACH ROW EXECUTE FUNCTION reviews_certificate_immutable_guard();`,
  // Deletes the reviews of retired workflow instances. Format 1 was reached only by omission and
  // is retired with them, so none may remain.
  10: `${retiredInstancesSql}
DELETE FROM review_commands WHERE result::jsonb->>'id' IN
  (SELECT id FROM reviews WHERE subject_id IN (SELECT id FROM wf_retired_instances));
${withoutTriggers(
  'reviews',
  ['reviews_no_delete'],
  `DELETE FROM reviews WHERE subject_id IN (SELECT id FROM wf_retired_instances);`,
)}
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM reviews WHERE format_version=1) THEN
    RAISE EXCEPTION USING MESSAGE = 'Format 1 reviews remain', ERRCODE = '23514';
  END IF;
END $check$;`,
  // The project's owner may claim a review as owner past the producer and contributor exclusions,
  // which keep binding every other claim. Version 1's unnamed check is found by what it says.
  11: `ALTER TABLE reviews ADD COLUMN owner_override BOOLEAN NOT NULL DEFAULT false;
DO $drop$
DECLARE name TEXT;
BEGIN
  FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='reviews'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%reviewer_id <> producer_id%' LOOP
    EXECUTE format('ALTER TABLE reviews DROP CONSTRAINT %I', name);
  END LOOP;
END $drop$;
ALTER TABLE reviews ADD CONSTRAINT reviews_reviewer_check CHECK(CASE WHEN owner_override
  THEN reviewer_id IS NOT NULL ELSE reviewer_id IS NULL OR reviewer_id <> producer_id END);
CREATE OR REPLACE FUNCTION reviews_contributors_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN
  IF NOT NEW.owner_override AND NEW.reviewer_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.excluded_actor_ids,'[]')::jsonb) AS excluded(value) WHERE value=NEW.reviewer_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'A contributor cannot review their submission', ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$merv$;
DROP TRIGGER reviews_contributors_claim ON reviews;
CREATE TRIGGER reviews_contributors_claim BEFORE UPDATE OF reviewer_id, owner_override ON reviews
FOR EACH ROW EXECUTE FUNCTION reviews_contributors_claim_guard();`,
  // Deletes the reviews of retired experiment.plan tasks.
  12: `${retiredPlanTasksSql}
DELETE FROM review_commands WHERE result::jsonb->>'id' IN
  (SELECT id FROM reviews WHERE subject_id IN (${retiredPlanTaskIds}));
${withoutTriggers(
  'reviews',
  ['reviews_no_delete'],
  `DELETE FROM reviews WHERE subject_id IN (${retiredPlanTaskIds});`,
)}`,
};
