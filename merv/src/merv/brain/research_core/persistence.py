# If you update this file, you must consult research_core.md to see whether research_core.md needs to be updated. research_core.md must not exceed 100 lines.
"""Research-owned tables and the ladder steps that shaped them.

Every work node and its evidence: claims, experiments, tasks, reflections and
their waves, reviews, candidates, the literature ledger, the links from
immutable artifact content to the node it belongs to, and the facts Research
keeps about heavy objects the sandbox service stores.

The migrations here also carry the pre-ledger SQLite convergence for these
tables (migration 12) and the two historical extractions — resources into
artifacts (24/25) and artifacts into content plus Research links (59).
"""

from __future__ import annotations

from ..kernel.secret_tokens import hash_secret
from ..kernel.state.schema import (
    Connection,
    Migration,
    Row,
    SchemaModule,
    ensure_columns,
    has_column,
    has_table,
    is_sqlite,
    table_ddl,
)
from ..kernel.utils import new_id


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
  mlflow_run_id TEXT NOT NULL DEFAULT '',
  mlflow_run_name TEXT NOT NULL DEFAULT '',
  mlflow_run_status TEXT NOT NULL DEFAULT '',
  mlflow_run_artifact_uri TEXT NOT NULL DEFAULT '',
  mlflow_run_created_at TEXT,
  mlflow_run_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  -- Migration 54 appended this column, so it stays last to keep a migrated
  -- schema and this fresh DDL byte-identical after normalization.
  updated_at TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS experiment_claims (
  experiment_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(experiment_id, claim_id)
);

-- Research facts about merv-sandboxes objects (migration 61): the producing
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
-- claim (migration 51). Its brief and delivery are artifacts; the row carries
-- only lifecycle. attempt_index is fixed at 1 (the one review return keeps
-- the same attempt) so the artifact and review machinery stays uniform.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL,
  -- The contract (migration 53): the goal's deliverables as a JSON list of
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

-- Git and the database cannot commit atomically. Intent is durable first, the
-- runner performs one compare-and-swap, and settle is idempotently replayed
-- from the observed central ref after a crash.
CREATE TABLE IF NOT EXISTS reflection_advances (
  id TEXT PRIMARY KEY,
  reflection_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE,
  expected_sha TEXT NOT NULL,
  target_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intended', 'bound', 'stale', 'failed')),
  observed_sha TEXT NOT NULL DEFAULT '',
  runner_id TEXT NOT NULL,
  proposal_parents_json TEXT NOT NULL DEFAULT '[]',
  diffstat_json TEXT NOT NULL DEFAULT '{}',
  ancestry_json TEXT NOT NULL DEFAULT '{}',
  intended_at TEXT NOT NULL,
  bound_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(reflection_id) REFERENCES reflections(id),
  FOREIGN KEY(proposal_id) REFERENCES consolidation_proposals(id)
);

