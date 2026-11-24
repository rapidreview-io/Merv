# Research coordinator

Research coordinates existing work without owning agent execution. [Automatic mode](CONTINUOUS_RESEARCH.md) stitches the same workflows into a continuous run:

```text
defining → researching → complete
                       ↘ consolidating ⟲ → complete  (accepted code main lacks)
```

Every cycle uses `research@7`: pin the project definition from the paper's Problem when it leaves `defining`, wait for the selected work to end (failed and abandoned work counts as an outcome), then complete. Any non-terminal stage may also end `abandoned` or `failed` through `research.end`. Task and experiment execution prerequisites still require success. Earlier versions and the dedicated Consolidation workflow are retired, as described [below](#retired-versions). Once the selected work has ended, the cycle completes when the project's accepted code is all on main; otherwise it injects one ordinary Git task that integrates what main lacks and publishes it, and waits on that task's acceptance and on its publication reaching main. There is no workspace choice at creation. Experiment submissions include their paper changes, accepted by their existing scientific reviews; Research creates no Methods/Results child workflows.

Advancing from `researching` asks Code what main lacks (`code.acceptedSince`, a Git reading taken before the advance's transaction opens; quarantined acceptances are named on the `research.advanced` event and left out). Where the project is not hosted by Code, nothing can publish, and the cycle completes. Otherwise Research creates one service task (`tasks.serviceTasks('research')`, workspace git) titled `<cycle>: consolidation`, whose prerequisites are exactly those accepted units, so its base holds them and main; its goal asks for every experiment of the cycle to be accounted for as kept, adapted or dropped. The task is marked with `code.publishOnAcceptance` before its first lease, appended to the cycle's `integrations`, and attached as a child the cycle waits on. The cycle then moves to `consolidating`. Its review carries Code's contributor certificate, as a resolution's does: no writer of the accepted work it integrates, of a resolution its base needed, or of the task itself, and no authority that directed one of them, may claim it.

From `consolidating` the advance reads the newest consolidation task and its `CodeUnit.publication`:

| The task                 | Its publication                                       | The advance                                                                                                                                     |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| unfinished               | —                                                     | `dependencies_pending` (409): wait                                                                                                              |
| done                     | `published`                                           | completes the cycle                                                                                                                             |
| done                     | `stale` (main moved first)                            | `reinject`: a fresh `acceptedSince`, in which the stale task is itself a candidate, and a successor task; completes when main lacks nothing now |
| done                     | pending, setup_required, disabled, unsealed, incident | Code's own publication blocker (409), such as `code_publication_pending`: its message and the next move Code names                              |
| done                     | `closed` (pull request closed unmerged)               | completes the cycle without its code, recording the integration as abandoned                                                                    |
| done                     | none                                                  | `publication_pending` (409)                                                                                                                     |
| ended without acceptance | —                                                     | `integration_failed` (409) until the advance carries `retryIntegration: true`, which injects afresh, or completes when main lacks nothing       |

Every injected task is appended to `integrations`, newest last, so a cycle's consolidation history is on its record; `research.end` still ends the cycle from `consolidating`.

Research requires State, Scope, Workflows, Domain Events, Paper, Tasks, Experiments, Artifacts and Code Work: every composition that loads it loads them, and it is restarted with any of them. Research does not depend on Knowledge. Project-wide record/reference reads remain independently available through Knowledge.

Git answers which accepted units are missing outside the committing transaction. The retired Consolidation plugin is never required or loaded.

Child creation, dependency links, outer transition and replay receipt share one transaction. Request IDs reject different-input reuse. Owner/operator authorization and project scope apply throughout.

## Cycle digest and lineage

What a cycle decided is carried into the next one as a record, not as chat.

**Digest.** When a cycle reaches `complete`, or is ended with `research.end`, Research composes a `ResearchDigest` from records, retains it as one immutable `application/json` artifact titled `Cycle digest: <name>`, and stores the artifact's metadata in `research_cycles.digest`. The column is set once: the write is `UPDATE … WHERE digest IS NULL`, a trigger on both backends refuses any later change, and the stored value is re-read, so concurrent composers agree on one digest and the loser's artifact stays unreferenced. `research.get` returns it as `digest`, `workflow.status_and_next` lists it as a reference, and `research.digested` `{artifactId, late}` is recorded. Composition reads only selected task and experiment records from their owning providers; unrelated project work is not loaded. It preserves creation-time/ID order and runs inside the advancing or ending command, so a replay returns the same digest and writes nothing.

| Field             | Derived from                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `cycle`           | `id`, `name`, `outcome` (the terminal state), `reason`, `createdAt`, `composedAt`, `late`    |
| `previousCycleId` | The cycle this one follows                                                                   |
| `integration`     | The newest consolidation task and its publication state; null for a cycle that injected none |
| `experiments`     | Selected experiments: `state`, attempt and submission counts, `conclusion`                   |
| `tasks`           | Selected tasks: `id`, `title`, `state`                                                       |
| `dropped`         | Selected work that failed or was abandoned                                                   |
| `carriedOver`     | Selected work still unfinished                                                               |
| `omitted`         | How many list entries were left out to keep the bound                                        |

A digest is `formatVersion: 2`; format 1 digests, written by `research@6` cycles, also carry `reflection` and `rejected` and are kept as written. Free text is clipped to 300 characters and each list to 100 entries; then entries are removed from the longest list until the digest is at most 12,000 characters, so it fits beside an assignment's other context. The digest contains no actor ID and is never pinned review evidence, so it changes nothing about reviewer independence. Work dropped by `research.replan` is not recorded.

**Never a guard.** A digest checks nothing: `research.end` and the completing advance compose it in their own transaction from the records as they are. Digests written before version 6 carry a `consolidation` reference and per-experiment consolidation decisions; they are retained artifacts and are never re-parsed. Older digests may also carry `claims`, `openQuestions` and per-experiment `testedClaimIds` from before research claims were retired.

**Following a cycle.** `research.create` accepts `previousCycleId`. The predecessor must be in this project (`research_not_found`, 404), must be `complete`, `abandoned` or `failed` (`previous_cycle_open`, 409) and must not already have a successor (`previous_cycle_followed`, 409; storage allows one successor per cycle). The link is kept in the immutable `predecessor_id` column and returned as `previousCycleId`; the predecessor reads it as `successorId`, and `workflow.status_and_next` lists it as a reference. Leased sessions remain refused. `research.created` carries `previousCycleId`.

**Late composition.** If the predecessor has no digest because it ended before digests existed, it is composed in the creating transaction and marked `cycle.late: true`. A late digest reads work as it is when composed, not as it was when the cycle ended. Any project writer may cause this, not only the predecessor's owner or an admin: the digest is composed by the server from records the caller can already read, nothing the caller supplies reaches it, and it can be written only once. A cycle ended before this change kept its `reason` only as check input and in the `research.ended` event, so its late digest has `reason: null`; cycles ended since keep the reason, clipped to 2000 characters, in workflow data.

**Reaching the next cycle.** The digest is never pushed into an assignment. Task and experiment workers do not receive it automatically: tasks and experiments carry no link to a cycle, and a new section would mean new versions of every task type and experiment recipe. They reach it through `research.lineage` and `artifact.read`, which any project reader, leased sessions included, may call; an owner can also hand the digest to a task through an existing custom `contextInputs` section.

**`research.lineage`** is read-only. Given a `researchId`, it returns the cycles it follows, oldest first and ending with the cycle asked about — each with `id`, `name`, `state`, `createdAt`, `previousCycleId`, child IDs and `digest` — walking back at most 20 cycles (`truncated: true` when the chain goes on), and the `successor` that follows it, if any.

## Retired versions

Published Research definitions remain immutable; every new cycle uses version 7 and consolidation tasks. Creation
refuses the obsolete `consolidationWorkspace`, `consolidationDependsOn` and `maxCycles` inputs, and `research.advance` no longer takes `nextWave`.

`research@6` cycles reflected: a five-lens reflection wave sat between researching and completion, and an approved plan could open the next wave of tasks and experiments with a successor cycle. That model is removed with the Reflections plugin. The `research@10` migration refuses to run while any reflection wave, lens or `research@6` cycle is still open, or a live session still serves a wave or lens; it then drops the reflections tables, their guard functions and migration rows, the blockers those cycles published, and the `research_automation` columns only plan successors wrote (`root_id`, `cycle_index`, `max_cycles`). `research_cycles.reflection_id` stays, unwritten, because the published retirement ledger reads it. Finished waves, lenses and `research@6` cycles stay as history in Workflows, read through their pinned definitions, with their reviews, sessions and artifacts. `ResearchRecord` no longer has `reflectionId` or `origin`.

`research@2`–`5` can no longer start, so they are no longer registered. The `research@7`
migration deleted their cycles, automation rows and command receipts; the `reflection@3` wave
each had opened as its reflecting stage went with them (`reflections@2`). Their ids stay listed in
`wf_retired_instances` (reasons `retired_version` and `stage_of_retired_research`), and the
`events` log still names them; their artifacts, digests included, are kept. A surviving cycle
that followed a retired one no longer has a `previousCycleId`, and an automatic run rooted in
a retired cycle is rooted at its earliest surviving cycle instead. Code keeps the acceptances
of retired Git experiments as history; what main lacks leaves them out, since no consolidation
task can depend on an instance that no longer exists. `research.get` and
`research.lineage` no longer return `consolidationId`. The same migration dropped the tables,
guard functions and migration receipts the retired Consolidation plugin had left behind. The
published definitions of the retired versions stay pinned in `wf_definitions`.

Existing `research@1` records and their standalone-writing child references remain historical records. The coordinator does not reinterpret or auto-complete an unfinished version-1 cycle. Start a new cycle using retained scientific work as explicit prerequisites when resuming that older model.

## What a cycle cost

A cycle attaches its children as dependencies, so a cycle's usage is the rollup over its
dependency closure: `usage.read` with the cycle's id covers its tasks, experiments and
consolidation. A cycle budget is set the
same way, with `usage.set_budget` on the cycle's id, and pauses automatic dispatch for the
work inside that closure only. Work never attached to the cycle is outside both. A cycle does not depend on the cycle it
follows, so a successor's usage and budget never include its predecessor's: read each
cycle of `research.lineage` by its own id. Work two cycles both select is a dependency of
each, so it is counted in each. A digest records no usage, because
sessions may still report after the cycle ends. See
[loop limits, usage and budgets](BUDGETS_AND_LIMITS.md).
