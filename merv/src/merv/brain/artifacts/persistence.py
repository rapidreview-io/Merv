# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Artifact-owned tables: immutable content, its figures, and sealed rounds.

Content only. Which node a file belongs to, in what role, at which attempt is
Research's fact and lives in ``research_artifact_links`` next door; a row here
is project-scoped bytes plus the upload settings that gate them.
"""

from __future__ import annotations

from ..kernel.state.schema import SchemaModule


ARTIFACT_DDL = """\
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  content_sha256 TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  upload_token TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- Upload gates the caller declares per file, not per research role: the
  -- accepted byte ceiling, and whether relative image links in a markdown
  -- body are minted as figures.
  max_bytes INTEGER NOT NULL DEFAULT 5000000,
  discover_figures INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Submission attempts (July 2026). A forward transition seals the target's
-- live artifact composition: every complete row still carrying submission_id
-- the empty string is stamped with the new submission id and becomes
-- immutable, because
-- _supersede_slot only ever deletes unsealed rows. That is what keeps the
-- report of a rejected round retrievable as a first-class artifact instead of
-- an unreachable blob. The target's own attempt counter stays the
-- authoritative plan-level counter, so the review snapshot never moves; a
-- submission is the round WITHIN one attempt, which a return to running
-- deliberately does not bump. created_seq is the total order the composition
-- query depends on — a submission's contents are every row sealed at or
-- before it, latest-per-slot, which picks up carried-over files for free.
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  transition TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Figures referenced via relative image links in a gated markdown artifact.
-- Minted pending (with their own one-time tokens) when the document upload
-- lands; lints and the UI read only 'complete' rows.
CREATE TABLE IF NOT EXISTS artifact_figures (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  link_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  upload_token TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  FOREIGN KEY(artifact_id) REFERENCES artifacts(id)
);

-- The round a sealed submission was retrieved by: its own rows plus whatever
-- earlier round it carried forward (see research_submission_artifacts).
CREATE INDEX IF NOT EXISTS idx_submissions_target
  ON submissions(target_type, target_id, attempt_index, created_seq);
"""


ARTIFACT_SCHEMA = SchemaModule(name="artifacts", ddl=ARTIFACT_DDL)