CREATE TABLE IF NOT EXISTS reflection_reserved_names (
  reflection_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  artifact_id TEXT NOT NULL DEFAULT '',
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
-- node it belongs to (migration 59). `active` marks the current complete row
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
"""

# Rebuild shape for the legacy `review_requests` table whose `capability`
# column carried a column-level UNIQUE (cloud plan Phase 7). SQLite cannot drop
# such a column in place, so copy into this shape — `capability_hash` replaces
# `capability` — and swap. No UNIQUE on capability_hash here: empty-string
# placeholders during the row-by-row rehash would collide under it; fresh DBs
# get the UNIQUE constraint from the DDL above.
_REVIEW_REQUESTS_REBUILD_DDL = """
CREATE TABLE review_requests_migrate (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  capability_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  target_snapshot_id TEXT NOT NULL,
  producer_session_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
"""

_EXPERIMENT_MLFLOW_COLUMNS = {
    "mlflow_run_id": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_name": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_status": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_artifact_uri": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_created_at": "TEXT",
    "mlflow_run_error": "TEXT NOT NULL DEFAULT ''",
}

# Migration 24's own legacy-role map (frozen here: the shared vocabulary no
# longer carries aliases). 'graph' is legacy only on reflection targets —
# experiment logic graphs legitimately keep the role.
_MIGRATION_24_LEGACY_ROLES = {
    "reflection": "reflection_lens_doc",
    "synthesis_doc": "reflection_doc",
    "proposals": "change_spec",
}

_RESEARCH_ARTIFACTS_VIEW = """
CREATE VIEW research_artifacts AS
SELECT l.id, a.id AS artifact_id, a.project_id,
       l.target_type, l.target_id, l.role, l.attempt_index, l.lens_id,
       a.path, a.title, a.content_sha256, a.size_bytes, a.content_type,
       a.status, a.upload_token, a.expires_at, a.created_by,
       l.created_at, a.updated_at, l.created_seq, l.submission_id, l.active
FROM research_artifact_links l JOIN artifacts a ON a.id = l.artifact_id
"""


def _canonical_artifact_role(*, role: str, target_type: str) -> str:
    if target_type == "reflection" and role == "graph":
        return "project_graph"
    return _MIGRATION_24_LEGACY_ROLES.get(role, role)


def _migrate_capability_hash(conn: Connection) -> None:
    """Pre-Phase-7 SQLite: review_requests.capability (plaintext) -> capability_hash.

    Those stores kept the minted capability in plaintext under a column-level
    UNIQUE column, which SQLite cannot drop in place, so the table is rebuilt:
    `capability_hash` replaces `capability`, backfilled with the sha256 of the
    existing plaintext so already-issued tokens still resolve. A request whose
    plaintext was empty converges to the empty-string hash, which no presented
    token matches — voided, must be re-requested (documented acceptable cost).
    """
    if not is_sqlite(conn) or not has_column(conn, "review_requests", "capability"):
        return
    seq = "created_seq" if has_column(conn, "review_requests", "created_seq") else "rowid"
    conn.execute("DROP TABLE IF EXISTS review_requests_migrate")
    conn.execute(_REVIEW_REQUESTS_REBUILD_DDL)
    conn.execute(
        f"""
        INSERT INTO review_requests_migrate (
          id, project_id, target_type, target_id, role, reason,
          capability_hash, status, target_snapshot_id,
          producer_session_id, expires_at, created_at, created_seq
        )
        SELECT
          id, project_id, target_type, target_id, role, reason,
          '', status, target_snapshot_id, producer_session_id,
          expires_at, created_at, {seq}
        FROM review_requests
        """
    )
    # SQLite has no portable sha256(); rehash row-by-row in Python.
    for row in conn.execute("SELECT id, capability FROM review_requests").fetchall():
        conn.execute(
            "UPDATE review_requests_migrate SET capability_hash = ? WHERE id = ?",
            (hash_secret(str(row["capability"] or "")), row["id"]),
        )
    conn.execute("DROP TABLE review_requests")
    conn.execute("ALTER TABLE review_requests_migrate RENAME TO review_requests")


def _add_experiment_mlflow_run_columns(conn: Connection) -> None:
    """Migration 12: the MLflow run identity columns, and — for a SQLite store
    old enough to predate the ledger — every research column and insertion
    order value that reached fresh schemas without a step of its own.
    """
    if is_sqlite(conn):
        _migrate_capability_hash(conn)
        # The accepted conclusion is persisted on `complete`; the short unique
        # name doubles as the folder name (empty on rows that predate it).
        ensure_columns(
            conn,
            "experiments",
            {"conclusion": "TEXT NOT NULL DEFAULT ''", "name": "TEXT NOT NULL DEFAULT ''"},
        )
        # Stage-routed rejections record which stage a rejection sent the work
        # back to; empty on passes and on rows that predate the column.
        ensure_columns(conn, "reviews", {"return_to": "TEXT NOT NULL DEFAULT ''"})
        # Review sessions keep a tenant column so future auth can scope review
        # starts without reshaping legacy rows.
        ensure_columns(conn, "review_sessions", {"tenant_id": "TEXT NOT NULL DEFAULT ''"})
        # Explicit insertion order replaces `ORDER BY rowid` so the same queries
        # run on Postgres. The two resource tables are here only until migration
        # 25 drops them: migration 24's ORDER BY reads their created_seq first.
        for table in (
            "resource_versions",
            "resource_associations",
            "review_requests",
            "reviews",
            "reflections",
        ):
            if "created_seq" in ensure_columns(
                conn, table, {"created_seq": "INTEGER NOT NULL DEFAULT 0"}
            ):
                conn.execute(f"UPDATE {table} SET created_seq = rowid")
    ensure_columns(conn, "experiments", _EXPERIMENT_MLFLOW_COLUMNS)


def _add_review_synopsis(conn: Connection) -> None:
    """Migration 13: the researcher-facing synopsis on a verdict."""
    ensure_columns(conn, "reviews", {"synopsis": "TEXT NOT NULL DEFAULT ''"})


def _adopt_legacy_table(conn: Connection, *, old: str, new: str) -> bool:
    """Rename ``old`` into ``new``, discarding an empty twin the DDL created.

    A database old enough to still hold ``old`` gets its DDL before this step
    when none of the module's modern tables exist yet, so the twin is the
    freshly created empty one, not data.
    """
    if not has_table(conn, old):
        return False
    if has_table(conn, new):
        rows = conn.execute(f"SELECT COUNT(*) AS n FROM {new}").fetchone()
        if int(rows["n"]):
            return False
        conn.execute(f"DROP TABLE {new}")
    conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
    return True


def _rename_syntheses_to_reflections(conn: Connection) -> None:
    """Migration 15: the wave table was formerly named syntheses. Row ids and
    payload keys keep their legacy spelling."""
    _adopt_legacy_table(conn, old="syntheses", new="reflections")


def _rename_synthesis_wave_tables(conn: Connection) -> None:
    """Move legacy synthesis_* wave-relation tables to reflection_*."""
    for old, new in (
        ("synthesis_claim_changes", "reflection_claim_changes"),
        ("synthesis_experiments", "reflection_experiments"),
    ):
        _adopt_legacy_table(conn, old=old, new=new)
        if has_table(conn, new) and has_column(conn, new, "synthesis_id"):
            conn.execute(f"ALTER TABLE {new} RENAME COLUMN synthesis_id TO reflection_id")


def _unify_synthesis_to_reflection(conn: Connection) -> None:
    """Migration 19: retire the synthesis wave vocabulary from persisted state.

    Fresh schemas already carry the reflection_* shapes, so every step is
    guarded or a naturally idempotent UPDATE. The snapshot-id rewrites are
    surgical (prefix swap + pipe-delimited status segment) so resource tokens
    embedding legacy roles like synthesis_doc stay byte-identical — those must
    keep matching the association rows they pinned.
    """
    _rename_synthesis_wave_tables(conn)
    if not has_table(conn, "reflections"):
        return
    conn.execute(
        "UPDATE reflections SET status = 'reflection_review' WHERE status = 'synthesis_review'"
    )
    # Events history: type prefix, target_type, and the known payload
    # vocabulary. String-level JSON rewrites are deliberate — the payload shapes
    # are known and `synthesizing` (the phase, which stays) matches none.
    conn.execute(
        "UPDATE events SET type = 'reflection.' || SUBSTR(type, LENGTH('synthesis.') + 1) "
        "WHERE type LIKE ?",
        ("synthesis.%",),
    )
    conn.execute(
        "UPDATE events SET target_type = 'reflection' WHERE target_type = 'synthesis'"
    )
    conn.execute(
        "UPDATE events SET payload_json = REPLACE(REPLACE(REPLACE(payload_json, "
        "'synthesis_review', 'reflection_review'), "
        "'submit_synthesis', 'submit_reflection_artifacts'), "
        "'source_synthesis_id', 'source_reflection_id') "
        "WHERE payload_json LIKE ?",
        ("%synthesis%",),
    )
    # Reviews and their capabilities: the persisted target_type plus the
    # byte-compared snapshot ids, so a pass recorded before the rename still
    # satisfies its gate.
    for table in ("reviews", "review_requests"):
        conn.execute(
            f"UPDATE {table} SET target_snapshot_id = "
            "'reflection' || SUBSTR(target_snapshot_id, LENGTH('synthesis') + 1) "
            "WHERE target_snapshot_id LIKE ?",
            ("synthesis|%",),
        )
        conn.execute(
            f"UPDATE {table} SET target_snapshot_id = "
            "REPLACE(target_snapshot_id, '|synthesis_review|', '|reflection_review|') "
            "WHERE target_snapshot_id LIKE ?",
            ("%|synthesis_review|%",),
        )
        conn.execute(
            f"UPDATE {table} SET target_type = 'reflection' WHERE target_type = 'synthesis'"
        )
    # Guarded: fresh post-cut schemas never create resource_associations;
    # migration 24 backfills it into artifacts and 25 drops it.
    if has_table(conn, "resource_associations"):
        conn.execute(
            "UPDATE resource_associations SET target_type = 'reflection' "
            "WHERE target_type = 'synthesis'"
        )


def _create_table(conn: Connection, table: str) -> None:
    if not has_table(conn, table):
        conn.execute(table_ddl(table=table))


def _add_litreview_sections(conn: Connection) -> None:
    """Migration 20: the literature review's sections."""
    _create_table(conn, "litreview_sections")


def _add_litreview_papers(conn: Connection) -> None:
    """Migration 21: the papers ledger."""
    _create_table(conn, "papers")


def _add_litreview_paper_links(conn: Connection) -> None:
    """Migration 22: citations from a section or work node to a paper."""
    _create_table(conn, "paper_links")


def _add_litreview_summary_unique_index(conn: Connection) -> None:
    """Migration 23: at most one summary section per project."""
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS litreview_one_summary\n"
        "  ON litreview_sections(project_id) WHERE kind = 'summary'"
    )


def _add_artifacts_tables(conn: Connection) -> None:
    """Migration 24: create the artifact tables and backfill from resources.

    Metadata-only: every gated/result blob already lives in the blob store
    keyed by (project_id, sha256), so one artifact row per association
    (resource x version x target) carries the story forward. Legacy role
    spellings are canonicalized here — post-cut readers (and the UI) know only
    the canonical vocabulary — and the snapshot-token rewrite emits the
    canonical role so pinned passing reviews keep matching. Fresh databases hit
    only the IF-NOT-EXISTS creates — the resource tables are empty, so every
    backfill loop is a no-op.
    """
    conn.execute(table_ddl(table="artifacts"))
    conn.execute(table_ddl(table="artifact_figures"))
    if not has_table(conn, "resource_associations"):
        return
    rows = conn.execute(
        """
        SELECT a.target_type, a.target_id, a.role, a.attempt_index,
               a.version_id, a.created_at, a.created_seq,
               r.id AS resource_id, r.project_id, r.path, r.title,
               r.created_by,
               v.content_sha256, v.size_bytes, v.content_type
        FROM resource_associations a
        JOIN resources r ON r.id = a.resource_id
        LEFT JOIN resource_versions v ON v.id = a.version_id
        ORDER BY a.created_seq
        """
    ).fetchall()
    # (resource, version, target, legacy role, attempt) -> (artifact id,
    # canonical role), for snapshot tokens — the version keeps a review pinned
    # to a superseded version stale instead of reviving it;
    # (version, target) -> [(artifact id, canonical role)], for figures and
    # published-graph refs (shared versions keep every artifact).
    by_assoc: dict[tuple[str, str, str, str, str, int], tuple[str, str]] = {}
    by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]] = {}
    # One artifact per new-model slot: an old DB could legally hold a legacy AND
    # a canonical role spelling for the same resource/target/attempt, which
    # canonicalize into one slot. Winner: the association already spelled
    # canonically, else the newer one; every duplicate still maps to the
    # survivor below so snapshot-token rewrites and figure fan-out resolve.
    prepared: list[tuple[Row, str, str, str, tuple]] = []
    winners: dict[tuple, int] = {}
    for row in rows:
        path = str(row["path"] or "")
        role = str(row["role"] or "")
        canonical = _canonical_artifact_role(
            role=role, target_type=str(row["target_type"])
        )
        basename = path.rsplit("/", 1)[-1]
        lens_id = basename.rsplit(".", 1)[0] if canonical == "reflection_lens_doc" else ""
        slot = (
            str(row["project_id"]),
            str(row["target_type"]),
            str(row["target_id"]),
            canonical,
            int(row["attempt_index"] or 0),
            lens_id,
            path,
        )
        prepared.append((row, role, canonical, lens_id, slot))
        held = winners.get(slot)
        held_was_canonical = held is not None and prepared[held][1] == prepared[held][2]
        if held is None or not (held_was_canonical and role != canonical):
            winners[slot] = len(prepared) - 1  # canonical > legacy > older
    slot_artifact: dict[tuple, str] = {}
    for index in winners.values():
        row, _role, canonical, lens_id, slot = prepared[index]
        path = slot[-1]
        artifact_id = new_id(prefix="art")
        created_at = str(row["created_at"])
        conn.execute(
            """
            INSERT INTO artifacts (
              id, project_id, target_type, target_id, role, attempt_index,
              lens_id, path, title, content_sha256, size_bytes, content_type,
              status, upload_token, created_by, created_at, updated_at,
              created_seq
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', '', ?, ?, ?, ?)
            """,
            (
                artifact_id,
                str(row["project_id"]),
                str(row["target_type"]),
                str(row["target_id"]),
                canonical,
                int(row["attempt_index"] or 0),
                lens_id,
                path,
                str(row["title"] or ""),
                str(row["content_sha256"] or ""),
                int(row["size_bytes"] or 0),
                str(row["content_type"] or ""),
                str(row["created_by"] or ""),
                created_at,
                created_at,
                int(row["created_seq"] or 0),
            ),
        )
        slot_artifact[slot] = artifact_id
    seen_version_artifacts: set[tuple] = set()
    for row, role, canonical, _lens_id, slot in prepared:
        artifact_id = slot_artifact[slot]
        target_key = (str(row["target_type"]), str(row["target_id"]))
        by_assoc[
            (
                str(row["resource_id"]),
                str(row["version_id"] or ""),
                *target_key,
                role,
                int(row["attempt_index"] or 0),
            )
        ] = (artifact_id, canonical)
        if row["version_id"]:
            version_key = (str(row["version_id"]), *target_key)
            if (version_key, artifact_id) in seen_version_artifacts:
                continue
            seen_version_artifacts.add((version_key, artifact_id))
            by_version_target.setdefault(version_key, []).append(
                (artifact_id, canonical)
            )
    _backfill_artifact_figures(conn, by_version_target=by_version_target)
    _rewrite_published_graph_refs(conn, by_version_target=by_version_target)
    _rewrite_snapshot_resource_tokens(conn, by_assoc=by_assoc)


