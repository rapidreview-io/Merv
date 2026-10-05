# Task program

A Cordis program implementing the durable task/delivery/review loop. Requires `state`, `scope`, `artifacts`, `workflows`, `reviews`, and `contextBuilder`; provides `tasks`. Core code has no dependency on transport or the tool registry.

Tasks registers its action checks and descriptions with Workflows. `task.get` and
`task.list` include caller-specific `guidance`; `workflow.status_and_next` returns
the same evaluated decision. The required task section carries it into every
context recipe, and the task UI displays it. Delivery/reissue/verdict commands
enforce those registered checks inside their transaction. See
[workflow guidance](../../docs/WORKFLOW_GUIDANCE.md).

Tasks registers only the contracts current creation selects: ordinary managed-Git work at `task@39`/`43` (small/large uploads), on which Sandboxes attaches native compute, and conflict-resolution service work at `task@6`/`11`. Service work suspends where ordinary work fails and adds `revise_suspended` and `resume`. Numeric versions identify immutable implementation contracts, not retry counts.

Other stored versions remain read-only history: records, evidence, verdicts, context packages and pinned graphs are retained. Their runtime implementations are not registered, so they cannot dispatch or accept new contexts, checkpoints, claims or submissions. No old record is upgraded into another contract. The program retains private registration handles; generic workflow tools cannot bypass task gates.

- **Create:** render and pin the goal and numbered checks as an immutable brief, or validate a compatible producer-supplied text brief. The current actor owns the task. Brief and goal fields are immutable.
- **Submit delivery:** the producer supplies immutable artifacts and the current task revision. Every task requires a structured confirmation for every numbered check, with evidence references and verification notes. Merv pins a generated assessment alongside the evidence. The task enters `in_review` and a review request pins the brief plus delivery manifest in the same transaction.
- **Reissue review:** the producer or project operator can replace an unavailable or revoked reviewer’s open claim with a reason and expected revision. This supersedes the old request, advances the task revision, and pins the same evidence in a new request atomically. Prior reviewers cannot submit against the replacement.
- **Submit review:** the actor who independently claimed the current review supplies a verdict and the pinned task revision, with a synopsis and per-criterion findings. Passing outcomes prefer structured evidence.outcome, then synopsis, then legacy notes. `pass` routes to `done`, `needs_changes` returns to `in_progress`, and `fail` routes to `failed`. Verdict, workflow transition/history, task events, and request deduplication commit or roll back together.

Confirmation coverage and evidence references are structural gates; the independent reviewer evaluates whether the submitted evidence actually meets the checks. Review notes become the workflow's outcome or revision context. A revised delivery receives a new review request; prior evidence and verdicts remain readable.

Task command request IDs are scoped to actor and project. An identical retry returns its originally committed response; different input under the same ID is rejected. `expectedRevision` always means the task workflow revision.

The optional `taskToolsPlugin` installs `task.create`, `task.get`, `task.list`, `task.context`, `task.checkpoint`, `task.submit_delivery`, `task.reissue_review`, and `task.mark_failed`. Reviews owns the generic `review.submit` tool. Tasks registers its submit-owner callback from the service lifecycle, identifies its subjects from durable Task records, and applies the existing Task command in the dispatcher's transaction. Historical submissions remain owned so successful retries retain their original response.

Disposal withdraws the review owner before suspending Tasks and draining its dependent tools, then releases workflow and context registrations after that drain. The generic review tool refuses missing ownership during unload. Durable tasks, verdicts and versioned workflow definitions remain available after restoration.

Task types and context references are pinned at creation. Tasks registers its versioned recipes, `TASK_TYPES`, directly with Context Builder: a task created under a retired `task.work` or `project.reflection` version renders with its format-2 successor, and every task is reviewed with `task.review@5`. Reflections registers `ITEM_RECIPES` the same way; a reflection is a typed task assignment over explicitly supplied artifact inputs and the ordinary delivery/review workflow, with no automatic corpus search, multi-agent workflow or Runner of its own. `task.context` checks current ownership, revision and review claim before building an immutable package. `task.checkpoint` saves attributed, immutable progress for the current assignment. Both are replayable; stale or revoked claims are refused. Producer identity stays historical attribution. See [recipes, required inputs and recovery behavior](../../docs/RECOVERY_AND_CONTEXT.md).

