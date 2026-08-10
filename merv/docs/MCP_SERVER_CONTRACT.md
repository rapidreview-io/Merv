# MCP Server Contract

This document describes the current agent-facing MCP architecture. The live
schemas and descriptions generated from `src/merv/brain/surface/tools/contracts.py` are the
authoritative per-field contract; `tools/list` is the authoritative catalog for
the active deployment.

## Authority and topology

The brain is the authority for durable research state and workflow policy. Every
agent client — local Claude Code, cloud Codex, Replit, browser-driven — connects
the same way: directly to the brain's stateless `POST /mcp` HTTP endpoint,
authenticated by a scoped bearer credential. The committed config files
(`.mcp.json`, `.mcp.codex.json`, `mcp.json`) are URL-only so interactive clients
can discover and complete Merv OAuth without a manually minted key. Headless
clients that cannot run OAuth pass a static scoped key from `MERV_MCP_KEY`; the
key is never inlined into a committed file.

An OAuth session can reach the projects available to its user; a static key is
scoped either to one project or to its owner's whole account. In either case the
caller names the project per call; ids come from
`project(action="list")`. The tool's actions are `list`, `current`, `create`,
and `overview`.
The gateway does not inject or hide
`project_id`: agents pass `project_id` explicitly on every project-scoped tool,
and the gateway enforces that it equals the key-bound project — a mismatched
`project_id` is rejected, and omitting it raises `project_id is required`. Agents
never send `repo_root`; the brain never receives a checkout root.

The normal session bootstrap is:

```text
project(action="list")               # choose one reachable project
workflow.status_and_next(project_id, experiment_id?)
```

For a credential confined to one project, `action="current"` returns that
project without a `project_id`. An account-scoped credential has no single
current project and receives its reachable list instead. Pass the selected id
explicitly thereafter. `action="overview"` returns the selected project's
macro context. `action="create"` is forbidden to a project-bound key.

## Tool catalog

The agent-visible control tools are:

```text
workflow.status_and_next
project
claim.create                 claim.update
experiment.create
experiment.transition        experiment.exhibit
reflection.create            reflection.get
reflection.transition
litreview.view               litreview.edit
litreview.cite
artifact.submit              artifact.find
storage.find                 storage.object
review.request               review.start               review.submit
sandbox.options              sandbox.get                 sandbox.list
sandbox.release              sandbox.extend
sandbox.runs                 sandbox.terminal
feed.register                feed.list
```

Every available tool is served by the brain over HTTP MCP. Byte operations
return one-line commands: Storage uses provider-presigned URLs, Artifact and
Feed use bounded one-time endpoints, and Sandbox output pulls use `rsync`.

Storage is optional. When no object store is configured, every `storage.*` tool
is omitted instead of advertising an unavailable feature.

These tools remain dispatchable for HTTP views but are hidden from agent
`tools/list`:

```text
project.get                  project.update              project.list
claim.list                   experiment.list             reflection.list
storage.put_object           storage.complete_upload
review.status
sandbox.health
```

The manifest is built in code as `TOOL_MANIFEST` in
`src/merv/brain/surface/tools/contracts.py` and exposed via `tools/list`; there is
no checked-in catalog JSON file. Because every tool is brain-served, `tools/list`
is unavailable until the brain responds.

## Project scope

The project is fixed by the bearer key, so a project-scoped call can never target
another project. Agents pass the key-bound `project_id` on every project-scoped
tool; supplying a different `project_id` does not switch projects — the gateway
rejects it as outside the key's scope.

Core services never infer an active project. Scope enforcement exists only at the
gateway.

## Artifact submissions

`artifact.submit {project_id, target_type, target_id, role, path, lens_id?, title?}`
is a control tool: the brain validates legality and workflow-state guards, mints
a pending artifact with a one-time upload token, and returns
`{artifact_id, run}` where `run` is a ready-to-run
`curl -sf -T <path> '<base>/api/artifacts/u/<token>'` line the agent executes
verbatim. The token-bearer PUT enforces the role byte cap, pins the bytes, and
(for gated markdown) returns one follow-up `run` line per relative image link.
Bytes travel over the agent's own shell, never through the brain or MCP.

Workflow lints and reviews read the submitted bytes, never a later live edit.
There is no background checkout scan. Resubmit a changed file to replace the
slot (a new artifact id is minted, invalidating review snapshots).

