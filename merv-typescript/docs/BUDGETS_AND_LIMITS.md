# Loop limits, usage and budgets

Two things used to be unbounded: how often a review could send work back, and what a
research cycle was allowed to cost. Both now have a bound that the server enforces, a
visible reason when the bound is reached, and a human act that lifts it. Neither ever fails
work or stops anything that is running.

## Loop limits

A program declares its caps on the `WorkflowPolicy` it registers:

```ts
limits: [{ name: 'review_rounds', from: 'in_review', actions: ['revise'], max: 3 }];
```

`max` is the number of times the named edges leaving `from` may be traversed by one
instance, summed over the actions. An edge belongs to at most one limit. A limit may not
cover a self-edge, an edge out of a terminal state, or an action name the engine writes
into history itself (such as `upgrade`).

The cap is **policy, not definition**. The graph JSON is fingerprinted and pinned per
version, so a cap written there would force a new version and an upgrade of every live
instance for a number operators need to tune. A limit on the policy governs every live
instance of every registered version at once, and the engine counts from the `wf_history`
rows it already writes, so there is no counter to keep in step. The consequence is
deliberate and worth knowing before a deploy: **lowering a cap escalates live instances
that are already over it**, retroactively, the moment the new server starts.

### What happens at the cap

- The transition is refused inside the committing transaction with `loop_limit_reached`
  (409), before the owning rule's guard, so the distinct code is what the caller sees. The
  whole command rolls back, including the review that would have returned the work.
- `workflow.status_and_next` reports `limits[]` for the current state (`base`, `granted`,
  `max`, `used`, `remaining`, `exhausted`). At an exhausted limit the gate and first
  blocker are `loop_limit_reached`. The uncapped actions stay available: a human reviewer
  can still accept or fail the work, and an experiment can still be abandoned.
- The project overview lists the instance under `escalated`, and under neither `ready`
  nor `blocked`. Work stalled on a failed dependency stays `stalled`, the stronger reason.
- `dispatchCandidates()` leaves escalated instances out, so automatic dispatch does not
  lease a reviewer for them. A reviewer leased at that point could only have a
  `needs_changes` verdict refused and rolled back, and the next poll would lease another.
- One `workflow.escalated` event is recorded when an instance arrives in the capped state
  with the limit used up. Reads never record it, and a self-edge such as a reissued review
  does not repeat it.

So a default of three review rounds means **three returns, after which the fourth
delivery waits for a human**. That person either reviews it by hand, or grants one more
round, which buys exactly one more automated review.

### Allowing more rounds

`workflow.extend_limit { instanceId, limit, additional, reason, requestId }` is for a
project admin who is not a leased worker; a session is refused with 403. It appends a row
to `wf_limit_grants` (immutable on both backends) and records `workflow.limit_extended`.
It changes neither the instance nor its revision, so pinned reviews and dispatch
revisions stay valid, and it adds no history row: history is transitions, and the grant
table is the record of grants. It is idempotent by `requestId` and input; the same
`requestId` with different input is a `request_conflict`. Grants add up. A grant only ever
raises a cap, so a grant racing a transition is benign.

### Defaults

Each is plugin configuration, an integer from 1 to 1000.

| Plugin      | Config key             | Default | Limit            | Capped edges                                            |
| ----------- | ---------------------- | ------- | ---------------- | ------------------------------------------------------- |
| tasks       | `limits.reviewRounds`  | 3       | `review_rounds`  | `in_review` → `revise`                                  |
| experiments | `limits.designRounds`  | 4       | `design_rounds`  | `design_review` → `revise_design`                       |
| experiments | `limits.resultRounds`  | 3       | `result_rounds`  | `experiment_review` → `revise_plan`, `revise_execution` |
| reflections | `limits.reviewReturns` | 2       | `review_returns` | `in_review` → `revise_synthesis`, `restart_lenses`      |

Only a reflection's parent workflow is capped; a lens has one way forward. The research
cycle has no loop and no limit. Task `reissue_review` and the experiment `retry_running`
self-edge are not capped: blocking them could strand a review or stop a permitted retry.

## Usage

Sessions writes one `session_usage` row in the transaction that closes a session, for
every session and every way of closing: instance, revision, workflow, state, role,
outcome, platform harness and model from the dispatch receipt, and `wall_ms`. The table
accepts no delete; identity and timing columns accept no update; after a report lands the
row accepts no update at all. Sessions closed before the migration have no row and are not
backfilled: `accounting.since` says when counting began.

`wall_ms` is **lease wall-clock**, from activation to close. A session that was never
activated records 0. For an expired session the close is stamped by the sweep that found
it, so the figure can include dead time up to the expiry window; it is not process time.

### The runner's report

The release route accepts an optional `usage` object: `inputTokens`, `outputTokens`,
optional `costUsd` and `model`, a closed shape of non-negative numbers. The first report
stored for a session is kept and `session.usage_reported` is recorded once, attributed to
`system:sessions`. A later or different report is dropped without an error, because a
runner retries a release whose reply it lost and must never be stuck on it. This is
first-wins idempotency, not `requestId` idempotency, the same as the release it rides on.
A session its own handoff already closed still accepts its report; that is the ending
almost all real usage has.

