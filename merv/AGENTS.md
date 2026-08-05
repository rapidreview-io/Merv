# Merv

This repository uses one Merv MCP surface backed by a single brain. The agent
connects directly to `POST /mcp` with `Authorization: Bearer <key>`, where the
key is an `mk_` key scoped either to one project or to the owner's whole
account (chosen when it is minted). The brain owns durable
research records, workflow policy, reviews, sandbox lifecycle, provider
credentials, blobs, and optional heavy storage.

The brain never receives a checkout root and never reads the agent's filesystem.
The agent submits explicit metadata and selected evidence bytes through MCP.

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
  work with `workflow.status_and_next`, and follow its gate, allowed actions,
  missing evidence, and next action.
- Local edits are not research state. Use `artifact.submit` to contribute
  evidence; it returns a presigned upload command for the bytes, and the
  submitted version can be associated with a target and role.
- Load `research-workflow` for experiment work and `project-reflection` for a
  five-lens reflection wave.
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

When a gate requests review, call `review.request` and delegate its handoff to a
separate agent using `experiment-design-review`, `experiment-attempt-review`, or
`project-reflection-review`. That reviewer calls `review.start` with its own
`caller_session_id` and submits the verdict through `review.submit`.

The capability is tied to a role and immutable target snapshot. At
`review.start` the brain rejects invalid/expired/superseded capabilities, stale
snapshots, or a declared reviewer session string equal to the declared producer
string. At submission it rechecks that the request is open and the snapshot is
current. Reviewer read-only behavior is an operating rule imposed by the skill;
the system does not authenticate every unrelated tool call as that reviewer.
This is a practical workflow boundary, not cryptographic proof of independence.

## Sandbox loop

Load `sandbox-operation` before requesting or operating a sandbox. It owns the
provider-selection, caller-key, durable-run observation, retention, extension,
recovery, and two-step release procedure.
