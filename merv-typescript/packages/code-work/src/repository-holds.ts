import type { State, Transaction } from '@merv/contracts';

/** Work-unit policy projects durable technical holds through Code's transactional API. */
export async function initializeWorkHolds(state: State): Promise<void> {
  await state.migrate('code_research_repository_holds', [
    {
      version: 1,
      sql: `
CREATE FUNCTION research_base_repository_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.state NOT IN ('resolved','cancelled','suspended') OR NEW.check_state IN ('queued','running') THEN
    PERFORM code_hold_repository(NEW.project_id,'research:base:' || NEW.base_key,'A retained research base is unresolved or its check is running');
  ELSE
    PERFORM code_release_repository(NEW.project_id,'research:base:' || NEW.base_key);
  END IF;
  PERFORM code_set_reference_eligibility(NEW.project_id,'mirror-base:' || NEW.base_key,
    CASE WHEN NEW.state='resolved' AND NEW.health='healthy' THEN NULL ELSE 'The retained base is unavailable or quarantined' END);
  RETURN NEW;
END $$;
CREATE TRIGGER research_base_repository_hold AFTER INSERT OR UPDATE ON code_bases FOR EACH ROW EXECUTE FUNCTION research_base_repository_hold();
CREATE FUNCTION research_publication_repository_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.settled=0 THEN
    PERFORM code_hold_repository(NEW.project_id,'research:publication:' || NEW.proposal_id,'A retained publication is unsettled');
  ELSE
    PERFORM code_release_repository(NEW.project_id,'research:publication:' || NEW.proposal_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_publication_repository_hold AFTER INSERT OR UPDATE ON code_publications FOR EACH ROW EXECUTE FUNCTION research_publication_repository_hold();
`,
    },
  ]);
}

export async function backfillWorkHolds(tx: Transaction): Promise<void> {
  for (const row of await tx.all<{
    project_id: string;
    base_key: string;
    state: string;
    check_state: string;
    health: string;
  }>('SELECT project_id,base_key,state,check_state,health FROM code_bases')) {
    await tx.run(
      'SELECT code_set_reference_eligibility(?,?,?)',
      row.project_id,
      `mirror-base:${row.base_key}`,
      row.state === 'resolved' && row.health === 'healthy'
        ? null
        : 'The retained base is unavailable or quarantined',
    );
    if (
      !['resolved', 'cancelled', 'suspended'].includes(row.state) ||
      ['queued', 'running'].includes(row.check_state)
    )
      await tx.run(
        'SELECT code_hold_repository(?,?,?)',
        row.project_id,
        `research:base:${row.base_key}`,
        'A retained research base is unresolved or its check is running',
      );
  }
  for (const row of await tx.all<{ project_id: string; proposal_id: string }>(
    'SELECT project_id,proposal_id FROM code_publications WHERE settled=0',
  ))
    await tx.run(
      'SELECT code_hold_repository(?,?,?)',
      row.project_id,
      `research:publication:${row.proposal_id}`,
      'A retained publication is unsettled',
    );
}