`artifact.find(project_id, artifact_id=...)` preserves the singular
`{artifact}` response. `artifact_ids=[...]` resolves an ordered batch of up to
50 artifacts as `{artifacts, count}`. Batch ids are de-duplicated in first-seen
order and a missing or cross-project id fails the request atomically. Both
id-based forms are metadata-only by default; opt into bounded submitted text
with `include_content=true`. Singular reads add a sibling `content` envelope;
plural reads add the envelope to each artifact row. The envelope contains
`content`, `available`, `is_binary`, `size_bytes`, and `content_type`, so binary
or unavailable bytes are represented without being injected as text. Without
either id selector, the tool lists the project's complete artifacts filtered
by target and role; `include_content` is invalid for this broad list mode.
`artifact.find` is the only agent-facing plural-id retrieval surface.

`workflow.status_and_next(project_id, experiment_id=...)` is the canonical
experiment read. Its `context` has exactly four sections: experiment, latest
plan, latest report, and the remaining current-attempt artifact references.
Live experiments receive the full latest plan; terminal experiments receive
its bounded Summary; the latest report is full when present. Plan, report, and
every artifact reference carry their immutable artifact id, local path, and
submission timestamp. `experiment.get_state` remains an internal compatibility
reader for UI/service code, stays singular, and does not accept
`experiment_ids` or `review_ids`.

## Experiment workflow

The agent-facing statuses are:

```text
planned -> design_review -> ready_to_run -> running -> experiment_review -> complete
```

`failed` and `abandoned` are terminal exits. The typed transitions are:

```text
submit_design
mark_ready_to_run
start_running
retry_running
submit_results
complete
mark_failed
abandon
```

The declaration in `src/merv/brain/research_core/experiment_workflow.py`
drives enforcement, `allowed_transitions`, gate checklists, review returns, and
`workflow.status_and_next`.

- `submit_design` requires a pinned `plan` artifact with the required section
  spine.
- `mark_ready_to_run` requires a passing design review for the current snapshot.
- `submit_results` requires current-attempt `result`, `report`, and `graph`
  artifacts. When a system metrics exhibit is pinned, the report must reference
  and interpret it.
- `complete` requires a passing experiment review for the current snapshot.
- `retry_running` is a same-attempt infrastructure retry and remains `running`.

A result-review rejection must return to `running` when the approved plan still
stands, or to `planned` with a new attempt when the design is flawed.

`workflow.status_and_next` returns a deliberately slim orientation view:
project reference, canonical experiment context, gate, allowed/blocked actions,
missing evidence, review substate, and next action. `experiment.transition`
returns only a compact state-change acknowledgement plus operation-specific
side-effect receipts. Agents call `workflow.status_and_next` afterward when
they need refreshed context. The HTTP UI uses richer service views.

## Reflection workflow

External tools and target types use **reflection**. Persisted ids keep the
`syn_` prefix. The statuses are:

```text
reflecting -> synthesizing -> reflection_review -> consolidating -> published
```

`abandoned` is terminal. One wave may be open per project.

- `reflection.create` snapshots the corpus and requires exactly five lenses:
  `amplify`, `avoid`, `entropy`, and two project-specific lenses.
- `submit_reflections` requires a separately submitted `reflection_lens_doc`
  for every roster lens. Each pinned Markdown document must contain a non-empty
  `Summary` section, which supplies its TLDR in macro reflection views.
- `submit_reflection_artifacts` requires a valid `project_graph`, concise
  `reflection_doc`, and materializable `change_spec`.
- `begin_consolidation` requires a passing `reflection_reviewer` review.
- `consolidation.submit` records one immutable proposal with a reasoned decision
  for every experiment and its declared Git integration kind.
- `publish` is internal: it requires a passing `consolidation_reviewer` review
  and the runner's central-ref receipt, then applies claim changes and creates
  the reviewed experiment wave.

A rejection returns to `synthesizing` when the lens documents stand, or to
`reflecting` with a new attempt when the fan-out must be repeated.

## Review sessions

Supported reviewer roles are `design_reviewer`, `experiment_reviewer`,
`reflection_reviewer`, `consolidation_reviewer`, `human`, and
`automated_check`. The four workflow gates use their matching reviewer roles.

The current protocol is:

```text
review.request(project_id, target_type, target_id, role, reason?, producer_session_id?)
review.start(review_request_id, reviewer_capability, caller_session_id, declared_agent?)
review.submit(review_session_id, verdict, synopsis, return_to?, notes?, findings?, evidence?)
```

`review.start` and `review.submit` are capability-addressed and take no
`project_id`.

For the three workflow reviewer roles, `review.request` validates the active
gate. `human` and `automated_check` are gate-exempt and may be requested outside
a workflow review gate. Every request pins a target snapshot, stores a hash of
the capability, and returns the plaintext capability once with
`reviewer_handoff.spawn_prompt`. Requesting a fresh capability supersedes prior
open requests for the same target and role.

