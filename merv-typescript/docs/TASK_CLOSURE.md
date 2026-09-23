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
2. Transitions the task to `failed` (a service task to `suspended`).
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

## Task versions

Every task starts on `task@2` or a later version, each of which has `mark_failed` from
`in_progress` and `in_review` in its published graph, so a withdrawal advances the revision by
exactly one. `task@1`, which lacked that edge and needed an in-place upgrade to close, was
retired on 2026-09-22 together with the engine's upgrade primitive: tasks migration 8 and
workflows migration 7 deleted its instances, including those an earlier withdrawal had upgraded
to `task@2`. Its definition row stays in `wf_definitions` as history.

## Validation

Focused tests cover task permissions, reason/revision validation, requested and
claimed review closure, stale work rejection, prior verdict preservation, command
replay/conflicts, forced rollback and restart. The public HTTP/MCP adapter is
included in the task closure tests. Final suite counts and check results are in
[the verification record](../verification/task-closure.json).
