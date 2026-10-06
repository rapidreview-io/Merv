# Research coordinator

Research coordinates existing work without owning agent execution. [Automatic mode](CONTINUOUS_RESEARCH.md) stitches the same workflows into a continuous run:

```text
defining → researching → reflecting → complete
                                  ↘ consolidating ⟲ → complete  (accepted code main lacks)
```

Every cycle uses `research@6`: pin the project definition, wait for the selected work to finish (including failure or abandonment), and create a five-lens reflection. Task and experiment execution prerequisites still require success. Versions 2–5 and the dedicated Consolidation workflow are retired, and their records deleted, as described [below](#retired-versions). Once the reflection is independently approved, the cycle completes when the project's accepted code is all on main; otherwise it injects one ordinary Git task that integrates what main lacks and publishes it, and waits on that task's acceptance and on its publication reaching main. There is no workspace choice at creation. Experiment and reflection submissions include their paper changes, accepted by their existing scientific reviews; Research creates no Methods/Results child workflows.

Research calls the same `Reflections.create` that Reflections' `reflection.create` tool calls when it advances a research cycle into reflection. A wave's workers read live research through their fixed tool grants (`project.records`, `task.get`, `experiment.get_state`, `paper.read`), so removing Research changes nothing they may read and neither unloads Reflections nor interrupts its assignment, lease or submission lifecycle. Project scope, lens independence and write restrictions remain authoritative.

Advancing from reflection verifies its exact independent approval, then asks Code what main lacks (`code.acceptedSince`, a Git reading taken before the advance's transaction opens; quarantined acceptances are named on the `research.advanced` event and left out). Where the project is not hosted by Code, nothing can publish, and the cycle completes. Otherwise Research creates one service task (`tasks.serviceTasks('research')`, workspace git) titled `<cycle>: consolidation`, whose prerequisites are exactly those accepted units, so its base holds them and main; its goal asks for every experiment of the cycle to be accounted for as kept, adapted or dropped, and ends with the provenance line naming the reflection, its report and its change specification. The task is marked with `code.publishOnAcceptance` before its first lease, appended to the cycle's `integrations`, and attached as a child the cycle waits on. The cycle then moves to `consolidating`. Its review carries Code's contributor certificate, as a resolution's does: no writer of the accepted work it integrates, of a resolution its base needed, or of the task itself, and no authority that directed one of them, may claim it.

From `consolidating` the advance reads the newest consolidation task and its `CodeUnit.publication`:

| The task                 | Its publication                                       | The advance                                                                                                                                     |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| unfinished               | —                                                     | `dependencies_pending` (409): wait                                                                                                              |
| done                     | `published`                                           | completes the cycle, applying the next-wave choice                                                                                              |
| done                     | `stale` (main moved first)                            | `reinject`: a fresh `acceptedSince`, in which the stale task is itself a candidate, and a successor task; completes when main lacks nothing now |
| done                     | pending, setup_required, disabled, unsealed, incident | Code's own publication blocker (409), such as `code_publication_pending`: its message and the next move Code names                              |
| done                     | `closed` (pull request closed unmerged)               | completes the cycle without its code, recording the integration as abandoned                                                                    |
| done                     | none                                                  | `publication_pending` (409)                                                                                                                     |
| ended without acceptance | —                                                     | `integration_failed` (409) until the advance carries `retryIntegration: true`, which injects afresh, or completes when main lacks nothing       |

Every injected task is appended to `integrations`, newest last, so a cycle's consolidation history is on its record; `research.end` still ends the cycle from `consolidating`.

Research requires State, Scope, Workflows, Domain Events, Paper, Reflections, Tasks, Experiments, Artifacts and Code Work: every composition that loads it loads them, and it is restarted with any of them. Research does not depend on Knowledge. Project-wide record/reference reads remain independently available through Knowledge.

Git answers which accepted units are missing outside the committing transaction. The retired Consolidation plugin is never required or loaded.

Child creation, dependency links, outer transition and replay receipt share one transaction. Request IDs reject different-input reuse. Owner/operator authorization and project scope apply throughout.

## Next wave

Automatic handoffs and a bounded number of successor cycles are implemented; see [Continuous research](CONTINUOUS_RESEARCH.md). Provenance-based exclusion of plan authors from future production and a shared cross-cycle cost budget are separate work. Experiment feasibility is checked by the experiment design workflow.

Synthesis may submit its change specification as a structured plan (see [Reflections](REFLECTIONS.md#structured-change-specification)). Once that reflection is independently approved, the advance that reaches `complete` — `reflecting → complete` when main holds the cycle's accepted code, `consolidating → complete` once the consolidation task is published — can create the plan as records. The handoff from reflection into consolidating is not a completion: it creates nothing of the plan, and because the preflight cannot ask Git, it still asks for `nextWave` when the plan continues; the answer is asked again at completion. Main is therefore the base of every next wave.

**Manual advances require an explicit choice.** When the approved plan's decision is `continue`, that advance requires `nextWave`. For a cycle created with `automatic: true`, Research supplies this choice under the captured owner authorization: create within the cycle limit, skip at the limit. `workflow.status_and_next` reports the action as `needs_input` naming `nextWave`, and a `research.advance` without it is refused with `next_wave_choice_required` (400). A client written before plans existed therefore never creates agent-planned work unknowingly.

- `nextWave: "create"` creates every task and experiment of the plan in dependency order, then opens one successor research cycle, named by the plan, that waits on the created work and the plan's carried-over work. The successor starts in `defining` on the current research version; the owner advances it as usual in manual mode; automatic successors inherit the original authority and remaining cycle allowance and advance on durable events. Created tasks are dispatched like hand-created ones as soon as the advance commits.
- `nextWave: "skip"` completes the cycle and creates nothing. It reads no plan, so it also completes a cycle whose plan can no longer be created.
- With a `stop` plan, a text change specification or no reflection, there is nothing to choose: `nextWave` is accepted and ignored, and the advance behaves as it always did. Follow-on work after a text change specification is the owner's to create.

**Authority.** The creating caller is the advancing caller, and `research.advance` rejects leased sessions and requires the cycle's owner or a project admin. No tool grant changed: a leased synthesis agent still holds only `artifact.create` and `reflection.submit`, and never creates work. The created tasks' producer and brief author is that owner or admin, exactly as when they create a task by hand. Tool policy is enforced per tool name at the transport, so an owner or admin whose policy denies `task.create` or `experiment.create` but allows `research.advance` creates this work through the advance; the explicit `nextWave: "create"` is the consent that covers it.

Because the text of a created task or experiment was written by an agent and is filed under the human who accepted it, every created record ends with its provenance: a `Why:` paragraph holding the item's rationale and an `Origin:` line naming the reflection, the change-specification artifact and hash, and the item key. The plan's limits keep a goal or details plus this suffix well inside the 16,000-character caps of `task.create` and `experiment.create`.

**Workspaces.** A specification declares each item's workspace explicitly. Research passes `provider: "code"` as `workspace: "git"` without `baseTaskId`; Tasks and Experiments choose their existing hosted or legacy versions. An unhosted project still creates legacy Git work. Code absence refuses the whole advance with the owning service's `code_unavailable`; the approved reflection remains intact and retryable. Automatic waves expose that refusal in their existing automation blocker. `provider: "none"` items create workspace-free work.

**One transaction.** The outer transition, every created record, the successor cycle, the `research.advanced` event and the replay receipt commit together, inside the caller's transaction when one is passed. A refusal anywhere — an unavailable workspace provider, a refused item — leaves the cycle where it was with nothing created. Every child request ID derives from the actor and the advance's `requestId` (`item:<key>` for work, `successor` for the cycle), so a replay returns the same records; a different `requestId` after success finds `research_complete`.

**Blockers.** Research checks the project state it can inspect in the `workflow.status_and_next` preflight (pass `nextWave: "create"` as input) and again inside the committing transition. Workspace admission is checked by Tasks and Experiments when creating each item in that same transaction:

| Code                       | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `reflection_open`          | Another reflection wave pauses task and experiment starts                        |
| `experiment_name_conflict` | A planned experiment name is already used in the project (compared without case) |
| `experiment_limit`         | Active experiments plus the plan's would exceed seven                            |
| `next_wave_inapplicable`   | Carried-over work is not a task or experiment                                    |

Every message names `nextWave: "skip"` as the way on.

**Records.** A successor's `origin` pins where it came from: the predecessor `researchId`, `reflectionId`, `reviewId`, the change-specification `{id, hash}`, each plan item as the record it became (`{key, kind, id}`) and the carried-over IDs. `origin` is null for a hand-created cycle and cannot be supplied to `research.create`. The predecessor reads its `successorId`, and `workflow.status_and_next` lists it as a reference. Storage holds the link in `research_cycles.predecessor_id`: immutable, and unique among non-null values on both backends, so a cycle has at most one successor whatever the code does. The `research.advanced` event carries `successorId` when a wave was created and `nextWave: "skipped"` when the owner skipped.

## Cycle digest and lineage

What a cycle decided is carried into the next one as a record, not as chat.

**Digest.** When a cycle reaches `complete`, or is ended with `research.end`, Research composes a `ResearchDigest` from records, retains it as one immutable `application/json` artifact titled `Cycle digest: <name>`, and stores the artifact's metadata in `research_cycles.digest`. The column is set once: the write is `UPDATE … WHERE digest IS NULL`, a trigger on both backends refuses any later change, and the stored value is re-read, so concurrent composers agree on one digest and the loser's artifact stays unreferenced. `research.get` returns it as `digest`, `workflow.status_and_next` lists it as a reference, and `research.digested` `{artifactId, late}` is recorded. Composition reads only selected task and experiment records from their owning providers; unrelated project work is not loaded. It preserves creation-time/ID order and runs inside the advancing or ending command, so a replay returns the same digest and writes nothing.

| Field             | Derived from                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`           | `id`, `name`, `outcome` (the terminal state), `reason`, `createdAt`, `composedAt`, `late`                                                                                                                                                                                  |
| `previousCycleId` | The cycle this one follows                                                                                                                                                                                                                                                 |
| `reflection`      | The approved reflection: `id`, `reviewId`, `approvedAt`, and the report and change specification as `{id, title, hash}`, and `next` — a structured plan's `decision`, stop `reason` and clipped `rationale`, null for a text specification; null when nothing was approved |
| `integration`     | The newest consolidation task and its publication state; null for a cycle that injected none                                                                                                                                                                               |
| `experiments`     | Selected experiments and the reflection's scope: `state`, attempt and submission counts, `conclusion`                                                                                                                                                                      |
| `tasks`           | Selected tasks: `id`, `title`, `state`                                                                                                                                                                                                                                     |
| `dropped`         | Selected work that failed or was abandoned                                                                                                                                                                                                                                 |
| `carriedOver`     | Selected work still unfinished                                                                                                                                                                                                                                             |
| `rejected`        | The alternatives an approved structured plan turned down: `title`, `reason`                                                                                                                                                                                                |
| `omitted`         | How many list entries were left out to keep the bound                                                                                                                                                                                                                      |

Reports and change specifications are named by ID and hash, never inlined; of a structured plan only the decision and the rejected alternatives are copied, because the items that became work are records the successor's `origin` names. Free text is clipped to 300 characters and each list to 100 entries; then entries are removed from the longest list until the digest is at most 12,000 characters, so it always fits a 24,000-character reflection context beside the assignment. The digest contains no actor ID and is never pinned review evidence, so it changes nothing about reviewer independence. Work dropped by `research.replan` is not recorded.

**Never a guard.** A digest checks nothing: `research.end` and the completing advance compose it in their own transaction from the records as they are. Digests written before version 6 carry a `consolidation` reference and per-experiment consolidation decisions; they are retained artifacts and are never re-parsed. Older digests may also carry `claims`, `openQuestions` and per-experiment `testedClaimIds` from before research claims were retired.

**Following a cycle.** `research.create` accepts `previousCycleId`. The predecessor must be in this project (`research_not_found`, 404), must be `complete`, `abandoned` or `failed` (`previous_cycle_open`, 409) and must not already have a successor (`previous_cycle_followed`, 409; storage allows one successor per cycle). The link is kept in the immutable `predecessor_id` column, the same one a plan-opened successor uses, and is returned as `previousCycleId` for both; `origin` stays null for a hand-created cycle. Leased sessions remain refused. `research.created` carries `previousCycleId`.

**Late composition.** If the predecessor has no digest because it ended before digests existed, it is composed in the creating transaction and marked `cycle.late: true`. A late digest reads work as it is when composed, not as it was when the cycle ended. Any project writer may cause this, not only the predecessor's owner or an admin: the digest is composed by the server from records the caller can already read, nothing the caller supplies reaches it, and it can be written only once. A cycle ended before this change kept its `reason` only as check input and in the `research.ended` event, so its late digest has `reason: null`; cycles ended since keep the reason, clipped to 2000 characters, in workflow data. Advancing a plan-opened successor into reflection also composes a missing predecessor digest.

**Reaching the next wave.** When a cycle that follows another advances from `researching`, its reflection wave receives the predecessor digest in the `previousCycle` context section (see [Reflections](REFLECTIONS.md#context-and-reads)). That is the only place the digest is pushed. Successor task and experiment workers do not receive it automatically: tasks and experiments carry no link to a cycle, and a new section would mean new versions of every task type and experiment recipe. They reach it through `research.lineage` and `artifact.read`, which any project reader, leased sessions included, may call; an owner can also hand the digest to a task through an existing custom `contextInputs` section.

**`research.lineage`** is read-only. Given a `researchId`, it returns the cycles it follows, oldest first and ending with the cycle asked about — each with `id`, `name`, `state`, `createdAt`, `previousCycleId`, child IDs and `digest` — walking back at most 20 cycles (`truncated: true` when the chain goes on), and the `successor` that follows it, if any.

## Retired versions

A completing advance asks for `nextWave` according to the approved reflection's plan. Finishing
requires Reflections unless the caller explicitly chooses `nextWave: "skip"`. Published Research
definitions remain immutable; every cycle uses version 6 and consolidation tasks. Creation
refuses the obsolete `consolidationWorkspace` and `consolidationDependsOn` inputs.

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
dependency closure: `usage.read` with the cycle's id covers its tasks, experiments,
reflection (with the lenses of every attempt) and consolidation. A cycle budget is set the
same way, with `usage.set_budget` on the cycle's id, and pauses automatic dispatch for the
work inside that closure only. Work never attached to the cycle is outside both. A cycle does not depend on the cycle it
follows, so a successor's usage and budget never include its predecessor's: read each
cycle of `research.lineage` by its own id. Work an approved plan carried over is a
dependency of the successor, and of the earlier cycle too when that cycle selected it, so it
is counted in each. A digest records no usage, because
sessions may still report after the cycle ends. See
[loop limits, usage and budgets](BUDGETS_AND_LIMITS.md).
