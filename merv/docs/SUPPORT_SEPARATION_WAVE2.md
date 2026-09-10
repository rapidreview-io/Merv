# Support separation: wave 2 contracts 

Same rules, definitions, and working conventions as wave 1
(`merv/docs/SUPPORT_SEPARATION.md` on branch `support-separation`). Wave 2 runs on top
of the merged wave-1 result. Base: `support-separation` at the merge of all five wave-1 branches (wave 1 landed at
net -205 source lines; migrations 61 = agent_workspaces and 62 = research_objects exist).

## Lines of code (founder target, applies to every wave-2 task)

Total source lines must go down. Measure `git diff --shortstat <base>..HEAD -- merv/src`
before you report. A task that adds net source lines must justify every added block;
prefer deleting a mechanism over adapting it, never keep a compatibility shim the spec
did not ask for, do not add a second dataclass or helper beside an existing one, and
fold verbose validation into the type that owns it. Tests may grow only where a new
behaviour exists; delete tests of removed mechanisms. Report the net LOC delta for
`merv/src` and `merv/tests` separately in your final message.

## Contract E: tool manifest split (registry is support, schemas belong to owners)

- Move the `ToolContract` dataclass (and any policy dataclass it carries) from
  `surface/tools/contracts.py` to `kernel/tools.py`, so every component can declare tool
  contracts without importing surface (layer law: application may not import delivery).
- Each owner exposes `TOOLS: Mapping[str, ToolContract]` from its package root:
  - research_core: experiment.*, task.*, reflection.*, review.*, claim.*, consolidation.*,
    candidate.*, litreview.*;
  - workflows: workflow.*;
  - artifacts: artifact.*;
  - feed: feed.* (move `surface/tools/feed_contracts.py` into `feed/`, and derive the ref
    prefix list and role enum in its schema text from the injected vocabulary and roles
    instead of hardcoding them);
  - infrastructure: sandbox.*, storage.*;
  - surface keeps agent.hello and the merged `project` tool (list/current/create are
    kernel-owned project records; `overview` delegates to research through the existing
    port).
  - mlflow.* contracts are frozen code: move them verbatim into
    `surface/tools/mlflow_contracts.py` and change nothing else about them.
- `surface/tools/contracts.py` becomes the aggregator: merges the owners' tables in a
  fixed order, asserts unique names, and keeps exposing the registry symbols the
  dispatcher, gateway, http policy, and tests already use. Handler binding stays in
  `surface/surface.py`.
- The gateway still special-cases `consolidation.submit` to inject `producer_session_id`
  (two `if name == "consolidation.submit"` blocks in `gateway.py`). Replace with a
  `ToolContract` flag (for example `binds_producer_session: bool`) declared by the
  owner; the gateway injects the verified session or context-window id for any tool
  whose contract sets it and never names a tool.
- Per-tool hosted policy entries in `http_policy.py` (for example
  `telemetry_from_review_request`) become fields on `ToolContract` declared by the
  owner; `http_policy.py` keeps only generic policy and the session baselines.
- Update `tests/structure/test_module_boundaries.py`: `kernel/tools.py` is foundation;
  each owner's tools module belongs to that owner's component.

## Contract F: each component owns its DDL and migrations

Pattern to copy: `feed/persistence.py` + `install_feed_schema(store)` called from the
component root. Today `kernel/state/store.py` creates roughly sixty tables and holds every
`_ensure_*` column upgrade and numbered migration.

- Kernel provides a registration API in `kernel/state`:
  `SchemaModule(name, ddl: str, migrations: tuple[Migration, ...])`,
  `Migration(version: int, name: str, apply: Callable[[Connection], None])`,
  `BaseStateStore.install(module)`. DDL is idempotent; migrations keep the existing
  global numbering, are recorded in `schema_migrations`, and are applied in ascending
  version order across all installed modules after every module's DDL exists. Dialect
  translation (`dialects.py`, `_schema_table_ddl`) stays in kernel.