The machine runner sets `MERV_USAGE_FILE` in the launched process's environment, pointing
at `usage.json` in that launch's private run directory, and removes any file left there
before it starts the process. The convention is vendor-neutral: a profile's wrapper (or
the process) writes the JSON shape above, and Merv parses no harness output. When the
launch is over, however it ended, the runner reads the file if it is a regular file of at
most 4 KB in exactly that shape and sends it: with the release when the process ended
first, and on its own when the server had already closed the session. The ledger records
that the report was answered, so it is retried across restarts until then. A missing or
malformed file sends nothing.

### Reading it

`usage.read` is read-only and open to any project reader, **including a leased worker**,
because a reflection lens has to be able to say what a cycle cost. With no input it rolls
up the project. With `instanceId` it rolls up that instance, everything it transitively
depends on, and the children their policies declare: a reflection names its lenses of
every attempt, which no dependency edge does. A research cycle's id therefore gives the
cycle. `includeDependencies: false` reads the one instance alone. `scope.instanceCount`
says how many instances were covered (the walk stops at 5000).

The result carries `totals`, `byWorkflow`, `byInstance` (the fifty with the most
wall-clock), `liveSessions`, the `budgets` in force for the scope, and `accounting`.
`reportedSessions` of `sessions` says how many sessions reported; token and cost sums cover
only those. `toolCalls` and `toolPayloadTokensEstimate` come from the
[tool-call observations](AGENT_CONTINUITY.md) and are payload sizes, not model usage. A
cycle's figure follows the current dependency edges: work never attached to the cycle is
not in it, while the project figure is complete.

## Budgets

`usage.set_budget { instanceId?, maxWallMinutes?, maxCostUsd?, maxTokens? }` is for a
project admin who is not a leased worker. Without `instanceId` it sets the project budget;
with it, a budget over that instance's closure, so a cycle budget is set on the cycle's
id. `null` clears a dimension and an omitted one is kept. It is a state-set command like
the dispatch switch: idempotent by value, not by `requestId`. Setting what is already set
records nothing; a change records `session.budget_changed`.

A dimension is reached when usage is at or over its bound. Nothing about being over is
stored: budgets are measured when they are read, so raising or clearing one resumes
dispatch on the next poll.

**A reached budget only pauses automatic dispatch.** A reached project budget answers every
lease request with `budget_exceeded`. A reached instance budget withholds the candidates
inside its closure, and other work is still offered. Running sessions are not closed,
shortened or halted, a person can still begin work by hand, and explicit offers are
unchanged. Budgets count closed sessions, so the overshoot is bounded by the sessions live
when the bound was crossed.

Trust boundary: **wall-clock is the dimension Merv measures itself.** Cost and tokens are
whatever wrote the usage file, which may be the agent process; they can be wrong in either
direction, so a forged report can pause dispatch early or never trip a cost budget. The
pause is visible (`budgets[]`, the runner's last decision) and an admin reverses it.

## Launch retry cap

Failed launches on one instance revision used to be retried for ever, thirty seconds
apart. Sessions config `maxLaunchFailures` (1 to 100, default 5) ends that. Each failed
attempt bumps one counter row per instance and revision in `session_dispatch_holds`
(session_dispatch 4), across every runner and platform of the project. An attempt is a
session that closed as `host_failed`, `crash_loop`, `workspace_failed`, `launch_failed` or
`stalled`; an offer that lapsed before any process activated it (`offer_expired`); or an
offer that could not be built at all, which leaves no session and is counted in its own
transaction after the lease rolled back. An expiry after activation does not count,
because that is also how long honest work ends, and neither does a refusal of who asked
(401, 403, or a lost race with another lease or a control change).

At the cap the row is held, `session.dispatch_held` is recorded once, and automatic
dispatch stops offering that target. The thirty-second backoff is unchanged and outranks
the hold: a runner is told `retries_exhausted` only when no candidate that could still be
tried remains. The status read reports `retriesExhausted`, the number of queued items
withheld this way. A hold gates automatic dispatch only: a person may still offer the
target by hand, and a failure of that session counts like any other.

A held target waits for a human, and `session.stuck` lists it as `dispatch_held` with its
last failure ([stuck work and dispatch holds](RUNNER_CONTROL_PLANE.md#stuck-work-and-dispatch-holds)).
A project admin who is not a leased worker calls
`session.release_hold` with the instance, its revision, a reason and a `requestId`; the count
restarts, `session.hold_released` is recorded, and the same request replays the same
answer. Switching automatic dispatch off and on is the same go-ahead for **every
instance in the project**. A new revision of the instance starts a fresh count, because a
hold names one revision; ending or revising the record is how to decide not to run it.

## What Merv cannot know

- Tokens, cost and model are self-reports. Merv verifies none of them and derives no cost
  from a price table.
- Model context, reasoning usage and provider billing are invisible to it.
- Anything done outside a Merv-launched process, and any session closed before this
  feature was installed, is not counted.
- Live sessions are counted as `liveSessions`, not yet as wall-clock.
- Wall-clock is a lease's duration, which can outlast the process that held it.
