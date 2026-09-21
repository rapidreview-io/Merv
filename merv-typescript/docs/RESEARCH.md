# Research coordinator

Research coordinates existing work without owning agent execution:

```text
defining → researching → reflecting → complete
                                  ↘ consolidating → complete  (code changes)
```

New cycles use `research@3`: pin the project definition, wait for selected prerequisite workflows, and create a five-lens reflection. With `consolidationWorkspace: 'none'` (the default), the cycle completes after its reflection is independently approved; it creates no Consolidation child. With `'git'`, it continues through Git consolidation and its independent review before completing. Experiment and reflection submissions include their paper changes, accepted by their existing scientific reviews; Research creates no Methods/Results child workflows.

Research owns the existing `reflection.create` tool and uses the same service method when advancing a research cycle into reflection. It registers an optional Workflows read-reference resolver for live reflection evidence, supplied by Knowledge. Removing Research removes these extra read permissions, without unloading Reflections or interrupting its assignment, lease or submission lifecycle. Reload restores reads for the same agent. Fixed tool grants, project scope, lens independence and write restrictions remain authoritative.

Advancing from reflection verifies its exact independent approval. If code changes were selected, Research selects the retained report/change-spec/lens artifacts. For live waves, it also selects current research-linked evidence and terminal experiment IDs through Knowledge, then passes these explicit inputs to Consolidation. Newly available evidence is reviewed by Consolidation, not claimed as part of the prior reflection approval. Legacy waves retain their original experiment scope and corpus artifacts. Research adds the approved reflection and any configured extra consolidation prerequisites as durable workflow dependencies. Consolidation does not call Reflections or Knowledge. After consolidation approval, Research can complete.

Research requires only State, Scope and Workflows. Paper, Reflections, Knowledge and Consolidation are optional bindings. Removing one leaves Research, its records, tools and UI active. Each action requires only the providers it actually uses:

| Operation                                                         | Optional capability needed                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Create, list or read a cycle; replay a committed Research command | None                                                                                 |
| Accept the project definition and begin researching               | Paper                                                                                |
| Create a reflection wave                                          | Reflections                                                                          |
| Finish a no-code cycle after reflection approval                  | Reflections                                                                          |
| Start a selected consolidation stage                              | Reflections and Consolidation; also Knowledge when collecting live research evidence |
| Finish after consolidation approval                               | Consolidation                                                                        |

Knowledge's extra reflection-evidence resolver exists only while Knowledge is bound. Removing it withdraws those additional read permissions without stopping the core reflection workflow. It does not turn unavailable evidence into an empty successful result. Creating a reflection wave itself does not require Knowledge.

A missing provider produces a named action blocker. A cycle requesting Git consolidation waits safely if Consolidation is unavailable; it neither skips the requested stage nor changes the outer cycle before creating the child. No-code cycles can complete without Consolidation or Code. Code remains mandatory inside Consolidation because it seals and validates code proposals. The UI hides and clears consolidation prerequisites when no code changes are selected and sends an empty prerequisite list for that branch.

Child creation, dependency links, outer transition and replay receipt share one transaction. Request IDs reject different-input reuse. Owner/operator authorization and project scope apply throughout.

Every optional provider used by an operation is pinned to its binding. Those bindings are checked before another provider call, after each awaited provider call and before the command returns. Replacement or removal during the operation rolls back its child, transition and receipt. An unrelated optional provider is not part of this check. Recorded Research commands replay before provider access, so a missing provider cannot invalidate a completed command. The direct `reflection.create` delegation still requires its Reflections owner.

The [Fable design consultation](reviews/research-optional-design-fable-20260916.md) addresses this resilience requirement; source review and runtime tests are separately attributed in [verification](../VERIFICATION.md).

## Existing cycles

Existing `research@2` cycles retain their original graph: defining → researching → reflecting → consolidating → complete. Their report-only and Git consolidation choices keep the same meaning, and existing child records are retained. A report-only version-2 cycle still creates its report consolidation; it is not silently converted into the version-3 no-code branch.

Existing `research@1` records and their standalone-writing child references remain historical records. The coordinator does not reinterpret or auto-complete an unfinished version-1 cycle. Start a new cycle using retained scientific work as explicit prerequisites when resuming that older model.

## What a cycle cost

A cycle attaches its children as dependencies, so a cycle's usage is the rollup over its
dependency closure: `usage.read` with the cycle's id covers its tasks, experiments,
reflection (with the lenses of every attempt) and consolidation. A cycle budget is set the
same way, with `usage.set_budget` on the cycle's id, and pauses automatic dispatch for the
work inside that closure only. Work never attached to the cycle is outside both. See
[loop limits, usage and budgets](BUDGETS_AND_LIMITS.md).
