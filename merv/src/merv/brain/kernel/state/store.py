"""Record-store state management: dialect-neutral base + the SQLite dialect.

``BaseStateStore`` defines the contract the services were written against;
``StateStore`` (= ``SqliteStateStore``) is the local-mode SQLite dialect and
the historical default. The Postgres dialect for the cloud control plane
lives in ``dialects.py`` (cloud plan Phase 6).
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from collections.abc import Iterable, Iterator, Mapping, Sequence
from contextlib import closing, contextmanager
from pathlib import Path
from types import TracebackType
from typing import Any, Protocol

from ..events import StoredEvent, freeze_json_object
from ..secret_tokens import hash_secret
from .fingerprints import oauth_client_fingerprint
from ..utils import NotFoundError, ValidationError
from ..utils import new_id
from ..utils import now_iso


class Row(Protocol):
    """Mapping-shaped database row shared by the SQLite and Postgres dialects."""

    def __getitem__(self, key: str) -> Any: ...

    def keys(self) -> Iterable[str]: ...


class ResultCursor(Protocol):
    """Cursor result surface used by record services."""

    def fetchone(self) -> Row | Mapping[str, Any] | None: ...

    def fetchall(self) -> list[Row | Mapping[str, Any]]: ...


class Connection(Protocol):
    """Small database connection surface exposed through ``BaseStateStore``."""

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> ResultCursor: ...

    def __enter__(self) -> Connection: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  -- Per-project policy knobs (e.g. require_verified_reviews), JSON dict.
  settings_json TEXT NOT NULL DEFAULT '{}',
  -- Tenancy (cloud plan Phase 6): ownership lives on the project row; every
  -- other table reaches its tenant through project_id. The current private
  -- deployment uses the fixed 'local' tenant until real user auth lands.
  tenant_id TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
  -- Access layer for authenticated (hosted) mode: user_id is a Supabase
  -- auth.users UUID; a row grants full member access to the project. The
  -- local surface carries no user_id, so membership never filters it.
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Surface-owned project credentials (agent-anywhere). The presented mk_ secret
-- is returned once at mint; only its SHA-256 digest is authoritative here. Key
-- scope is immutable: there is no update path for either scope column.
-- Ceilings are stored but not yet enforced (enforcement is a later phase).
CREATE TABLE IF NOT EXISTS project_api_keys (
  id TEXT PRIMARY KEY,
  secret_digest TEXT NOT NULL UNIQUE,
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- 'project' confines the credential to project_id. 'account' authorizes
  -- every project the owner is a member of, and project_id is then only the
  -- home project the key is administered from (listed and revoked under the
  -- existing /api/projects/{id}/keys routes), never a limit on its reach.
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  -- OAuth access keys bind this to their full RFC 8707 resource URI. Direct
  -- project keys keep NULL and retain their existing REST + MCP authority.
  audience TEXT,
  -- Stable grant identity for OAuth access-key rotations. Direct project keys
  -- keep NULL and use their immutable key id for idempotency instead.
  oauth_family_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  parent_key_id TEXT,
  sandbox_seconds_ceiling BIGINT CHECK (sandbox_seconds_ceiling IS NULL OR sandbox_seconds_ceiling >= 0),
  blob_bytes_ceiling BIGINT CHECK (blob_bytes_ceiling IS NULL OR blob_bytes_ceiling >= 0),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(parent_key_id) REFERENCES project_api_keys(id)
);

-- OAuth 2.1 public DCR registrations (agent-anywhere Phase B). A repeated
-- registration with identical metadata resolves to the SAME client_id, so the
-- Cursor double-DCR race is safe without growing the table; registrations that
-- never authorized anything are swept by CleanupService. Only public clients
-- (token_endpoint_auth_method=none) exist, so no client secret is stored.
-- ``metadata_fingerprint`` is that "identical metadata" statement made a
-- database fact: a digest over the CANONICAL (sorted-array) metadata, carrying
-- the UNIQUE index added by migration 38. NULL is the one legal duplicate — a
-- legacy row whose canonical twin already holds the fingerprint (both dialects
-- treat NULLs as distinct in a unique index), which stays reachable by
-- client_id while new registrations resolve to the twin. That index belongs to
-- migration 38 and never to SCHEMA (see the submissions note below for why).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  grant_types_json TEXT NOT NULL,
  metadata_fingerprint TEXT,
  created_at TEXT NOT NULL
);

-- OAuth authorization codes are opaque one-shot credentials. Only a digest
-- is stored; every security-relevant request value is bound into the row.
CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_digest TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- Carries the consent decision through to the minted key (see
  -- project_api_keys.grant_scope).
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Refresh tokens rotate once. Their opaque value is never persisted, and the
-- current project-key link makes the existing key revocation path authoritative
-- for refresh authority as well as direct bearer use.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  -- Preserved across every rotation so a refreshed key keeps the scope the
  -- user consented to (see project_api_keys.grant_scope).
  grant_scope TEXT NOT NULL DEFAULT 'project'
    CHECK (grant_scope IN ('project', 'account')),
  resource TEXT NOT NULL,
  current_key_id TEXT NOT NULL,
  parent_token_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(current_key_id) REFERENCES project_api_keys(id),
  FOREIGN KEY(parent_token_id) REFERENCES oauth_refresh_tokens(id)
);

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
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- One locally hosted coding-agent process working one experiment. The runner
-- submits a high-entropy session secret once; only its digest is stored. A
-- partial unique index installed by migration 41 makes the live-worker rule a
-- database fact rather than a polling convention.
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('experiment', 'reflection')),
  target_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'experiment'
    CHECK (kind IN ('experiment', 'review', 'consolidation')),
  review_request_id TEXT NOT NULL DEFAULT '',
  source_sha TEXT NOT NULL DEFAULT '',
  runner_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  secret_digest TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('offered', 'active', 'released', 'expired')),
  host_session_ref TEXT NOT NULL DEFAULT '',
  workspace_ref TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  assignment_json TEXT NOT NULL DEFAULT '{}',
  agent_setup_json TEXT NOT NULL DEFAULT '{}',
  telemetry_json TEXT NOT NULL DEFAULT '{}',
  telemetry_at TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_activity_at TEXT,
  lease_expires_at TEXT NOT NULL,
  hard_deadline_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT NOT NULL DEFAULT '',
  source_key_id TEXT,
  source_user_id TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- One small, non-secret liveness record per project runner. The daemon renews
-- it every poll even while idle, so the UI can distinguish a ready machine
-- from a remembered or disconnected one without dialing the user's network.
CREATE TABLE IF NOT EXISTS agent_runners (
  project_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  machine_json TEXT NOT NULL DEFAULT '{}',
  platforms_json TEXT NOT NULL DEFAULT '{}',
  capacity INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(project_id, runner_id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Durable code identity for an experiment across owner and reviewer sessions.
-- The worktree stays on the runner's machine; the brain stores only Git facts
-- needed for exact reviews, consolidation handoffs, and truthful UI lineage.
CREATE TABLE IF NOT EXISTS experiment_workspaces (
  experiment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  commit_count INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(experiment_id) REFERENCES experiments(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS experiment_claims (
  experiment_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  PRIMARY KEY(experiment_id, claim_id)
);

CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  namespace TEXT NOT NULL,
  status TEXT NOT NULL,
  upload_id TEXT,
  expires_at TEXT,
  created_by TEXT NOT NULL DEFAULT 'codex',
  producing_experiment_id TEXT NOT NULL DEFAULT '',
  producing_run TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  created_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, name, version),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Token-curl upload completion (no-dataplane Phase D). storage.submit mints a
-- one-time, expiring token bound to a pending upload; the auth-exempt bodyless
-- POST /api/storage/u/<token>/complete is the ONLY wire-reachable completion for
-- a key agent (storage.complete_upload is internal and rejected over MCP), so
-- without it a direct-to-S3 object stays uploading forever. Single-use: the row
-- is deleted once a head-verified completion succeeds.
CREATE TABLE IF NOT EXISTS storage_completion_tokens (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(object_id) REFERENCES storage_objects(id)
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

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

-- Lookup key for the MLflow tracking delivery barrier (migration 40, July
-- 2026). One row per KEYED tracking write, inserted in the same transaction as
-- the event it names, so replay detection is one indexed lookup on
-- (project_id, target_type, target_id, delivery_id) instead of a decode of
-- every keyed event the target has accrued. `event_id` names the `events` row
-- the delivery appended, which the barrier then fetches by primary key. The
-- delivery id still rides in that event payload, but only as a readable trace,
-- never as a lookup key. Nothing here is derived state: the row and its event
-- commit together or not at all. The UNIQUE index belongs to migration 40 and
-- never to SCHEMA (see the tool_calls block below).
CREATE TABLE IF NOT EXISTS tracking_deliveries (
  project_id TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  delivery_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
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

CREATE TABLE IF NOT EXISTS sandboxes (
  sandbox_uid TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  sandbox_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'none',
  gpu TEXT NOT NULL DEFAULT '',
  cpu REAL NOT NULL DEFAULT 0,
  memory INTEGER NOT NULL DEFAULT 0,
  -- Compute provider that owns this sandbox (the backend's capabilities.name).
  -- Empty on rows that predate multi-provider support and means "the
  -- configured default backend" at read time.
  provider TEXT NOT NULL DEFAULT '',
  -- Provider-bundled machine SKU + datacenter, for backends (Lambda Labs) that
  -- procure a fixed instance type rather than composing cpu/memory. Empty for
  -- Modal, which sets gpu/cpu/memory above instead.
  instance_type TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  -- Provider price quote at provision (cloud plan Phase 7): captured from the
  -- catalog option (Lambda has it; Modal leaves 0). Recorded on the row AND
  -- appended to sandbox_generations so per-generation spend is reconstructable
  -- even though the row itself only retains its current generation.
  price_usd_per_hour REAL NOT NULL DEFAULT 0,
  time_limit INTEGER NOT NULL DEFAULT 0,
  ssh_host TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 0,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  workdir TEXT NOT NULL DEFAULT '',
  sync_dir TEXT NOT NULL DEFAULT '',
  unsynced_dir TEXT NOT NULL DEFAULT '',
  sandbox_data_dir TEXT NOT NULL DEFAULT '',
  -- Management keypair reference (cloud plan Phase 5, fixed decision 4):
  -- non-empty when a control-plane management key was minted for this
  -- sandbox. A key-store reference (the sandbox_uid) — never key material.
  mgmt_key_ref TEXT NOT NULL DEFAULT '',
  -- User SSH key custody source: caller supplied an OpenSSH public key, or the
  -- local data plane used the managed fallback keypair.
  public_key_source TEXT NOT NULL DEFAULT 'managed',
  volume_name TEXT NOT NULL DEFAULT '',
  sandbox_name TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  provision_started_at TEXT,
  requested_at TEXT,
  expires_at TEXT,
  last_seen_at TEXT,
  idle_since TEXT,
  heartbeat_snapshot_json TEXT NOT NULL DEFAULT '{}',
  last_command_id TEXT NOT NULL DEFAULT '',
  last_command_text TEXT NOT NULL DEFAULT '',
  last_command_started_at TEXT,
  last_command_status TEXT NOT NULL DEFAULT '',
  last_command_exit_code INTEGER,
  last_command_finished_at TEXT,
  last_command_output_tail TEXT NOT NULL DEFAULT '',
  last_command_snapshot_at TEXT,
  -- Set when a receipt read SUCCEEDED while the row was still active, on the
  -- way to terminal. It is what separates "we looked and the run was not
  -- there" (lost) from "we never got to look" (unknown): reconcile_row
  -- reports a dead channel, a timeout and genuine no-news identically, so
  -- without this stamp every unfinished run on a dead box reads as lost.
  runs_final_observed_at TEXT,
  terminated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Insertion-order column replacing rowid ordering (cloud plan Phase 6).
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- Migration 44 (columns stay LAST so migrated and fresh stores hash the
  -- same schema): payer of record ('' = unattributed, never capped), the
  -- credential source that bills it ('platform' | 'own', adapter-reported),
  -- the tri-state admitted/validated price (NULL = unknown, distinct from
  -- the NOT NULL 0 floor above), and the budget-enforcement ladder
  -- ('' | 'warned' | 'over_budget').
  user_id TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '',
  quoted_price_usd_per_hour REAL,
  budget_state TEXT NOT NULL DEFAULT '',
  over_budget_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS sandbox_attachments (
  sandbox_uid TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  attached_at TEXT NOT NULL,
  detached_at TEXT,
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);

-- merv_run receipts observed on the box (July 2026). The sandbox filesystem is
-- the registry — .runs/<label>/ sentinel files written by the merv_run wrapper —
-- and this table is the brain's reconciled mirror of it, so run status
-- outlives both the agent session and the sandbox. finished_event_emitted
-- makes the run.finished event exactly-once across daemon restarts (flag and
-- event flip in one transaction).
CREATE TABLE IF NOT EXISTS sandbox_runs (
  sandbox_uid TEXT NOT NULL,
  label TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '',
  pid INTEGER,
  exit_code INTEGER,
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_event_emitted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sandbox_uid, label),
  FOREIGN KEY(sandbox_uid) REFERENCES sandboxes(sandbox_uid)
);

-- Typed submitted artifacts (July 2026, dev_docs/artifact_submit_cut_plan.md).
-- One row per submitted object against a workflow target; bytes live in the
-- blob store keyed by (project_id, content_sha256). ``path`` is a trust-based
-- provenance label, never identity. Rows are born 'pending' with a one-time
-- upload token and flip to 'complete' when the PUT lands; resubmitting the
-- same slot mints a NEW id and deletes the old row, so review snapshot ids
-- (artifact_id:role:attempt) invalidate naturally.
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
-- an unreachable blob. `experiments.attempt_index` stays the authoritative
-- plan-level counter, so the byte-stable review snapshot never moves; a
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

-- Both indexes are created by migration 36, never here. SCHEMA runs before the
-- migration ladder and its CREATE TABLE IF NOT EXISTS is a no-op on a database
-- that already has `artifacts`, so an index naming submission_id would fail on
-- every existing deployment before the ALTER that adds the column could run.
-- _apply_migrations executes on fresh databases too, so both paths get them.

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

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- Tenant records. The current private hosted-control deployment has no user
-- auth yet, but projects, quotas, budgets, and counters are already tenant
-- shaped so the real auth system can attach users later without reshaping
-- stored project data.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Cost governance (cloud plan Phase 7). One quota row per tenant; every
-- column nullable = unlimited. Local mode's 'local' tenant has no row, so
-- QuotaService.check_admission is a no-op (unlimited) — byte-identical
-- behavior. Enforcement gates at the procurement choke point only when a
-- ceiling is set and exceeded.
CREATE TABLE IF NOT EXISTS tenant_quotas (
  tenant_id TEXT PRIMARY KEY,
  max_concurrent_sandboxes INTEGER,
  max_time_limit_seconds INTEGER,
  max_price_usd_per_hour REAL,
  gpu_hours_budget REAL,
  usd_budget REAL,
  blob_bytes_budget INTEGER
);

-- Per-generation sandbox spend ledger (cloud plan Phase 7). The sandboxes row
-- retains only its current generation, so it cannot reconstruct historical
-- spend; each provisioned generation appends a row here with the price the
-- provider quoted (Lambda has it; Modal leaves it 0/null). Reconstructable
-- spend = sum over rows of price_usd_per_hour * runtime. Dormant in local
-- mode (no quota to govern) but always recorded so the ledger is truthful.
CREATE TABLE IF NOT EXISTS sandbox_generations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'local',
  sandbox_id TEXT NOT NULL DEFAULT '',
  -- Owning compute provider (empty = pre-multi-provider row / default backend).
  provider TEXT NOT NULL DEFAULT '',
  instance_type TEXT NOT NULL DEFAULT '',
  gpu TEXT NOT NULL DEFAULT '',
  price_usd_per_hour REAL NOT NULL DEFAULT 0,
  -- Provisioning credential attribution (agent-anywhere spend). NULL for every
  -- JWT/rr_sk_/local write; set to the project_api_keys.id that provisioned it.
  key_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_seq INTEGER NOT NULL DEFAULT 0,
  -- Migration 44 (columns stay LAST so migrated and fresh stores hash the
  -- same schema): payer of record + billing source ('' rows predate
  -- attribution, never capped), the durable sandbox_uid linkage that new
  -- close/update paths key on (legacy '' rows keep sandbox_id + provider
  -- matching), and price_known (1 = real provider quote, genuine $0 allowed;
  -- 0 = unknown, the stored 0 is only the NOT NULL floor — legacy rows keep
  -- 0, matching their existing "unpriced hours" treatment).
  user_id TEXT NOT NULL DEFAULT '',
  billing_mode TEXT NOT NULL DEFAULT '',
  sandbox_uid TEXT NOT NULL DEFAULT '',
  price_known INTEGER NOT NULL DEFAULT 0
);

-- Per-user per-provider daily USD caps (migration 44). user_id '' is the
-- platform default for the provider; a user-specific row overrides it; a
-- NULL daily_usd_limit is an explicit uncapped override. Spend is always
-- recomputed from sandbox_generations — this table stores policy only.
CREATE TABLE IF NOT EXISTS provider_user_caps (
  provider TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT '',
  daily_usd_limit REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, user_id)
);

-- Spend kill-switch (cloud plan Phase 9, risk 13). An operator-trippable
-- circuit breaker that refuses NEW sandbox provisioning when set, independent
-- of (and faster to act than) per-dimension budgets. ``scope = 'global'`` is a
-- platform-wide halt; ``scope = '<tenant_id>'`` halts one tenant. A row exists
-- only when the switch was tripped; absence = armed/off. Dormant in local mode
-- (no row, no tripping). Never carries secrets — just a reason string.
CREATE TABLE IF NOT EXISTS spend_kill_switches (
  scope TEXT PRIMARY KEY,
  tripped INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  tripped_at TEXT
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

-- Per-user Hugging Face access token (no-dataplane Phase C). Keyed by the
-- Supabase auth.users UUID; a member brings their own token so no deployment-
-- wide HF secret exists. WRITE-ONLY by contract: the value is set/cleared over
-- the API and read back only internally at sandbox provisioning to inject
-- HF_TOKEN into the provisioning user's sandbox — no API ever returns it. Cross-
-- member exposure WITHIN a shared project is accepted (a teammate can read a
-- sandbox the token was placed in); cross-project exposure is closed because no
-- shared secret exists. Absence = public-models-only graceful degrade.
CREATE TABLE IF NOT EXISTS user_hf_tokens (
  user_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Per-project compute-provider connections (August 2026). One row per
-- (project, provider) the project has touched in Sandboxes → Configure:
-- saved credentials (JSON keyed by canonical MERV_* field names) and the
-- agent-facing enable switch. Credentials are WRITE-ONLY by contract — set,
-- merged, or cleared over the API; reads surface only WHICH keys are set
-- (plus non-secret values) and the raw JSON is read back only internally at
-- sandbox provisioning. No row means "no opinion": env-configured providers
-- stay usable until a row explicitly disables them.
CREATE TABLE IF NOT EXISTS sandbox_provider_settings (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credentials TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  -- '' = decide from what exists (saved creds, else env); 'own' and
  -- 'platform' record an explicit wizard choice (platform = the deployment's
  -- shared credentials, offered for Lambda Labs by default).
  credential_mode TEXT NOT NULL DEFAULT '',
  -- NULL = uncapped. Admission stops NEW provisioning on this provider once
  -- the project's UTC-day spend reaches the cap (quotas.py).
  daily_usd_limit REAL,
  -- Set when credential_check last confirmed access; cleared on every
  -- credential write.
  verified_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, provider)
);

-- Durable tool-call ledger (July 2026, logging/observability P0). One row per
-- dispatched call AND per refusal that never reached the dispatcher, so agent
-- friction — retry loops, gate bounces, poll churn, per-tool latency, context
-- bloat — outlives a restart. Sizes and digests only: the in-memory rings keep
-- serving the debug UI's raw request/response view, and this table must never
-- become a second payload store. No foreign key to projects: project_id is
-- empty for global and rejected calls, and a telemetry insert may not fail on
-- a missing parent. Indexes are migration 37's, never SCHEMA's (see the
-- submissions block above). Retention is a bounded prune, not a row cap.
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  -- Correlates every row a single HTTP request produced (X-RP-Request-Id).
  request_id TEXT NOT NULL DEFAULT '',
  -- Non-secret caller identity: key:<project_api_keys.id>, user:<uuid>,
  -- 'local', or 'open'. Never a token, never a digest of one.
  principal_id TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'rejected')),
  error_code TEXT NOT NULL DEFAULT '',
  -- First line of the failure, secret-scrubbed and capped: enough to group
  -- errors, never enough to reconstruct a payload.
  error_head TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  sent_chars INTEGER NOT NULL DEFAULT 0,
  received_chars INTEGER NOT NULL DEFAULT 0,
  -- sha256 prefix of the redacted arguments: a retry loop repeats one digest.
  args_digest TEXT NOT NULL DEFAULT ''
);
"""


