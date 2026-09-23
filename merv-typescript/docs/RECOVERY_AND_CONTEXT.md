# Durable recovery and task-type context recipes

Implemented on 2026-09-14. Two new Cordis services: Domain Events and Context Builder. No task-context adapters were added. Runner/agent scheduling remains a separate future component.

## Responsibilities and dependencies

- Domain Events → State. Owns durable event delivery, progress, retries and lifecycle registration.
- Reviews → State, Scope, Artifacts, Domain Events. Owns claim release and independent verdicts.
- Context Builder → State, Scope, Artifacts. Owns versioned recipe registration, assembly and persisted context packages.
- Tasks → State, Scope, Artifacts, Workflows, Reviews, Context Builder. Owns task types, assignment checks, recipes and checkpoints.

Arrows mean a declared dependency. Publishers continue appending events through State, so revocation works with delivery disabled. Cordis unloads affected consumers and tools when a required provider is removed.

## Revocation and recovery

Scope commits `active=false` and `actor.revoked` together. Subsequent authorization checks immediately reject the actor. Reviews' durable consumer eventually releases that actor's unfinished claims. Its database changes, a `review.claim_released` event and delivery progress commit together. Failed delivery rolls back and retries; unload/restart retains pending events.

Recovery changes the review from `started` to `requested`, clears its current reviewer/claim ID and records the cause. The review ID, pinned evidence, criteria, snapshot hash and task workflow revision stay the same. Completed verdicts and historical claim events are retained. Actor attribution and task producer identity are not reassigned.

`review.start` returns a fresh `claimId` and increasing `claimGeneration`. `review.submit` now requires that exact claim ID in addition to the current task revision and active reviewer identity. This is an intentional client-contract change: update clients to retain `review.start`'s result. Existing started reviews migrate to stable `legacy:<reviewId>` claim IDs, obtainable through `review.get`. Manual `task.reissue_review` remains available for other recovery cases and still creates a new review/revision.

## Context formulas belong to task types

| Type                   | Required context                                              | Output                                                             |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `task.work@1`          | Authoritative task and pinned brief                           | Evidence-backed task delivery                                      |
| `experiment.plan@2`    | Task, brief, `research`, `constraints`                        | Experiment plan, with its feasibility stated, submitted for review |
| `project.reflection@1` | Task, brief, `experiments`, `projectKnowledge`                | Reflection on the explicitly selected corpus                       |
| `task.review@1`        | Task, claimed assessment, pinned evidence and task background | Independent verdict                                                |

`previousReflection` is optional for reflection. Relevant revision feedback, saved checkpoints and checkpoint evidence are optional background where included by the recipe. Review recovery cause is also retained in its required assessment record. Context Builder never guesses which experiments or papers to select.

Create planning/reflection work through `task.create`, supplying `type`, optional `typeVersion` (default 1), and `contextInputs`, a mapping from the named recipe sections to immutable artifact IDs. Plain tasks default to `task.work@1`. Review context is selected by the existing task's review assignment; it is not a second manually created task.

New `experiment.plan` tasks start on version 2. Merv appends one feasibility check to their checks and rendered brief — what the plan requires against what exists, every dependency and no known blocker — and names it in the delivery review's `requiredCriteria`, so that review cannot waive it. A caller's own `briefId` must contain the check. `experiment.plan@1` was retired on 2026-09-22 together with its tasks; a new task asking for it is refused with `task_type_unavailable`. The experiment program's own recipes (`experiment.design`, `experiment.design_review`, `experiment.execute`, `experiment.attempt_review`) are at version 9; every registered experiment version requires a feasibility statement and holds its review to the feasibility criterion.

```json
{
  "title": "Design a controlled comparison",
  "goal": "Test the proposed improvement.",
  "checks": ["Define the controls."],
  "briefId": "artifact_brief",
  "type": "experiment.plan",
  "contextInputs": {
    "research": ["artifact_prior_findings"],
    "constraints": ["artifact_constraints"]
  },
  "requestId": "create-plan-1"
}
```

The brief must still contain the goal and each Done-when check. Required recipe inputs must be present and accessible at creation. The task pins its type version and context references. Additional types register directly through `ctx.tasks.registerType(definition)`; disposal withdraws that type's recipe handle. Work recipes must require `task` and `brief` sections. There is no separate plugin per recipe.

## Rework history

A producer returning to rejected work is shown every earlier rejected round, not only the last one. The rounds were always stored; what changed is the projection. `reviewHistory()` in Contracts turns the rejected reviews of one subject, oldest first, into a bounded `ReviewHistory`:

