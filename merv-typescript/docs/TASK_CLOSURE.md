# Task closure and workflow version compatibility

The task producer or a project operator can now end an active task with
`task.mark_failed`. It requires `taskId`, the current `expectedRevision`, a
nonblank `reason` of at most 16,000 characters, and a stable `requestId`.
Other producers, readers and reviewers cannot withdraw someone else's task;
revoked actors and callers from another project are refused.

```json
{
  "taskId": "wf_TASK_ID",
  "expectedRevision": 1,
  "reason": "The required dataset is no longer available.",
  "requestId": "close-unavailable-dataset"
}
```

## One terminal operation

Tasks uses the same registered check for `workflow.status_and_next` preflight and
command enforcement. The action appears as an explicit alternative for active
tasks, but is never suggested as normal progress. It is not cancellation of an
external process: execution leases and runner cancellation remain separate gaps.

The command transaction:

1. Checks active identity, project, producer/operator authority, revision and reason.
2. Upgrades a legacy task if necessary, then transitions it to `failed`.
3. Supersedes any current unfinished review, making its claim unusable.
4. Records the attributed reason and `task.failed` event, then saves the replay receipt.

All steps commit together or roll back together. A completed independent verdict
is never overwritten. A task returned for changes can subsequently be withdrawn,
while the earlier verdict remains recorded. Task brief, submitted artifacts,
checkpoints and review history are retained. No further delivery, new assignment
context, checkpoint or verdict is accepted for the closed task. Previously saved
context and command receipts remain historical records.

`task.get` and `task.list` include a `failure` object with reason, actor, time and
the review ID closed by this command (or null), alongside terminal guidance.
The UI displays “Why this task ended” and the reason. Feed activity includes the
ordinary project-scoped task event. A repeated identical request returns the
original response; changed input under the same request ID conflicts.

## Existing tasks remain usable

`task@1` is retained byte-for-byte as a graph definition. New tasks start on
`task@2`, which adds `mark_failed` from `in_progress` and `in_review`. Old task
instances, pending review snapshots and claim IDs are untouched on startup,
ordinary reads, deliveries and verdicts.

The v1 policy exposes failure as an auxiliary command, just as it exposes review
claiming. When that command is used, Tasks explicitly upgrades that instance and
closes it within the same transaction. The caller sends the original revision;
a successful v1 closure advances it by two (upgrade, then transition). A v2
closure advances it by one. Callers must use the returned revision rather than
assume every command advances by exactly one. Failed closure leaves the original
version, revision, review and request receipts unchanged.

The upgrade capability belongs to the managed registration handle. There is no
new upgrade tool or generic public mutation method. It accepts only newer,
additive graphs for the same managed workflow: the initial state, states,
terminal states and all prior edges must remain unchanged. Both registrations
must be active. It preserves instance data/state, records source/target versions
in history/events, enforces project scope and revision fencing, and rejects fresh
upgrades of terminal instances. This small primitive does not claim parity for
arbitrary state remapping, bulk migrations or review migration between versions.

## Validation

Focused tests cover task permissions, reason/revision validation, requested and
claimed review closure, stale work rejection, prior verdict preservation, command
replay/conflicts, forced rollback, legacy compatibility and restart. Engine tests
cover additive validation, source/target lifecycle, tenancy, concurrent revision
checks, history/events and transaction rollback. The public HTTP/MCP adapter is
included in the task closure tests. Final suite counts and check results are in
[the verification record](../verification/task-closure.json).
