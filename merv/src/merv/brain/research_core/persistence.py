# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research-owned tables.

Every work node and its evidence: claims, experiments, tasks, reflections and
their waves, reviews, candidates, the literature ledger, the links from
immutable artifact content to the node it belongs to, and the facts Research
keeps about heavy objects the sandbox service stores.
"""

from __future__ import annotations

from ..kernel.state.schema import (
    Connection,
    Migration,
    SchemaModule,
    has_column,
    has_table,
)


RESEARCH_DDL = """\
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  confidence TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 1,
  revision_context TEXT NOT NULL DEFAULT '',
  conclusion TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- What the creator asked for beyond the one-line intent: free prose the
  -- plan must answer, empty when the intent was the whole brief.
  details TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS experiment_claims (
  experiment_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(experiment_id, claim_id)
);

-- Research facts about merv-sandboxes objects: the producing
-- target, the classification and provenance the submitter declared, and the
-- metadata snapshot captured at completion, so experiment views need no
-- service call.
-- The service owns the object; storage_objects above is the retired ledger,
-- kept only for deploy/migrate_storage_ledger.py.
CREATE TABLE IF NOT EXISTS research_objects (
  object_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  producing_run TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  object_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  -- Capability hardening (cloud plan Phase 7): the reviewer capability is
  -- stored HASHED (sha256 of the minted token), never in plaintext. The
  -- plaintext is returned once to the caller at request time; review.start
  -- resolves the request by hashing the presented token and comparing with a
  -- constant-time check. Replaces the pre-Phase-7 plaintext `capability`
  -- column (legacy DBs converge in _ensure_forward_schema).
  capability_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  target_snapshot_id TEXT NOT NULL,
  producer_session_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The record spine every graph-bound row carries. A review never retries, so
  -- its attempt stays 1 and its revision context empty; the shape belongs to the engine.
  attempt_index INTEGER NOT NULL DEFAULT 1,
  revision_context TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  -- Insertion-order column replacing rowid ordering (cloud plan Phase 6).
  created_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  declared_agent TEXT NOT NULL DEFAULT '',
  caller_session_id TEXT NOT NULL DEFAULT '',
  -- Principal binding (cloud plan Phase 7): the authenticated tenant that
  -- started the session, so cross-tenant review hijacking is rejected at
  -- start. Local mode (single tenant, auth off) writes the 'local' tenant —
  -- a no-op. Empty on legacy rows that predate the column.
  tenant_id TEXT NOT NULL DEFAULT '',
  independence TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id) REFERENCES review_requests(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  target_snapshot_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  verdict TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  -- Researcher-facing TLDR (July 2026): 1-3 plain sentences, the first thing
  -- the human reads on the experiment page. Required on new submissions;
  -- empty on rows that predate the column (legacy DBs converge below).
  synopsis TEXT NOT NULL DEFAULT '',
  findings_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  -- Insertion-order column replacing rowid ordering (cloud plan Phase 6).
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- The sealed submission this verdict graded ('' on rows predating the
  -- column, and on reviews of a target that never sealed one). It is what
  -- lets the figure draw round 2 of a report review as a step after round 1
  -- instead of a sibling hanging off the attempt.
  submission_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(request_id) REFERENCES review_requests(id),
  FOREIGN KEY(session_id) REFERENCES review_sessions(id)
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 1,
  revision_context TEXT NOT NULL DEFAULT '',
  -- The declared reflection roster: 5 lenses (3 core + 2 wave-authored), each
  -- {id, title, charter, core, why_distinct}. JSON list, fixed at create.
  roster_json TEXT NOT NULL DEFAULT '[]',
  -- The corpus snapshot taken at create: terminal experiments (id + attempt +
  -- status) and claim statuses at that moment. The reflection review judges the
  -- story against this fixed corpus, and staleness is computed against it.
  corpus_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  -- Version id of the project logic graph association at publish time, so the
  -- single living graph file still yields an immutable per-wave history.
  published_graph_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Insertion-order column replacing rowid ordering (cloud plan Phase 6).
  created_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS reflection_claim_changes (
  reflection_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  op TEXT NOT NULL,
  claim_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(reflection_id, claim_id),
  FOREIGN KEY(reflection_id) REFERENCES reflections(id),
  FOREIGN KEY(claim_id) REFERENCES claims(id)
);

CREATE TABLE IF NOT EXISTS reflection_experiments (
  reflection_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  proposal_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(reflection_id, experiment_id),
  FOREIGN KEY(reflection_id) REFERENCES reflections(id),
  FOREIGN KEY(experiment_id) REFERENCES experiments(id)
);

-- A task is scoped non-experiment work with a verifiable finish line and no
-- claim. Its brief and delivery are artifacts; the row carries
-- only lifecycle. attempt_index is fixed at 1 (the one review return keeps
-- the same attempt) so the artifact and review machinery stays uniform.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  -- The contract: the goal's deliverables as a JSON list of
  -- strings, immutable with the rest of the goal from creation. Pre-53 rows
  -- keep '[]' and fall back to the brief's Done-when checks on read.
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 1,
  revision_context TEXT NOT NULL DEFAULT '',
  -- On done: the accepted outcome note; on failed: the recorded reason.
  outcome TEXT NOT NULL DEFAULT '',
  -- Who ended a failed task: 'reviewer' (fail verdict) or 'owner' (withdrawn).
  failed_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS reflection_tasks (
  reflection_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  proposal_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY(reflection_id, task_id),
  FOREIGN KEY(reflection_id) REFERENCES reflections(id),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

-- The wave DAG: a node (exp_ or task_) that must not start or deliver before
-- another node (exp_ or task_) is done. Edges only ever point at nodes of the
-- same project; the workflow gates read them, the reflection writes them.
CREATE TABLE IF NOT EXISTS node_dependencies (
  project_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(node_id, depends_on_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- One immutable proposal per consolidation revision. The reflection is already
-- authoritative when these rows are written; this is code integration history,
-- never another research-belief workflow.
CREATE TABLE IF NOT EXISTS consolidation_proposals (
  id TEXT PRIMARY KEY,
  reflection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  proposal_sha TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_by_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(reflection_id, revision),
  FOREIGN KEY(reflection_id) REFERENCES reflections(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS consolidation_decisions (
  proposal_id TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('used_as_is', 'adapted', 'reviewed_not_used', 'superseded')
  ),
  rationale TEXT NOT NULL,
  -- The experiment workspace head is supplied by Merv, not trusted from the
  -- consolidating agent. integration_kind is the agent's declared mechanism;
  -- the runner records the independent ancestry result on the advance receipt.
  source_sha TEXT NOT NULL DEFAULT '',
  integration_kind TEXT NOT NULL DEFAULT 'none' CHECK (
    integration_kind IN (
      'merge', 'fast_forward', 'cherry_pick', 'rewrite', 'none'
    )
  ),
  superseded_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY(proposal_id, experiment_id),
  FOREIGN KEY(proposal_id) REFERENCES consolidation_proposals(id),
  FOREIGN KEY(experiment_id) REFERENCES experiments(id)
);

CREATE TABLE IF NOT EXISTS reflection_reserved_names (
  reflection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  artifact_id TEXT NOT NULL DEFAULT '',
  experiment_slots INTEGER NOT NULL DEFAULT 1 CHECK (experiment_slots IN (0, 1)),
  PRIMARY KEY (reflection_id, name_lower),
  FOREIGN KEY(reflection_id) REFERENCES reflections(id)
);

CREATE INDEX IF NOT EXISTS idx_reserved_names_project
  ON reflection_reserved_names(project_id, name_lower);

-- Project candidates are immutable nominations. Artifact/Object Storage
-- sources are already durable; experiment workspaces await one staging event.
-- The optional source experiment is provenance, not ownership, so a starter
-- can have none. Champion changes use append-only events for full lineage.
CREATE TABLE IF NOT EXISTS project_candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('artifact', 'storage_object', 'experiment_workspace')),
  source_ref TEXT NOT NULL,
  source_experiment_id TEXT,
  expected_sha256 TEXT NOT NULL DEFAULT '',
  validation_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, idempotency_key),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(source_experiment_id) REFERENCES experiments(id)
);

-- Literature review (July 2026, dev_docs/litreview_feature_plan.md). One
-- living sectioned document per project: kind='summary' is the General
-- Summary (at most one, enforced by the litreview_one_summary partial index
-- below; ensured lazily on first WRITE — reads never create it), kind='section'
-- are the dynamic theme sections. Rows are mutable envelopes; history is the
-- events table (full post-state per mutation, like claims). ``revision`` is
-- the per-section compare-and-swap counter; reorder bumps every row's
-- revision because position is section state.
CREATE TABLE IF NOT EXISTS litreview_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('summary','section')),
  title TEXT NOT NULL,
  tldr TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, kind, title),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS litreview_one_summary
  ON litreview_sections(project_id) WHERE kind = 'summary';