```ts
interface ReviewHistory {
  rounds: ReviewRound[];
  omittedRounds: number;
}
interface ReviewRound {
  round: number; // 1-based among all rejected rounds, oldest first
  reviewId: string;
  subjectRevision: number;
  label?: string;
  verdict: 'needs_changes' | 'fail';
  returnTo?: string;
  synopsis: string | null;
  unmet: {
    criterionNumber: number;
    criterion: string;
    status: 'not_met' | 'not_verified';
    notes: string;
  }[];
  notes: string | null;
}
```

Passed and unsubmitted reviews are left out. Notes are clipped to 800 characters, finding notes to 300 and criterion text to 200. No actor ID is copied: a history says what was rejected and why, never who said so. When the rounds exceed the domain's budget the oldest are dropped first and counted in `omittedRounds`; the latest round is always kept. Each `reviewId` can be opened in full with `review.get`.

| Domain        | Where the history appears                                              | Budget |
| ------------- | ---------------------------------------------------------------------- | ------ |
| Reflections   | Its own optional `history` section, after `feedback`                   | 6000   |
| Tasks         | Appended to the `feedback` text as "Earlier review rounds"             | 4000   |
| Experiments   | `feedback.history`, labelled `<stage> attempt N round M`               | 8000   |
| Consolidation | Unchanged: its `feedback` section already carried every rejected round | —      |

Context Builder never truncates: an optional section that does not fit is left out whole and named in `omitted`. That is why reflections, whose recipes changed version anyway, give the history a section of its own after `feedback`, so the latest review wins the budget. Tasks and experiments keep it inside `feedback` under a small budget instead of publishing new recipe versions; there, an oversized `feedback` section is omitted whole, latest assessment included, and the worker reads `feedback` in `omitted` and opens the review with `review.get`.

Only producers are shown a history. Reflection reviewers, experiment design and result reviewers and task reviewers judge the submission in front of them and are shown no earlier verdicts.

A task remembers its rejected rounds in `workflow.data.rejectedReviewIds` (at most the last 50), appended by each `needs_changes` or `fail` and left untouched by a pass. `revisionContext` keeps its meaning: the notes of the latest rejection. A task already in rework when this was introduced has no such list; its first later rejection seeds it with the review that put it into rework, and until then its context uses the current review alone.

## Context and checkpoints over MCP/HTTP

`task.context` takes `taskId`, `purpose` (`work` or `review`), `expectedRevision`, `requestId`, and a required current `claimId` for review work. It returns the complete persisted context package. Work context requires the task producer or a project operator. Review context requires the current independent reviewer. The read/claim checks and package write share one transaction.

`task.checkpoint` takes the same assignment identity plus nonempty `notes` (up to 16,000 characters) and optional `artifactIds` (up to 50). It saves immutable, attributed progress and an event. It is not a delivery or verdict. Reviewers can save review notes without gaining permission to create/modify producer evidence.

Context includes up to the latest 20 relevant checkpoints, subject to the recipe's optional-background budget. Work checkpoints retain their recorded revisions. Review checkpoints must belong to the same review and subject revision; an old claim's notes are labeled unverified progress. Missing required context or oversized required evidence fails clearly. Omitted optional sections are listed in the returned package.

A replacement reviewer claims the released review, calls `task.context` with the fresh claim ID, continues independent verification from the saved context, and submits a verdict with that same claim ID. Old context remains auditable but does not make an old claim valid again. Authoritative state must be checked again by any future Runner at launch.

## Delivery guarantees and current limits

The dispatcher runs in-process and awaits each handler, with persisted per-consumer progress, isolated retries and explicit starting positions. A handler’s effects and its cursor commit in one transaction. State retains the full event history. Status is available through `ctx.domainEvents.status()`. Remote cancellation, agent spawning, time-based work leases, OAuth and shared-login rollout are not part of this implementation. Access revocation blocks new dispatches; an already-dispatched remote operation may finish.

Recipe versions and complete context packages are retained in SQLite. Context assembly reads pinned UTF-8 artifacts; version 2 task review/checkpoint evidence can also include retained binary references through explicit auto mode; it does not automatically capture an agent's conversation, unsaved files or private reasoning. Recipes use explicit character budgets rather than unverified token estimates.

No Fable consultation was performed for this implementation, following the user's instruction.

Task evidence and stable assignment-context replay have since been extended; see [structured evidence](STRUCTURED_TASK_EVIDENCE.md). New context request IDs refresh progress, while retries preserve the original snapshot after current authorization is rechecked.