`caller_session_id` is required at `review.start` and must differ from the
producer session. Start returns the project id, bounded `project_context`, the
target's canonical experiment `context` or `reflection_context`. Experiment
context is built only from artifact versions pinned to the immutable request
snapshot: the plan and report are supplied according to the normal context
rules, while other artifacts are listed by retrievable id. Reflection reviews
continue to receive their pinned `submitted_artifacts`. A capability remains startable while the
request is `requested` or `started` and the capability is unexpired; the first
accepted submission closes the request and prevents other sessions from
submitting.

`project_context` is the same five-section macro packet returned by
`project(action="overview")` and by project-scoped
`workflow.status_and_next`: project metadata; latest published reflection plus
only its reflection-document and project-graph references; the literature
General Summary; every claim; and every experiment with tested claim ids and
one status-dependent summary. Live experiment rows summarize the latest plan;
reviewing or terminal rows prefer the latest report. Rich workflow, review,
artifact, and storage state is excluded.

`review.submit` requires a plain-language `synopsis`. Rejected experiment-attempt
and reflection reviews require `return_to`; design-review rejections always
return to `planned`. Rejection immediately routes the target state. A passing
review satisfies a workflow gate only when its role matches that gate and its
snapshot is current; `human` and `automated_check` passes do not replace the
required workflow reviewer. A pass does not perform the target's next
transition.

Reviewer skills impose the read-only operating role. The dispatcher rejects
other mutations that explicitly carry a `review_session_id`, but the system does
not authenticate every read or unrelated call as that reviewer. Session
separation is therefore a workflow boundary, not cryptographic model identity.

## Sandboxes

Sandboxes are project-scoped machines. They may be standalone, attached to
multiple experiments, and addressed by `sandbox_uid`. An experiment may have
multiple active sandboxes.

`sandbox.request` requires a caller-owned OpenSSH public key. The brain records
and authorizes the public key; caller private-key material never enters brain
state. The response and `sandbox.get` expose SSH facts such as host, port, and
user. The agent client constructs and runs SSH commands. `sandbox.pull_outputs`
takes no key argument: it returns a filled rsync command with a `<key_path>`
placeholder the caller substitutes with its own private-key path when running
the command.

The sandbox workdir is machine-owned, independent of experiment attachment, and
defaults under `/workspace`; provider-specific `MERV_*_WORKDIR`
settings can change the root. Files are not synchronized automatically. Pull
compact outputs into the local experiment folder before artifact submission,
and use durable object storage for heavy files.

Provider behavior is capability-shaped:

- Lambda Labs (default) and Thunder Compute expose fixed instance types and may
  return `needs_selection` with a live hardware menu.
- Modal composes GPU/CPU/memory directly.
- `fake` is used by tests.

Provisioning is best-effort synchronous. `sandbox.request` may return
`provisioning`; poll with `sandbox.get`, never repeated request calls. Long work
uses `merv_run`; `sandbox.runs` reports durable run receipts. Transcript and run
lookups are sandbox-scoped even when addressed through an experiment.

`sandbox.release` is a two-step destructive operation: the first call returns a
retention checklist, and `confirm_retained=true` terminates the machine. Release
or expiry destroys anything not explicitly retained.

## Storage and feed

- `storage.submit` and `storage.fetch` return a one-line command the agent runs
  to transfer bytes over a presigned URL; `storage.find` and `storage.object`
  operate on the brain's ledger.
- `feed.post` returns a one-line command to upload any captured image or HTML
  embed; feed registration and reads are brain control operations.

## HTTP transport and errors

The brain exposes `/mcp/tools` and `/mcp/call`, plus the stateless `/mcp`
endpoint every agent client connects to. It rejects `repo_root` context. Byte
payloads do not ride MCP: tools return commands for one-time Artifact/Feed
endpoints, provider-presigned Storage transfers, or Sandbox `rsync`.

Tool responses are tool-specific dictionaries; there is no universal mutation
envelope. Domain validation and workflow failures remain MCP protocol errors.
Transient transport failures are returned as error tool results so clients do
not disable the entire server:

- `brain_not_running` for an unreachable loopback brain;
- `cloud_unreachable` for a remote brain;
- `daemon_bad_response` (a retained legacy error-code spelling) for an invalid
  brain payload.

## Persistence

The brain selects its record and blob adapters at composition time:

- local preset: SQLite and local-directory blobs under the brain state root;
- control preset: Postgres and an S3-compatible submitted-byte blob store;
- optional heavy-object storage: a separate S3-compatible bucket.

The checkout never contains the brain database. There is no machine-local routing
state; project files remain ordinary checkout files until explicitly submitted.

See [ARCHITECTURE.md](ARCHITECTURE.md),
[WORKFLOW_AND_REVIEW.md](WORKFLOW_AND_REVIEW.md), and the live
[Artifacts guide](../src/merv/brain/artifacts/artifacts.md).
