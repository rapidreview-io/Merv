# Research coordinator

Research coordinates existing work without owning agent execution. [Automatic mode](CONTINUOUS_RESEARCH.md) stitches the same workflows into a continuous run:

```text
defining → researching → reflecting → complete
                                  ↘ consolidating → complete  (code changes)
```

New cycles use `research@5`: pin the project definition, wait for the selected work to finish (including failure or abandonment), and create a five-lens reflection. Task and experiment execution prerequisites still require success. Versions 2–4 retain their original gates. With `consolidationWorkspace: 'none'` (the default), the cycle completes after its reflection is independently approved; it creates no Consolidation child. With `'git'`, it continues through Git consolidation and its independent review before completing. Experiment and reflection submissions include their paper changes, accepted by their existing scientific reviews; Research creates no Methods/Results child workflows.

Research owns the existing `reflection.create` tool and uses the same service method when advancing a research cycle into reflection. It registers an optional Workflows read-reference resolver for live reflection evidence, supplied by Knowledge. Removing Research removes these extra read permissions, without unloading Reflections or interrupting its assignment, lease or submission lifecycle. Reload restores reads for the same agent. Fixed tool grants, project scope, lens independence and write restrictions remain authoritative.

Advancing from reflection verifies its exact independent approval. If code changes were selected, Research selects the retained report/change-spec/lens artifacts. For live waves, it also selects current research-linked evidence and terminal experiment IDs through Knowledge, then passes these explicit inputs and its selected cycle task IDs to Consolidation. Newly available evidence is reviewed by Consolidation, not claimed as part of the prior reflection approval. Legacy waves retain their original experiment scope and corpus artifacts. Research adds the approved reflection and any configured extra consolidation prerequisites as durable workflow dependencies. Consolidation does not call Reflections or Knowledge. After consolidation approval, Research can complete.

Research requires only State, Scope and Workflows. Paper, Reflections, Knowledge, Consolidation, Tasks, Experiments and Artifacts are optional bindings. Removing one leaves Research, its records, tools and UI active. Each action requires only the providers it actually uses:

| Operation                                                             | Optional capability needed                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Create, list or read a cycle; replay a committed Research command     | None                                                                                                           |
| Accept the project definition and begin researching                   | Paper                                                                                                          |
| Create a reflection wave                                              | Reflections                                                                                                    |
| Finish a no-code cycle after reflection approval                      | Reflections                                                                                                    |
| Start a selected consolidation stage                                  | Reflections and Consolidation; also Knowledge when collecting live research evidence                           |
| Finish after consolidation approval                                   | Consolidation; also Reflections when the cycle has a reflection, unless the advance carries `nextWave: "skip"` |
| Create an approved plan's work (`nextWave: "create"`)                 | Reflections and Tasks; also Experiments when the plan holds experiments                                        |
| Digest a cycle as it completes or is ended                            | None required: composed only when Artifacts, Knowledge and the cycle's Reflections and Consolidation are bound |
| Create a cycle with `previousCycleId` whose predecessor has no digest | Artifacts and Knowledge; also Reflections and Consolidation when the predecessor has those children            |

Knowledge's extra reflection-evidence resolver exists only while Knowledge is bound. Removing it withdraws those additional read permissions without stopping the core reflection workflow. It does not turn unavailable evidence into an empty successful result. Creating a reflection wave itself does not require Knowledge.

A missing provider produces a named action blocker. A cycle requesting Git consolidation waits safely if Consolidation is unavailable; it neither skips the requested stage nor changes the outer cycle before creating the child. No-code cycles can complete without Consolidation or Code. Consolidation remains available without Code and can record its legacy version-4 child; that child refuses Git assignments until Code returns. Consolidation chooses version 5 for hosted Git projects inside its creating transaction; Research carries the task scope and workspace declaration without interpreting hosting. The UI hides and clears consolidation prerequisites when no code changes are selected and sends an empty prerequisite list for that branch.

Child creation, dependency links, outer transition and replay receipt share one transaction. Request IDs reject different-input reuse. Owner/operator authorization and project scope apply throughout.

