# Work-item dependencies

Workflows now owns the persistent work dependency graph. This graph describes
which work items must succeed before other work proceeds; Cordis still manages
which plugins need which services. No new plugin is required.

## Task interface

`task.create` accepts `dependsOn` as one workflow/task ID, an array of IDs, or null.
Omission means no prerequisites. IDs are trimmed; empty and duplicate IDs are
ignored. Each target must exist in the caller’s project and have declared success
semantics. Unknown, cross-project and malformed targets are rejected atomically.

```json
{
  "title": "Analyze the prepared data",
  "goal": "Produce the analysis.",
  "checks": ["Analysis addresses the question."],
  "briefId": "art_BRIEF",
  "dependsOn": ["wf_DATA_PREPARATION_TASK"],
  "requestId": "create-analysis"
}
```

The task ID is its workflow instance ID. Public task dependencies are set at
creation; no dependency-editing tool is exposed. `task.get` and `task.list` return
both `dependencies` (waits on) and `dependents` (unblocks). Each row carries its
ID, workflow, current version, name, state, and `settled`/`failed` flags. The task
UI displays both directions and links task prerequisites to their task pages.

| Prerequisite condition        | Downstream task behavior                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Active or awaiting review     | Creation and evidence upload remain allowed; work context, checkpoints and delivery are blocked                   |
| Returned for changes          | Still blocked; a submitted delivery is not success                                                                |
| Independently passed (`done`) | That prerequisite is satisfied; all prerequisites must satisfy before work proceeds                               |
| Failed or withdrawn           | `dependency_failed`; an eligible producer/operator is offered `task.mark_failed`, or can replan outside this task |
| Missing stored target         | Remains unsettled with state `missing`; never silently opens the gate                                             |

Failure guidance does not itself mutate or fail downstream work. Withdrawal
requires an explicit command with a reason and current revision. Another
producer, a reader or a reviewer is not given an authorized withdrawal action.
Reviewing already-submitted evidence is not globally blocked by dependencies.

`workflow.status_and_next` supplies the same caller-specific dependency facts and
blockers as the task’s `guidance`. Preflight is read-only and checks the requested
action; a delivery preflight never silently switches to withdrawal. Actual
delivery rechecks its registered rules inside the write transaction.

## Context and continuity

Task work context and checkpoints use the same Workflows prerequisite checker.
Once the prerequisites succeed, their IDs, names, states and success/failure
flags appear in the required task section of the context recipe. Agents follow
those references to inspect upstream evidence. This matches Python’s behavior;
upstream documents are not silently copied into a downstream assignment.

Reverse `dependents` are a live navigation view, not part of the assignment’s
pinned context. Creating another downstream task must not change the upstream
assignment’s context retry. Tests cover that exact case. Forward prerequisites
and canonical guidance remain included. Existing immutable recipes are unchanged.

Saved contexts and command receipts remain historical. Fresh task reads/guidance
show current dependency state. A dependency-free legacy task remains usable with
its original workflow version and an empty dependency list.

## Reusable program contract

A program declares terminal `successStates` when registering a workflow policy.
Tasks declares `done`. Another program can declare `complete` or another terminal
state; Workflows does not contain a switch on task or experiment types. Success
declarations are durable and immutable per workflow name/version. Each new edge
pins the target’s success and terminal-state criteria, so provider removal or a
later version upgrade cannot silently rewrite an existing dependency’s meaning.

`requiresDependencies: true` on an action applies the shared gate to that action.
Programs use `checkDependencies` when constructing assignments or authorizing
execution separately. This distinction matters for experiment parity: Python
permits planning and design review while prerequisites are pending, then gates
execution dispatch. Dependencies are deliberately not an unconditional gate on
every transition. The actual experiment program and execution leases are still
unimplemented; generic tests verify the reusable cross-program behavior.

A policy may name `dependencyFailureAction` for owner-approved recovery guidance.
The engine checks that action independently, preserving authorization and
explicit-action preflight behavior. It never performs the recovery automatically.

Registration handles also offer additive `addDependencies` for a future program
that creates multiple work items and then connects them in one transaction, as
Python reflection materialization does. It checks ownership, project, revision,
self-links and cycles. New links advance the revision and record history/events;
repeated identical requests replay, duplicate links do not advance the revision,
and partial failures roll back links, revisions, events and receipts together.
Terminal instances reject fresh modifications. A program must coordinate any
existing assignment/review handoff in its transaction. There is no public editing
tool and no edge removal operation.

## Verification

The full suite passes **221 tests**, with zero failures, cancellations or skips,
including real loopback HTTP/MCP and the prepared Nisa fixture. Backend/UI builds,
typechecks and formatting are checked. New tests cover cross-program success
states, DAG/cycle validation, tenant isolation, dangling targets, private
composition/replay/rollback, pinned criteria across upgrade/unload/restart, task
chains, independent verdict outcomes, context continuity and transport validation.
The corresponding Python task/experiment tests passed **29 tests** during the
parity comparison. No new live-model acceptance or browser sign-in was performed
for this slice; their previous checkpoint and approval status remain separate.

See [verification evidence](../verification/work-item-dependencies.json).
