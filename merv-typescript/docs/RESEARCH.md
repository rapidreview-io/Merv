# Research coordinator

Research coordinates existing work without owning agent execution:

```text
defining → researching → reflecting → complete
                                  ↘ consolidating → complete  (code changes)
```

New cycles use `research@3`: pin the project definition, wait for selected prerequisite workflows, and create a five-lens reflection. With `consolidationWorkspace: 'none'` (the default), the cycle completes after its reflection is independently approved; it creates no Consolidation child. With `'git'`, it continues through Git consolidation and its independent review before completing. Experiment and reflection submissions include their paper changes, accepted by their existing scientific reviews; Research creates no Methods/Results child workflows.

Research owns the existing `reflection.create` tool and uses the same service method when advancing a research cycle into reflection. It registers an optional Workflows read-reference resolver for live reflection evidence, supplied by Knowledge. Removing Research removes these extra read permissions, without unloading Reflections or interrupting its assignment, lease or submission lifecycle. Reload restores reads for the same agent. Fixed tool grants, project scope, lens independence and write restrictions remain authoritative.

Advancing from reflection verifies its exact independent approval. If code changes were selected, Research selects the retained report/change-spec/lens artifacts. For live waves, it also selects current research-linked evidence and terminal experiment IDs through Knowledge, then passes these explicit inputs to Consolidation. Newly available evidence is reviewed by Consolidation, not claimed as part of the prior reflection approval. Legacy waves retain their original experiment scope and corpus artifacts. Research adds the approved reflection and any configured extra consolidation prerequisites as durable workflow dependencies. Consolidation does not call Reflections or Knowledge. After consolidation approval, Research can complete.

Research requires only State, Scope and Workflows. Paper, Reflections, Knowledge, Consolidation, Tasks and Experiments are optional bindings. Removing one leaves Research, its records, tools and UI active. Each action requires only the providers it actually uses:

| Operation                                                         | Optional capability needed                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Create, list or read a cycle; replay a committed Research command | None                                                                                                           |
| Accept the project definition and begin researching               | Paper                                                                                                          |
| Create a reflection wave                                          | Reflections                                                                                                    |
| Finish a no-code cycle after reflection approval                  | Reflections                                                                                                    |
| Start a selected consolidation stage                              | Reflections and Consolidation; also Knowledge when collecting live research evidence                           |
| Finish after consolidation approval                               | Consolidation; also Reflections when the cycle has a reflection, unless the advance carries `nextWave: "skip"` |
| Create an approved plan's work (`nextWave: "create"`)             | Reflections and Tasks; also Experiments when the plan holds experiments                                        |

Knowledge's extra reflection-evidence resolver exists only while Knowledge is bound. Removing it withdraws those additional read permissions without stopping the core reflection workflow. It does not turn unavailable evidence into an empty successful result. Creating a reflection wave itself does not require Knowledge.

A missing provider produces a named action blocker. A cycle requesting Git consolidation waits safely if Consolidation is unavailable; it neither skips the requested stage nor changes the outer cycle before creating the child. No-code cycles can complete without Consolidation or Code. Code remains mandatory inside Consolidation because it seals and validates code proposals. The UI hides and clears consolidation prerequisites when no code changes are selected and sends an empty prerequisite list for that branch.

Child creation, dependency links, outer transition and replay receipt share one transaction. Request IDs reject different-input reuse. Owner/operator authorization and project scope apply throughout.

Every optional provider used by an operation is pinned to its binding. Those bindings are checked before another provider call, after each awaited provider call and before the command returns. Replacement or removal during the operation rolls back its child, transition and receipt. An unrelated optional provider is not part of this check. Recorded Research commands replay before provider access, so a missing provider cannot invalidate a completed command. The direct `reflection.create` delegation still requires its Reflections owner.

The [Fable design consultation](reviews/research-optional-design-fable-20260916.md) addresses this resilience requirement; source review and runtime tests are separately attributed in [verification](../VERIFICATION.md).

## Next wave

Deliberately not taken from the [next-wave memo](../dev_docs/next-wave-memo-gpt6-2026-09-19.md): automatic advance and delegated owner authority, a `research@5` definition, provenance-based exclusion of the plan's authors from its work, a continuation budget, and a mandatory feasibility task per experiment.