def _backfill_artifact_figures(
    conn: Connection,
    *,
    by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]],
) -> None:
    """report_figures rows fan out to one row per backfilled artifact."""
    if not has_table(conn, "report_figures"):
        return
    artifacts_by_version: dict[str, list[str]] = {}
    for (version_id, _tt, _tid), artifacts in by_version_target.items():
        artifacts_by_version.setdefault(version_id, []).extend(
            artifact_id for artifact_id, _role in artifacts
        )
    for row in conn.execute(
        "SELECT report_version_id, link_path, sha256, size_bytes FROM report_figures"
    ).fetchall():
        for artifact_id in artifacts_by_version.get(str(row["report_version_id"]), []):
            conn.execute(
                """
                INSERT INTO artifact_figures
                  (id, artifact_id, link_path, content_sha256, size_bytes,
                   status, upload_token)
                VALUES (?, ?, ?, ?, ?, 'complete', '')
                """,
                (
                    new_id(prefix="fig"),
                    artifact_id,
                    str(row["link_path"]),
                    str(row["sha256"]),
                    int(row["size_bytes"] or 0),
                ),
            )


def _rewrite_published_graph_refs(
    conn: Connection,
    *,
    by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]],
) -> None:
    """Repoint each publish pin at that reflection's project_graph artifact
    specifically — a version shared with another role must not win."""
    for row in conn.execute(
        "SELECT id, published_graph_version_id FROM reflections "
        "WHERE COALESCE(published_graph_version_id, '') != ''"
    ).fetchall():
        candidates = by_version_target.get(
            (str(row["published_graph_version_id"]), "reflection", str(row["id"])), []
        )
        artifact_id = next(
            (aid for aid, role in candidates if role == "project_graph"), None
        )
        if artifact_id:
            conn.execute(
                "UPDATE reflections SET published_graph_version_id = ? WHERE id = ?",
                (artifact_id, row["id"]),
            )


