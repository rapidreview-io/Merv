# MCP Server Contract

This document describes the current agent-facing MCP architecture. The live
schemas and descriptions are the authoritative per-field contract; `tools/list`
is the authoritative catalog for the active deployment. Each component declares
its own tools (`<component>/tools.py`, exported as `TOOLS` from the package
root); `surface/tools/contracts.py` merges those tables into one manifest.

## Authority and topology

The brain is the authority for durable research state and workflow policy. Every
agent client — local Claude Code, cloud Codex, Replit, browser-driven — connects
the same way: directly to the brain's stateless `POST /mcp` HTTP endpoint,
authenticated by a scoped bearer credential. The committed config files
(`.mcp.json`, `.mcp.codex.json`, `mcp.json`) are URL-only so interactive clients
can discover and complete Merv OAuth without a manually minted key. A client on
a machine with no browser — a VM, a platform sandbox, CI, the Messages API MCP
connector — passes a static scoped key from `MERV_MCP_KEY` instead, because a
refresh token is single-use and several agent processes on one machine race on
the same stored one ([AUTH.md](AUTH.md#machines-with-no-browser)); the key is
never inlined into a committed file.

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
agent.hello()                        # once per context window: returns agent_id
project(action="list", agent_id)     # choose one reachable project
workflow.status_and_next(project_id, experiment_id?, agent_id)
```

`agent.hello` mints the short `agent_id` that names this context window (this
conversation, or this subagent) to Merv; every other tool advertises
`agent_id` as a required argument and the gateway refuses a call without a
valid one — with the fix in the message. Never reuse another context's id, and
have each subagent call `agent.hello` itself. See `docs/AGENT_IDENTITY.md`.

For a credential confined to one project, `action="current"` returns that
project without a `project_id`. An account-scoped credential has no single
current project and receives `{exists: false, hint}` pointing at `list`, whose
rows are `{id, name, summary, created_at}`. Pass the selected id explicitly
thereafter. `action="overview"` returns the selected project's macro context.
`action="create"` is forbidden to a project-bound key.

## Tool catalog

The agent-visible control tools are:

```text
agent.hello
workflow.status_and_next
project
claim.create                 claim.update
experiment.create
experiment.transition        experiment.exhibit
task.create                  task.transition
reflection.create            reflection.get
reflection.transition
litreview.view               litreview.edit
litreview.cite
artifact.upload              artifact.read               artifact.attach
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
task.list                    task.get_state
storage.put_object           storage.complete_upload
review.status
sandbox.health
```

The manifest is built in code as `TOOL_MANIFEST` in
`src/merv/brain/surface/tools/contracts.py`, which merges the owners' tables —
research_core, workflows, artifacts, feed, infrastructure, and the surface's
own `agent.hello` and `project` — and
is exposed via `tools/list`; there is no checked-in catalog JSON file. Because every tool is brain-served, `tools/list`
is unavailable until the brain responds.

## Project scope

The project is fixed by the bearer key, so a project-scoped call can never target
another project. Agents pass the key-bound `project_id` on every project-scoped
tool; supplying a different `project_id` does not switch projects — the gateway
rejects it as outside the key's scope.

Core services never infer an active project. Scope enforcement exists only at the
gateway.

## Artifact submissions

`artifact.upload {project_id, path, title?, discover_figures?, attach_to?}`
returns `{artifact_id, run}`. Write the local file first, then execute `run` to
send its bytes through a one-time-token PUT to Merv's R2-backed artifact API.
Upload tokens expire after about 15 minutes. Generic content needs no target.
To submit research evidence in the same operation, pass
`attach_to: {target_type, target_id, role, lens_id?}`. Research validates the
association and activates it atomically when the upload completes; existing
role limits (16 KB) and attempt guards apply. `lens_id` is required only for
`reflection_lens_doc`. Attached documents follow their role's figure policy;
for generic Markdown, opt in with `discover_figures=true`. Execute any figure
upload commands returned by the PUT response too.

`artifact.attach {project_id, artifact_id, target_type, target_id, role, lens_id?}`
associates already uploaded content, returning `{artifact_id, association}`.
The content is reusable across targets. Workflow gates and reviews freeze exact
submitted versions; a later upload can replace the current slot without
changing frozen history. There is no background checkout scan.

`artifact.read {project_id, artifact_id?, artifact_ids?, include_content?,
max_bytes?, offset?, target_type?, target_id?, role?}` supports three selections:

- One ID returns `{artifact, download_url}`.
- A batch of up to 50 IDs returns `{artifacts, count}`, preserving first-seen
  order and deduplicating IDs. Missing or cross-project IDs fail the whole call.
- Without IDs, list complete research evidence with optional target/role filters.
  Unattached content is read by ID; it does not appear in research listings.

IDs can name content or research associations. Association reads include target,
role, attempt, lens, and submission metadata, plus the underlying `artifact_id`;
legacy IDs that identify both return the association. ID reads include download
URLs requiring normal project/account authentication, not MCP-only worker
credentials. `include_content=true` adds figure paths and a content envelope
whose text is the byte window `[offset, offset + max_bytes)` (default 16000
per artifact, batch rows included) with `truncated`/`next_offset` for paging;
the tool description names the envelope's fields. Content cannot be requested
in list mode, and ID selectors and list filters cannot be mixed.

`workflow.status_and_next(project_id, experiment_id=...)` is the canonical
experiment read. Its `context` has exactly four sections: experiment, latest
plan, latest report, and the remaining current-attempt artifact references.
Live experiments receive the full latest plan; terminal experiments receive
its bounded Summary; the latest report is full when present. Plan, report, and
every artifact reference carry their immutable artifact id, local path, and
submission timestamp; a plan or report whose upload command never succeeded
reads `pending_upload`.

## Experiment workflow

The agent-facing statuses are:

```text
planned -> design_review -> running -> experiment_review -> complete
```

`failed` and `abandoned` are terminal exits. The typed transitions an agent
may call are:

```text
submit_design
retry_running
submit_results
mark_failed
abandon
```

`approve_design`, `complete` and the `revise_*` returns are `auto` edges: a
review verdict applies them in its own transaction, so they are absent from the
`experiment.transition` enum (likewise `accept`/`revise`/`fail_review` for
tasks and `begin_consolidation`/`revise_*`/`publish` for reflections).

The graph in `src/merv/brain/workflows/definitions/experiment.py` drives
transition enforcement, dispatch prerequisites, node briefs, and allowed actions.
Research Core binds its state and evidence to the graph. The compatibility views
in `workflow.status_and_next` use the same evaluated graph.

- `submit_design` requires a pinned `plan` artifact with the required section
  spine.
- A passing design review applies `approve_design` in the review transaction,
  entering `running` directly. The owner need not make another transition.
- `submit_results` requires current-attempt `result`, `report`, and `graph`
  artifacts. When a system metrics exhibit is pinned, the report must reference
  and interpret it.
- A passing experiment review applies `complete` for the current snapshot in
  the same transaction.
- `retry_running` is a same-attempt infrastructure retry and remains `running`.

A result-review rejection must return to `running` when the approved plan still
stands, or to `planned` with a new attempt when the design is flawed.

`workflow.status_and_next` returns a deliberately slim view: `{scope, workflow,
context}`, where `workflow` states each gate once (`suggested_action` when one
is open, else `blocked_actions`) beside the revision, review substate and next
action. Project scope carries the project document and one row per experiment
and task; experiment scope adds a `sandbox` summary. `experiment.transition`
returns a compact state-change acknowledgement plus operation-specific
side-effect receipts. The HTTP UI uses richer service views.

`experiment.create` returns `{id, name, status, folder, next}`; `next` names
the plan document, its role and required sections. It accepts `depends_on`
(exp_/task_ ids). An experiment may be
`running` after plan approval while `dependencies_pending` blocks its execution
lease. The same prerequisites are rechecked in the lease transaction. Actual
work start is recorded when the execution agent activates its lease, or an
interactive agent calls `workflow.begin` with the current revision; plan
approval does not start a clock.

## Task workflow

A task is scoped non-experiment work with a verifiable finish line and no
claim. The agent-facing statuses are:

```text
in_progress -> in_review -> done
```

`failed` is the only other ending. The typed transitions are:

```text
submit_delivery
mark_failed
```

The graph in `src/merv/brain/workflows/definitions/task.py` drives
enforcement, `allowed_transitions`, gate checklists, review returns, and
`workflow.status_and_next(task_id=...)`.

- `task.create(name, goal, deliverables, depends_on?)` creates the task
  straight into `in_progress` and returns `{id, name, status, folder, next}`;
  the name becomes the folder `tasks/<name>/` and `next` names the delivery
  document with its required sections. Goal and deliverables are immutable —
  Merv renders and pins `brief.md` from them, and brief submissions against
  tasks are refused.
- `submit_delivery` requires a `delivery` artifact whose `Confirmations`
  section carries one numbered entry per deliverable, and every dependency
  succeeded.
- A passing `task_reviewer` review applies `accept` for its current snapshot
  in the review transaction; no separate owner acceptance is required.
- `mark_failed` is the owner's exit; `evidence.reason` is recorded and
  `failed_by` is `owner`.

A task review `needs_changes` returns to `in_progress` on the same attempt
(`return_to` may be omitted). A `fail` verdict ends the task (`failed_by`
`reviewer`); `return_to` must be omitted or `failed`.

`workflow.status_and_next(project_id, task_id)` returns the task scope: the
slim task (goal, deliverables, status, dependencies, dependents, artifacts, reviews),
the workflow guidance, and a bounded context with the brief and delivery content.
`task.transition` returns a compact acknowledgement.

## Reflection workflow

External tools and target types use **reflection**. Persisted ids keep the
`syn_` prefix. The statuses are:

```text
reflecting -> synthesizing -> reflection_review -> consolidating -> consolidation_review -> published
```

`abandoned` is terminal. One wave may be open per project. The native reflection
record projects `consolidation_review` as `consolidating`; the workflow assignment
identifies the separate reviewer node and its read-only role.

- `reflection.create` snapshots the corpus and requires exactly five lenses:
  `amplify`, `avoid`, `entropy`, and two project-specific lenses.
- Each roster lens runs as a `reflection_lens` child workflow. It stores its
  Markdown document with `artifact.upload(project_id, path)`, executes the
  returned upload command, and submits that content id through
  `workflow.transition` for the child. The child records its roster association.
  Each document needs a non-empty `Summary`.
  Once all five children finish, the parent joins their exact contributions and
  applies `submit_reflections` automatically.
- `submit_reflection_artifacts` requires a valid `project_graph`, concise
  `reflection_doc`, and materializable `change_spec`. The spec's `decision`
  names the next wave: at most three `experiments` plus any number of `tasks`
  (each with `goal` and `done_when` checks); both kinds may carry `depends_on`
  (spec keys or existing exp_/task_ ids, acyclic). A wave may be tasks only.
- A passing `reflection_reviewer` review applies `begin_consolidation` in the
  review transaction, handing work to a separate consolidator.
- `consolidation.submit` records one immutable proposal with a reasoned decision
  for every experiment and its declared Git integration kind. It and
  `reflection.transition` answer with a receipt (status, gate checklist,
  allowed transitions; the proposal id and any `superseded_proposal_id`).
- `publish` is the runner's: after a passing `consolidation_reviewer` review the
  wave stays in review status until the central-ref receipt arrives, then
  publish applies claim changes and creates the reviewed wave: tasks (each
  with its brief pinned from the spec), experiments, and the dependency edges
  between them.

A rejection returns to `synthesizing` when the lens documents stand, or to
`reflecting` with a new attempt when the fan-out must be repeated.

## Review sessions

Supported reviewer roles are `design_reviewer`, `experiment_reviewer`,
`task_reviewer`, `reflection_reviewer`, `consolidation_reviewer`, `human`, and
`automated_check`. The five workflow gates use their matching reviewer roles;
`review.request` accepts `target_type` `experiment`, `task`, or `reflection`.

The current protocol is:

```text
review.request(project_id, target_type, target_id, role, reason?, producer_session_id?)
review.start(review_request_id, reviewer_capability, caller_session_id)
review.submit(review_session_id, verdict, synopsis, return_to?, notes?, findings?, evidence?)
```

`review.start` and `review.submit` are capability-addressed and take no
`project_id`.

For the workflow reviewer roles, `review.request` validates the active
gate. `human` and `automated_check` are gate-exempt and may be requested outside
a workflow review gate. Every request pins a target snapshot, stores a hash of
the capability, and returns the plaintext capability once with
`reviewer_handoff.spawn_prompt`. Requesting a fresh capability supersedes prior
open requests for the same target and role.

`caller_session_id` is required at `review.start` and must differ from the
producer session; the session also binds to the verified `agent_id` that
started it, and only that context window may submit. Start returns the project
id, `project_context` (`{id, name, summary}`), and the target's canonical
experiment `context` or `reflection_context`. Experiment context is built only
from artifact versions pinned to the immutable request snapshot: the plan and
report are supplied according to the normal context rules, while other
artifacts (logic graph, metrics exhibit) are listed by id for `artifact.read`.
Reflection reviews receive their pinned `submitted_artifacts`. A capability
remains startable while the request is `requested` or `started` and the
capability is unexpired; the first accepted submission closes the request and
prevents other sessions from submitting.

`review.submit` requires a plain-language `synopsis`. Rejected experiment-attempt
and reflection reviews require `return_to`; design-review rejections always
return to `planned`. The verdict routes the target in its own transaction: a
passing design, attempt, task, or reflection review follows its graph's `auto`
verdict edge, a rejection follows the return path, and a passing consolidation
review leaves the wave for the runner's central-ref receipt. The receipt
reports `target.status_before`/`status_after` and a `next_action` for the
producer, who refreshes `workflow.status_and_next` rather than transitioning.
A passing review satisfies a workflow gate only when its role matches that gate
and its snapshot is current; `human` and `automated_check` passes do not
replace the required workflow reviewer. `review.request` returns
`producer_next` saying the same.

Auto-run reviewer credentials are read-only outside their exact `review.start`
and `review.submit` capability. In an assigned session, use the assignment's
request id and `reviewer_capability="assigned", caller_session_id="assigned"`;
Merv resolves the authenticated session identity. Interactive capability handoffs
still rely on the reviewer skill for calls made with a general project key.

Generic workflow tools are `workflow.catalog`, `workflow.start`,
`workflow.assignment`, `workflow.begin`, `workflow.history`, and `workflow.transition`.
Interactive agents call `workflow.begin(project_id, instance_id, expected_revision)`
when ready to work; auto-run uses its own lease activation instead. Transitions
name an instance and expected revision. Auto-run credentials can mutate only
their assigned instance and revision, and become invalid when that node changes.
Assignments freeze the node-owned brief and exact evidence references at lease
time; recovery resumes current work without replaying completed nodes.

## Sandboxes

Sandboxes are project-scoped machines. They may be standalone, attached to
multiple experiments, and addressed by `sandbox_uid`. An experiment may have
multiple active sandboxes.

`sandbox.request` requires a caller-owned OpenSSH public key. The brain records
and authorizes the public key; caller private-key material never enters brain
state. While provisioning, the response and `sandbox.get` are a short poll
receipt (`sandbox_uid`, `status`, `poll_after_seconds`); once running they carry
the full facts and an `ssh` block (host, port, user, certificate, host key).
The agent client constructs and runs SSH commands. `sandbox.pull_outputs`
takes no key argument: it returns a filled rsync command with a `<key_path>`
placeholder the caller substitutes with its own private-key path when running
the command.

The sandbox workdir is `/workspace`, machine-owned and independent of
experiment attachment. Files are not synchronized automatically. Pull compact
outputs into the local experiment folder before artifact submission, and use
durable object storage for heavy files.

`sandbox.options` lists one flat object per offer (`provider`, `instance_type`,
`region`, `gpu`, `cpu`, `memory`, `price_usd_per_hour`, `available`);
`sandbox.request` without an `instance_type` returns `needs_selection` with the
matching offers, and an unknown or ambiguous selection is refused with the
candidates named.

Provisioning is best-effort synchronous. `sandbox.request` may return
`provisioning`; poll with `sandbox.get`, never repeated request calls. Long work
uses `sandbox.run`, which returns `job_id`, `cursor` and the `sandbox.job` call
to wait on; `sandbox.job` long-polls one job (`after` + `wait_seconds`, up to
30s per call — the cap merv-sandboxes honours) and reads output by `tail` or
offset/limit (default 4 KB). `sandbox.runs` returns `runs[]` and with
`wait_seconds` blocks until any pending job changes; `sandbox.terminal` is a
fresh bounded tail of the latest job on every call. Transcript and run lookups
are sandbox-scoped even when addressed through an experiment.

`sandbox.release` is a two-step destructive operation: the first call returns a
retention checklist, and `confirm_retained=true` terminates the machine. Release
or expiry destroys anything not explicitly retained.

## Storage and feed

- `storage.submit` and `storage.fetch` return a one-line command the agent runs
  to transfer bytes over a presigned URL; `storage.find` and `storage.object`
  operate on the brain's ledger. The what-goes-where rule lives in the
  `storage.find` description, not in its rows.
- `feed.post` returns `{post_id, thread?}`, or a one-line command to upload a
  captured image or HTML embed that prints the same receipt; feed registration
  and reads are brain control operations.
- Every upload command is `curl -sS --fail-with-body`, so a rejected upload
  prints the server's reason; `litreview.edit` answers `{section, revision,
  bytes}`.

## HTTP transport and errors

The brain exposes `/mcp/tools` and `/mcp/call`, plus the stateless `/mcp`
endpoint every agent client connects to. It rejects `repo_root` context. Byte
payloads do not ride MCP: tools return commands for one-time Artifact/Feed
endpoints, provider-presigned Storage transfers, or Sandbox `rsync`.

Tool responses are tool-specific dictionaries; there is no universal mutation
envelope. Domain validation and workflow failures remain MCP protocol errors;
argument validation errors carry `loc`, `msg` and `type` only, never the
input, and a disallowed transition names the allowed ones.
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
- optional heavy-object storage: merv-sandboxes object storage (`MERV_SANDBOXES_URL`).

The checkout never contains the brain database. There is no machine-local routing
state; project files remain ordinary checkout files until explicitly submitted.

See [ARCHITECTURE.md](ARCHITECTURE.md),
[WORKFLOW_AND_REVIEW.md](WORKFLOW_AND_REVIEW.md), and the live
[Artifacts guide](../src/merv/brain/artifacts/artifacts.md).