# Ordered migration ledger. SCHEMA above stays the CREATE-IF-NOT-EXISTS
# baseline for fresh databases; one-time or destructive DDL goes here and is
# applied exactly once per database, recorded in schema_migrations. The
# introspective helpers (_ensure_columns/_drop_columns) remain the SQLite
# legacy-convergence path for pre-ledger databases; NEW schema changes should
# be ledger migrations, not new introspective branches.
MIGRATIONS: tuple[tuple[int, str, str], ...] = (
    # The defunct `jobs` table predates the sandbox model. Dropping it lived in
    # the every-boot SCHEMA constant; destructive DDL belongs in the ledger.
    (1, "drop_legacy_jobs_table", "DROP TABLE IF EXISTS jobs"),
    # Existing hosted Postgres control stores predate sandboxes.tenant_id; fresh
    # schemas have it, and this idempotent migration backfills existing rows.
    (2, "add_sandbox_tenant_id", ""),
    # Slice-3 (June 2026): idle-reaper heartbeat columns. Fresh schemas have
    # them; this idempotently adds them to existing SQLite + Postgres stores.
    (3, "add_sandbox_heartbeat_columns", ""),
    # Slice-2 (June 2026): the sandbox gets its own identity. Existing hosted
    # Postgres stores keyed sandboxes by experiment_id; this swaps the primary
    # key to sandbox_uid and opens the sandbox_attachments relation. Must run
    # before the mgmt-key/attachment migrations below (they read sandbox_uid).
    # SQLite already reaches this shape in _ensure_forward_schema, so the
    # handler is a guarded no-op there and on every fresh schema.
    (4, "migrate_sandbox_uid_identity", ""),
    # Slice-4 (June 2026): one experiment may own multiple sandbox rows.
    (5, "drop_sandboxes_experiment_unique", ""),
    # Slice-5 (June 2026): management keys follow the sandbox, not the
    # experiment; legacy non-empty refs are left as fallback refs.
    (6, "backfill_sandbox_mgmt_key_refs", ""),
    # Slice-5 (June 2026): attachment history can contain multiple
    # close-then-open rows for the same sandbox/experiment pair.
    (7, "allow_sandbox_attachment_history", ""),
    # Slice-6 (June 2026): sandbox rows are machine state only; experiment
    # relationships live in sandbox_attachments.
    (8, "drop_sandboxes_experiment_id", ""),
    # Slice-6 follow-up: MLflow is centralized and no longer archived through
    # sandbox release/daemon paths.
    (9, "drop_metrics_snapshots", "DROP TABLE IF EXISTS metrics_snapshots"),
    # Storage simplification: `missing` is no longer a storage object status.
    # Old rows are unavailable to agents, so keep them visible only through
    # expired/history views instead of preserving a removed state.
    (
        10,
        "normalize_storage_missing_status",
        "UPDATE storage_objects SET status = 'expired' WHERE status = 'missing'",
    ),
    # Review policy (July 2026): per-project settings dict backing knobs like
    # require_verified_reviews. Fresh schemas have the column; this backfills.
    (11, "add_project_settings_json", ""),
    # MLflow tracking (July 2026): fresh schemas have these columns, but hosted
    # Postgres stores that predate the feature need an explicit ledger step.
    (12, "add_experiment_mlflow_run_columns", ""),
    # Researcher synopsis (July 2026): fresh schemas have the column; this
    # backfills hosted Postgres stores that predate the requirement.
    (13, "add_review_synopsis", ""),
    # Daemon diet Phase 4b: sandbox.get must report whether the authorized
    # user SSH key came from the caller or the managed fallback.
    (14, "add_sandbox_public_key_source", ""),
    # Product-name alignment Phase 5: the reflection-wave table was formerly
    # named syntheses. Row ids and payload keys keep their legacy spelling.
    (15, "rename_syntheses_to_reflections", ""),
    # The whole last_command_* snapshot family reached the fresh-create SCHEMA
    # without a migration, so migrated deployments lacked all eight columns
    # (found when the sandbox signal ETag 500ed on production Postgres).
    (16, "add_sandbox_last_command_columns", ""),
    # Hard stop removed (July 2026): a published reflection can no longer stop
    # the project — winding down is the researcher's call, made outside the
    # workflow. Reactivate projects stopped under the old contract; the legacy
    # hard_stop_* columns stay behind in old databases, inert.
    (
        17,
        "reactivate_hard_stopped_projects",
        "UPDATE projects SET status = 'active' WHERE status = 'stopped'",
    ),
    # Multi-provider sandboxes (July 2026): rows record their owning compute
    # provider. Existing rows keep '' = "the configured default backend".
    (18, "add_sandbox_provider_columns", ""),
    # Synthesis -> reflection unification (July 2026): the wave entity is a
    # reflection everywhere (only the consolidation PHASE keeps the name
    # `synthesizing`), and the external names become the internal names — the
    # projection layer is deleted. Renames the two wave-relation tables (and
    # their synthesis_id columns), rewrites the persisted status/target_type/
    # event vocabulary, and rewrites review snapshot ids so passing reviews
    # keep satisfying their gates.
    (19, "unify_synthesis_to_reflection", ""),
    # Literature review (July 2026): three new tables + the at-most-one-summary
    # partial index. The table entries dispatch to handlers that execute the
    # SCHEMA-extracted DDL (_schema_table_ddl), so ledger and SCHEMA cannot
    # drift; each entry stays one statement.
    (20, "add_litreview_sections", ""),
    (21, "add_litreview_papers", ""),
    (22, "add_litreview_paper_links", ""),
    (
        23,
        "add_litreview_summary_unique_index",
        "CREATE UNIQUE INDEX IF NOT EXISTS litreview_one_summary\n"
        "  ON litreview_sections(project_id) WHERE kind = 'summary'",
    ),
    # Artifact submit cut (July 2026): the typed-artifact tables plus a
    # metadata-only backfill from the resource system (blobs already live in
    # the blob store keyed by sha). Also rewrites the artifact-bearing refs
    # that must keep matching: review snapshot ids (resource:version tokens ->
    # artifact_id:role:attempt) and reflections.published_graph_version_id
    # (version id -> the backfilled artifact id) — without these, passed
    # review gates and published-graph diffs silently break (the migration-19
    # lesson).
    (24, "add_artifacts_tables", ""),
    # Artifact submit cut, deletion phase: the resource-tracking tables are
    # dead once 24 has backfilled them into artifacts. Child tables drop first
    # so FK enforcement never blocks. resources_migrate is the transient
    # rebuild table from the retired pre-ledger UNIQUE migration.
    (25, "drop_resource_tables", ""),
    # Agent-anywhere Phase A (July 2026): an authoritative, project-scoped
    # credential table (mk_ keys). SCHEMA creates it before this ledger runs;
    # the handler runs the SCHEMA-extracted DDL so ledger and SCHEMA cannot
    # drift. audience + oauth_family_id are folded into the initial DDL (no
    # separate ALTER migrations) and stay NULL for direct project keys.
    (26, "add_project_api_keys", ""),
    # Spend attribution for project-key sandbox generations. Nullable keeps
    # every JWT, rr_sk_, and local write on its historical row shape.
    (27, "add_sandbox_generation_key_id", ""),
    # Agent-anywhere Phase B (July 2026): the OAuth 2.1 DCR + PKCE + rotating-
    # refresh state. SCHEMA creates the three tables before this ledger runs;
    # the handlers execute the SCHEMA-extracted DDL (_schema_table_ddl) so
    # ledger and SCHEMA cannot drift. Each is guarded on _has_table so an
    # existing store gains the tables and a fresh store is a no-op. The audience
    # + oauth_family_id columns these bearers ride live in migration 26's DDL
    # already, so no separate audience/family migration is needed here. Order:
    # clients first (codes + refresh tokens FK it; refresh tokens also FK
    # project_api_keys from migration 26).
    (28, "add_oauth_clients", ""),
    (29, "add_oauth_authorization_codes", ""),
    (30, "add_oauth_refresh_tokens", ""),
    # No-dataplane Phase C (July 2026): per-user Hugging Face token. Fresh
    # schemas create user_hf_tokens above; the handler runs the SCHEMA-extracted
    # DDL so ledger and SCHEMA cannot drift.
    (31, "add_user_hf_tokens", ""),
    # Historical Feed token migration marker. Feed now owns this table and its
    # compatibility creation in feed/feed.py; keep version 32 in the
    # immutable ledger so existing databases and later migration numbers align.
    (32, "add_feed_upload_tokens", ""),
    # No-dataplane Phase D (storage token-curl): the one-time completion-token
    # table backing the auth-exempt POST /api/storage/u/<token>/complete route.
    # SCHEMA creates it on fresh DBs; the handler runs the SCHEMA-extracted DDL
    # so ledger and SCHEMA cannot drift.
    (33, "add_storage_completion_tokens", ""),
    # Agent-anywhere multi-project (July 2026): a credential may be scoped to
    # its owner's whole membership rather than to one project. `grant_scope` is
    # the discriminator on all three credential tables. `project_id` stays NOT
    # NULL — for an account grant it is the home project the credential is
    # administered from — so every existing key route, revocation predicate,
    # and foreign key keeps working untouched. Existing rows are all
    # project-scoped, which is exactly what the column default states.
    (34, "add_grant_scope", ""),
    # Truthful run observation (July 2026): a nullable stamp recording that a
    # receipt read SUCCEEDED while the sandbox was still active. Without it,
    # `_run_status` calls every unfinished run on a terminal box `lost`, which
    # is a guess — reconcile_row cannot distinguish a dead channel from a run
    # that genuinely left no sentinel. Existing rows stay NULL, which reads as
    # `unknown`: honest about boxes that died before this shipped.
    (35, "add_runs_final_observed_at", ""),
    # Submission attempts (July 2026): the round WITHIN an experiment attempt.
    # Additive only — a new table, two seal columns, two indexes. Existing rows
    # keep submission_id '' and stay exactly as reachable as they are today,
    # and no review snapshot string is rewritten. Verified against production
    # before shipping: 2,965 complete artifacts, zero duplicate slots, so
    # latest-per-slot selects the identical set that the flat filter did.
    (36, "add_submission_attempts", ""),
    # Durable tool-call ledger + the audit's minimum index plan (July 2026,
    # logging/observability P0). Purely additive: one new append-only table and
    # the read-path indexes below, all IF NOT EXISTS. Nothing existing is
    # rewritten, so the migration is a no-op for every current row.
    (37, "add_tool_call_ledger", ""),
    # OAuth DCR get-or-create becomes database-enforced (July 2026, auth
    # hardening round 2). SELECT-then-INSERT only serializes where the writers
    # share a lock, and the Postgres advisory lock is keyed on the DSN *string*
    # — two replicas spelling the same database differently could both insert.
    # This adds the canonical metadata fingerprint plus its UNIQUE index, so the
    # database itself is the arbiter, and backfills existing rows from
    # CANONICALIZED metadata so a pre-canonicalization row is found by a
    # post-canonicalization lookup instead of consuming another cap slot. The
    # two child-table client_id indexes serve the prune/eviction eligibility
    # subqueries, which run under the global writer lock.
    (38, "add_oauth_client_fingerprint", ""),
    # The MLflow delivery barrier's index (July 2026, tracking idempotency).
    # `_delivery_event` reads one experiment's keyed tracking events newest
    # first; migration 37 left `events(project_id, id)` as the table's only
    # index, so that lookup scanned the project's whole event history whenever
    # the keyed events were sparse in it. Purely additive, one IF NOT EXISTS
    # index — nothing existing is read or rewritten.
    (39, "add_events_target_index", ""),
    # The delivery barrier gets a real key (July 2026, tracking idempotency).
    # Migration 39 indexed the events read, but the barrier still had to
    # JSON-decode every keyed tracking event of the target on EVERY keyed
    # write, inside the write transaction, because the delivery id only
    # existed inside opaque payload JSON — and keyed cardinality is unbounded,
    # so the cumulative work over one experiment's deliveries grew with their
    # square. This normalizes the delivery into its own row plus a UNIQUE
    # index, making the barrier one indexed lookup and one primary-key fetch.
    # Purely additive: a new table and one index, both IF NOT EXISTS, nothing
    # existing read or rewritten. Deliberately NO backfill of the payload-keyed
    # events: every delivery committed before this migration predates the
    # dedupe feature shipping, so there is no historical keyed write a row
    # could describe, and an unkeyed event has no delivery to name.
    (40, "add_tracking_deliveries", ""),
    # Merv-hosted coding agents (July 2026): one durable session row per
    # locally launched agent process. The runner supplies the secret and keeps
    # it in the child environment; the control plane stores only its digest.
    # Three indexes make retry identity, one-live-worker-per-experiment, and
    # project status reads explicit database guarantees.
    (41, "add_agent_sessions", ""),
    # Reflection-wave code consolidation: generic session targets, durable
    # experiment branch identity, immutable consolidation proposals/coverage,
    # and the intent/CAS/settle receipt.
    (42, "add_consolidation", ""),
    # Sandbox provider connections (August 2026): per-project saved cloud
    # credentials + the agent-facing enable switch behind Sandboxes →
    # Configure. Fresh schemas create the table above; the handler runs the
    # SCHEMA-extracted DDL on existing stores.
    (43, "add_sandbox_provider_settings", ""),
    # Per-user per-provider daily spend caps (August 2026). Additive only:
    # payer/billing attribution columns on both sandbox tables, tri-state
    # price + budget-state columns on sandboxes, the provider_user_caps
    # policy table, and its indexes. The handler seeds the platform default
    # ('lambda_labs', '', 50.0) exactly once — the ladder runs on fresh
    # databases too, so both paths get the seed and the ladder row records
    # it. Indexes live in the handler, never SCHEMA: they name ladder-added
    # columns (the migration-36 crash-loop lesson).
    (44, "add_user_provider_caps", ""),
    # Durable project champion (August 2026): immutable candidate pointers and
    # append-only staging/promotion receipts in the existing event ledger.
    # Candidate bytes stay in Artifacts, Object Storage, or evaluator custody.
    (45, "add_project_candidates", ""),
    # Auto-run observability (August 2026): the immutable human-readable work
    # packet, the exact non-secret harness setup, and a small mutable telemetry
    # summary. Full provider traces remain on the runner machine.
    (46, "add_agent_session_observability", ""),
    # Idle runner presence (August 2026): one non-secret machine heartbeat lets
    # Auto-run show which executor is ready even before it claims its first job.
    (47, "add_agent_runners", ""),
)

