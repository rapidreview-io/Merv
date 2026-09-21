# Workflow guidance

Workflows now evaluates registered domain rules and exposes
`workflow.status_and_next`. Tasks supplies its checks; Workflows owns evaluation,
action selection and the public decision. No additional guidance service or
context-adapter plugin is involved.

## Agent interface

```json
{ "instanceId": "wf_THE_TASK_ID" }
```

The task ID is also its workflow instance ID. The result includes `state`,
`revision`, `currentGate`, `nextAction`, `blockers`, `actions`, evidence/review
`references`, and `terminal`. Each action includes its tool, instructions,
server-derived arguments and required input fields. Mutation tools still require
a stable `requestId`.

An action is `ready`, `needs_input`, or `blocked`. `needs_input` means the caller
can prepare that action but must supply evidence or assessment details. It is not
a claim that unseen evidence has passed validation. `nextAction: null` means no
normal action is recommended for this actor; terminal workflows explicitly say
they have ended. Recovery actions such as reissuing a review remain listed when
applicable but are not recommended as ordinary progress.

`limits` lists each [loop limit](BUDGETS_AND_LIMITS.md) leaving the current state, with
its `base`, `granted`, `max`, `used`, `remaining` and `exhausted`; it is an empty array
elsewhere. When a limit is exhausted the gate and first blocker are
`loop_limit_reached`: every allowed return is used, the work is not failed, and it waits
for a human. Uncapped actions stay available, so a reviewer can still accept or fail it
by hand, and a project admin can allow more rounds with `workflow.extend_limit`. The
commit refuses the capped edge with the same code, before the rule's own guard.

With no arguments, the tool returns a project-scoped overview of **instances**,
including `ready`, `blocked`, `escalated`, `terminal`, and `unavailable` ID lists.
`escalated` instances have an exhausted loop limit; they appear in neither `ready` nor
`blocked`, and automatic dispatch leaves them alone. Here `ready`
means the caller has a recommended action, including preparation needing input;
it does not mean an execution lease can be granted. This view neither schedules
agents nor chooses project research priorities.

An optional preflight uses the same checks against a proposed command:

```json
{
  "instanceId": "wf_THE_TASK_ID",
  "action": "submit_delivery",
  "input": {
    "taskId": "wf_THE_TASK_ID",
    "expectedRevision": 0,
    "artifactIds": ["art_THE_DELIVERY_ID"]
  }
}
```

Preflight is read-only. It does not attach evidence, claim a review, reserve
permission or execute a transition. Actual commands recheck their rules in the
transaction that changes state. A stale revision, changed permission, invalid
delivery or replaced claim can therefore invalidate an earlier successful read.

## Task behavior

| Situation                                       | Guidance                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Producer, work in progress                      | Read task context, complete the brief and prepare delivery evidence     |
| Delivery submitted, producer                    | Wait for independent review; do not review the delivery yourself        |
| Eligible independent reviewer, unclaimed review | Call `review.start`, then refresh guidance and obtain review context    |
| Current claimed reviewer                        | Inspect evidence and submit a verdict with the current claim ID         |
| Another reviewer holds the claim                | Wait; no verdict action is available to this actor                      |
| Reviewer revoked, cleanup not yet delivered     | Recovery is pending; do not reuse the old claim                         |
| Recovery reopens the review                     | An eligible replacement can claim it and receive new guidance/context   |
| `needs_changes` verdict                         | Producer resumes delivery work at the new revision with review feedback |
| `pass` or `fail` verdict                        | Workflow is terminal; no further action is required                     |

`task.get` and `task.list` include the same caller-specific decision as `guidance`.
Tasks reads its record, workflow and guidance on one transaction. The required
task section in every context recipe carries that decision into Context Builder;
there is no duplicate gate policy in recipes or a reverse dependency from Context
Builder to Tasks. Saved packages remain immutable historical snapshots. Their
existing character budgets include this extra guidance.

Command replay returns the originally committed receipt, including any guidance
stored with it; older receipts may predate that field. Refresh `task.get` or
`workflow.status_and_next` for current guidance. A saved context is similarly not
fresh authority to act.

The task detail UI renders a “What happens next” section from `task.get.guidance`.
It displays the current gate, next step and blockers and remains read-only.

## Registering another program

`workflows.register(definition, policy)` accepts the existing versioned graph and
an optional policy. Each policy action declares its states, public tool,
instructions, required input fields, and a synchronous `check(context)` function.
It maps to zero or more graph transition names. An auxiliary step such as claiming
a review need not itself change the task graph.

When a policy is supplied, every graph edge must have exactly one owning action
rule. The engine invokes that rule again before transitioning. Programs retain
their private managed handles, so a generic transition cannot bypass the owning
program's command. Task verdict routing is checked before recording the verdict;
both still commit or roll back together.

