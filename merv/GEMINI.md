# Merv

This extension exposes one Merv MCP surface backed by a single brain. The agent
connects directly to `POST /mcp` with `Authorization: Bearer <key>`, where the
key is an `mk_` key scoped either to one project or to the owner's whole
account (chosen when it is minted). The brain owns durable
research records, workflow policy, reviews, and research object metadata. Merv
owns research artifacts, figures, and feed bytes in its own R2 storage. The
independent merv-sandboxes service owns sandbox lifecycle, cloud-provider
credentials, durable jobs, and ML workload storage such as datasets and models.

The brain never receives a checkout root and never reads the agent's filesystem.
The agent submits explicit metadata and selected evidence bytes through MCP.

## Identify this context window first

Call `agent.hello` once at the start of a context window — before any other
Merv call — and pass the returned `agent_id` in every Merv tool call after
that. The id names THIS conversation (or this subagent) to Merv so it can
attribute what each agent did and was told; a call without a valid `agent_id`
is refused with instructions. Never reuse another context's id, and tell each
subagent you spawn to call `agent.hello` itself (it may pass your id as
`parent_agent_id`).

## Project scope

Call `project(action="list")` to see every project this key can reach, with
names, summaries, and creation dates. Pick the one the user means and pass its
`project_id` explicitly on every project-scoped tool.

If the key is scoped to a single project, `project(action="current")` returns
it and that is the only project the key can ever act on; a mismatched
`project_id` is rejected. Omitting `project_id` on a project-scoped tool raises
"project_id is required" — never guess an id, call `project(action="list")`.
There is no linking step and no `connect` action. Use
`project(action="overview")` for the full claim and experiment history.

## Operating rules

- Treat the brain state returned through MCP as authoritative. Start or resume
  work with `workflow.status_and_next`, and follow its gate, allowed actions
  and next action. Auto-run assignments own one graph node;
  stop after its handoff. Interactive agents call `workflow.begin` with the
  instance id and current revision before beginning node work.
- Local edits are not research state. Use `artifact.upload` with
  `attach_to: {target_type, target_id, role}` to contribute research evidence.
  Run the returned upload command to store bytes and activate the association.
  Add `lens_id` inside `attach_to` only for `reflection_lens_doc`.
  Workflow nodes that accept content IDs use `artifact.upload` without an
  attachment; their submission transition records the association.
- Load `research-workflow` for experiment and task work and
  `project-reflection` for a five-lens reflection wave. Work that tests a
  claim is an experiment; scoped work with a verifiable finish line and no
  claim (a lit review, data preparation, a harness, a memo) is a task.
- Use a sandbox for long or expensive work; lightweight checks may run locally.
  Load `sandbox-operation` before requesting or operating one. Do not assume a
  provider; choose from `sandbox.options` when hardware selection is needed.
- For quantitative work, retain compact machine-readable result files and
  figures under the experiment folder, then submit them as result evidence.
- A project manager must register each newly promising result with
  `candidate.submit` immediately, then promote only a durably staged candidate
  after refreshing `candidate.list`, validating it, and comparing it with the
  champion.
  Large candidate bytes belong in Object Storage, never Git.

## Review boundary

Entering a review node queues its independent review, and auto-run dispatches
a fresh reviewer. Interactive coordinators can use `review.request` and hand its
capability to a separate agent running the matching review skill. The producer
must not review its own work.

An assigned reviewer calls `review.start` for its exact request with
`reviewer_capability="assigned"` and `caller_session_id="assigned"`; Merv resolves
the authenticated session. A manual handoff uses its exact capability and the
reviewer's own `caller_session_id`; the session binds to the reviewer's
`agent_id`. Review submission rechecks the immutable snapshot and applies the
verdict's graph route atomically, reporting the target's status before and after.

Auto-run reviewer credentials enforce read-only access outside their review
calls. Interactive reviewers using a general project key follow the skill's
read-only procedure. A passing design enters execution directly; passing attempt
and task reviews complete work; passing reflection review enters consolidation.
`approve_design`, `complete` and `accept` are not agent transitions: the
producer refreshes `workflow.status_and_next` instead. The assigned agent stops
after its verdict.

## Sandbox loop

Load `sandbox-operation` before requesting or operating a sandbox. It owns the
provider-selection, caller-key, durable-run observation, retention, extension,
recovery, and two-step release procedure.
