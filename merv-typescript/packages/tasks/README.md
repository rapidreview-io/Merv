# Task program

A Cordis program implementing the durable task/delivery/review loop. Requires `state`, `scope`, `artifacts`, `workflows`, `reviews`, and `contextBuilder`; provides `tasks`. Core code has no dependency on transport or the tool registry.

Tasks registers its action checks and descriptions with Workflows. `task.get` and
`task.list` include caller-specific `guidance`; `workflow.status_and_next` returns
the same evaluated decision. The required task section carries it into every
context recipe, and the task UI displays it. Delivery/reissue/verdict commands
enforce those registered checks inside their transaction. See
[workflow guidance](../../docs/WORKFLOW_GUIDANCE.md).

`task@2` is the managed workflow for scratch tasks. Git tasks use `task@3`–`task@5`, which share its graph; service tasks use `task@6`, which suspends where the others fail (only `done` is terminal) and adds `revise_suspended` and `resume`. `task@1` was retired with its records on 2026-09-22. The program retains its private registration handle; generic workflow tools cannot start instances or bypass the task's evidence/review gates.

- **Create:** render and pin the goal and numbered checks as an immutable brief, or validate a compatible producer-supplied text brief. The current actor owns the task. Brief and goal fields are immutable.
- **Submit delivery:** the producer supplies immutable artifacts and the current task revision. Every task requires a structured confirmation for every numbered check, with evidence references and verification notes. Merv pins a generated assessment alongside the evidence. The task enters `in_review` and a review request pins the brief plus delivery manifest in the same transaction.
- **Reissue review:** the producer or project operator can replace an unavailable or revoked reviewer’s open claim with a reason and expected revision. This supersedes the old request, advances the task revision, and pins the same evidence in a new request atomically. Prior reviewers cannot submit against the replacement.
- **Submit review:** the actor who independently claimed the current review supplies a verdict and the pinned task revision, with a synopsis and per-criterion findings. Passing outcomes prefer structured evidence.outcome, then synopsis, then legacy notes. `pass` routes to `done`, `needs_changes` returns to `in_progress`, and `fail` routes to `failed`. Verdict, workflow transition/history, task events, and request deduplication commit or roll back together.

Confirmation coverage and evidence references are structural gates; the independent reviewer evaluates whether the submitted evidence actually meets the checks. Review notes become the workflow's outcome or revision context. A revised delivery receives a new review request; prior evidence and verdicts remain readable.

Task command request IDs are scoped to actor and project. An identical retry returns its originally committed response; different input under the same ID is rejected. `expectedRevision` always means the task workflow revision.

The optional `taskToolsPlugin` installs `task.create`, `task.get`, `task.list`, `task.context`, `task.checkpoint`, `task.submit_delivery`, `task.reissue_review`, and `task.mark_failed`. Reviews owns the generic `review.submit` tool. Tasks registers its submit-owner callback from the service lifecycle, identifies its subjects from durable Task records, and applies the existing Task command in the dispatcher's transaction. Historical submissions remain owned so successful retries retain their original response.

Disposal withdraws the review owner before suspending Tasks and draining its dependent tools, then releases workflow and context registrations after that drain. The generic review tool refuses missing ownership during unload. Durable tasks, verdicts and versioned workflow definitions remain available after restoration.

Task types and context references are pinned at creation. Tasks registers its versioned recipes directly with Context Builder. `task.context` checks current ownership, revision and review claim before building an immutable package. `task.checkpoint` saves attributed, immutable progress for the current assignment. Both are replayable; stale or revoked claims are refused. Producer identity stays historical attribution. See [recipes, required inputs and recovery behavior](../../docs/RECOVERY_AND_CONTEXT.md).

Creation and type registration copy their inputs before asynchronous work. A type registration cannot publish after Tasks is disposed; a recipe acquired during disposal is released so a replacement owner can register it.

`task.mark_failed` gives the producer/operator an explicit terminal exit with a reason. It closes any unfinished review in the same transaction, preserves evidence and prior verdicts, and records `task.failed`. Guidance lists this action without recommending it as ordinary progress. See [task closure and task versions](../../docs/TASK_CLOSURE.md).

## Work prerequisites

`task.create.dependsOn` accepts existing same-project work IDs (array, one ID, null
or omitted). Workflows owns the durable DAG and its completion checks. Tasks
declares `done` as success and gates producer context/checkpoints and delivery.
Creation, artifact retention, independent review and explicit withdrawal keep
their own rules. Failed prerequisites produce guidance rather than automatic
failure. Task reads include `dependencies` and `dependents`; assignment context
includes forward prerequisites, while reverse links remain live navigation data.
See [dependency behavior and parity](../../docs/WORK_ITEM_DEPENDENCIES.md).

`task.create` with `workspace: "git"` gives the producer a private Git checkout
and lets it deliver a commit in place of, or beside, files; the reviewer's leased
read-only checkout is pinned to that commit, and only that leased review, once its
runner has attached at that commit, can pass the task. Nobody else may claim such a
review until `review_rounds` is used up. `baseTaskId` bases the checkout on another Git task's accepted commit.
Code is bound optionally: only Git tasks ask for it. See
[delivering a commit](../../docs/STRUCTURED_TASK_EVIDENCE.md#delivering-a-commit).

See [structured task evidence](../../docs/STRUCTURED_TASK_EVIDENCE.md) for the versioned contract, server-generated briefs, binary references, stable context replay and remaining review work.

[Structured review assessments](../../docs/REVIEW_ASSESSMENTS.md) pin the verdict format, preserve explicit reviewer waivers and carry canonical findings into revision context. Guidance and commands use the same expected-revision and assessment guards.

## Workflow assignments

Tasks registers producer/reviewer assignments with Workflows and shares recipe preparation between full read-only previews and saved context. Eligible reviewers can inspect an open review before claiming it; saved context, checkpoints and verdicts still require their current claim. Operators retain assistance access but cannot submit another producer’s delivery. Task reads expose historical `workStarts`; these are not ownership claims. See [assignment and begin](../../docs/WORKFLOW_ASSIGNMENT_PLAN.md).

## Running page

`tasks.running` draws the Running page's work lane: a card for every task not yet done or failed, and for an ended one only while another owner holds its key there (a Code merge). `tasks.runningPanel` answers a task's sidebar: its ladder, what it waits on and unblocks, its goal and a brief a person wrote, its checks with the delivery's claims while they stand, and its producer. Both read one snapshot. `tasks.running` never evaluates guidance, so a card says the same to every reader: waiting comes from the prerequisites themselves, a task another plugin holds back reads `Waiting` rather than `Ready`, and red is kept for a failed prerequisite while the task is in progress, used review rounds until a reviewer claims the review by hand, a suspension, and (for operators) a review no independent reviewer can take. The sidebar's ladder is Workflows' own process read, the same one the task page serves. The task ui adapter registers both with `ctx.ui.contribute`; see [Running contributions](../../docs/UI_PLUGIN.md#running-contributions).