`context` carries the authenticated caller, a frozen snapshot, the current
transaction, optional proposed input and the actual transition when enforcing a
command. Checks must be synchronous, read-only local operations. They may call
the owning program's normal read capabilities; they must not write, perform
network I/O or launch work. Typed domain errors become blockers; unexpected
errors fail the evaluation instead of reporting a ready action. Async functions
and returned promises are rejected. The transaction is a trusted plugin port,
not a sandbox for hostile plugin code.

Optional `arguments(context)` supplies the current task/review/claim IDs and
revision. Optional `describe(context)` supplies a label, references and
domain-specific gate/waiting wording. Declaration order chooses the first
unblocked suggested action; `suggested: false` keeps exceptional recovery actions
out of the normal recommendation. Programs can register new rules without adding
workflow-name cases to the engine.

Graph JSON remains fingerprinted and version-pinned. Callbacks are deployed
program code, like command handlers, and are not serialized or fingerprinted as
graph data. This change does not migrate existing instances or change their graph
version. Persisted recipe definitions also remain unchanged.

## Lifecycle and boundaries

Workflows still injects only State and Scope. Tasks registers callbacks using its
own declared dependencies. The single guidance tool is published by the
Workflows tool adapter, which injects Workflows and Tools. The removed catalog,
list/get/history tools have not been restored.

Unloading a program unregisters its policy. Its stored active instances report
`workflow_unavailable` with no recommended actions; terminal history stays
terminal. Reinstallation supplies fresh callbacks and resumes evaluation. An old
registration disposer cannot remove its replacement. Unloading Workflows itself
withdraws both its guidance tool and dependent task tools while admitted calls
drain. Existing unrelated providers remain usable.

Scope still authenticates and authorizes individual tools. Reading evidence,
searching Nisa or posting to the feed does not require inventing a graph edge for
each operation. Workflows governs managed progress, not every low-level tool call.

## Verification

The [verification report](../verification/workflow-guidance.json) records the
complete test suite and browser check. The new tests exercise an unrelated
calibration program, status/preflight agreement with command checks, changed facts
after preflight, tenant boundaries, unload/reinstall, task/reviewer roles, stale
claims and revisions, recovery, context inclusion, revision cycles and both
terminal outcomes. Existing HTTP/MCP tests verify the tool, project overview and
task response agree; the held-call unload test includes guidance withdrawal.

The browser preview used disposable synthetic tasks. Production data and live
model calls were not needed for these checks. This completes the first guidance
slice from the [parity audit](BACKEND_PARITY_AUDIT.md); task dependencies, producer
failure commands, richer evidence formats, research programs and the runner are
still separate work.

## Task closure extension

Tasks also registers `mark_failed` for active tasks. It is an explicit alternative,
never the normal suggested next step. The producer/operator supplies a reason;
preflight and the command use the same permission and state checks. New tasks use
`task@2`. Existing `task@1` instances advertise the command as an auxiliary action,
and the command upgrades and closes them atomically. Saved contexts remain
historical; fresh task reads show the terminal decision and recorded failure.
See [task closure](TASK_CLOSURE.md).

## Work prerequisites

Decisions now include `dependencies`. A program can flag an action with
`requiresDependencies`; only successful prerequisites satisfy that requirement.
Task delivery and producer context/checkpoints use it. `dependencies_pending`
explains waiting; `dependency_failed` can recommend the program’s authorized
failure action. Explicit preflight stays on the requested action. See
[work-item dependencies](WORK_ITEM_DEPENDENCIES.md).

## Structured delivery inputs

New tasks require artifact IDs plus one numbered confirmation per acceptance check. Tasks owns the validation; the existing Workflows evaluator reports the same missing input or invalid confirmation as the command. Required input fields may be computed from a frozen evaluation context so legacy task evidence contracts retain their original requirements. See [structured evidence](STRUCTURED_TASK_EVIDENCE.md).

## Review assessments

The pinned review format determines whether synopsis and findings are required. Review preflight validates a supplied expectedRevision against the same task revision as the command. Typed findings include explicit waivers with reasons; a passing verdict cannot contain an unmet or unverified criterion. [Assessment contract](REVIEW_ASSESSMENTS.md).

## Beginning a step

For programs declaring assignments, guidance includes a preflightable `begin` action and prefers it before the first recorded activation. `workflow.begin` returns the full starting context atomically with that record. Exit actions remain independently checked; begin is not a claim or lease. After activation, guidance recommends the current domain handoff. See [assignment semantics](WORKFLOW_ASSIGNMENT_PLAN.md).