def _rewrite_snapshot_resource_tokens(
    conn: Connection,
    *,
    by_assoc: dict[tuple[str, str, str, str, str, int], tuple[str, str]],
) -> None:
    """Old `res:ver:role:attempt` snapshot tokens become `art:role:attempt`
    with the canonical role spelling.

    The version is part of the lookup key: a review pinned to a superseded
    version finds no mapping and keeps its token verbatim — the snapshot stays
    stale instead of being revived onto the current version.
    """
    for table in ("reviews", "review_requests"):
        for row in conn.execute(
            f"SELECT id, target_type, target_id, target_snapshot_id FROM {table} "
            "WHERE target_snapshot_id LIKE ?",
            ("%|%",),
        ).fetchall():
            parts = str(row["target_snapshot_id"]).split("|", 4)
            if len(parts) < 5 or not parts[4]:
                continue
            tokens = []
            for token in parts[4].split(","):
                mapped = None
                try:
                    head, role, attempt = token.rsplit(":", 2)
                    resource_id, _, version_id = head.partition(":")
                    mapped = by_assoc.get(
                        (
                            resource_id,
                            version_id,
                            str(row["target_type"]),
                            str(row["target_id"]),
                            role,
                            int(attempt),
                        )
                    )
                except ValueError:
                    mapped = None
                tokens.append(f"{mapped[0]}:{mapped[1]}:{attempt}" if mapped else token)
            # set(): duplicate-slot dedupe maps several old associations to one
            # survivor; the live snapshot lists that artifact once.
            rewritten = "|".join([*parts[:4], ",".join(sorted(set(tokens)))])
            if rewritten != str(row["target_snapshot_id"]):
                conn.execute(
                    f"UPDATE {table} SET target_snapshot_id = ? WHERE id = ?",
                    (rewritten, row["id"]),
                )