Every optional provider used by an operation is pinned to its binding. Those bindings are checked before another provider call, after each awaited provider call and before the command returns. Replacement or removal during the operation rolls back its child, transition and receipt. An unrelated optional provider is not part of this check. Recorded Research commands replay before provider access, so a missing provider cannot invalidate a completed command. The direct `reflection.create` delegation still requires its Reflections owner.

The [Fable design consultation](reviews/research-optional-design-fable-20260916.md) addresses this resilience requirement; source review and runtime tests are separately attributed in [verification](../VERIFICATION.md).

## Next wave

Automatic handoffs and a bounded number of successor cycles are implemented; see [Continuous research](CONTINUOUS_RESEARCH.md). Provenance-based exclusion of plan authors from future production and a shared cross-cycle cost budget are separate work. Experiment feasibility is checked by the experiment design workflow.

Synthesis may submit its change specification as a structured plan (see [Reflections](REFLECTIONS.md#structured-change-specification)). Once that reflection is independently approved, the advance that reaches `complete` — `reflecting → complete` without consolidation, `consolidating → complete` with it — can create the plan as records. The handoff from reflection into consolidation is not a completion: it asks nothing and creates nothing.

**Manual advances require an explicit choice.** When the approved plan's decision is `continue`, that advance requires `nextWave`. For a cycle created with `automatic: true`, Research supplies this choice under the captured owner authorization: create within the cycle limit, skip at the limit. `workflow.status_and_next` reports the action as `needs_input` naming `nextWave`, and a `research.advance` without it is refused with `next_wave_choice_required` (400). A client written before plans existed therefore never creates agent-planned work unknowingly.

- `nextWave: "create"` creates every task and experiment of the plan in dependency order, then opens one successor research cycle, named by the plan, that waits on the created work and the plan's carried-over work. The successor starts in `defining` on the current research version, with the predecessor's `consolidationWorkspace` and no extra consolidation prerequisites; the owner advances it as usual in manual mode; automatic successors inherit the original authority and remaining cycle allowance and advance on durable events. Created tasks are dispatched like hand-created ones as soon as the advance commits.
- `nextWave: "skip"` completes the cycle and creates nothing. It reads no plan, so it also completes a cycle whose plan can no longer be created or whose Reflections is unloaded.
- With a `stop` plan, a text change specification or no reflection, there is nothing to choose: `nextWave` is accepted and ignored, and the advance behaves as it always did. Follow-on work after a text change specification is the owner's to create.

**Authority.** The creating caller is the advancing caller, and `research.advance` rejects leased sessions and requires the cycle's owner or a project admin. No tool grant changed: a leased synthesis agent still holds only `artifact.create` and `reflection.submit`, and never creates work. The created tasks' producer and brief author is that owner or admin, exactly as when they create a task by hand. Tool policy is enforced per tool name at the transport, so an owner or admin whose policy denies `task.create` or `experiment.create` but allows `research.advance` creates this work through the advance; the explicit `nextWave: "create"` is the consent that covers it.

Because the text of a created task or experiment was written by an agent and is filed under the human who accepted it, every created record ends with its provenance: a `Why:` paragraph holding the item's rationale and an `Origin:` line naming the reflection, the change-specification artifact and hash, and the item key. The plan's limits keep a goal or details plus this suffix well inside the 16,000-character caps of `task.create` and `experiment.create`.

**Workspaces.** Version-2 specifications declare each item's workspace explicitly. Research passes `provider: "code"` as `workspace: "git"` without `baseTaskId`; Tasks and Experiments choose their existing hosted or legacy versions. An unhosted project still creates legacy Git work. Code absence refuses the whole advance with the owning service's `code_unavailable`; the approved reflection remains intact and retryable. Automatic waves expose that refusal in their existing automation blocker. Version-1 plans and version-2 `provider: "none"` items create workspace-free work.

**One transaction.** The outer transition, every created record, the successor cycle, the `research.advanced` event and the replay receipt commit together, inside the caller's transaction when one is passed. A refusal anywhere — an unavailable workspace provider, a capability replaced mid-operation — leaves the cycle where it was with nothing created. Every child request ID derives from the actor and the advance's `requestId` (`item:<key>` for work, `successor` for the cycle), so a replay returns the same records; a different `requestId` after success finds `research_complete`.

**Blockers.** Research checks the project state it can inspect in the `workflow.status_and_next` preflight (pass `nextWave: "create"` as input) and again inside the committing transition. Workspace admission is checked by Tasks and Experiments when creating each item in that same transaction:

| Code                                                                      | Meaning                                                                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tasks_unavailable`, `experiments_unavailable`, `reflections_unavailable` | A provider the creation needs is not loaded                                                                    |
| `reflection_open`                                                         | Another reflection wave pauses task and experiment starts                                                      |
| `experiment_name_conflict`                                                | A planned experiment name is already used in the project (compared without case)                               |
| `experiment_limit`                                                        | Active experiments plus the plan's would exceed seven                                                          |
| `next_wave_inapplicable`                                                  | Carried-over work is not a task or experiment; legacy cycles also reject failed or abandoned carried-over work |

Only the existence of tested claims is left to creation, because Research holds no Claims. Every message but the general `reflections_unavailable` names `nextWave: "skip"` as the way on.

**Records.** A successor's `origin` pins where it came from: the predecessor `researchId`, `reflectionId`, `reviewId`, the change-specification `{id, hash}`, each plan item as the record it became (`{key, kind, id}`) and the carried-over IDs. `origin` is null for a hand-created cycle and cannot be supplied to `research.create`. The predecessor reads its `successorId`, and `workflow.status_and_next` lists it as a reference. Storage holds the link in `research_cycles.predecessor_id`: immutable, and unique among non-null values on both backends, so a cycle has at most one successor whatever the code does. The `research.advanced` event carries `successorId` when a wave was created and `nextWave: "skipped"` when the owner skipped.

## Cycle digest and lineage

What a cycle decided is carried into the next one as a record, not as chat.

**Digest.** When a cycle reaches `complete`, or is ended with `research.end`, Research composes a `ResearchDigest` from records, retains it as one immutable `application/json` artifact titled `Cycle digest: <name>`, and stores the artifact's metadata in `research_cycles.digest`. The column is set once: the write is `UPDATE … WHERE digest IS NULL`, a trigger on both backends refuses any later change, and the stored value is re-read, so concurrent composers agree on one digest and the loser's artifact stays unreferenced. `research.get` returns it as `digest`, `workflow.status_and_next` lists it as a reference, and `research.digested` `{artifactId, late}` is recorded. Composition runs inside the advancing or ending command, so a replay returns the same digest and writes nothing.

| Field             | Derived from                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycle`           | `id`, `name`, `outcome` (the terminal state), `reason`, `createdAt`, `composedAt`, `late`                                                                                                                                                                                  |
| `previousCycleId` | The cycle this one follows                                                                                                                                                                                                                                                 |
| `reflection`      | The approved reflection: `id`, `reviewId`, `approvedAt`, and the report and change specification as `{id, title, hash}`, and `next` — a structured plan's `decision`, stop `reason` and clipped `rationale`, null for a text specification; null when nothing was approved |
| `consolidation`   | The approved consolidation: `id`, `reviewId`, report `{id, title, hash}`; null otherwise                                                                                                                                                                                   |
| `experiments`     | Selected experiments, the reflection's scope and those consolidation decided on: `state`, attempt and submission counts, `testedClaimIds`, `conclusion`, and the approved consolidation's `decision` and `rationale`                                                       |
| `tasks`           | Selected tasks: `id`, `title`, `state`                                                                                                                                                                                                                                     |
| `claims`          | Claims those experiments tested, with `status`, `confidence` and `testedBy`                                                                                                                                                                                                |
| `dropped`         | Selected work that failed or was abandoned, and experiments consolidation decided to `drop`                                                                                                                                                                                |
| `carriedOver`     | Selected work still unfinished, and experiments consolidation decided to `adapt`                                                                                                                                                                                           |
| `openQuestions`   | Tested claims still `draft` or `active`. Derived, not authored: prose open questions remain in the change specification                                                                                                                                                    |
| `rejected`        | The alternatives an approved structured plan turned down: `title`, `reason`                                                                                                                                                                                                |
| `omitted`         | How many list entries were left out to keep the bound                                                                                                                                                                                                                      |

Reports and change specifications are named by ID and hash, never inlined; of a structured plan only the decision and the rejected alternatives are copied, because the items that became work are records the successor's `origin` names. Free text is clipped to 300 characters and each list to 100 entries; then entries are removed from the longest list until the digest is at most 12,000 characters, so it always fits a 24,000-character reflection context beside the assignment. The digest contains no actor ID and is never pinned review evidence, so it changes nothing about reviewer independence. Work dropped by `research.replan` is not recorded.

**Never a guard.** Ending exists so a cycle that cannot continue can always be ended, so a digest never blocks `research.end` or the completing advance. It needs Artifacts and Knowledge, plus Reflections when the cycle has a reflection and Consolidation when it has a consolidation; when any of these is unbound the column stays null, no `research.digested` is recorded, and the digest is composed late.

**Following a cycle.** `research.create` accepts `previousCycleId`. The predecessor must be in this project (`research_not_found`, 404), must be `complete`, `abandoned` or `failed` (`previous_cycle_open`, 409) and must not already have a successor (`previous_cycle_followed`, 409; storage allows one successor per cycle). The link is kept in the immutable `predecessor_id` column, the same one a plan-opened successor uses, and is returned as `previousCycleId` for both; `origin` stays null for a hand-created cycle. Leased sessions remain refused. `research.created` carries `previousCycleId`.

**Late composition.** If the predecessor has no digest — it ended before digests existed, or while a capability was unbound — it is composed in the creating transaction and marked `cycle.late: true`. Here a missing capability is refused with its `<name>_unavailable` code, because the caller asked for carry-forward. A late digest reads claims and work as they are when composed, not as they were when the cycle ended. Any project writer may cause this, not only the predecessor's owner or an admin: the digest is composed by the server from records the caller can already read, nothing the caller supplies reaches it, and it can be written only once. A cycle ended before this change kept its `reason` only as check input and in the `research.ended` event, so its late digest has `reason: null`; cycles ended since keep the reason, clipped to 2000 characters, in workflow data. Advancing a plan-opened successor into reflection also composes a missing predecessor digest when the capabilities are bound, and otherwise starts the wave without one.

**Reaching the next wave.** When a cycle that follows another advances from `researching`, its reflection wave receives the predecessor digest in the `previousCycle` context section (see [Reflections](REFLECTIONS.md#context-and-reads)). That is the only place the digest is pushed. Successor task and experiment workers do not receive it automatically: tasks and experiments carry no link to a cycle, and a new section would mean new versions of every task type and experiment recipe. They reach it through `research.lineage` and `artifact.read`, which any project reader, leased sessions included, may call; an owner can also hand the digest to a task through an existing custom `contextInputs` section.

**`research.lineage`** is read-only. Given a `researchId`, it returns the cycles it follows, oldest first and ending with the cycle asked about — each with `id`, `name`, `state`, `createdAt`, `previousCycleId`, child IDs and `digest` — walking back at most 20 cycles (`truncated: true` when the chain goes on), and the `successor` that follows it, if any.

## Existing cycles

Whether a completing advance asks for `nextWave` follows the approved reflection's `plan`, not the research version: a `research@2`, `@3`, `@4` or `@5` cycle creates its plan the same way, and a cycle whose reflection was approved with a text change specification completes exactly as before. One requirement did change for every registered version: finishing after consolidation now reads the approved reflection, so it needs Reflections unless the advance carries `nextWave: "skip"`. Research does not skip silently when it cannot see whether a plan waits.

Existing `research@2` cycles retain their original graph: defining → researching → reflecting → consolidating → complete. Their report-only and Git consolidation choices keep the same meaning, and existing child records are retained. A report-only version-2 cycle still creates its report consolidation; it is not silently converted into the version-3 no-code branch.

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
