/** Published publication rows keep their first migration; reviewed rounds add retained facts. */
const additions = `
ALTER TABLE code_publications ADD COLUMN stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1));
ALTER TABLE code_publications ADD COLUMN successor TEXT;
ALTER TABLE code_publications ADD COLUMN verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1));
ALTER TABLE code_publications ADD COLUMN incident_json TEXT;
CREATE TABLE code_review_acceptances(project_id TEXT NOT NULL,unit_id TEXT NOT NULL,review_id TEXT PRIMARY KEY,acceptance_json TEXT NOT NULL,accepted_at TEXT NOT NULL);
CREATE TABLE code_publication_controls(project_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE code_publication_requests(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
`;
const guards = [
  ['code_review_acceptances', 'UPDATE', '', 'Reviewed acceptances are immutable'],
  ['code_review_acceptances', 'DELETE', '', 'Reviewed acceptances are retained'],
  [
    'code_publications',
    'UPDATE',
    "NEW.proposal_id <> OLD.proposal_id OR NEW.project_id <> OLD.project_id OR NEW.record_json <> OLD.record_json OR (OLD.verified=1 AND NEW.merge_json IS DISTINCT FROM OLD.merge_json) OR (OLD.review_json IS NOT NULL AND NEW.review_json IS DISTINCT FROM OLD.review_json) OR (OLD.binding_json <> 'null' AND NEW.binding_json <> OLD.binding_json) OR (OLD.successor IS NOT NULL AND NEW.successor IS DISTINCT FROM OLD.successor) OR (OLD.incident_json IS NOT NULL AND NEW.incident_json IS DISTINCT FROM OLD.incident_json) OR NEW.stale < OLD.stale OR NEW.verified < OLD.verified",
    'Publication facts are immutable',
  ],
  ['code_publications', 'DELETE', '', 'Publications are retained'],
  ['code_publication_requests', 'UPDATE', '', 'Publication requests are immutable'],
  ['code_publication_requests', 'DELETE', '', 'Publication requests are retained'],
];
export const publicationMigration = {
  version: 2,
  sql:
    additions +
    guards
      .map(
        ([table, event, condition, message], i) =>
          `CREATE TRIGGER publication_guard_${i} BEFORE ${event} ON ${table} ${condition ? `WHEN ${condition.replaceAll('IS DISTINCT FROM', 'IS NOT')}` : ''} BEGIN SELECT RAISE(ABORT,'${message}'); END;`,
      )
      .join('\n'),
  postgres:
    additions +
    guards
      .map(
        ([table, event, condition, message], i) =>
          `CREATE FUNCTION publication_guard_${i}() RETURNS trigger LANGUAGE plpgsql AS $merv$ BEGIN ${condition ? `IF ${condition} THEN` : ''} RAISE EXCEPTION USING MESSAGE='${message}', ERRCODE='23514'; ${condition ? 'END IF;' : ''} RETURN NEW; END; $merv$; CREATE TRIGGER publication_guard_${i} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION publication_guard_${i}();`,
      )
      .join('\n'),
};