def _drop_resource_tables(conn: Connection) -> None:
    """Migration 25: the resource-tracking tables are dead once 24 has
    backfilled them into artifacts. Child tables drop first so foreign-key
    enforcement never blocks. resources_migrate is the transient rebuild table
    from the retired pre-ledger UNIQUE migration."""
    for table in (
        "report_figures",
        "resource_associations",
        "resource_versions",
        "resources",
        "resources_migrate",
    ):
        conn.execute(f"DROP TABLE IF EXISTS {table}")


def _add_submission_attempts(conn: Connection) -> None:
    """Migration 36: the sealed round within an attempt, plus the two seal
    columns. Purely additive and idempotent."""
    if not has_table(conn, "submissions"):
        conn.execute(table_ddl(table="submissions"))
    for table in ("artifacts", "reviews"):
        ensure_columns(conn, table, {"submission_id": "TEXT NOT NULL DEFAULT ''"})
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_submissions_target "
        "ON submissions(target_type, target_id, attempt_index, created_seq)"
    )
    if has_column(conn, "artifacts", "target_type"):
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_artifacts_submission "
            "ON artifacts(target_type, target_id, attempt_index, submission_id)"
        )


def _add_consolidation(conn: Connection) -> None:
    """Migration 42: generic coding-session targets plus consolidation lineage."""
    if has_table(conn, "agent_sessions") and not has_column(
        conn, "agent_sessions", "target_type"
    ):
        conn.execute(table_ddl(table="agent_sessions", name="agent_sessions_v42"))
        # The lease still carried these when 42 shipped; migration 63 is what
        # retires them, so the copy has to land somewhere.
        ensure_columns(
            conn,
            "agent_sessions_v42",
            {
                "kind": "TEXT NOT NULL DEFAULT ''",
                "review_request_id": "TEXT NOT NULL DEFAULT ''",
            },
        )
        conn.execute(
            """
            INSERT INTO agent_sessions_v42 (
              id, project_id, target_type, target_id, attempt_index, kind,
              review_request_id, runner_id, platform, idempotency_key,
              secret_digest, status, host_session_ref, workspace_ref,
              created_at, activated_at, last_activity_at, lease_expires_at,
              hard_deadline_at, closed_at, close_reason, source_key_id,
              source_user_id
            )
            SELECT id, project_id, 'experiment', experiment_id, attempt_index,
                   kind, review_request_id, runner_id, platform,
                   idempotency_key, secret_digest, status, host_session_ref,
                   workspace_ref, created_at, activated_at, last_activity_at,
                   lease_expires_at, hard_deadline_at, closed_at, close_reason,
                   source_key_id, source_user_id
            FROM agent_sessions
            """
        )
        conn.execute("DROP TABLE agent_sessions")
        conn.execute("ALTER TABLE agent_sessions_v42 RENAME TO agent_sessions")
    for table in (
        "consolidation_proposals",
        "consolidation_decisions",
        "reflection_advances",
    ):
        _create_table(conn, table)
    # Migration 42 was exercised by development databases before the
    # consolidation receipt learned to distinguish selection from actual Git
    # ancestry. Keep those databases usable without another migration number;
    # released databases have not seen 42.
    ensure_columns(
        conn,
        "consolidation_decisions",
        {
            "source_sha": "TEXT NOT NULL DEFAULT ''",
            "integration_kind": "TEXT NOT NULL DEFAULT 'none'",
        },
    )
    ensure_columns(
        conn, "reflection_advances", {"ancestry_json": "TEXT NOT NULL DEFAULT '{}'"}
    )
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_consolidation_proposals_reflection"
        "  ON consolidation_proposals(reflection_id, revision)",
        "CREATE INDEX IF NOT EXISTS idx_reflection_advances_reflection"
        "  ON reflection_advances(reflection_id, intended_at)",
    ):
        conn.execute(statement)


