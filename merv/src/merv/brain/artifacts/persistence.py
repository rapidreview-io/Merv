# If you update this file, you must consult artifacts.md to see whether artifacts.md needs to be updated. artifacts.md must not exceed 100 lines.
"""Artifact-owned tables: immutable content, its figures, and sealed rounds.

The DDL is the historical baseline the artifact migrations replay against:
migration 59 (Research) is what strips the association columns out of
``artifacts`` and adds the generic upload settings, so an existing database
and a fresh one converge on the same shape through the same ladder step.
"""

from __future__ import annotations

from ..kernel.state.schema import SchemaModule


# The historical baseline migrations 24 and 36 replay against. Migration 59
# moves the association fields out to Research-owned links and drops them
# here, leaving immutable project-scoped content plus generic upload
# settings. Keep the baseline replayable for pre-artifact databases; CREATE
# IF NOT EXISTS does not reintroduce the old fields on an upgraded store.
ARTIFACT_DDL = """\
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT NOT NULL,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  lens_id TEXT NOT NULL DEFAULT '',
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
  submission_id TEXT NOT NULL DEFAULT '',
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
"""


ARTIFACT_SCHEMA = SchemaModule(name="artifacts", ddl=ARTIFACT_DDL)