-- The papers ledger: every external paper the project has cited, deduplicated
-- per project by ``norm_key`` (arxiv:<id-sans-version> | doi:<casefolded> |
-- normalized URL). Metadata comes from the strict paper unfurler;
-- ``fetch_status`` records how ('fetched' beats 'manual' beats 'failed' and
-- is never downgraded).
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  norm_key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  authors_json TEXT NOT NULL DEFAULT '[]',
  year TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL CHECK (source_kind IN ('arxiv','doi','url')),
  fetch_status TEXT NOT NULL CHECK (fetch_status IN ('fetched','manual','failed')),
  created_by TEXT NOT NULL DEFAULT '',
  created_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, norm_key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Citation edges: paper -> lit-review section | experiment | claim. Same-
-- project integrity is enforced in the service write transaction (paper and
-- target are both looked up WHERE project_id = ?); deleting a section deletes
-- its links in the same transaction. The rendered References block is derived
-- from these rows and is never hand-edited.
CREATE TABLE IF NOT EXISTS paper_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  paper_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('litreview_section','experiment','claim')),
  target_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(project_id, paper_id, target_type, target_id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(paper_id) REFERENCES papers(id)
);

-- Research-owned associations between immutable artifact content and the work
-- node it belongs to. `active` marks the current complete row
-- of a slot; sealed predecessors stay reachable through their submission.
CREATE TABLE IF NOT EXISTS research_artifact_links (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  lens_id TEXT NOT NULL DEFAULT '',
  submission_id TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0
);