def _add_project_candidates(conn: Connection) -> None:
    """Migration 45: immutable candidate pointers and champion history."""
    _create_table(conn, "project_candidates")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_project_candidates_order"
        "  ON project_candidates(project_id, created_seq)"
    )


def _add_tasks(conn: Connection) -> None:
    """Migration 51: task nodes, their reflection join, and the wave DAG."""
    for table in ("tasks", "reflection_tasks", "node_dependencies"):
        _create_table(conn, table)
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at)",
        "CREATE INDEX IF NOT EXISTS idx_node_dependencies_project"
        "  ON node_dependencies(project_id, node_id)",
        "CREATE INDEX IF NOT EXISTS idx_node_dependencies_target"
        "  ON node_dependencies(depends_on_id)",
    ):
        conn.execute(statement)


def _add_task_deliverables(conn: Connection) -> None:
    """Migration 53: the goal's contract as a structured column."""
    ensure_columns(conn, "tasks", {"deliverables_json": "TEXT NOT NULL DEFAULT '[]'"})


def _add_experiment_details(conn: Connection) -> None:
    """Migration 54: the creator's ask beyond the intent line."""
    ensure_columns(conn, "experiments", {"details": "TEXT NOT NULL DEFAULT ''"})


def _separate_artifact_content_from_research(conn: Connection) -> None:
    """Migration 59: preserve content IDs while transferring research facts.

    Alter in place so figure foreign keys and every external artifact reference
    survive. The whole extraction and its ledger row share a transaction on
    both dialects; no content bytes or review IDs change.
    """
    for table in ("research_artifact_links", "research_submission_artifacts"):
        _create_table(conn, table)
    for statement in (
        "CREATE INDEX IF NOT EXISTS idx_research_artifacts_target"
        "  ON research_artifact_links(project_id, target_type, target_id, attempt_index)",
        "CREATE INDEX IF NOT EXISTS idx_research_artifacts_content"
        "  ON research_artifact_links(artifact_id)",
    ):
        conn.execute(statement)
    ensure_columns(
        conn,
        "artifacts",
        {
            "max_bytes": "INTEGER NOT NULL DEFAULT 5000000",
            "discover_figures": "INTEGER NOT NULL DEFAULT 0",
        },
    )
    # Frozen historical policy: replay must not depend on today's roles.
    conn.execute(
        "UPDATE artifacts SET max_bytes = 16000 WHERE role IN "
        "('plan','report','graph','project_graph','reflection_lens_doc',"
        "'reflection_doc','change_spec','brief','delivery','result')"
    )
    conn.execute(
        "UPDATE artifacts SET discover_figures = 1 "
        "WHERE role IN ('plan','report','reflection_doc')"
    )
    conn.execute(
        """
        INSERT INTO research_artifact_links (
          id, artifact_id, project_id, target_type, target_id, role,
          attempt_index, lens_id, submission_id, active, created_at, created_seq
        )
        SELECT id, id, project_id, target_type, target_id, role,
               attempt_index, lens_id, submission_id, 0, created_at, created_seq
        FROM artifacts
        """
    )
    # Only the current complete version of each research slot is active. Sealed
    # predecessors remain visible through their first-seal marker; pending
    # uploads remain intents until Research accepts their bytes.
    conn.execute(
        """
        UPDATE research_artifact_links SET active = 1 WHERE id IN (
          SELECT link_id FROM (
            SELECT l.id AS link_id, ROW_NUMBER() OVER (
              PARTITION BY l.project_id, l.target_type, l.target_id,
                           l.attempt_index, l.role, l.lens_id, a.path
              ORDER BY l.created_seq DESC, a.updated_at DESC, l.id DESC
            ) AS slot_rank
            FROM research_artifact_links l JOIN artifacts a ON a.id = l.artifact_id
            WHERE a.status = 'complete'
          ) ranked WHERE slot_rank = 1
        )
        """
    )
    # Trusted system pins replaced the whole role, even when its display path
    # changed. A later agent submission still owns only its own slot.
    conn.execute(
        """
        UPDATE research_artifact_links SET active = 0 WHERE id IN (
          SELECT older.id FROM research_artifact_links older
          JOIN artifacts old_content ON old_content.id = older.artifact_id
          JOIN research_artifact_links newer ON newer.project_id = older.project_id
            AND newer.target_type = older.target_type AND newer.target_id = older.target_id
            AND newer.attempt_index = older.attempt_index AND newer.role = older.role
          JOIN artifacts new_content ON new_content.id = newer.artifact_id
          WHERE older.active = 1 AND new_content.status = 'complete'
            AND new_content.created_by = 'system'
            AND (newer.created_seq, new_content.updated_at, newer.id)
              > (older.created_seq, old_content.updated_at, older.id)
        )
        """
    )
    # Old rounds carried forward the latest slot sealed at or before that round.
    # Materialize that exact composition, not just newly sealed rows.
    conn.execute(
        """
        INSERT INTO research_submission_artifacts (submission_id, link_id)
        SELECT submission_id, link_id FROM (
          SELECT s.id AS submission_id, l.id AS link_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY s.id, l.role, l.lens_id, a.path
                   ORDER BY l.created_seq DESC, a.updated_at DESC, l.id DESC
                 ) AS slot_rank
          FROM submissions s
          JOIN research_artifact_links l ON l.project_id = s.project_id
            AND l.target_type = s.target_type AND l.target_id = s.target_id
            AND l.attempt_index = s.attempt_index
          JOIN artifacts a ON a.id = l.artifact_id AND a.status = 'complete'
          JOIN submissions sealed ON sealed.id = l.submission_id
            AND sealed.project_id = s.project_id
            AND sealed.target_type = s.target_type AND sealed.target_id = s.target_id
            AND sealed.attempt_index = s.attempt_index
          WHERE sealed.created_seq <= s.created_seq
        ) eligible WHERE slot_rank = 1
        """
    )
    conn.execute("DROP INDEX IF EXISTS idx_artifacts_submission")
    for column in (
        "target_type", "target_id", "role", "attempt_index", "lens_id", "submission_id"
    ):
        conn.execute(f"ALTER TABLE artifacts DROP COLUMN {column}")
    conn.execute(_RESEARCH_ARTIFACTS_VIEW)


