# Task program

A Cordis program implementing the durable task/delivery/review loop. Requires `state`, `scope`, `artifacts`, `workflows`, and `reviews`; provides `tasks`. Core code has no dependency on transport or the tool registry.

`task@1` is a managed workflow. The program retains its private registration handle; generic workflow tools cannot start instances or bypass the task's evidence/review gates.

- **Create:** pin a valid UTF-8 text brief containing the goal and every Done-when check. The current actor owns the task. Brief and goal fields are immutable.
- **Submit delivery:** the producer supplies immutable artifacts and the current task revision. Every text delivery document must contain valid UTF-8; the delivery must address each check verbatim and differ from the brief. The task enters `in_review` and a review request pins the brief plus delivery manifest in the same transaction.
- **Reissue review:** the producer or project operator can replace an unavailable or revoked reviewer’s open claim with a reason and expected revision. This supersedes the old request, advances the task revision, and pins the same evidence in a new request atomically. Prior reviewers cannot submit against the replacement.
- **Submit review:** the actor who independently claimed the current review supplies a verdict and the pinned task revision. `pass` routes to `done`, `needs_changes` returns to `in_progress`, and `fail` routes to `failed`. Verdict, workflow transition/history, task events, and request deduplication commit or roll back together.

Text coverage is a structural gate; the independent reviewer evaluates whether the submitted evidence actually meets the checks. Review notes become the workflow's outcome or revision context. A revised delivery receives a new review request; prior evidence and verdicts remain readable.

Task command request IDs are scoped to actor and project. An identical retry returns its originally committed response; different input under the same ID is rejected. `expectedRevision` always means the task workflow revision.

The optional `taskToolsPlugin` installs `task.create`, `task.get`, `task.list`, `task.submit_delivery`, `task.reissue_review`, and `review.submit`. Disposal removes runtime registrations but preserves durable tasks and the versioned workflow definition.
