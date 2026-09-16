# Workflow assignment and begin

Status: implemented in the existing Workflows, Tasks and Context Builder plugins.
This closes the interactive assignment/start slice. The later [Sessions slice](SESSION_LEASES.md)
adds scoped credentials, leases and ownership recovery; process launch and research
programs remain separate parity work.

## Ownership

| Component       | Responsibility                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows       | Select the current state’s assignment, check admission and prerequisites, return the packet, and retain the first start at each revision. |
| Tasks           | Declare work/review assignments beside their action rules; choose the task type’s recipe and prepare its domain context.                  |
| Context Builder | Render read-only previews and immutable saved packages through the same renderer.                                                         |
| Workflow tools  | Expose `workflow.status_and_next`, `workflow.assignment` and `workflow.begin`.                                                            |
| Task UI         | Display current and historical first starts from the same durable task data.                                                              |

No new plugin or Cordis dependency was added. The composition remains 28 plugin
entrypoints and 58 direct dependencies; the interface now has 28 domain tools,
or 30 with the optional UI tools.

## Agent flow

```text
workflow.status_and_next → workflow.begin → do the assigned work → domain handoff
                                │
                                └─ complete context preview from the task’s recipe
```

`workflow.assignment({ instanceId })` reads the same packet without starting work.
`workflow.begin({ instanceId, expectedRevision })` records the first start at that
revision and returns a fresh packet. The authenticated caller supplies identity;
neither feature accepts an actor, role, session or context override. The common
API envelope still permits an authorized project selection.

Packets contain actor/project/instance/version/state/revision, role, label, brief,
references, handoff instructions, declared tool bindings, a complete
`ContextPreview`, and `workStart`. The preview includes the assembled prompt,
pinned source manifest, recipe hash and content hash. It has no package ID or
creation timestamp. `task.context` explicitly saves a package when needed; its
existing stable request replay remains ahead of artifact rendering.

Task recipes still own their formulas directly. The preview uses the same inputs
as saved context, including the brief, type-specific background, review evidence,
feedback, recovery notes and checkpoints. Reverse dependent links remain outside
the pinned assignment inputs. Prerequisite artifacts are referenced rather than
copied automatically.

## Admission and handoff

Starting work is independent of completing it. A task producer, or an operator
assisting that producer, may begin before delivery evidence exists. Successful
prerequisites and an available recipe are required. Only the producer can submit
the delivery; an assisting operator’s handoff explains that boundary.

An eligible independent reviewer may inspect or begin an open review before
claiming it. Begin does not claim ownership. Its packet directs `review.start`
and a refresh before assessment. An existing claim held by another actor blocks
assignment. Saved review context, checkpoints and verdicts still require the
current owned claim. Actor revocation and claim replacement are rechecked on
repeat calls.

Guidance reports a preflightable `begin` action and prefers it before the first
start. Afterward it recommends the current domain action, such as claiming or
submitting a review. Guidance checks admission without rendering context, so a
context recipe can embed guidance without recursive construction. A missing
recipe blocks begin while ordinary task reads and closure remain available.

The later [fixed execution-policy slice](WORKFLOW_EXECUTION.md) replaces Tasks'
dynamic ready-action tool list with a version-pinned declaration.
`execution.readOnly` describes the work and `execution.tools` displays common
fixed bindings; `execution.policy` carries the complete alternatives and reference
constraints, with a policy hash and registration generation. Required submission
content and stable request IDs still come from the caller. Each actual tool
rechecks its own permissions, claim, revision and evidence rules. These packets
still do not create or enforce a session bearer. Third-party assignment rules
without a fixed policy can retain their advisory instructions, but receive no
internal dispatch authority from them.

## Persistence and failure semantics

`wf_work_starts` has an immutable unique `(instance_id, revision)` key, with first
actor, time, state/version and `workflow.work_started` event ID. Begin runs under
State’s `BEGIN IMMEDIATE` transaction:

1. Check project/active identity, current revision, installed program and admission.
2. Reuse the first marker, or insert its event and marker.
3. Render the complete assignment. The embedded guidance sees the new marker.
4. Validate and detach the packet; reject callback changes to the workflow.
5. Commit together. Rendering or event failure leaves no committed start.

Begin does not advance state, revision or transition history. Repeat begin
rechecks admission and rebuilds current context, preserving the first attribution
without another start event. A later workflow revision gets its own marker.
Version upgrades already increment revision, preserving this identity.

This is a first-activation ledger, not a lease, current owner or time sheet. A
replacement reviewer’s new claim and recovery history record ownership; the
original first start stays historical. Legacy submissions may have no marker:
that means no start was recorded, not that the work never happened. No invented
start times are backfilled.

SQLite serializes writers before admission reads. Rendering currently uses
bounded local artifact reads inside that transaction, with no network/model
calls. This deliberately preserves atomic failure semantics; large concurrent
workloads and future asynchronous storage need a separate design.

## Python parity and remaining limits

The Python audit ran 45 workflow tests. The implementation preserves read-only
assignment, independent admission, pre-claim review inspection, first-start
identity, repeat admission and rollback. Python’s public assignment hides its
internal execution metadata; TypeScript’s advisory declaration is additive.

Python also joins the complete living project document into assignments. That
project Introduction/literature/Methods/Results model does not exist here yet;
these packets include the real task context available today. Interactive begin
creates no session. The separate [Sessions control plane](SESSION_LEASES.md) now
implements capability, lease, heartbeat and recovery enforcement. Runner activation,
workspaces and durable external start effects remain unimplemented.

Evidence: [assignment verification](../verification/workflow-assignment.json),
[live run](../verification/workflow-assignment-live.json),
[Fable design review and dispositions](reviews/workflow-assignment-fable-design.md).