CANDIDATE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_project_candidates_order"
    "  ON project_candidates(project_id, created_seq)",
)

# Migration 44's indexes — handler-only, see the migration comment.
USER_PROVIDER_CAP_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_sandbox_generations_user"
    "  ON sandbox_generations(user_id, provider, started_at)",
)

# Mirrors the SCHEMA blocks exactly; extending either means extending these.
SANDBOX_BUDGET_COLUMNS = {
    "user_id": "TEXT NOT NULL DEFAULT ''",
    "billing_mode": "TEXT NOT NULL DEFAULT ''",
    "quoted_price_usd_per_hour": "REAL",
    "budget_state": "TEXT NOT NULL DEFAULT ''",
    "over_budget_at": "TEXT",
}

GENERATION_ATTRIBUTION_COLUMNS = {
    "user_id": "TEXT NOT NULL DEFAULT ''",
    "billing_mode": "TEXT NOT NULL DEFAULT ''",
    "sandbox_uid": "TEXT NOT NULL DEFAULT ''",
    "price_known": "INTEGER NOT NULL DEFAULT 0",
}

# Migration 41 indexes. They cannot live in SCHEMA because an existing store
# reaches the table only when the migration ladder creates it.
AGENT_SESSION_INDEXES = (
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_runner_retry"
    "  ON agent_sessions(runner_id, idempotency_key)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_experiment"
    "  ON agent_sessions(target_type, target_id)"
    "  WHERE kind = 'experiment' AND status IN ('offered', 'active')",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_consolidation"
    "  ON agent_sessions(target_type, target_id)"
    "  WHERE kind = 'consolidation' AND status IN ('offered', 'active')",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_sessions_one_live_review"
    "  ON agent_sessions(review_request_id)"
    "  WHERE kind = 'review' AND status IN ('offered', 'active')",
    "CREATE INDEX IF NOT EXISTS idx_agent_sessions_project"
    "  ON agent_sessions(project_id, created_at)",
)

CONSOLIDATION_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_consolidation_proposals_reflection"
    "  ON consolidation_proposals(reflection_id, revision)",
    "CREATE INDEX IF NOT EXISTS idx_reflection_advances_reflection"
    "  ON reflection_advances(reflection_id, intended_at)",
)

# Migration 40's index. Same rule as 37/38/39's: it lives HERE, never in
# SCHEMA, because SCHEMA runs before the ladder and cannot name a column the
# ladder has not added yet.
TRACKING_DELIVERY_INDEXES = (
    # Exactly the barrier's lookup, and its uniqueness law: one row per
    # delivery per target, so the database itself — not only the check inside
    # the write transaction — states that a delivery appends at most once.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_deliveries_key"
    "  ON tracking_deliveries(project_id, target_type, target_id, delivery_id)",
)

# Migration 39's index. Same rule as 37's and 38's: it lives HERE, never in
# SCHEMA, because SCHEMA runs before the ladder and cannot name a column the
# ladder has not added yet.
EVENT_TARGET_INDEXES = (
    # The equality columns first, then `id` so a newest-first window is read
    # straight off the index instead of sorted. Migration 40 moved the
    # delivery barrier off this index onto its own key; what remains — and
    # what keeps it — is every other per-target event read (an experiment's or
    # reflection's own history).
    "CREATE INDEX IF NOT EXISTS idx_events_target"
    "  ON events(project_id, target_type, target_id, id)",
)

# Migration 38's indexes. Same rule as migration 37's: they live HERE, never in
# SCHEMA, because SCHEMA runs before the ladder and cannot name a column the
# ladder has not added yet.
OAUTH_CLIENT_FINGERPRINT_INDEXES = (
    # The get-or-create arbiter. NULLs are distinct on both dialects, which is
    # exactly the escape hatch legacy duplicate rows need.
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_fingerprint"
    "  ON oauth_clients(metadata_fingerprint)",
    # `client_id NOT IN (SELECT client_id FROM ...)` on the registration path.
    "CREATE INDEX IF NOT EXISTS idx_oauth_codes_client"
    "  ON oauth_authorization_codes(client_id)",
    "CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_client"
    "  ON oauth_refresh_tokens(client_id)",
)

# Migration 37's indexes. They live HERE and never in SCHEMA: SCHEMA runs on
# every boot BEFORE the ladder, and its CREATE TABLE IF NOT EXISTS is a no-op
# on a database that already has the table — so an index in SCHEMA can name a
# column the ladder has not added yet and crash-loop the container (the
# migration-36 outage, commit d4b766c). _apply_migrations runs on fresh
# databases too, so both paths get every index.
TOOL_CALL_LEDGER_INDEXES = (
    # The ledger's own mining reads: per-project timeline, error hunt, per-tool
    # rollup. Each pairs its filter with the append order it is scanned in.
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_project ON tool_calls(project_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status, id)",
    "CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool, id)",
    # Audit §5.3 minimum plan for the existing hot reads.
    "CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, id)",
    "CREATE INDEX IF NOT EXISTS idx_storage_objects_content"
    "  ON storage_objects(namespace, content_sha256, status)",
    "CREATE INDEX IF NOT EXISTS idx_storage_objects_latest"
    "  ON storage_objects(project_id, status, name, version DESC)",
    "CREATE INDEX IF NOT EXISTS idx_storage_objects_producer"
    "  ON storage_objects(project_id, producing_experiment_id, status)",
    # Deliberately NOT unique: upload_id uniqueness is unenforced today, so a
    # unique index could fail on existing production rows. Enforcing it is a
    # separate behavioral decision.
    "CREATE INDEX IF NOT EXISTS idx_storage_objects_upload"
    "  ON storage_objects(project_id, upload_id)",
    "CREATE INDEX IF NOT EXISTS idx_sandbox_generations_tenant"
    "  ON sandbox_generations(tenant_id, started_at)",
    "CREATE INDEX IF NOT EXISTS idx_sandbox_generations_project"
    "  ON sandbox_generations(project_id, created_seq)",
)

# Credential tables that carry a scope discriminator (migration 34).
GRANT_SCOPE_TABLES = (
    "project_api_keys",
    "oauth_authorization_codes",
    "oauth_refresh_tokens",
)


EXPERIMENT_MLFLOW_COLUMNS: dict[str, str] = {
    "mlflow_run_id": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_name": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_status": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_artifact_uri": "TEXT NOT NULL DEFAULT ''",
    "mlflow_run_created_at": "TEXT",
    "mlflow_run_error": "TEXT NOT NULL DEFAULT ''",
}


# Rebuild shape for the legacy `review_requests` table whose `capability`
# column carried a column-level UNIQUE (cloud plan Phase 7). SQLite cannot drop
# such a column in place, so copy into this shape — `capability_hash` replaces
# `capability` — and swap. No UNIQUE on capability_hash here: empty-string
# placeholders during the row-by-row rehash would collide under it; fresh DBs
# get the UNIQUE constraint from the SCHEMA constant. Kept in sync with the
# review_requests block in SCHEMA above (minus that one constraint).
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


def _schema_table_ddl(*, table: str, name: str | None = None) -> str:
    """Extract one CREATE TABLE block from SCHEMA for SQLite rebuilds."""
    match = re.search(
        rf"CREATE TABLE IF NOT EXISTS {table} \((.*?)\n\);",
        SCHEMA,
        re.DOTALL,
    )
    if match is None:
        raise RuntimeError(f"table not found in schema: {table}")
    ddl = match.group(0)
    if name is not None:
        ddl = ddl.replace(
            f"CREATE TABLE IF NOT EXISTS {table}",
            f"CREATE TABLE {name}",
            1,
        )
    return ddl


