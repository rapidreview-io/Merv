import type { State } from '@merv/contracts';

/** Retained merge plans, results and check receipts remain readable without their executor. */
const postgres = `
CREATE TABLE code_bases (
  project_id TEXT NOT NULL,
  base_key TEXT NOT NULL,
  members_json TEXT NOT NULL,
  left_key TEXT NOT NULL,
  right_key TEXT NOT NULL,
  engine TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting_inputs','queued','running','retry_wait','blocked_infra','awaiting_resolution','resolved','suspended','cancelled')),
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','quarantined')),
  result_json TEXT,
  conflict_json TEXT,
  resolution_task_id TEXT,
  attempts BIGINT NOT NULL DEFAULT 0,
  next_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id,base_key),
  CHECK ((state='resolved')=(result_json IS NOT NULL))
);
CREATE UNIQUE INDEX code_bases_resolution ON code_bases(resolution_task_id) WHERE resolution_task_id IS NOT NULL;
CREATE INDEX code_bases_due ON code_bases(state,next_at);
CREATE FUNCTION code_bases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Base records are retained'; END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.base_key IS DISTINCT FROM OLD.base_key OR NEW.members_json IS DISTINCT FROM OLD.members_json OR NEW.left_key IS DISTINCT FROM OLD.left_key OR NEW.right_key IS DISTINCT FROM OLD.right_key OR NEW.engine IS DISTINCT FROM OLD.engine THEN
    RAISE EXCEPTION 'The plan of a base is frozen';
  END IF;
  IF OLD.result_json IS NOT NULL AND NEW.result_json IS DISTINCT FROM OLD.result_json THEN
    RAISE EXCEPTION 'The result of a base is recorded once';
  END IF;
  IF OLD.resolution_task_id IS NOT NULL AND NEW.resolution_task_id IS DISTINCT FROM OLD.resolution_task_id THEN
    RAISE EXCEPTION 'A base has one resolution task';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_guard BEFORE UPDATE OR DELETE ON code_bases
  FOR EACH ROW EXECUTE FUNCTION code_bases_guard();

ALTER TABLE code_bases ADD COLUMN resolution_error TEXT;
ALTER TABLE code_bases ADD COLUMN resolution_commit TEXT;
CREATE FUNCTION code_bases_acceptance_guard() RETURNS trigger AS $$ BEGIN
IF (OLD.resolution_commit IS NOT NULL AND NEW.resolution_commit IS DISTINCT FROM OLD.resolution_commit) OR (NEW.resolution_commit IS NOT NULL AND NEW.resolution_task_id IS NULL) THEN RAISE EXCEPTION 'A resolution acceptance is recorded once for its task'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_acceptance BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_acceptance_guard();
ALTER TABLE code_bases ADD COLUMN execution_epoch BIGINT NOT NULL DEFAULT 0;
ALTER TABLE code_bases ADD COLUMN deadline TEXT;
ALTER TABLE code_bases ADD COLUMN sponsors_json TEXT;
ALTER TABLE code_bases ADD COLUMN blocker TEXT;
ALTER TABLE code_bases ADD COLUMN operator_reason TEXT;
ALTER TABLE code_bases ADD COLUMN resume_state TEXT;
CREATE FUNCTION code_bases_sponsors_guard() RETURNS trigger AS $$ BEGIN
IF OLD.sponsors_json IS NOT NULL AND NEW.sponsors_json IS DISTINCT FROM OLD.sponsors_json THEN RAISE EXCEPTION 'Base sponsorship is frozen'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_sponsors BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_sponsors_guard();`;

/**
 * The project check of a base. The published words and the two pairings are CHECK
 * constraints; a guard records the receipt once. There is no insert guard: `ensure` is the
 * only inserter and writes no check column, so the defaults already satisfy both pairings.
 */
const postgresChecks = `
ALTER TABLE code_bases ADD COLUMN check_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE code_bases ADD COLUMN check_job_json TEXT;
ALTER TABLE code_bases ADD COLUMN check_json TEXT;
ALTER TABLE code_bases ADD CONSTRAINT code_bases_check_state CHECK (check_state IN ('none','queued','running','unavailable','passed','failed','skipped'));
ALTER TABLE code_bases ADD CONSTRAINT code_bases_check_recorded CHECK ((check_json IS NOT NULL) = (check_state IN ('passed','failed','skipped')));
ALTER TABLE code_bases ADD CONSTRAINT code_bases_check_seal CHECK (state<>'resolved' OR check_state<>'failed' OR resolution_commit IS NOT NULL);
CREATE FUNCTION code_bases_check_guard() RETURNS trigger AS $$ BEGIN
IF OLD.check_json IS NOT NULL AND NEW.check_json IS DISTINCT FROM OLD.check_json THEN RAISE EXCEPTION 'The check of a base is recorded once'; END IF;
RETURN NEW; END $$ LANGUAGE plpgsql;
CREATE TRIGGER code_bases_check BEFORE UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION code_bases_check_guard();`;

/** Keep deployed migration text unchanged; the research adapter supplies execution policy. */
export async function migrateBases(state: State): Promise<void> {
  await state.migrate('code_bases', [
    { version: 1, sql: postgres },
    // No backfill: an already resolved base keeps check_state 'none', which both new
    // constraints admit. Inventing a verdict for work nobody checked would be permanent,
    // because the verdict of a base is recorded once.
    { version: 2, sql: postgresChecks },
  ]);
}