-- The exact composition one sealed round carried, including files carried
-- forward from an earlier round.
CREATE TABLE IF NOT EXISTS research_submission_artifacts (
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  link_id TEXT NOT NULL REFERENCES research_artifact_links(id),
  PRIMARY KEY (submission_id, link_id)
);

CREATE INDEX IF NOT EXISTS idx_research_artifacts_target
  ON research_artifact_links(project_id, target_type, target_id, attempt_index);
CREATE INDEX IF NOT EXISTS idx_research_artifacts_content
  ON research_artifact_links(artifact_id);

-- The reads one work node makes about itself: wave DAG edges both ways,
-- tasks, candidate order, the proposals under a reflection, and the objects
-- produced against it.
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_node_dependencies_project
  ON node_dependencies(project_id, node_id);
CREATE INDEX IF NOT EXISTS idx_node_dependencies_target
  ON node_dependencies(depends_on_id);
CREATE INDEX IF NOT EXISTS idx_project_candidates_order
  ON project_candidates(project_id, created_seq);
CREATE INDEX IF NOT EXISTS idx_consolidation_proposals_reflection
  ON consolidation_proposals(reflection_id, revision);
CREATE INDEX IF NOT EXISTS idx_research_objects_target
  ON research_objects(project_id, target_type, target_id, status);