def _add_research_objects(conn: Connection) -> None:
    """Migration 62: research associations for merv-sandboxes objects.

    An existing completion-token table is rebuilt from Infrastructure's DDL so
    it no longer references the retired storage_objects ledger: tokens now name
    service object ids. Pending rows survive the rebuild. A database that has
    not got the table yet gets the new shape from that DDL directly, so this
    leaves it alone rather than creating another component's table early.
    """
    _create_table(conn, "research_objects")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_research_objects_target"
        "  ON research_objects(project_id, target_type, target_id, status)"
    )
    if not has_table(conn, "storage_completion_tokens"):
        return
    conn.execute("DROP TABLE IF EXISTS storage_completion_tokens_migrate")
    conn.execute(
        table_ddl(
            table="storage_completion_tokens",
            name="storage_completion_tokens_migrate",
        )
    )
    conn.execute(
        """
        INSERT INTO storage_completion_tokens_migrate
          (token, project_id, object_id, upload_id, status, expires_at, created_at)
        SELECT token, project_id, object_id, upload_id, status, expires_at, created_at
        FROM storage_completion_tokens
        """
    )
    conn.execute("DROP TABLE storage_completion_tokens")
    conn.execute(
        "ALTER TABLE storage_completion_tokens_migrate RENAME TO storage_completion_tokens"
    )