Synthesis may submit its change specification as a structured plan (see [Reflections](REFLECTIONS.md#structured-change-specification)). Once that reflection is independently approved, the advance that reaches `complete` — `reflecting → complete` without consolidation, `consolidating → complete` with it — can create the plan as records. The handoff from reflection into consolidation is not a completion: it asks nothing and creates nothing.

**The owner's choice is explicit.** When the approved plan's decision is `continue`, that advance requires `nextWave`. `workflow.status_and_next` reports the action as `needs_input` naming `nextWave`, and a `research.advance` without it is refused with `next_wave_choice_required` (400). A client written before plans existed therefore never creates agent-planned work unknowingly.

- `nextWave: "create"` creates every task and experiment of the plan in dependency order, then opens one successor research cycle, named by the plan, that waits on the created work and the plan's carried-over work. The successor starts in `defining` on the current research version, with the predecessor's `consolidationWorkspace` and no extra consolidation prerequisites; the owner advances it as usual. Created tasks are dispatched like hand-created ones as soon as the advance commits.
- `nextWave: "skip"` completes the cycle and creates nothing. It reads no plan, so it also completes a cycle whose plan can no longer be created or whose Reflections is unloaded.
- With a `stop` plan, a text change specification or no reflection, there is nothing to choose: `nextWave` is accepted and ignored, and the advance behaves as it always did. Follow-on work after a text change specification is the owner's to create.

**Authority.** The creating caller is the advancing caller, and `research.advance` rejects leased sessions and requires the cycle's owner or a project admin. No tool grant changed: a leased synthesis agent still holds only `artifact.create` and `reflection.submit`, and never creates work. The created tasks' producer and brief author is that owner or admin, exactly as when they create a task by hand. Tool policy is enforced per tool name at the transport, so an owner or admin whose policy denies `task.create` or `experiment.create` but allows `research.advance` creates this work through the advance; the explicit `nextWave: "create"` is the consent that covers it.

Because the text of a created task or experiment was written by an agent and is filed under the human who accepted it, every created record ends with its provenance: a `Why:` paragraph holding the item's rationale and an `Origin:` line naming the reflection, the change-specification artifact and hash, and the item key. The plan's limits keep a goal or details plus this suffix well inside the 16,000-character caps of `task.create` and `experiment.create`.

**One transaction.** The outer transition, every created record, the successor cycle, the `research.advanced` event and the replay receipt commit together, inside the caller's transaction when one is passed. A refusal anywhere — a tested claim that does not exist, a capability replaced mid-operation — leaves the cycle where it was with nothing created. Every child request ID derives from the actor and the advance's `requestId` (`item:<key>` for work, `successor` for the cycle), so a replay returns the same records; a different `requestId` after success finds `research_complete`.

**Blockers.** Everything about the project that could refuse the plan is judged before the cycle moves, in the `workflow.status_and_next` preflight (pass `nextWave: "create"` as input) and again inside the committing transition, which receives the same `nextWave` as its input:

| Code                                                                      | Meaning                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `tasks_unavailable`, `experiments_unavailable`, `reflections_unavailable` | A provider the creation needs is not loaded                                                                                |
| `reflection_open`                                                         | Another reflection wave pauses task and experiment starts                                                                  |
| `experiment_name_conflict`                                                | A planned experiment name is already used in the project (compared without case)                                           |
| `experiment_limit`                                                        | Active experiments plus the plan's would exceed seven                                                                      |
| `next_wave_inapplicable`                                                  | Carried-over work is not a task or experiment, or has failed or been abandoned, which would end the successor as it opened |

Only the existence of tested claims is left to creation, because Research holds no Claims. Every message but the general `reflections_unavailable` names `nextWave: "skip"` as the way on.

**Records.** A successor's `origin` pins where it came from: the predecessor `researchId`, `reflectionId`, `reviewId`, the change-specification `{id, hash}`, each plan item as the record it became (`{key, kind, id}`) and the carried-over IDs. `origin` is null for a hand-created cycle and cannot be supplied to `research.create`. The predecessor reads its `successorId`, and `workflow.status_and_next` lists it as a reference. Storage holds the link in `research_cycles.predecessor_id`: immutable, and unique among non-null values on both backends, so a cycle has at most one successor whatever the code does. The `research.advanced` event carries `successorId` when a wave was created and `nextWave: "skipped"` when the owner skipped.

## Existing cycles

Whether a completing advance asks for `nextWave` follows the approved reflection's `plan`, not the research version: a `research@2`, `@3` or `@4` cycle creates its plan the same way, and a cycle whose reflection was approved with a text change specification completes exactly as before. One requirement did change for every registered version: finishing after consolidation now reads the approved reflection, so it needs Reflections unless the advance carries `nextWave: "skip"`. Research does not skip silently when it cannot see whether a plan waits.

Existing `research@2` cycles retain their original graph: defining → researching → reflecting → consolidating → complete. Their report-only and Git consolidation choices keep the same meaning, and existing child records are retained. A report-only version-2 cycle still creates its report consolidation; it is not silently converted into the version-3 no-code branch.

Existing `research@1` records and their standalone-writing child references remain historical records. The coordinator does not reinterpret or auto-complete an unfinished version-1 cycle. Start a new cycle using retained scientific work as explicit prerequisites when resuming that older model.