-- Every research read of a file joins its link row to the content it names,
-- so the join is a view rather than a query each caller re-spells. Content
-- columns keep the names they carried before the extraction.
CREATE VIEW IF NOT EXISTS research_artifacts AS
SELECT l.id, a.id AS artifact_id, a.project_id,
       l.target_type, l.target_id, l.role, l.attempt_index, l.lens_id,
       a.path, a.title, a.content_sha256, a.size_bytes, a.content_type,
       a.status, a.upload_token, a.expires_at, a.created_by,
       l.created_at, a.updated_at, l.created_seq, l.submission_id, l.active
FROM research_artifact_links l JOIN artifacts a ON a.id = l.artifact_id;
"""

# The tracking columns of a deleted integration. Nothing reads a run id, a run
# name, its status, its artifact URI, when it was created, or the error that
# replaced it, so the experiments row stops carrying them.
_TRACKING_COLUMNS = (
    "mlflow_run_id",
    "mlflow_run_name",
    "mlflow_run_status",
    "mlflow_run_artifact_uri",
    "mlflow_run_created_at",
    "mlflow_run_error",
)


def _drop_tracking_columns(conn: Connection) -> None:
    """Migration 68: an experiment no longer records an external run."""
    if not has_table(conn, "experiments"):
        return
    for column in _TRACKING_COLUMNS:
        if has_column(conn, "experiments", column):
            conn.execute(f"ALTER TABLE experiments DROP COLUMN {column}")


def _hand_advances_to_workspaces(conn: Connection) -> None:
    """Migration 70: a central compare-and-swap receipt is a workspace fact.

    Research decides which accepted work may advance the central ref; carrying
    the receipt of the swap is Agent Sessions' job, so the table moves there
    and its owning row becomes the opaque instance the packet named. This step
    lives here because only research may write the retiring name.
    """
    if not has_table(conn, "reflection_advances"):
        return
    if has_table(conn, "workspace_advances"):
        # The new owner's idempotent DDL landed first on this database; its
        # empty twin gives way to the rows that carry the actual history.
        conn.execute("DROP TABLE workspace_advances")
    conn.execute("ALTER TABLE reflection_advances RENAME TO workspace_advances")
    conn.execute("ALTER TABLE workspace_advances RENAME COLUMN reflection_id TO instance_id")


def _reserve_experiment_slots(conn: Connection) -> None:
    """Keep legacy reservations conservative until their pinned bytes can be read."""
    if has_table(conn, "reflection_reserved_names") and not has_column(conn, "reflection_reserved_names", "experiment_slots"):
        conn.execute("ALTER TABLE reflection_reserved_names ADD COLUMN experiment_slots "
                     "INTEGER NOT NULL DEFAULT 1 CHECK (experiment_slots IN (0, 1))")


def _reviews_join_the_record_spine(conn: Connection) -> None:
    """Migration 72: the review lifecycle is a declared graph, so its row
    carries the same spine every other graph-bound record does."""
    for column, declaration in (("attempt_index", "INTEGER NOT NULL DEFAULT 1"),
                                ("revision_context", "TEXT NOT NULL DEFAULT ''"),
                                ("updated_at", "TEXT NOT NULL DEFAULT ''")):
        if has_table(conn, "review_requests") and not has_column(conn, "review_requests", column):
            conn.execute(f"ALTER TABLE review_requests ADD COLUMN {column} {declaration}")


RESEARCH_SCHEMA = SchemaModule(
    name="research_core",
    ddl=RESEARCH_DDL,
    migrations=(Migration(68, "drop_experiment_tracking_columns", _drop_tracking_columns),
                Migration(70, "hand_advances_to_workspaces", _hand_advances_to_workspaces),
                Migration(71, "reserve_experiment_slots", _reserve_experiment_slots),
                Migration(72, "reviews_join_the_record_spine", _reviews_join_the_record_spine)),
)