RESEARCH_SCHEMA = SchemaModule(
    name="research_core",
    ddl=RESEARCH_DDL,
    migrations=(
        Migration(12, "add_experiment_mlflow_run_columns", _add_experiment_mlflow_run_columns),
        Migration(13, "add_review_synopsis", _add_review_synopsis),
        Migration(15, "rename_syntheses_to_reflections", _rename_syntheses_to_reflections),
        Migration(19, "unify_synthesis_to_reflection", _unify_synthesis_to_reflection),
        Migration(20, "add_litreview_sections", _add_litreview_sections),
        Migration(21, "add_litreview_papers", _add_litreview_papers),
        Migration(22, "add_litreview_paper_links", _add_litreview_paper_links),
        Migration(23, "add_litreview_summary_unique_index", _add_litreview_summary_unique_index),
        Migration(24, "add_artifacts_tables", _add_artifacts_tables),
        Migration(25, "drop_resource_tables", _drop_resource_tables),
        Migration(36, "add_submission_attempts", _add_submission_attempts),
        Migration(42, "add_consolidation", _add_consolidation),
        Migration(45, "add_project_candidates", _add_project_candidates),
        Migration(51, "add_tasks", _add_tasks),
        Migration(53, "add_task_deliverables", _add_task_deliverables),
        Migration(54, "add_experiment_details", _add_experiment_details),
        Migration(59, "separate_artifact_content_from_research", _separate_artifact_content_from_research),
        Migration(62, "add_research_objects", _add_research_objects),
    ),
)
