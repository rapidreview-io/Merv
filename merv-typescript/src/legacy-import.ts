import type { State } from '@merv/contracts';

/**
 * The retired offline foundation import recorded its receipts here, and production still holds
 * this table and its migration row. Nothing imports any more; the migration stays registered only
 * so its published hash remains pinned by tests/published-migrations.test.ts.
 */
export async function initializeLegacyFoundationImports(state: State): Promise<void> {
  await state.migrate('legacy-foundation-import', [
    {
      version: 1,
      sql: `CREATE TABLE legacy_foundation_imports (
  source_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL
);
CREATE FUNCTION legacy_foundation_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $merv$
BEGIN RAISE EXCEPTION USING MESSAGE='Import receipts are immutable', ERRCODE='23514'; END;
$merv$;
CREATE TRIGGER legacy_foundation_no_update BEFORE UPDATE OR DELETE ON legacy_foundation_imports
FOR EACH ROW EXECUTE FUNCTION legacy_foundation_immutable_guard();`,
    },
  ]);
}