# Migration 24's own legacy-role map (frozen here: the shared vocabulary no
# longer carries aliases). 'graph' is legacy only on reflection targets —
# experiment logic graphs legitimately keep the role.
_MIGRATION_24_LEGACY_ROLES = {
    "reflection": "reflection_lens_doc",
    "synthesis_doc": "reflection_doc",
    "proposals": "change_spec",
}


def _canonical_artifact_role(*, role: str, target_type: str) -> str:
    if target_type == "reflection" and role == "graph":
        return "project_graph"
    return _MIGRATION_24_LEGACY_ROLES.get(role, role)


class BaseStateStore:
    """Dialect-neutral record-store contract and shared persistence helpers.

    The dialect seam (cloud plan Phase 6): subclasses own connections and
    transaction semantics, but must present the same surface the services
    were written against — ``connect()`` returns a connection whose
    ``execute`` accepts ``?`` placeholders and whose rows are mappings
    (``row["col"]`` + ``.keys()``), and ``transaction()`` yields such a
    connection under single-writer semantics. Everything here is plain SQL
    that runs unchanged on both dialects.
    """

    def connect(self) -> Connection:
        raise NotImplementedError

    @contextmanager
    def transaction(self) -> Iterator[Connection]:
        raise NotImplementedError

    @contextmanager
    def _migration_scope(self, *, conn: Connection) -> Iterator[None]:
        """Atomicity for one migration + its ledger row. SQLite already runs
        _apply_migrations inside _initialize's BEGIN IMMEDIATE, so the base is
        a no-op; the Postgres dialect (autocommit connections) overrides."""
        yield

    def _apply_migrations(self, *, conn: Connection) -> None:
        """Apply unapplied ledger migrations in order, recording each."""
        applied = {
            int(row["version"])
            for row in conn.execute("SELECT version FROM schema_migrations").fetchall()
        }
        for version, name, statement in MIGRATIONS:
            if version in applied:
                continue
            with self._migration_scope(conn=conn):
                self._apply_one_migration(conn=conn, name=name, statement=statement)
                conn.execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
                    (version, name, now_iso()),
                )

    def _apply_one_migration(
        self, *, conn: Connection, name: str, statement: str
    ) -> None:
        if name == "add_sandbox_tenant_id":
            self._ensure_sandbox_tenant_id(conn=conn)
        elif name == "add_sandbox_heartbeat_columns":
            self._ensure_sandbox_heartbeat_columns(conn=conn)
        elif name == "migrate_sandbox_uid_identity":
            self._migrate_sandbox_uid_identity(conn=conn)
        elif name == "drop_sandboxes_experiment_unique":
            self._drop_sandboxes_experiment_unique(conn=conn)
        elif name == "backfill_sandbox_mgmt_key_refs":
            self._backfill_sandbox_mgmt_key_refs(conn=conn)
        elif name == "allow_sandbox_attachment_history":
            self._allow_sandbox_attachment_history(conn=conn)
        elif name == "drop_sandboxes_experiment_id":
            self._drop_sandboxes_experiment_id(conn=conn)
        elif name == "add_project_settings_json":
            self._ensure_project_settings_json(conn=conn)
        elif name == "add_experiment_mlflow_run_columns":
            self._ensure_experiment_mlflow_columns(conn=conn)
        elif name == "add_review_synopsis":
            self._ensure_review_synopsis(conn=conn)
        elif name == "add_sandbox_public_key_source":
            self._ensure_sandbox_public_key_source(conn=conn)
        elif name == "rename_syntheses_to_reflections":
            self._rename_syntheses_to_reflections(conn=conn)
        elif name == "add_sandbox_last_command_columns":
            self._ensure_sandbox_last_command_columns(conn=conn)
        elif name == "add_sandbox_provider_columns":
            self._ensure_sandbox_provider_columns(conn=conn)
        elif name == "unify_synthesis_to_reflection":
            self._unify_synthesis_to_reflection(conn=conn)
        elif name == "add_litreview_sections":
            conn.execute(_schema_table_ddl(table="litreview_sections"))
        elif name == "add_litreview_papers":
            conn.execute(_schema_table_ddl(table="papers"))
        elif name == "add_litreview_paper_links":
            conn.execute(_schema_table_ddl(table="paper_links"))
        elif name == "add_artifacts_tables":
            self._add_artifacts_tables(conn=conn)
        elif name == "drop_resource_tables":
            self._drop_resource_tables(conn=conn)
        elif name == "add_project_api_keys":
            if not self._has_table(conn=conn, table="project_api_keys"):
                conn.execute(_schema_table_ddl(table="project_api_keys"))
        elif name == "add_sandbox_generation_key_id":
            self._ensure_sandbox_generation_key_id(conn=conn)
        elif name == "add_oauth_clients":
            if not self._has_table(conn=conn, table="oauth_clients"):
                conn.execute(_schema_table_ddl(table="oauth_clients"))
        elif name == "add_oauth_authorization_codes":
            if not self._has_table(conn=conn, table="oauth_authorization_codes"):
                conn.execute(_schema_table_ddl(table="oauth_authorization_codes"))
        elif name == "add_oauth_refresh_tokens":
            if not self._has_table(conn=conn, table="oauth_refresh_tokens"):
                conn.execute(_schema_table_ddl(table="oauth_refresh_tokens"))
        elif name == "add_user_hf_tokens":
            if not self._has_table(conn=conn, table="user_hf_tokens"):
                conn.execute(_schema_table_ddl(table="user_hf_tokens"))
        elif name == "add_sandbox_provider_settings":
            if not self._has_table(conn=conn, table="sandbox_provider_settings"):
                conn.execute(_schema_table_ddl(table="sandbox_provider_settings"))
        elif name == "add_feed_upload_tokens":
            pass  # Historical marker; Feed installs its owned schema at startup.
        elif name == "add_storage_completion_tokens":
            if not self._has_table(conn=conn, table="storage_completion_tokens"):
                conn.execute(_schema_table_ddl(table="storage_completion_tokens"))
        elif name == "add_grant_scope":
            self._ensure_grant_scope(conn=conn)
        elif name == "add_runs_final_observed_at":
            self._ensure_runs_final_observed_at(conn=conn)
        elif name == "add_submission_attempts":
            self._add_submission_attempts(conn=conn)
        elif name == "add_tool_call_ledger":
            self._add_tool_call_ledger(conn=conn)
        elif name == "add_oauth_client_fingerprint":
            self._add_oauth_client_fingerprint(conn=conn)
        elif name == "add_events_target_index":
            self._add_events_target_index(conn=conn)
        elif name == "add_tracking_deliveries":
            self._add_tracking_deliveries(conn=conn)
        elif name == "add_agent_sessions":
            self._add_agent_sessions(conn=conn)
        elif name == "add_consolidation":
            self._add_consolidation(conn=conn)
        elif name == "add_user_provider_caps":
            self._add_user_provider_caps(conn=conn)
        elif name == "add_project_candidates":
            self._add_project_candidates(conn=conn)
        elif name == "add_agent_session_observability":
            self._add_agent_session_observability(conn=conn)
        elif name == "add_agent_runners":
            if not self._has_table(conn=conn, table="agent_runners"):
                conn.execute(_schema_table_ddl(table="agent_runners"))
        else:
            conn.execute(statement)

    def _add_agent_session_observability(self, *, conn: Connection) -> None:
        """Migration 46: bounded assignment/setup/telemetry session state."""
        columns = {
            "assignment_json": "TEXT NOT NULL DEFAULT '{}'",
            "agent_setup_json": "TEXT NOT NULL DEFAULT '{}'",
            "telemetry_json": "TEXT NOT NULL DEFAULT '{}'",
            "telemetry_at": "TEXT",
        }
        for column, ddl in columns.items():
            if not self._has_column(conn=conn, table="agent_sessions", column=column):
                conn.execute(f"ALTER TABLE agent_sessions ADD COLUMN {column} {ddl}")

    def _add_project_candidates(self, *, conn: Connection) -> None:
        """Migration 45: immutable project candidates and champion history."""
        if not self._has_table(conn=conn, table="project_candidates"):
            conn.execute(_schema_table_ddl(table="project_candidates"))
        for statement in CANDIDATE_INDEXES:
            conn.execute(statement)

    def _add_user_provider_caps(self, *, conn: Connection) -> None:
        """Migration 44: payer attribution + per-user per-provider daily caps."""
        for column, ddl in SANDBOX_BUDGET_COLUMNS.items():
            if not self._has_column(conn=conn, table="sandboxes", column=column):
                conn.execute(f"ALTER TABLE sandboxes ADD COLUMN {column} {ddl}")
        for column, ddl in GENERATION_ATTRIBUTION_COLUMNS.items():
            if not self._has_column(
                conn=conn, table="sandbox_generations", column=column
            ):
                conn.execute(
                    f"ALTER TABLE sandbox_generations ADD COLUMN {column} {ddl}"
                )
        if not self._has_table(conn=conn, table="provider_user_caps"):
            conn.execute(_schema_table_ddl(table="provider_user_caps"))
        exists = conn.execute(
            "SELECT 1 FROM provider_user_caps WHERE provider = ? AND user_id = ''",
            ("lambda_labs",),
        ).fetchone()
        if exists is None:
            conn.execute(
                "INSERT INTO provider_user_caps "
                "(provider, user_id, daily_usd_limit, updated_at) "
                "VALUES (?, '', ?, ?)",
                ("lambda_labs", 50.0, now_iso()),
            )
        for statement in USER_PROVIDER_CAP_INDEXES:
            conn.execute(statement)

    def _add_agent_sessions(self, *, conn: Connection) -> None:
        """Migration 41: coding-agent sessions and their concurrency keys."""
        if not self._has_table(conn=conn, table="agent_sessions"):
            conn.execute(_schema_table_ddl(table="agent_sessions"))
        for statement in AGENT_SESSION_INDEXES:
            conn.execute(statement)

    def _add_consolidation(self, *, conn: Connection) -> None:
        """Migration 42: generic coding tasks plus consolidation lineage."""
        if self._has_table(conn=conn, table="agent_sessions") and not self._has_column(
            conn=conn, table="agent_sessions", column="target_type"
        ):
            conn.execute(
                _schema_table_ddl(table="agent_sessions", name="agent_sessions_v42")
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
            "experiment_workspaces",
            "consolidation_proposals",
            "consolidation_decisions",
            "reflection_advances",
        ):
            if not self._has_table(conn=conn, table=table):
                conn.execute(_schema_table_ddl(table=table))
        # Migration 42 was exercised by development databases before the
        # consolidation receipt learned to distinguish selection from actual
        # Git ancestry. Keep those databases usable without another migration
        # number; released databases have not seen 42.
        for table, column, ddl in (
            (
                "consolidation_decisions",
                "source_sha",
                "ALTER TABLE consolidation_decisions "
                "ADD COLUMN source_sha TEXT NOT NULL DEFAULT ''",
            ),
            (
                "consolidation_decisions",
                "integration_kind",
                "ALTER TABLE consolidation_decisions "
                "ADD COLUMN integration_kind TEXT NOT NULL DEFAULT 'none'",
            ),
            (
                "reflection_advances",
                "ancestry_json",
                "ALTER TABLE reflection_advances "
                "ADD COLUMN ancestry_json TEXT NOT NULL DEFAULT '{}'",
            ),
        ):
            if not self._has_column(conn=conn, table=table, column=column):
                conn.execute(ddl)
        for statement in (*AGENT_SESSION_INDEXES, *CONSOLIDATION_INDEXES):
            conn.execute(statement)

    def _add_tracking_deliveries(self, *, conn: Connection) -> None:
        """Migration 40: the keyed-delivery table plus its UNIQUE index.

        Additive and idempotent. The table guard is belt-and-braces — SCHEMA
        creates it on both dialects before the ladder runs — but the index
        genuinely needs to be here, where it executes after the table it names
        exists. No backfill: pre-migration deliveries predate the dedupe
        feature shipping, so no committed event needs a row (see the ledger)."""
        if not self._has_table(conn=conn, table="tracking_deliveries"):
            conn.execute(_schema_table_ddl(table="tracking_deliveries"))
        for statement in TRACKING_DELIVERY_INDEXES:
            conn.execute(statement)

    def _add_events_target_index(self, *, conn: Connection) -> None:
        """Migration 39: the per-target events index the delivery barrier reads.

        Additive and idempotent — an index only. `events` is created by SCHEMA
        on both dialects long before this runs, so no table guard is needed."""
        for statement in EVENT_TARGET_INDEXES:
            conn.execute(statement)

    def _add_oauth_client_fingerprint(self, *, conn: Connection) -> None:
        """Migration 38: the canonical DCR fingerprint, its UNIQUE index, and
        the two child-table client_id indexes.

        Additive. The backfill computes each existing row's fingerprint from
        CANONICALIZED metadata — the same normalization new registrations
        apply — so a row written before canonicalization is still found by a
        canonical lookup. Rows that canonicalize to an already-claimed
        fingerprint keep NULL: the oldest row owns the identity, the duplicates
        stay reachable by client_id, and the UNIQUE index can be built."""
        if not self._has_table(conn=conn, table="oauth_clients"):
            return
        if not self._has_column(
            conn=conn, table="oauth_clients", column="metadata_fingerprint"
        ):
            conn.execute(
                "ALTER TABLE oauth_clients ADD COLUMN metadata_fingerprint TEXT"
            )
        # Seeded from whatever already holds an identity so the backfill is
        # re-runnable: a second pass can never hand out a taken fingerprint.
        claimed = {
            str((row_to_dict(row=row) or {}).get("metadata_fingerprint") or "")
            for row in conn.execute(
                "SELECT metadata_fingerprint FROM oauth_clients "
                "WHERE metadata_fingerprint IS NOT NULL"
            ).fetchall()
        }
        rows = conn.execute(
            """
            SELECT client_id, client_name, redirect_uris_json, grant_types_json
            FROM oauth_clients
            WHERE metadata_fingerprint IS NULL
            ORDER BY created_at, client_id
            """
        ).fetchall()
        for row in rows:
            data = row_to_dict(row=row) or {}
            fingerprint = oauth_client_fingerprint(
                client_name=str(data.get("client_name") or ""),
                redirect_uris_json=str(data.get("redirect_uris_json") or ""),
                grant_types_json=str(data.get("grant_types_json") or ""),
            )
            if fingerprint in claimed:
                continue
            claimed.add(fingerprint)
            conn.execute(
                "UPDATE oauth_clients SET metadata_fingerprint = ? WHERE client_id = ?",
                (fingerprint, str(data.get("client_id") or "")),
            )
        for statement in OAUTH_CLIENT_FINGERPRINT_INDEXES:
            conn.execute(statement)

    def _add_tool_call_ledger(self, *, conn: Connection) -> None:
        """Migration 37: the durable tool-call ledger plus the read-path indexes.

        Additive and idempotent. The table guard is belt-and-braces — SCHEMA
        creates it on both dialects before the ladder runs — but the indexes
        genuinely need to be here, where they execute after every table and
        column they name exists."""
        if not self._has_table(conn=conn, table="tool_calls"):
            conn.execute(_schema_table_ddl(table="tool_calls"))
        for statement in TOOL_CALL_LEDGER_INDEXES:
            conn.execute(statement)

    def _add_submission_attempts(self, *, conn: Connection) -> None:
        """Migration 36: the submissions table plus the two seal columns.

        Purely additive and idempotent. The indexes are issued explicitly
        because _schema_table_ddl only extracts CREATE TABLE blocks."""
        if not self._has_table(conn=conn, table="submissions"):
            conn.execute(_schema_table_ddl(table="submissions"))
        for table in ("artifacts", "reviews"):
            if not self._has_column(conn=conn, table=table, column="submission_id"):
                conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN submission_id TEXT NOT NULL "
                    "DEFAULT ''"
                )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_submissions_target "
            "ON submissions(target_type, target_id, attempt_index, created_seq)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_artifacts_submission "
            "ON artifacts(target_type, target_id, attempt_index, submission_id)"
        )

    def _ensure_grant_scope(self, *, conn: Connection) -> None:
        # Same column definition the SCHEMA declares, so a migrated database
        # and a fresh one are identical (CHECK included: both dialects accept
        # it on ADD COLUMN).
        for table in GRANT_SCOPE_TABLES:
            if not self._has_column(conn=conn, table=table, column="grant_scope"):
                conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN grant_scope TEXT NOT NULL "
                    "DEFAULT 'project' CHECK (grant_scope IN ('project', 'account'))"
                )

    def _ensure_sandbox_generation_key_id(self, *, conn: Connection) -> None:
        if not self._has_column(
            conn=conn, table="sandbox_generations", column="key_id"
        ):
            conn.execute("ALTER TABLE sandbox_generations ADD COLUMN key_id TEXT")

    def _ensure_project_settings_json(self, *, conn: Connection) -> None:
        if not self._has_column(conn=conn, table="projects", column="settings_json"):
            conn.execute(
                "ALTER TABLE projects ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'"
            )

    def _ensure_experiment_mlflow_columns(self, *, conn: Connection) -> None:
        for column, ddl in EXPERIMENT_MLFLOW_COLUMNS.items():
            if not self._has_column(conn=conn, table="experiments", column=column):
                conn.execute(f"ALTER TABLE experiments ADD COLUMN {column} {ddl}")

    def _ensure_review_synopsis(self, *, conn: Connection) -> None:
        if not self._has_column(conn=conn, table="reviews", column="synopsis"):
            conn.execute(
                "ALTER TABLE reviews ADD COLUMN synopsis TEXT NOT NULL DEFAULT ''"
            )

    def _ensure_runs_final_observed_at(self, *, conn: Connection) -> None:
        # Nullable with no default: NULL is the meaningful "never observed"
        # value, so pre-existing rows correctly report `unknown` rather than
        # claiming an observation that never happened.
        if not self._has_column(
            conn=conn, table="sandboxes", column="runs_final_observed_at"
        ):
            conn.execute("ALTER TABLE sandboxes ADD COLUMN runs_final_observed_at TEXT")

    def _ensure_sandbox_public_key_source(self, *, conn: Connection) -> None:
        if not self._has_column(
            conn=conn, table="sandboxes", column="public_key_source"
        ):
            conn.execute(
                "ALTER TABLE sandboxes ADD COLUMN public_key_source TEXT NOT NULL DEFAULT 'managed'"
            )

    # Mirrors the SCHEMA block exactly; adding a ninth last_command_* column
    # there means extending this map too.
    SANDBOX_LAST_COMMAND_COLUMNS = {
        "last_command_id": "TEXT NOT NULL DEFAULT ''",
        "last_command_text": "TEXT NOT NULL DEFAULT ''",
        "last_command_started_at": "TEXT",
        "last_command_status": "TEXT NOT NULL DEFAULT ''",
        "last_command_exit_code": "INTEGER",
        "last_command_finished_at": "TEXT",
        "last_command_output_tail": "TEXT NOT NULL DEFAULT ''",
        "last_command_snapshot_at": "TEXT",
    }

    def _ensure_sandbox_last_command_columns(self, *, conn: Connection) -> None:
        for column, ddl in self.SANDBOX_LAST_COMMAND_COLUMNS.items():
            if not self._has_column(conn=conn, table="sandboxes", column=column):
                conn.execute(f"ALTER TABLE sandboxes ADD COLUMN {column} {ddl}")

    def _ensure_sandbox_provider_columns(self, *, conn: Connection) -> None:
        """Idempotently add the owning-provider column to both sandbox tables.

        Backfill is the empty string: '' means "the configured default
        backend" at read time, so pre-multi-provider rows keep working.
        """
        for table in ("sandboxes", "sandbox_generations"):
            if not self._has_column(conn=conn, table=table, column="provider"):
                conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN provider TEXT NOT NULL DEFAULT ''"
                )

    def _rename_syntheses_to_reflections(self, *, conn: Connection) -> None:
        if self._has_table(conn=conn, table="reflections"):
            return
        if self._has_table(conn=conn, table="syntheses"):
            conn.execute("ALTER TABLE syntheses RENAME TO reflections")

    def _rename_synthesis_wave_tables(self, *, conn: Connection) -> None:
        """Move legacy synthesis_* wave-relation tables to reflection_*.

        Runs BEFORE the SCHEMA create in both stores' _initialize (like
        _rename_syntheses_to_reflections) so old data is renamed into place
        rather than stranded beside fresh empty reflection_* tables; guarded
        and idempotent, so the ledger handler can call it again safely.
        """
        for old, new in (
            ("synthesis_claim_changes", "reflection_claim_changes"),
            ("synthesis_experiments", "reflection_experiments"),
        ):
            if not self._has_table(conn=conn, table=new) and self._has_table(
                conn=conn, table=old
            ):
                conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
            if self._has_table(conn=conn, table=new) and self._has_column(
                conn=conn, table=new, column="synthesis_id"
            ):
                conn.execute(
                    f"ALTER TABLE {new} RENAME COLUMN synthesis_id TO reflection_id"
                )

    def _unify_synthesis_to_reflection(self, *, conn: Connection) -> None:
        """Retire the synthesis wave vocabulary from persisted state.

        Fresh schemas already carry the reflection_* shapes, so every step is
        guarded or a naturally idempotent UPDATE. The snapshot-id rewrites are
        surgical (prefix swap + pipe-delimited status segment) so resource
        tokens embedding legacy roles like synthesis_doc stay byte-identical —
        those must keep matching the association rows they pinned.
        """
        self._rename_synthesis_wave_tables(conn=conn)
        conn.execute(
            "UPDATE reflections SET status = 'reflection_review' WHERE status = 'synthesis_review'"
        )
        # Events history: type prefix, target_type, and the known payload
        # vocabulary (statuses, the transition verb, claim provenance keys).
        # String-level JSON rewrites are deliberate — the payload shapes are
        # known and `synthesizing` (the phase, which stays) matches none of
        # the patterns.
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
        # byte-compared snapshot ids (`synthesis|<id>|synthesis_review|...`),
        # so a pass recorded before the rename still satisfies its gate.
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
        if self._has_table(conn=conn, table="resource_associations"):
            conn.execute(
                "UPDATE resource_associations SET target_type = 'reflection' "
                "WHERE target_type = 'synthesis'"
            )

    def _add_artifacts_tables(self, *, conn: Connection) -> None:
        """Create the artifact tables and backfill from the resource system.

        Metadata-only: every gated/result blob already lives in the blob store
        keyed by (project_id, sha256), so one artifact row per association
        (resource x version x target) carries the story forward. Legacy role
        spellings are canonicalized here — post-cut readers (and the UI) know
        only the canonical vocabulary — and the snapshot-token rewrite emits
        the canonical role so pinned passing reviews keep matching. Fresh
        databases hit only the IF-NOT-EXISTS creates — the resource tables are
        empty, so every backfill loop is a no-op.
        """
        conn.execute(_schema_table_ddl(table="artifacts"))
        conn.execute(_schema_table_ddl(table="artifact_figures"))
        if not self._has_table(conn=conn, table="resource_associations"):
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
        # canonical role), for snapshot tokens — the version keeps a review
        # pinned to a superseded version stale instead of reviving it;
        # (version, target) -> [(artifact id, canonical role)], for figures
        # and published-graph refs (shared versions keep every artifact).
        by_assoc: dict[tuple[str, str, str, str, str, int], tuple[str, str]] = {}
        by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]] = {}
        # One artifact per new-model slot: an old DB could legally hold a
        # legacy AND a canonical role spelling for the same resource/target/
        # attempt, which canonicalize into one slot. Winner: the association
        # already spelled canonically, else the newer one; every duplicate
        # still maps to the survivor below so snapshot-token rewrites and
        # figure fan-out resolve.
        prepared: list[tuple[Row, str, str, str, tuple]] = []
        winners: dict[tuple, int] = {}
        for row in rows:
            path = str(row["path"] or "")
            role = str(row["role"] or "")
            canonical = _canonical_artifact_role(
                role=role, target_type=str(row["target_type"])
            )
            basename = path.rsplit("/", 1)[-1]
            lens_id = (
                basename.rsplit(".", 1)[0] if canonical == "reflection_lens_doc" else ""
            )
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
            held_was_canonical = (
                held is not None and prepared[held][1] == prepared[held][2]
            )
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
        self._backfill_artifact_figures(conn=conn, by_version_target=by_version_target)
        self._rewrite_published_graph_refs(
            conn=conn, by_version_target=by_version_target
        )
        self._rewrite_snapshot_resource_tokens(conn=conn, by_assoc=by_assoc)

    @staticmethod
    def _drop_resource_tables(*, conn: Connection) -> None:
        """Migration 25: drop the resource-tracking tables, child tables first."""
        for table in (
            "report_figures",
            "resource_associations",
            "resource_versions",
            "resources",
            "resources_migrate",
        ):
            conn.execute(f"DROP TABLE IF EXISTS {table}")

    def _backfill_artifact_figures(
        self,
        *,
        conn: Connection,
        by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]],
    ) -> None:
        """report_figures rows fan out to one row per backfilled artifact."""
        if not self._has_table(conn=conn, table="report_figures"):
            return
        artifacts_by_version: dict[str, list[str]] = {}
        for (version_id, _tt, _tid), artifacts in by_version_target.items():
            artifacts_by_version.setdefault(version_id, []).extend(
                artifact_id for artifact_id, _role in artifacts
            )
        for row in conn.execute(
            "SELECT report_version_id, link_path, sha256, size_bytes FROM report_figures"
        ).fetchall():
            for artifact_id in artifacts_by_version.get(
                str(row["report_version_id"]), []
            ):
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

    @staticmethod
    def _rewrite_published_graph_refs(
        *,
        conn: Connection,
        by_version_target: dict[tuple[str, str, str], list[tuple[str, str]]],
    ) -> None:
        """Repoint each publish pin at that reflection's project_graph artifact
        specifically — a version shared with another role must not win."""
        for row in conn.execute(
            "SELECT id, published_graph_version_id FROM reflections "
            "WHERE COALESCE(published_graph_version_id, '') != ''"
        ).fetchall():
            candidates = by_version_target.get(
                (str(row["published_graph_version_id"]), "reflection", str(row["id"])),
                [],
            )
            artifact_id = next(
                (aid for aid, role in candidates if role == "project_graph"), None
            )
            if artifact_id:
                conn.execute(
                    "UPDATE reflections SET published_graph_version_id = ? WHERE id = ?",
                    (artifact_id, row["id"]),
                )

    @staticmethod
    def _rewrite_snapshot_resource_tokens(
        *,
        conn: Connection,
        by_assoc: dict[tuple[str, str, str, str, str, int], tuple[str, str]],
    ) -> None:
        """Old `res:ver:role:attempt` snapshot tokens become `art:role:attempt`
        with the canonical role spelling.

        The version is part of the lookup key: a review pinned to a superseded
        version finds no mapping and keeps its token verbatim — the snapshot
        stays stale instead of being revived onto the current version.
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
                    tokens.append(
                        f"{mapped[0]}:{mapped[1]}:{attempt}" if mapped else token
                    )
                # set(): duplicate-slot dedupe maps several old associations to
                # one survivor; the live snapshot lists that artifact once.
                rewritten = "|".join([*parts[:4], ",".join(sorted(set(tokens)))])
                if rewritten != str(row["target_snapshot_id"]):
                    conn.execute(
                        f"UPDATE {table} SET target_snapshot_id = ? WHERE id = ?",
                        (rewritten, row["id"]),
                    )

    def _ensure_sandbox_tenant_id(self, *, conn: Connection) -> None:
        if not self._has_column(conn=conn, table="sandboxes", column="tenant_id"):
            conn.execute(
                "ALTER TABLE sandboxes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local'"
            )
        conn.execute(
            """
            UPDATE sandboxes
            SET tenant_id = COALESCE(
              (SELECT tenant_id FROM projects WHERE projects.id = sandboxes.project_id),
              tenant_id,
              'local'
            )
            WHERE project_id != ''
            """
        )

    def _ensure_sandbox_heartbeat_columns(self, *, conn: Connection) -> None:
        """Idempotently add the idle-reaper columns to existing SQLite/Postgres."""
        for column, ddl in (
            ("idle_since", "TEXT"),
            ("heartbeat_snapshot_json", "TEXT NOT NULL DEFAULT '{}'"),
        ):
            if not self._has_column(conn=conn, table="sandboxes", column=column):
                conn.execute(f"ALTER TABLE sandboxes ADD COLUMN {column} {ddl}")

    def _drop_sandboxes_experiment_unique(self, *, conn: Connection) -> None:
        conn.execute(
            "ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_experiment_id_key"
        )

    def _backfill_sandbox_mgmt_key_refs(self, *, conn: Connection) -> None:
        if not self._has_column(conn=conn, table="sandboxes", column="mgmt_key_ref"):
            conn.execute(
                "ALTER TABLE sandboxes ADD COLUMN mgmt_key_ref TEXT NOT NULL DEFAULT ''"
            )
        conn.execute(
            """
            UPDATE sandboxes
            SET mgmt_key_ref = sandbox_uid
            WHERE COALESCE(mgmt_key_ref, '') = '' AND COALESCE(sandbox_uid, '') != ''
            """
        )

    def _allow_sandbox_attachment_history(self, *, conn: Connection) -> None:
        conn.execute(
            "ALTER TABLE sandbox_attachments DROP CONSTRAINT IF EXISTS sandbox_attachments_pkey"
        )

    def _drop_sandboxes_experiment_id(self, *, conn: Connection) -> None:
        """Drop the legacy Postgres sandbox experiment_id column after backfill."""
        if not self._has_column(conn=conn, table="sandboxes", column="experiment_id"):
            return
        self._backfill_sandbox_attachments(conn=conn)
        conn.execute("ALTER TABLE sandboxes DROP COLUMN IF EXISTS experiment_id")

    def _migrate_sandbox_uid_identity(self, *, conn: Connection) -> None:
        """Repoint an experiment_id-keyed sandboxes table onto sandbox_uid.

        The decoupling refactor makes sandbox_uid the primary key and opens the
        sandbox_attachments relation. Fresh schemas already have that shape and
        SQLite reaches it in _ensure_forward_schema, so the guard makes this a
        no-op there; the real work upgrades a hosted Postgres store that predates
        the refactor. Idempotent: every step is guarded or IF-EXISTS, and the PK
        swap only commits once (a partial run re-converges on the next boot).
        """
        if self._sandboxes_uid_is_pk(conn=conn):
            return
        # No legacy sandboxes table yet (a fresh database, before its
        # schema-create) — there is nothing to upgrade; the schema-create builds
        # the final sandbox_uid-keyed shape directly.
        if not self._has_column(conn=conn, table="sandboxes", column="experiment_id"):
            return
        if not self._has_column(conn=conn, table="sandboxes", column="sandbox_uid"):
            conn.execute("ALTER TABLE sandboxes ADD COLUMN sandbox_uid TEXT")
        # experiment_id was the legacy primary key, so it addresses each row.
        for row in conn.execute(
            "SELECT experiment_id FROM sandboxes WHERE COALESCE(sandbox_uid, '') = ''"
        ).fetchall():
            conn.execute(
                "UPDATE sandboxes SET sandbox_uid = ? WHERE experiment_id = ?",
                (uuid.uuid4().hex, row["experiment_id"]),
            )
        conn.execute("ALTER TABLE sandboxes DROP CONSTRAINT IF EXISTS sandboxes_pkey")
        conn.execute("ALTER TABLE sandboxes ADD PRIMARY KEY (sandbox_uid)")
        # Open one attachment per surviving sandbox (closed if already terminated).
        self._backfill_sandbox_attachments(conn=conn)

    def _sandboxes_uid_is_pk(self, *, conn: Connection) -> bool:
        """True once sandbox_uid is the sandboxes primary key (fresh or upgraded)."""
        try:
            rows = conn.execute("PRAGMA table_info(sandboxes)").fetchall()
            if rows:
                return any(
                    str(row["name"]) == "sandbox_uid" and int(row["pk"] or 0) > 0
                    for row in rows
                )
        except Exception:  # noqa: BLE001 - Postgres has no PRAGMA
            pass
        row = conn.execute(
            """
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.table_name = 'sandboxes'
              AND tc.constraint_type = 'PRIMARY KEY'
              AND kcu.column_name = 'sandbox_uid'
            """
        ).fetchone()
        return row is not None

    def _backfill_sandbox_attachments(self, *, conn: Connection) -> None:
        """Open the forward relation for legacy/un-attached rows; a no-op once filled.

        Dialect-neutral so both the SQLite forward-schema rebuild and the Postgres
        identity migration share it.
        """
        conn.execute(_schema_table_ddl(table="sandbox_attachments"))
        if not self._has_column(conn=conn, table="sandboxes", column="experiment_id"):
            return
        # Only rows still missing their attachment — so re-runs after the first
        # upgrade do no work, while a partial upgrade still gets finished.
        rows = conn.execute(
            """
            SELECT sandbox_uid, experiment_id, requested_at, created_at, updated_at,
                   terminated_at, status
            FROM sandboxes
            WHERE COALESCE(sandbox_uid, '') != ''
              AND NOT EXISTS (
                SELECT 1 FROM sandbox_attachments a
                WHERE a.sandbox_uid = sandboxes.sandbox_uid
                  AND a.experiment_id = sandboxes.experiment_id
              )
            """
        ).fetchall()
        for row in rows:
            attached_at = (
                row["requested_at"]
                or row["created_at"]
                or row["updated_at"]
                or now_iso()
            )
            detached_at = None
            if row["terminated_at"] or row["status"] in {"terminated", "failed"}:
                detached_at = row["terminated_at"] or row["updated_at"] or attached_at
            conn.execute(
                """
                INSERT INTO sandbox_attachments (
                  sandbox_uid, experiment_id, attached_at, detached_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (row["sandbox_uid"], row["experiment_id"], attached_at, detached_at),
            )

    def _has_column(self, *, conn: Connection, table: str, column: str) -> bool:
        try:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
            if rows:
                return any(str(row["name"]) == column for row in rows)
        except Exception:  # noqa: BLE001 - Postgres has no PRAGMA
            pass
        row = conn.execute(
            """
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ? AND column_name = ?
            """,
            (table, column),
        ).fetchone()
        return row is not None

    def _has_table(self, *, conn: Connection, table: str) -> bool:
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                (table,),
            ).fetchone()
            return row is not None
        except Exception:  # noqa: BLE001 - Postgres has no sqlite_master
            pass
        row = conn.execute(
            """
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = ?
            """,
            (table,),
        ).fetchone()
        return row is not None

    def require_project_id(
        self,
        *,
        conn: Connection,
        project_id: str | None,
        tenant_id: str | None = None,
    ) -> str:
        """Resolve and existence-check a project id, optionally tenant-scoped.

        Tenancy enforcement (cloud plan Phase 7): when ``tenant_id`` is given,
        the lookup is scoped to that tenant — a project owned by another tenant
        reads as not-found, so cross-tenant access is denied at the record
        layer. The default (``tenant_id`` unset) is today's behavior exactly, so
        every existing call site is unchanged and local mode (single implicit
        'local' tenant) never threads a tenant.
        """
        if not project_id:
            raise ValidationError("project_id is required")
        if tenant_id is None:
            row = conn.execute(
                "SELECT id FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM projects WHERE id = ? AND tenant_id = ?",
                (project_id, tenant_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"project not found: {project_id}")
        return project_id

    def record_event(
        self,
        *,
        conn: Connection,
        project_id: str,
        event_type: str,
        target_type: str = "",
        target_id: str = "",
        payload: dict[str, Any] | None = None,
    ) -> StoredEvent:
        created_at = now_iso()
        payload_json = json.dumps(payload or {}, sort_keys=True)
        row = conn.execute(
            """
            INSERT INTO events (project_id, type, target_type, target_id, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING id
            """,
            (
                project_id,
                event_type,
                target_type,
                target_id,
                payload_json,
                created_at,
            ),
        ).fetchone()
        if row is None:  # pragma: no cover - both supported dialects return it
            raise RuntimeError("event insert did not return an id")
        canonical_payload = json.loads(payload_json)
        return StoredEvent(
            id=int(row["id"]),
            project_id=project_id,
            type=event_type,
            target_type=target_type,
            target_id=target_id,
            payload=freeze_json_object(canonical_payload),
            created_at=created_at,
        )

    def events_since(
        self, *, project_id: str | None, after_id: int, limit: int = 500
    ) -> dict[str, Any]:
        """Ascending tail of the append-only events table — the SSE cursor read."""
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, type, target_type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ? AND id > ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (project_id, int(after_id), max(1, min(int(limit), 500))),
            ).fetchall()
            events = []
            for row in rows:
                item = row_to_dict(row=row) or {}
                item["payload"] = json.loads(str(item.pop("payload_json", "{}")))
                events.append(item)
            return {"events": events}

    def add_project_member(self, *, project_id: str, user_id: str) -> None:
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO project_members (project_id, user_id, added_at)
                VALUES (?, ?, ?)
                ON CONFLICT (project_id, user_id) DO NOTHING
                """,
                (project_id, user_id, now_iso()),
            )

    def remove_project_member(self, *, project_id: str, user_id: str) -> None:
        """Drop one membership, never the last one.

        Every human path into a project — listing, sharing, key minting — keys
        on membership, so emptying the table orphans the project permanently
        with no recovery route (audit AUTH-01). Removing a non-member stays the
        idempotent no-op it has always been.
        """
        with self.transaction() as conn:
            members = {
                str(row["user_id"])
                for row in conn.execute(
                    "SELECT user_id FROM project_members WHERE project_id = ?",
                    (project_id,),
                ).fetchall()
            }
            if members == {user_id}:
                raise ValidationError(
                    f"{user_id} is the only member of {project_id}; add another "
                    "member first — a project with no members can never be "
                    "reached or restored",
                    details={"project_id": project_id, "user_id": user_id},
                )
            conn.execute(
                "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
                (project_id, user_id),
            )

    def set_user_hf_token(self, *, user_id: str, token: str) -> None:
        """Upsert a user's Hugging Face token (no-dataplane Phase C).

        Write-only by contract: this + ``clear_user_hf_token`` are the only
        mutators, and no read method returns the value to an API — ``resolve``
        below is internal-only (sandbox provisioning). Dialect-neutral upsert
        (``excluded`` works on both SQLite >= 3.24 and Postgres)."""
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO user_hf_tokens (user_id, token, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT (user_id) DO UPDATE
                  SET token = excluded.token, updated_at = excluded.updated_at
                """,
                (user_id, token, now_iso()),
            )

    def clear_user_hf_token(self, *, user_id: str) -> None:
        with self.transaction() as conn:
            conn.execute("DELETE FROM user_hf_tokens WHERE user_id = ?", (user_id,))

    def user_hf_token(self, *, user_id: str) -> str:
        """Resolve a user's HF token for sandbox provisioning. INTERNAL ONLY —
        never surface this through an API. Empty when unset/unauthenticated,
        which the sandbox path treats as public-models-only graceful degrade."""
        if not user_id:
            return ""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT token FROM user_hf_tokens WHERE user_id = ?", (user_id,)
            ).fetchone()
        return str(row["token"]) if row and row["token"] else ""

    def upsert_sandbox_provider_settings(
        self,
        *,
        project_id: str,
        provider: str,
        credentials_json: str | None = None,
        enabled: bool | None = None,
        credential_mode: str | None = None,
        verified_at: str | None = None,
    ) -> None:
        """Upsert one (project, provider) connection row. ``None`` keeps the
        stored value (for ``verified_at`` pass ``""`` to clear); the insert
        defaults are ``'{}'``, enabled, mode ``''`` and unverified. Read-
        modify-write inside one transaction — a naive ON CONFLICT upsert would
        clobber the field a ``None`` meant to keep. A credential write always
        resets ``verified_at`` unless the caller stamps it in the same call.
        Credentials are write-only by contract — ``sandbox_provider_credentials``
        below is the internal-only read (see ``user_hf_token``)."""
        with self.transaction() as conn:
            row = conn.execute(
                """
                SELECT credentials, enabled, credential_mode, verified_at
                FROM sandbox_provider_settings
                WHERE project_id = ? AND provider = ?
                """,
                (project_id, provider),
            ).fetchone()
            stored_credentials = str(row["credentials"]) if row else "{}"
            stored_enabled = bool(row["enabled"]) if row else True
            stored_mode = str(row["credential_mode"] or "") if row else ""
            stored_verified = str(row["verified_at"] or "") if row else ""
            if verified_at is None:
                verified_at = "" if credentials_json is not None else stored_verified
            conn.execute(
                """
                INSERT INTO sandbox_provider_settings
                  (project_id, provider, credentials, enabled, credential_mode,
                   verified_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, provider) DO UPDATE SET
                  credentials = excluded.credentials,
                  enabled = excluded.enabled,
                  credential_mode = excluded.credential_mode,
                  verified_at = excluded.verified_at,
                  updated_at = excluded.updated_at
                """,
                (
                    project_id,
                    provider,
                    stored_credentials if credentials_json is None
                    else credentials_json,
                    int(stored_enabled if enabled is None else enabled),
                    stored_mode if credential_mode is None else credential_mode,
                    verified_at,
                    now_iso(),
                ),
            )

    def set_sandbox_provider_daily_limit(
        self, *, project_id: str, provider: str, daily_usd_limit: float | None
    ) -> None:
        """Set (or clear, with ``None``) the provider's daily USD cap. Its own
        method because ``None`` is a meaningful value here, not "keep"."""
        with self.transaction() as conn:
            existing = conn.execute(
                """
                SELECT 1 FROM sandbox_provider_settings
                WHERE project_id = ? AND provider = ?
                """,
                (project_id, provider),
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    UPDATE sandbox_provider_settings
                    SET daily_usd_limit = ?, updated_at = ?
                    WHERE project_id = ? AND provider = ?
                    """,
                    (daily_usd_limit, now_iso(), project_id, provider),
                )
            else:
                conn.execute(
                    """
                    INSERT INTO sandbox_provider_settings
                      (project_id, provider, daily_usd_limit, updated_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (project_id, provider, daily_usd_limit, now_iso()),
                )

    def list_sandbox_provider_settings(
        self, *, project_id: str
    ) -> list[dict[str, Any]]:
        """Every connection row for a project, credentials included — callers
        (the settings service) redact before anything reaches an API."""
        with closing(self.connect()) as conn:
            rows = conn.execute(
                """
                SELECT provider, credentials, enabled, credential_mode,
                       daily_usd_limit, verified_at, updated_at
                FROM sandbox_provider_settings WHERE project_id = ?
                ORDER BY provider
                """,
                (project_id,),
            ).fetchall()
        return [
            {
                "provider": str(row["provider"]),
                "credentials": str(row["credentials"] or "{}"),
                "enabled": bool(row["enabled"]),
                "credential_mode": str(row["credential_mode"] or ""),
                "daily_usd_limit": (
                    None
                    if row["daily_usd_limit"] is None
                    else float(row["daily_usd_limit"])
                ),
                "verified_at": str(row["verified_at"] or ""),
                "updated_at": str(row["updated_at"] or ""),
            }
            for row in rows
        ]

    def sandbox_provider_credentials(
        self, *, project_id: str, provider: str
    ) -> str:
        """Raw saved-credentials JSON for provisioning. INTERNAL ONLY — never
        surface this through an API. ``'{}'`` when no row exists."""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT credentials FROM sandbox_provider_settings
                WHERE project_id = ? AND provider = ?
                """,
                (project_id, provider),
            ).fetchone()
        return str(row["credentials"]) if row and row["credentials"] else "{}"

    # ---------- per-user per-provider daily caps (migration 44) ----------

    def resolve_provider_user_cap(
        self, *, provider: str, user_id: str, conn: Connection | None = None
    ) -> float | None:
        """The cap that applies to one user on one provider, or None.

        The user's own row wins over the '' platform default; a row whose
        limit is NULL is an explicit uncapped override and also returns None.
        """
        if not provider or not user_id:
            return None
        if conn is None:
            with closing(self.connect()) as owned:
                return self.resolve_provider_user_cap(
                    provider=provider, user_id=user_id, conn=owned
                )
        for scope in (user_id, ""):
            row = conn.execute(
                "SELECT daily_usd_limit FROM provider_user_caps "
                "WHERE provider = ? AND user_id = ?",
                (provider, scope),
            ).fetchone()
            if row is not None:
                limit = row["daily_usd_limit"]
                return None if limit is None else float(limit)
        return None

    def serialize_provider_user_cap(
        self, *, conn: Connection, provider: str, user_id: str
    ) -> None:
        """Row-touch the applicable cap row so concurrent capped admissions
        and extensions for one user serialize on it (the tenant_quotas
        pattern). Touches the user's own row when it exists, else the ''
        platform default; no row = uncapped, nothing to serialize."""
        for scope in (user_id, ""):
            cursor = conn.execute(
                "UPDATE provider_user_caps SET provider = provider "
                "WHERE provider = ? AND user_id = ?",
                (provider, scope),
            )
            if int(getattr(cursor, "rowcount", 0)) == 1:
                return

    def any_provider_user_caps(self) -> bool:
        """Whether any user×provider cap is active — the scheduler must run
        the budget sweep whenever this is true."""
        try:
            with closing(self.connect()) as conn:
                row = conn.execute(
                    "SELECT 1 FROM provider_user_caps "
                    "WHERE daily_usd_limit IS NOT NULL LIMIT 1"
                ).fetchone()
            return row is not None
        except Exception:  # pragma: no cover - pre-migration store
            return False

    def api_key_owner(self, *, key_id: str) -> str:
        """Owner user of a management key, for payer-of-record resolution.

        Resolved at write time — key rows can be revoked or deleted later, so
        spend attribution must never depend on a read-time join.
        """
        if not key_id:
            return ""
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT owner_user_id FROM project_api_keys WHERE id = ?",
                (key_id,),
            ).fetchone()
        return str(row["owner_user_id"]) if row is not None else ""

    def is_project_member(self, *, project_id: str, user_id: str) -> bool:
        with closing(self.connect()) as conn:
            row = conn.execute(
                "SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?",
                (project_id, user_id),
            ).fetchone()
            return row is not None

    def list_project_members(self, *, project_id: str) -> list[dict[str, Any]]:
        with closing(self.connect()) as conn:
            rows = conn.execute(
                "SELECT user_id, added_at FROM project_members WHERE project_id = ? ORDER BY added_at",
                (project_id,),
            ).fetchall()
            return [row_to_dict(row=row) or {} for row in rows]

    def project_event_signal(self, *, project_id: str | None) -> str:
        """Monotonic per-project signal for the append-only event stream."""
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            row = conn.execute(
                """
                SELECT COALESCE(MAX(id), 0) AS max_id, COUNT(*) AS count
                FROM events
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
            if row is None:
                return "0:0"
            return f"{int(row['max_id'] or 0)}:{int(row['count'] or 0)}"

    def project_sandbox_signal(self, *, project_id: str | None) -> str:
        """Change signal for a project's sandbox rows (no event-table proxy).

        Sandbox lifecycle mutations — provision, status, heartbeat, command,
        terminate — every one bumps ``updated_at`` (see repository) but,
        unlike claims/experiments/reviews, do NOT append an event, so the event
        signal can't stand in for them. Digest each row's identity plus the
        fields the sandbox_list_view surfaces: it changes iff that payload would.
        Cheap — a few rows, a handful of columns, no per-row view rendering.
        """
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT sandbox_uid, status, updated_at, last_seen_at,
                       last_command_snapshot_at, terminated_at
                FROM sandboxes
                WHERE project_id = ?
                ORDER BY sandbox_uid
                """,
                (project_id,),
            ).fetchall()
            digest = "\n".join(
                "|".join(
                    str(row[column] or "")
                    for column in (
                        "sandbox_uid",
                        "status",
                        "updated_at",
                        "last_seen_at",
                        "last_command_snapshot_at",
                        "terminated_at",
                    )
                )
                for row in rows
            )
            return f"{len(rows)}:{digest}"

    def tenant_event_count(self, *, tenant_id: str) -> int:
        """Count durable project events for one tenant."""
        with closing(self.connect()) as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS n
                FROM events e
                JOIN projects p ON p.id = e.project_id
                WHERE p.tenant_id = ?
                """,
                (tenant_id,),
            ).fetchone()
        return int(row["n"]) if row is not None else 0

    def recent_events(
        self, *, project_id: str | None, limit: int = 100
    ) -> dict[str, Any]:
        with closing(self.connect()) as conn:
            project_id = self.require_project_id(conn=conn, project_id=project_id)
            rows = conn.execute(
                """
                SELECT id, project_id, type, target_type, target_id, payload_json, created_at
                FROM events
                WHERE project_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (project_id, max(1, min(int(limit), 500))),
            ).fetchall()
            events = []
            for row in rows:
                item = row_to_dict(row=row) or {}
                item["payload"] = json.loads(str(item.pop("payload_json", "{}")))
                events.append(item)
            return {"events": events}


class StateStore(BaseStateStore):
    """The SQLite dialect — local mode's store, and the historical default.

    Records only — the store does not know where a caller's checkout lives.
    The same record layer serves SQLite-backed test composition and hosted
    Postgres without receiving caller filesystem context.
    The Postgres dialect lives in ``dialects.PostgresStateStore``; the name
    ``StateStore`` stays on the SQLite class so every existing call site and
    test keeps working unchanged (``SqliteStateStore`` is an alias).
    """

    def __init__(self, *, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        # WAL lets the background reconcile poller read while a submit writes,
        # instead of readers and writers blocking each other (rollback-journal
        # mode upgrades a read lock to write and returns SQLITE_BUSY immediately,
        # which surfaced as "database is locked" on concurrent submits).
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute("PRAGMA busy_timeout = 10000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            # IMMEDIATE acquires the write lock up front so busy_timeout governs
            # the wait. A DEFERRED BEGIN takes a read lock first and then fails
            # instantly when it can't upgrade under contention.
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _initialize(self) -> None:
        self._migrate_capability_hash()
        conn = self.connect()
        try:
            self._rename_syntheses_to_reflections(conn=conn)
            self._rename_synthesis_wave_tables(conn=conn)
            conn.executescript(SCHEMA)  # IF NOT EXISTS — safe to race
            # The column probes and migration ledger below are check-then-act;
            # hold the write lock across them so two processes booting the same
            # upgrade can't both run one ALTER (executescript autocommits).
            conn.execute("BEGIN IMMEDIATE")
            self._ensure_forward_schema(conn=conn)
            self._apply_migrations(conn=conn)
            row = conn.execute("SELECT id FROM projects LIMIT 1").fetchone()
            if row is None:
                project_id = new_id(prefix="proj")
                conn.execute(
                    "INSERT INTO projects (id, name, summary, created_at) VALUES (?, ?, ?, ?)",
                    (project_id, "Local Research Project", "", now_iso()),
                )
                self.record_event(
                    conn=conn,
                    project_id=project_id,
                    event_type="project.created",
                    target_type="project",
                    target_id=project_id,
                    payload={"name": "Local Research Project"},
                )
            conn.commit()
        finally:
            conn.close()

    def _ensure_forward_schema(self, *, conn: sqlite3.Connection) -> None:
        # Cloud-split Phase 6 (June 2026): tenancy column — projects carry
        # ownership; local mode is the fixed 'local' tenant (which is also the
        # column default, so older rows converge to it).
        self._ensure_columns(
            conn=conn,
            table="projects",
            columns={
                "tenant_id": "TEXT NOT NULL DEFAULT 'local'",
                "status": "TEXT NOT NULL DEFAULT 'active'",
            },
        )
        # Experiments now persist the accepted conclusion on `complete`; older
        # databases predate the column. Named experiments (June 2026): the
        # short unique name doubles as the experiment folder name; empty on
        # rows that predate the requirement (their folders stay id-named).
        self._ensure_columns(
            conn=conn,
            table="experiments",
            columns={
                "conclusion": "TEXT NOT NULL DEFAULT ''",
                "name": "TEXT NOT NULL DEFAULT ''",
                # MLflow run identity (July 2026): best-effort run created by
                # the control plane when an experiment enters `running`.
                **EXPERIMENT_MLFLOW_COLUMNS,
            },
        )
        # Stage-routed rejections (June 2026): experiment reviews record which
        # stage a rejection sent the experiment back to ('planned' or
        # 'running'); empty on passes and on rows that predate the column.
        self._ensure_columns(
            conn=conn,
            table="reviews",
            columns={"return_to": "TEXT NOT NULL DEFAULT ''"},
        )
        # Review sessions keep a tenant column so future auth can scope review
        # starts without reshaping legacy rows.
        self._ensure_columns(
            conn=conn,
            table="review_sessions",
            columns={"tenant_id": "TEXT NOT NULL DEFAULT ''"},
        )
        # Async provisioning (June 2026): sandboxes gained a provisioning/failed
        # lifecycle with progress + error fields. Older DBs predate these columns.
        self._ensure_columns(
            conn=conn,
            table="sandboxes",
            columns={
                "sandbox_name": "TEXT NOT NULL DEFAULT ''",
                "tenant_id": "TEXT NOT NULL DEFAULT 'local'",
                "phase": "TEXT NOT NULL DEFAULT ''",
                "detail": "TEXT NOT NULL DEFAULT ''",
                "error": "TEXT NOT NULL DEFAULT ''",
                "provision_started_at": "TEXT",
                "sandbox_data_dir": "TEXT NOT NULL DEFAULT ''",
                "sync_dir": "TEXT NOT NULL DEFAULT ''",
                "unsynced_dir": "TEXT NOT NULL DEFAULT ''",
                # Lambda-default (June 2026): provider-bundled machine SKU +
                # datacenter for backends that procure a fixed instance type.
                "instance_type": "TEXT NOT NULL DEFAULT ''",
                "region": "TEXT NOT NULL DEFAULT ''",
                # Cloud-split Phase 7 (June 2026): provider price quote captured
                # at provision for cost governance. 0 on rows that predate it.
                "price_usd_per_hour": "REAL NOT NULL DEFAULT 0",
                # Cloud-split Phase 5 (June 2026): management keypair reference
                # — non-empty when a control-plane management key exists for
                # this sandbox. Never key material.
                "mgmt_key_ref": "TEXT NOT NULL DEFAULT ''",
                "public_key_source": "TEXT NOT NULL DEFAULT 'managed'",
                # Command status snapshot (July 2026): populated by
                # sandbox.terminal from rec.sh transcript markers so agents
                # keep the last known command state even if a later transcript
                # SSH read is unavailable.
                "last_command_id": "TEXT NOT NULL DEFAULT ''",
                "last_command_text": "TEXT NOT NULL DEFAULT ''",
                "last_command_started_at": "TEXT",
                "last_command_status": "TEXT NOT NULL DEFAULT ''",
                "last_command_exit_code": "INTEGER",
                "last_command_finished_at": "TEXT",
                "last_command_output_tail": "TEXT NOT NULL DEFAULT ''",
                "last_command_snapshot_at": "TEXT",
            },
        )
        conn.execute(
            """
            UPDATE sandboxes
            SET tenant_id = COALESCE(
              (SELECT tenant_id FROM projects WHERE projects.id = sandboxes.project_id),
              tenant_id,
              'local'
            )
            WHERE project_id != ''
            """
        )
        # Cloud-split Phase 3 (June 2026): machine-local values left the
        # cloud-bound sandboxes row — the per-experiment SSH key path and the
        # local sync dir live in the data-plane worker's local store now
        # (dataplane_state.sqlite under the checkout state dir). Both columns
        # were always derivable, so no value migration is needed.
        self._drop_columns(
            conn=conn,
            table="sandboxes",
            columns=("key_path", "local_sync_dir"),
        )
        # Slice-1 (June 2026): the automatic experiment-folder push was removed,
        # so the per-sandbox initial_pushed file count no longer exists.
        self._drop_columns(
            conn=conn,
            table="sandboxes",
            columns=("initial_pushed",),
        )
        # Cloud-split Phase 6 (June 2026): explicit insertion-order columns
        # replace `ORDER BY rowid` so the same queries run on the Postgres
        # dialect (which has no rowid). Legacy rows backfill created_seq from
        # their rowid — the exact order the old queries observed — once, when
        # the column is first added; new writes set it via next_created_seq().
        # The two resource tables stay in the loop only until migration 25
        # drops them: pre-cut databases need created_seq before migration 24's
        # ORDER BY a.created_seq backfill can run.
        for table in (
            "resource_versions",
            "resource_associations",
            "review_requests",
            "reviews",
            "reflections",
            "sandboxes",
        ):
            if table.startswith("resource") and not self._has_table(
                conn=conn, table=table
            ):
                continue
            added = self._ensure_columns(
                conn=conn,
                table=table,
                columns={"created_seq": "INTEGER NOT NULL DEFAULT 0"},
            )
            if "created_seq" in added:
                conn.execute(f"UPDATE {table} SET created_seq = rowid")
        # Slice-2 (June 2026): sandbox rows now have their own durable id;
        # public 1:1 behavior is preserved by registry primary selection.
        self._migrate_sandbox_identity(conn=conn)
        self._backfill_sandbox_attachments(conn=conn)
        self._drop_sandboxes_experiment_id(conn=conn)
        # Cloud-split Phase 9 (June 2026): the per-tenant USD spend budget. The
        # GPU-hour budget shipped in Phase 7; USD is its sibling. Nullable =
        # unlimited; pre-Phase-9 quota rows predate the column.
        self._ensure_columns(
            conn=conn,
            table="tenant_quotas",
            columns={"usd_budget": "REAL"},
        )

    def _migrate_sandbox_identity(self, *, conn: sqlite3.Connection) -> None:
        """Rebuild sandboxes when legacy SQLite has experiment_id as the PK."""
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'"
        ).fetchone()
        if table is None:
            return
        columns = conn.execute("PRAGMA table_info(sandboxes)").fetchall()
        uid_pk = any(
            str(row["name"]) == "sandbox_uid" and int(row["pk"] or 0) > 0
            for row in columns
        )
        if uid_pk:
            return
        conn.execute("DROP TABLE IF EXISTS sandbox_attachments")
        conn.execute(_schema_table_ddl(table="sandboxes", name="sandboxes_migrate"))
        source_column_list = [str(row["name"]) for row in columns]
        source_columns = set(source_column_list)
        target_columns = [
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(sandboxes_migrate)").fetchall()
        ]
        copy_columns = [
            column
            for column in target_columns
            if column != "sandbox_uid" and column in source_columns
        ]
        insert_columns = ", ".join(["sandbox_uid", *copy_columns])
        placeholders = ", ".join("?" for _ in ["sandbox_uid", *copy_columns])
        attachments: list[tuple[str, str, str, str | None]] = []
        select_columns = ", ".join(source_column_list)
        for row in conn.execute(f"SELECT {select_columns} FROM sandboxes").fetchall():
            row_uid = uuid.uuid4().hex
            conn.execute(
                f"INSERT INTO sandboxes_migrate ({insert_columns}) VALUES ({placeholders})",
                [row_uid, *[row[column] for column in copy_columns]],
            )
            if "experiment_id" in source_columns and row["experiment_id"]:
                attached_at = (
                    (row["requested_at"] if "requested_at" in source_columns else None)
                    or (row["created_at"] if "created_at" in source_columns else None)
                    or (row["updated_at"] if "updated_at" in source_columns else None)
                    or now_iso()
                )
                detached_at = None
                terminated_at = (
                    row["terminated_at"] if "terminated_at" in source_columns else None
                )
                status = row["status"] if "status" in source_columns else ""
                if terminated_at or status in {"terminated", "failed"}:
                    detached_at = (
                        terminated_at
                        or (
                            row["updated_at"]
                            if "updated_at" in source_columns
                            else None
                        )
                        or attached_at
                    )
                attachments.append(
                    (row_uid, row["experiment_id"], attached_at, detached_at)
                )
        conn.execute("DROP TABLE sandboxes")
        conn.execute("ALTER TABLE sandboxes_migrate RENAME TO sandboxes")
        conn.execute(_schema_table_ddl(table="sandbox_attachments"))
        for sandbox_uid, experiment_id, attached_at, detached_at in attachments:
            conn.execute(
                """
                INSERT INTO sandbox_attachments (
                  sandbox_uid, experiment_id, attached_at, detached_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (sandbox_uid, experiment_id, attached_at, detached_at),
            )

    def _drop_sandboxes_experiment_unique(self, *, conn: sqlite3.Connection) -> None:
        """Rebuild sandboxes when SQLite still has UNIQUE(experiment_id)."""
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'"
        ).fetchone()
        if table is None or not self._sandboxes_has_experiment_unique(conn=conn):
            return
        self._backfill_sandbox_attachments(conn=conn)
        attachments_exist = (
            conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandbox_attachments'"
            ).fetchone()
            is not None
        )
        if attachments_exist:
            conn.execute("DROP TABLE IF EXISTS sandbox_attachments_migrate")
            conn.execute(
                """
                CREATE TEMP TABLE sandbox_attachments_migrate AS
                SELECT sandbox_uid, experiment_id, attached_at, detached_at
                FROM sandbox_attachments
                """
            )
            conn.execute("DROP TABLE sandbox_attachments")
        conn.execute(_schema_table_ddl(table="sandboxes", name="sandboxes_migrate"))
        source_columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(sandboxes)").fetchall()
        }
        target_columns = [
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(sandboxes_migrate)").fetchall()
            if str(row["name"]) in source_columns
        ]
        if target_columns:
            columns = ", ".join(target_columns)
            conn.execute(
                f"INSERT INTO sandboxes_migrate ({columns}) SELECT {columns} FROM sandboxes"
            )
        conn.execute("DROP TABLE sandboxes")
        conn.execute("ALTER TABLE sandboxes_migrate RENAME TO sandboxes")
        conn.execute(_schema_table_ddl(table="sandbox_attachments"))
        if attachments_exist:
            conn.execute(
                """
                INSERT OR IGNORE INTO sandbox_attachments (
                  sandbox_uid, experiment_id, attached_at, detached_at
                )
                SELECT sandbox_uid, experiment_id, attached_at, detached_at
                FROM sandbox_attachments_migrate
                """
            )
            conn.execute("DROP TABLE sandbox_attachments_migrate")
        self._backfill_sandbox_attachments(conn=conn)

    def _drop_sandboxes_experiment_id(self, *, conn: sqlite3.Connection) -> None:
        """Rebuild sandboxes without the legacy experiment_id column."""
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandboxes'"
        ).fetchone()
        if table is None or not self._has_column(
            conn=conn, table="sandboxes", column="experiment_id"
        ):
            return
        self._backfill_sandbox_attachments(conn=conn)
        attachments_exist = (
            conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandbox_attachments'"
            ).fetchone()
            is not None
        )
        if attachments_exist:
            conn.execute("DROP TABLE IF EXISTS sandbox_attachments_migrate")
            conn.execute(
                """
                CREATE TEMP TABLE sandbox_attachments_migrate AS
                SELECT sandbox_uid, experiment_id, attached_at, detached_at
                FROM sandbox_attachments
                """
            )
            conn.execute("DROP TABLE sandbox_attachments")
        conn.execute(_schema_table_ddl(table="sandboxes", name="sandboxes_migrate"))
        source_columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(sandboxes)").fetchall()
        }
        target_columns = [
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(sandboxes_migrate)").fetchall()
            if str(row["name"]) in source_columns
        ]
        if target_columns:
            columns = ", ".join(target_columns)
            conn.execute(
                f"INSERT INTO sandboxes_migrate ({columns}) SELECT {columns} FROM sandboxes"
            )
        conn.execute("DROP TABLE sandboxes")
        conn.execute("ALTER TABLE sandboxes_migrate RENAME TO sandboxes")
        conn.execute(_schema_table_ddl(table="sandbox_attachments"))
        if attachments_exist:
            conn.execute(
                """
                INSERT OR IGNORE INTO sandbox_attachments (
                  sandbox_uid, experiment_id, attached_at, detached_at
                )
                SELECT sandbox_uid, experiment_id, attached_at, detached_at
                FROM sandbox_attachments_migrate
                """
            )
            conn.execute("DROP TABLE sandbox_attachments_migrate")

    def _sandboxes_has_experiment_unique(self, *, conn: sqlite3.Connection) -> bool:
        for idx in conn.execute("PRAGMA index_list(sandboxes)").fetchall():
            if not idx["unique"]:
                continue
            columns = [
                str(info["name"])
                for info in conn.execute(f"PRAGMA index_info({idx['name']})").fetchall()
            ]
            if columns == ["experiment_id"]:
                return True
        return False

    def _allow_sandbox_attachment_history(self, *, conn: sqlite3.Connection) -> None:
        """Rebuild sandbox_attachments when SQLite still keys only the pair."""
        table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sandbox_attachments'"
        ).fetchone()
        if table is None:
            conn.execute(_schema_table_ddl(table="sandbox_attachments"))
            return
        if self._sandbox_attachment_pk_columns(conn=conn) == []:
            return
        conn.execute("DROP TABLE IF EXISTS sandbox_attachments_migrate")
        conn.execute(
            _schema_table_ddl(
                table="sandbox_attachments", name="sandbox_attachments_migrate"
            )
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO sandbox_attachments_migrate (
              sandbox_uid, experiment_id, attached_at, detached_at
            )
            SELECT sandbox_uid, experiment_id, attached_at, detached_at
            FROM sandbox_attachments
            """
        )
        conn.execute("DROP TABLE sandbox_attachments")
        conn.execute(
            "ALTER TABLE sandbox_attachments_migrate RENAME TO sandbox_attachments"
        )

    def _sandbox_attachment_pk_columns(self, *, conn: sqlite3.Connection) -> list[str]:
        rows = conn.execute("PRAGMA table_info(sandbox_attachments)").fetchall()
        return [
            str(row["name"])
            for row in sorted(rows, key=lambda row: int(row["pk"] or 0))
            if int(row["pk"] or 0) > 0
        ]

    def _backfill_sandbox_attachments(self, *, conn: sqlite3.Connection) -> None:
        """Open the forward relation for legacy/un-attached rows; a no-op once filled."""
        conn.execute(_schema_table_ddl(table="sandbox_attachments"))
        if not self._has_column(conn=conn, table="sandboxes", column="experiment_id"):
            return
        # Only rows still missing their attachment — so re-runs after the first
        # upgrade do no work, while a partial upgrade still gets finished.
        rows = conn.execute(
            """
            SELECT sandbox_uid, experiment_id, requested_at, created_at, updated_at,
                   terminated_at, status
            FROM sandboxes
            WHERE COALESCE(sandbox_uid, '') != ''
              AND NOT EXISTS (
                SELECT 1 FROM sandbox_attachments a
                WHERE a.sandbox_uid = sandboxes.sandbox_uid
                  AND a.experiment_id = sandboxes.experiment_id
              )
            """
        ).fetchall()
        for row in rows:
            attached_at = (
                row["requested_at"]
                or row["created_at"]
                or row["updated_at"]
                or now_iso()
            )
            detached_at = None
            if row["terminated_at"] or row["status"] in {"terminated", "failed"}:
                detached_at = row["terminated_at"] or row["updated_at"] or attached_at
            conn.execute(
                """
                INSERT INTO sandbox_attachments (
                  sandbox_uid, experiment_id, attached_at, detached_at
                )
                VALUES (?, ?, ?, ?)
                """,
                (row["sandbox_uid"], row["experiment_id"], attached_at, detached_at),
            )

    def _migrate_capability_hash(self) -> None:
        """Migrate review_requests.capability (plaintext) → capability_hash.

        Pre-Phase-7 databases stored the minted capability in plaintext under a
        column-level UNIQUE `capability` column. Phase 7 stores its sha256
        instead. SQLite cannot DROP a column carrying a column-level UNIQUE in
        place, so the table is
        rebuilt into the new shape (own connection, foreign_keys toggled off so
        the review_sessions/reviews FKs to review_requests(id) don't block the
        DROP/RENAME): `capability_hash` replaces `capability`, backfilled with
        the sha256 of the existing plaintext so already-issued tokens still
        resolve. A request whose plaintext was empty converges to the
        empty-string hash, which no presented token matches — voided, must be
        re-requested (documented acceptable cost). No-op on fresh DBs (the table
        does not exist yet) and once `capability` is already gone.
        """
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            table = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_requests'"
            ).fetchone()
            if table is None:
                return
            cols = {
                str(row["name"])
                for row in conn.execute("PRAGMA table_info(review_requests)").fetchall()
            }
            if "capability" not in cols:
                return
            seq_expr = "created_seq" if "created_seq" in cols else "rowid"
            conn.execute("PRAGMA foreign_keys = OFF")
            conn.execute("BEGIN IMMEDIATE")
            try:
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
                      expires_at, created_at, {seq_expr}
                    FROM review_requests
                    """
                )
                # SQLite has no portable sha256(); rehash row-by-row in Python.
                for row in conn.execute(
                    "SELECT id, capability FROM review_requests"
                ).fetchall():
                    plaintext = str(row["capability"] or "")
                    conn.execute(
                        "UPDATE review_requests_migrate SET capability_hash = ? WHERE id = ?",
                        (
                            hash_secret(plaintext),
                            row["id"],
                        ),
                    )
                conn.execute("DROP TABLE review_requests")
                conn.execute(
                    "ALTER TABLE review_requests_migrate RENAME TO review_requests"
                )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.execute("PRAGMA foreign_keys = ON")
        finally:
            conn.close()

    def _ensure_columns(
        self,
        *,
        conn: sqlite3.Connection,
        table: str,
        columns: dict[str, str],
    ) -> set[str]:
        """Add missing columns; returns the names actually added."""
        existing = {
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        added: set[str] = set()
        for name, definition in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
                added.add(name)
        return added

    def _drop_columns(
        self,
        *,
        conn: sqlite3.Connection,
        table: str,
        columns: tuple[str, ...],
    ) -> None:
        """Drop columns that no longer appear in the live schema.

        Requires SQLite ≥ 3.35 for `ALTER TABLE ... DROP COLUMN`. Idempotent:
        a column already absent is silently skipped.
        """
        existing = {
            str(row["name"])
            for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        for name in columns:
            if name in existing:
                conn.execute(f"ALTER TABLE {table} DROP COLUMN {name}")


# Alias for composition code that wants to name the dialect explicitly; the
# primary name stays on the class so call sites and reprs are unchanged.
SqliteStateStore = StateStore


def next_created_seq(*, conn: Connection, table: str) -> int:
    """The next insertion-order value for ``table`` (see created_seq columns).

    MAX+1 inside the caller's open write transaction is race-free under the
    store's single-writer semantics: SQLite's BEGIN IMMEDIATE holds the write
    lock, and the Postgres dialect's transaction() holds the advisory lock,
    so no two writers compute the same value.
    """
    row = conn.execute(
        f"SELECT COALESCE(MAX(created_seq), 0) + 1 AS next_seq FROM {table}"
    ).fetchone()
    return int(row["next_seq"])


def row_to_dict(*, row: Row | Mapping[str, Any] | None) -> dict[str, Any] | None:
    """Plain dict from a row of either dialect (sqlite3.Row or mapping)."""
    if row is None:
        return None
    return {key: row[key] for key in row.keys()}


def rows_to_dicts(*, rows: Iterable[Row | Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [row_to_dict(row=row) or {} for row in rows]