Creation and type registration copy their inputs before asynchronous work. A type registration cannot publish after Tasks is disposed; a recipe acquired during disposal is released so a replacement owner can register it.

`task.mark_failed` gives the producer/operator an explicit terminal exit with a reason. It closes any unfinished review in the same transaction, preserves evidence and prior verdicts, and records `task.failed`. Guidance lists this action without recommending it as ordinary progress. See [task closure and task versions](../../docs/TASK_CLOSURE.md).

## Work prerequisites

Tasks owns no compute. Sandboxes attaches native compute to a leased assignment where the project has a funded
connection: `execute` for work, `check` for review. Conflict-resolution service tasks declare
`computeProfile: 'none'`. The assignment carries the guidance from
`@merv/sandboxes/compute-capability`, and delivery admits the capture collections Sandboxes
verified for the task. See [compute as an assignment capability](../../docs/COMPUTE_CAPABILITY.md).

`task.create.dependsOn` accepts existing same-project work IDs (array, one ID, null
or omitted). Workflows owns the durable DAG and its completion checks. Tasks
declares `done` as success and gates producer context/checkpoints and delivery.
Creation, artifact retention, independent review and explicit withdrawal keep
their own rules. Failed prerequisites produce guidance rather than automatic
failure. Task reads include `dependencies` and `dependents`; assignment context
includes forward prerequisites, while reverse links remain live navigation data.
See [dependency behavior and parity](../../docs/WORK_ITEM_DEPENDENCIES.md).

Every new `task.create` uses the project's managed Git repository. The producer
receives its own checkout and delivers a retained commit, with optional artifacts;
the independent reviewer receives that exact commit read-only. An unchanged-source
delivery may retain the existing commit. GitHub credentials are not needed.
Code is required for creation; storage failure blocks work instead of selecting a
scratch workspace. Use `dependsOn` for accepted code dependencies. The retired
`baseTaskId` and scratch policies remain readable for existing work only. See
[managed Git](../../docs/ALWAYS_GIT.md) and
[delivering a commit](../../docs/STRUCTURED_TASK_EVIDENCE.md#delivering-a-commit).

See [structured task evidence](../../docs/STRUCTURED_TASK_EVIDENCE.md) for the versioned contract, server-generated briefs, binary references, stable context replay and remaining review work.

[Structured review assessments](../../docs/REVIEW_ASSESSMENTS.md) pin the verdict format, preserve explicit reviewer waivers and carry canonical findings into revision context. Guidance and commands use the same expected-revision and assessment guards.

## Workflow assignments

Tasks registers producer/reviewer assignments with Workflows and shares recipe preparation between full read-only previews and saved context. Eligible reviewers can inspect an open review before claiming it; saved context, checkpoints and verdicts still require their current claim. Operators retain assistance access but cannot submit another producer’s delivery. Task reads expose historical `workStarts`; these are not ownership claims. See [assignment and begin](../../docs/WORKFLOW_ASSIGNMENT_PLAN.md).

## Running page

`tasks.running` draws the Running page's work lane: a card for every task not yet done or failed, and for an ended one only while another owner holds its key there (a Code merge). `tasks.runningPanel` answers a task's sidebar: its ladder, what it waits on and unblocks, its goal and a brief a person wrote, its checks with the delivery's claims while they stand, and its producer. Both read one snapshot. `tasks.running` never evaluates guidance, so a card says the same to every reader: waiting comes from the prerequisites themselves, a task another plugin holds back reads `Waiting` rather than `Ready`, and red is kept for a failed prerequisite while the task is in progress, used review rounds until a reviewer claims the review by hand, a suspension, and (for operators) a review no independent reviewer can take. The sidebar's ladder is Workflows' own process read, the same one the task page serves. The board draws only what a task waits on, so what waits on it is the sidebar's to read, and the prerequisites and review rounds of every task are each read once for all of them (`workflows.prerequisites`, `workflows.limitStatusOf`); a review a task names and Reviews does not hold leaves that card without it rather than the lane empty. The task ui adapter registers both with `ctx.ui.contribute`; see [Running contributions](../../docs/UI_PLUGIN.md#running-contributions).