- Ownership (each gets a `persistence.py`; `_ensure_*` helpers move with their tables):
  - kernel keeps: projects, project_members, events, tool_calls and payload blobs,
    tenants, schema_migrations;
  - research_core: claims, experiments, experiment_claims, tasks, reviews,
    review_requests, review_sessions, reflections, reflection_*, consolidation_*,
    node_dependencies, project_candidates, research_artifact_links,
    research_submission_artifacts, the research object links added in wave 1,
    litreview_sections, papers, paper_links;
  - workflows: workflow_instances, workflow_history, workflow_actions,
    tracking_deliveries;
  - artifacts: artifacts, submissions, artifact_figures;
  - agent_sessions: agent_sessions, agent_runners, agent_runner_pairings,
    agent_runner_pairing_attempts, agent_session_traces, agent_workspaces. Drop the
    unread legacy `kind`, `review_request_id`, `source_sha` columns from agent_sessions
    with a migration (63) and rewrite the migration-60 replay tests that recreate the
    old enum schema so they no longer need them;
  - infrastructure: sandboxes, remote_sandbox_links, sandbox_attachments, sandbox_runs,
    sandbox_generations, sandbox_provider_settings, provider_user_caps,
    spend_kill_switches, tenant_quotas, and the legacy storage_objects table until the
    migration script has run;
  - surface: oauth_* (into `oauth_store.py`), project_api_keys (into `project_keys.py`),
    user_hf_tokens (into `user_settings.py`), mcp_sessions and agent_identities (into
    `agent_identity.py`), storage_completion_tokens (into the storage router's module).
- `surface/surface.py` installs kernel first, then each component's schema when the
  component is constructed. Startup on an existing SQLite or Postgres database must
  produce an identical schema; add a test that installs on a fresh database and compares
  the table and column set against the pre-move snapshot.
- `TABLE_OWNERS` in the boundary test becomes authoritative: assert each `CREATE TABLE`
  lives in its owner's persistence module, and that no SQL string in a support module
  references a research table.

## Contract G: enforcement and documentation

- Collapse the component matrix in `tests/structure/test_module_boundaries.py`:
  research = research_core + workflows + application + literature; support components =
  artifacts, feed, agent_sessions, and support surface; infrastructure; kernel; mlflow
  (frozen). Allowed edges: research → research, any support public root, infrastructure
  root, kernel; support → own component, kernel; infrastructure → own, kernel;
  surface → any; mlflow → mlflow, application, kernel as a named frozen exception.
  Research routers, `experiment_figure.py`, and `workflow_knowledge.py` are research
  files inside surface (use `FILE_COMPONENTS`).
- Add a vocabulary scan test: for every file in support packages (artifacts, feed,
  agent_sessions, kernel, support surface, client, shared) tokenize the source and assert
  no identifier or string literal matches
  `experiment|reflection|consolidat|reviewer|\bclaim\b|\blens\b|\bcandidate\b`
  outside comments and docstrings, and no SQL string names a research table. Keep an
  explicit, justified allowlist for opaque pass-through field names if any remain
  (the goal is an empty allowlist).
- `kernel/state/activity.py` names research id fields for redaction and target
  extraction; turn those into a registry that owners populate at composition.
- Docs: rewrite `docs/MODULE_BOUNDARIES.md` around the three layers; update the
  composition, tool routing, and persistence sections of `docs/ARCHITECTURE.md`; refresh
  the "How the system fits together" bullets in both READMEs; fix `AGENTS.md` where it
  says large candidate bytes belong in Object Storage (they belong in merv-sandboxes
  storage); keep every component `.md` under 100 lines and accurate.

## Contract H: delete what wave 1 left behind (LOC)

Owner runs after E and F merge, together with G, and must end net negative.

- Delete the three `/api/projects/{pid}/consolidation/*` alias routes in
  `surface/transport/api/agent_sessions.py` and their tests. Runners that still call
  them cannot parse the new packet either, so the aliases serve nobody.
- `infrastructure/objects.py` (639 lines) and `research_core/objects.py` (284 lines):
  move `ResearchObjects.adopt` into `deploy/migrate_storage_ledger.py` (its only
  caller), collapse the token mint/consume pair into the storage router if it is not
  used by tools, fold `find`/`list_objects`/`resolve`/`_by_name` into one catalog read
  with parameters, and shrink docstrings that restate the spec. Target: the two files
  together under 650 lines with identical tests.
- Remove the dead `storage_max_upload_bytes` project setting (contracts.py `project.update`,
  `research_core/research.py`, `transport/api/meta.py`, UI-facing docs) and the unused
  `surface/config.py::storage_feature_enabled`.
- `research_core/policy.py::_ENTITY_ID_RE` duplicates `ENTITY_REF_VOCABULARY`; derive one
  from the other.
- `client/runs_wait.py` docstring still says "experiment-scoped listing"; reword.
- `application/application.py::present_session` and `session_kind` decorate sessions with
  `kind`, `experiment_id`, `reflection_id`, `review_request_id` for the UI. Keep them (the
  UI reads them) but make sure they are the only place research names appear for sessions.
