import { postgresMigrations } from './storage.postgres.js';
import type { State } from '@merv/contracts';
export async function migratePaper(state: State): Promise<void> {
  await state.migrate('paper', [
    {
      version: 1,
      postgres: postgresMigrations[1],
      sql: `
CREATE TABLE paper_revisions(project_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(project_id,kind,revision));
CREATE TRIGGER paper_revisions_immutable BEFORE UPDATE ON paper_revisions BEGIN SELECT RAISE(ABORT,'Paper revisions are immutable'); END;
CREATE TRIGGER paper_revisions_retained BEFORE DELETE ON paper_revisions BEGIN SELECT RAISE(ABORT,'Paper revisions are retained'); END;
CREATE TABLE paper_citations(id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,identifier TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE INDEX paper_citations_project ON paper_citations(project_id,id,revision);
CREATE TRIGGER paper_citations_immutable BEFORE UPDATE ON paper_citations BEGIN SELECT RAISE(ABORT,'Citation revisions are immutable'); END;
CREATE TRIGGER paper_citations_retained BEFORE DELETE ON paper_citations BEGIN SELECT RAISE(ABORT,'Citation revisions are retained'); END;
CREATE TABLE paper_updates(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,base_revision INTEGER NOT NULL,corpus_id TEXT NOT NULL,record TEXT NOT NULL);
CREATE TRIGGER paper_updates_immutable BEFORE UPDATE ON paper_updates BEGIN SELECT RAISE(ABORT,'Paper update inputs are immutable'); END;
CREATE TRIGGER paper_updates_retained BEFORE DELETE ON paper_updates BEGIN SELECT RAISE(ABORT,'Paper update inputs are retained'); END;
CREATE TABLE paper_publications(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,update_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL);
CREATE TRIGGER paper_publications_immutable BEFORE UPDATE ON paper_publications BEGIN SELECT RAISE(ABORT,'Paper publications are immutable'); END;
CREATE TRIGGER paper_publications_retained BEFORE DELETE ON paper_publications BEGIN SELECT RAISE(ABORT,'Paper publications are retained'); END;
CREATE TABLE paper_commands(project_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,actor_id,request_id));
CREATE TRIGGER paper_commands_immutable BEFORE UPDATE ON paper_commands BEGIN SELECT RAISE(ABORT,'Paper receipts are immutable'); END;
CREATE TRIGGER paper_commands_retained BEFORE DELETE ON paper_commands BEGIN SELECT RAISE(ABORT,'Paper receipts are retained'); END;
CREATE TABLE paper_leases(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,update_id TEXT NOT NULL,actor_id TEXT NOT NULL,revision INTEGER NOT NULL,receipt TEXT NOT NULL,released_at TEXT);
CREATE UNIQUE INDEX paper_live_lease ON paper_leases(project_id,update_id) WHERE released_at IS NULL;
CREATE TRIGGER paper_leases_immutable BEFORE UPDATE OF id,project_id,update_id,actor_id,revision,receipt ON paper_leases BEGIN SELECT RAISE(ABORT,'Paper lease provenance is immutable'); END;
CREATE TRIGGER paper_leases_retained BEFORE DELETE ON paper_leases BEGIN SELECT RAISE(ABORT,'Paper leases are retained'); END;
`,
    },
    {
      version: 2,
      postgres: postgresMigrations[2],
      sql: `
CREATE TABLE paper_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,record TEXT NOT NULL,acceptance TEXT);
CREATE TRIGGER paper_proposal_immutable BEFORE UPDATE OF id,project_id,record ON paper_proposals BEGIN SELECT RAISE(ABORT,'Paper proposals are immutable'); END;
CREATE TRIGGER paper_acceptance_immutable BEFORE UPDATE ON paper_proposals WHEN OLD.acceptance IS NOT NULL BEGIN SELECT RAISE(ABORT,'Accepted paper proposals are immutable'); END;
CREATE TRIGGER paper_proposal_retained BEFORE DELETE ON paper_proposals BEGIN SELECT RAISE(ABORT,'Paper proposals are retained'); END;
`,
    },
  ]);
}
