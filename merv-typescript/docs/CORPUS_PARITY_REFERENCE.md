# Project corpus and query reference

Source audit: 2026-09-15. This document describes the current Python selection
and presentation contracts, then identifies the requirements for the next
TypeScript increment. It does not claim that a Corpus or Reflection provider
has been implemented. Existing production Experiments remains intact.

## Three different reads

Keep these meanings separate:

1. **Current project knowledge:** the current Introduction, research inventory,
   current work and published knowledge. Ordinary reads may change as the
   project changes.
2. **A reflection corpus:** the fixed source selection stored when a wave is
   created. Later claims, terminal work or uploads do not silently join it.
3. **Published coverage:** the corpus of the latest successfully published wave.
   An open or merely reviewed wave does not advance this coverage.

Python creates `corpus_json` within the reflection creation transaction. It
allows one open reflection per project. The latest published wave is selected
by `published_at DESC, created_seq DESC`; an open wave is selected by descending
creation sequence. The declaration permits no ordinary transition to rewrite
the stored corpus. The schema stores JSON without a corpus-specific immutable
SQL trigger; this is an application invariant, not a database-level proof.

Sources: [creation and selection](../../merv/src/merv/brain/research_core/reflections.py)
lines 78–84, 230–284; [record declaration](../../merv/src/merv/brain/workflows/definitions/reflection.py)
lines 328–343; [schema](../../merv/src/merv/brain/research_core/persistence.py)
lines 161–186.

## Exact frozen source selection

| Corpus field                       | Python selection                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `captured_at`                      | Server timestamp when the wave is created                                                                           |
| `terminal_experiments`             | **All** project experiments in `complete`, `abandoned` or `failed`; not just successes or newly finished work       |
| `terminal_tasks`                   | **All** project tasks in `done` or `failed`; failed tasks are still inputs                                          |
| `claims`                           | **All** project claims, including draft/abandoned claims; frozen `id`, `statement`, `status`, `confidence`, `scope` |
| `new_terminal_experiments`         | `{id,name,status}` for corpus experiments absent from the previous published corpus's experiment ID set             |
| `new_terminal_tasks`               | Equivalent task delta against the previous published task ID set                                                    |
| `previous_published_reflection_id` | Latest published reflection ID, or null                                                                             |
| `previous_published_artifacts`     | Prior wave's current-attempt `project_graph` and `reflection_doc`, if present                                       |
| `previous_lens_reflections`        | Prior wave's covered lens contributions, keyed by lens ID                                                           |

Experiments, tasks and claims are selected in ascending `created_at, id` order.
The `new_terminal_*` arrays preserve that source order; they explain why a wave
is happening, not the extent of what it must read. Coverage compares IDs, not
artifact hashes or latest update timestamps.

Experiment entries contain `id`, `name`, `attempt_index`, `status`, and artifact
references. Task entries additionally contain `goal`, `outcome` and `failed_by`.
The experiment corpus entry does not currently carry intent, conclusion, tested
claim IDs, review IDs or full attempt history. A richer TypeScript packet may
retain those existing authoritative facts, but that is an explicit strengthening
of this smaller Python shape.

Sources: [terminal row queries](../../merv/src/merv/brain/research_core/reflections.py)
lines 258–284; [pure corpus assembly](../../merv/src/merv/brain/workflows/definitions/reflection_corpus.py)
lines 48–81; terminal outcomes in the
[Experiment definition](../../merv/src/merv/brain/workflows/definitions/experiment.py)
and [Task definition](../../merv/src/merv/brain/workflows/definitions/task.py).

### Which evidence is selected

For each terminal experiment, Python chooses its **current attempt's latest
report and latest graph**, one per role. It does not include every result file,
the exhibit or plan in this corpus projection. For each terminal task it selects
the current attempt's latest brief and delivery. A terminal failed/abandoned
experiment may have no report/graph, or only unfinished evidence; selection
must not imply that an independent review accepted it.

“Latest” uses the tuple `(submitted_order, updated_at-or-created_at, id-or-artifact_id,
path)`. Filtering to the attempt happens first. Selecting one artifact per role
differs from selecting the latest artifact in every role/path slot, and differs
again from selecting an exact sealed submission. Do not interchange these
operations. The simple corpus selector does not require a review seal.

A corpus content reference retains `artifact_id`, `path`, `role` and
`submitted_order`. Python's research artifact IDs may be association handles,
so these must resolve through the owning artifact service rather than be treated
as filesystem paths. The current shape does not explicitly store the content
hash, media type, size or submission/association identity separately. TypeScript
already has these facts and should retain them with a captured selection.

Sources: [reference selection](../../merv/src/merv/brain/workflows/definitions/reflection_corpus.py)
lines 25–46; [recency, slot and seal selectors](../../merv/src/merv/brain/workflows/definitions/documents.py)
lines 132–177; [association-handle regression](../../merv/tests/application/test_logic_graph.py)
lines 227–244.

### Prior lenses and publication

The previous published wave contributes covered lens references plus its
project graph and reflection document. It does not supply an unreviewed newer
wave as the publication baseline. Within the current wave, submitted lens
children pin their exact artifact IDs; a newer upload under the same lens does
not replace that submitted child contribution. Lens identity is part of the
slot: five lenses can legally use the same path and must remain five documents.

Sources: [pinned lens hydration](../../merv/src/merv/brain/research_core/reflections.py)
lines 338–365; [review evidence regressions](../../merv/tests/workflow/test_evidence_selection.py)
lines 265–324.

## Hydration and drift are separate from capture

The stored corpus names bytes rather than copying them into each record. A
focused content read gathers the fixed corpus references, previous publication
and lens references, plus the current wave's contributions. Each referenced
document returns content, `content_available` and `content_truncated`. Missing
bytes remain explicitly unavailable. Hydration strips a stale `tldr` field;
it does not pretend a summary is the referenced document.

Python limits each hydrated text to 16,000 UTF-8 bytes, uses replacement decoding
for malformed source bytes and marks truncation. TypeScript should preserve
explicit availability/truncation while retaining its stronger hash/size checks
and deliberate text/binary handling. A metadata query must not silently hydrate
all bytes or erase a missing-content distinction.

Current snapshots freeze claim text and fields. A compatibility path fills
missing text in **old** snapshots from live claim rows while retaining the old
claim set/status. This means a legacy hydrated snapshot can mix capture-time
status with later text; do not repeat that ambiguity for new captures. Mark a
legacy backfill as such if importing old data.

Sources: [hydration](../../merv/src/merv/brain/workflows/definitions/reflection_corpus.py)
lines 84–145; [claim compatibility](../../merv/src/merv/brain/research_core/reflections.py)
lines 403–416.

The reflection signal is recomputed from current rows versus the latest
published corpus. New terminal experiments trigger recommendation at 1, a nudge
at 3 and the experiment-creation debt block at 5. Tasks count as new material
but never increase experiment debt. A claim status change to `contradicted`
also marks new material and, when no wave is open, staleness. Other status
changes are counted; text/confidence/scope-only edits and deleted claims are not
detected by this status-only comparison. With no published wave, Python reports
no claim-status deltas. An open wave suppresses the stale nudge but does not
make its unpublished corpus covered or remove the experiment-debt block.

Sources: [coverage and drift](../../merv/src/merv/brain/research_core/policy.py)
lines 96–157; [thresholds](../../merv/src/merv/brain/workflows/definitions/research_contracts.py)
lines 58–62; [publication resets coverage test](../../merv/tests/research_core/test_reflections.py)
lines 946–968. Do not enable a blocking reflection-debt gate in TypeScript before
the real reflection/publication path can clear it.

## Project document and inventory inputs

Project Introduction is `projects.summary`, not a field of `corpus_json`.
`project_brief()` reads a project fact separately whenever a joining brief is
built. Its rendered document contains Introduction, literature summary and cited
papers, Methods, Results, selected references and a pending-maintenance notice.
It adds the current record-specific instructions afterward. All installed
research agent nodes receive the full Introduction, including reviewers;
automatically assigned sessions cannot edit it. Empty Introduction adds no
workflow completeness gate.

Python's `project_context_facts` supplies current project ID/name/summary, all
claims, all experiments with intent/conclusion/tested-claim links, tasks with
goal/outcome/failure attribution, open/latest-published reflection metadata,
literature summary, paper count and candidate context. Its broader `snapshot`
reads project research and gate evaluations in one transaction. These are live
read models, not wave coverage receipts.

The TypeScript prerequisite should put Introduction metadata in Scope, with
current authority, scalar validation, revision CAS and stable request replay.
No separate small Introduction plugin is needed. Versioning the Introduction
inside a future capture, if chosen, should be explicit; Python's wave corpus
does not currently freeze it. Literature maintenance and Methods/Results
publication remain separate programs rather than invented empty authoritative
documents.

Sources: [project context and snapshot](../../merv/src/merv/brain/research_core/research.py)
lines 693–764; [brief composition](../../merv/src/merv/brain/workflows/definitions/checks.py)
lines 57–59; [document renderer](../../merv/src/merv/brain/workflows/definitions/research_contracts.py)
lines 13–33; [full-intent tests](../../merv/tests/workflow/test_project_intent.py).

## Graph selection and reference resolution

Python's project graph **display** prefers the open wave's current-attempt graph.
If that attempt has no graph, it falls back to the latest published wave's graph.
A rejected prior attempt's graph must not reappear as the current open graph.
The graph's reflection ID/status/attempt/publication timestamp travel with it.
The corpus baseline still uses the previous published wave.

A TypeScript query should distinguish a working graph from a published graph;
calling the UI-preferred open graph “authoritative published knowledge” would
change its meaning. With no graph, return unavailable/null plus the project
signal, not an invented graph from a task recipe.

The common graph view returns availability, graph artifact/path, producing
attempt, parsed document, validation problems and a `ref_index`. Missing bytes
make the graph unavailable. Present but malformed JSON can still be reported as
an available artifact with `graph: null` and problems. The current TypeScript
Experiment graph reader instead throws on invalid graph content; choose and
document an explicit presentation contract when adding the shared query.

Node `refs` are traversed in document order and deduplicated by first occurrence.
Resolution is project-scoped, returns metadata only, and supports:

| Prefix/type                                | Resolved fields beyond identity/type |
| ------------------------------------------ | ------------------------------------ |
| `rev_` review                              | role, verdict, created_at            |
| `claim_` claim                             | statement, status                    |
| `exp_` experiment                          | intent, status                       |
| `task_` task                               | goal, status                         |
| `syn_` reflection                          | title, status, published_at          |
| `lit_` literature section                  | title, tldr                          |
| `paper_` paper                             | title, url, year                     |
| `art_` / `artref_` artifact or association | artifact_id, path, role, title       |

Known typed IDs that do not exist in this project return `resolved: false` and
type `unknown`. Other unresolved references also receive an explanatory hint.
There is no foreign-project fallback. Research SQL lookup batches at 400 IDs;
the application layer composes artifact lookup and preserves first-seen order.
Do not invent a currently absent Reflection/Literature service just to make its
reference resolve: unsupported types can remain explicit unresolved entries.

Sources: [graph selection](../../merv/src/merv/brain/research_core/reflections.py)
lines 463–510; [shared view/resolver](../../merv/src/merv/brain/application/queries.py)
lines 94–195; [typed resolver](../../merv/src/merv/brain/research_core/research.py)
lines 50–71 and 766–786; [graph-selection regressions](../../merv/tests/workflow/test_evidence_selection.py)
lines 326–391 and [query tests](../../merv/tests/application/test_logic_graph.py).

Graph comparison names both published baseline and current graph version. It
returns explicit reasons for missing current graph, absent previous publication,
or unreadable/invalid content. A diff is produced only after both documents
validate. For a published wave, its baseline is the prior published wave with an
earlier creation sequence; for an open wave it is the latest published wave.

Sources: [comparison selection](../../merv/src/merv/brain/research_core/reflections.py)
lines 513–543; [pure graph comparison](../../merv/src/merv/brain/workflows/definitions/reflection_corpus.py)
lines 184–223.

## Exact code references: improve the Python boundary

Python's corpus capture does **not** freeze experiment Git heads. At consolidation
proposal time, the application reads `AgentSessions.workspaces` for every corpus
experiment and overwrites any caller-supplied `source_sha` with the server's
recorded `head_sha`. The accepted proposal and per-experiment decisions then
retain those exact values immutably.

The workspace source table is a mutable latest row per project/instance. Only
persistent workspaces update it; scratch/ephemeral workspaces add no lineage.
It records branch/base/head/stats and time, but has no stable capture ID or exact
attempt/revision/worker provenance. A later session can overwrite it before
proposal submission. This is better than trusting the agent's claimed SHA, but
it is not a capture-time evidence identity.

TypeScript should consume its existing source-authenticated Session workspace
results or accepted live Code receipts with explicit identity: project,
instance, attempt/revision, producing worker/session, repository/workspace,
base/head OIDs, stats and source receipt. Retain the exact capture reference used
by a corpus or proposal; never reinterpret a mutable “latest head” as what a
reviewer previously assessed. Late results may be appended to history but must
not rewrite an existing corpus. A report/graph-only experiment can validly have
no code capture. Recorded capture facts are not evidence that Git objects exist
on another runner or permission to advance central.

Sources: [proposal source binding](../../merv/src/merv/brain/application/application.py)
lines 678–704; [workspace reads](../../merv/src/merv/brain/agent_sessions/agent_sessions.py)
lines 762–783 and [persistent-only mutable writer](../../merv/src/merv/brain/agent_sessions/agent_sessions.py)
lines 1001–1056; [sealed proposal/decisions](../../merv/src/merv/brain/research_core/reflections.py)
lines 630–680. Existing TypeScript mechanisms are documented in
[workspaces](WORKSPACES.md), [Code operations](CODE_OPERATIONS.md) and
[Code publication ordering](CODE_PUBLICATION_PLAN.md).

## Minimum coherent integration order

1. Add Scope-owned Introduction metadata and current-project read/update
   contracts. Preserve interactive-only editing and make request replay/CAS
   explicit.
2. Add one authoritative current-project read model over the existing public
   Claims, Experiments, Tasks, Artifacts and Workflows contracts. Keep summary
   reads metadata-only; expose scoped graph reference resolution with explicit
   unavailable/unsupported results.
3. Retain exact authenticated code-capture facts and immutable source-selection
   receipts. Freeze all terminal work and claims in one consistent read,
   preserving distinction between current slots, reviewed seals and history.
4. Build actual Reflection on that capture contract: one open wave, fixed lens
   membership, synthesis/review and eventual publication. Only publication can
   advance coverage. Published graph/doc/lens pointers remain absent until the
   owning program can produce them legitimately.

The Scope Introduction foundation is now implemented in
[Scope](../packages/scope/src/index.ts) and its
[narrow input/migration module](../packages/scope/src/project-context.ts): current
projects return `summary` and `contextRevision`; ordinary operators/producers can
submit an exact-previous-text update, while leased workers cannot. Accepted
updates retain immutable request receipts and audit events. New task lease
receipts capture the Introduction for worker context; old leases and already
saved contexts retain their original packets. This is current project intent,
not a published Reflection or frozen research corpus. The core and task-context
regressions are in [project-context.test.ts](../tests/project-context.test.ts).

Avoid a cross-domain SQL reader that bypasses owner authorization or imports
package internals. Query assembly should consume public transaction-taking
contracts. Session use must pin the selected references and exclude later bytes;
having project membership alone is not a worker artifact-read grant. Stable
capture identities, immutable SQL guards and complete revision provenance are
deliberate TypeScript requirements beyond the smaller Python corpus JSON.

See [the research-program order](RESEARCH_PROGRAM_PARITY_PLAN.md) and
[implemented Experiments](EXPERIMENTS.md). Project synthesis, literature,
candidate management, reflection publication, claim belief history and central
Git publication remain outside this read/capture prerequisite.

## Verification

**18 existing Python tests passed in 1.728 seconds**, with no external service or
live research operation. Command from the Python `merv/` directory:

```sh
PYTHONPATH=src:. /opt/anaconda3/bin/python -m unittest -v \
  tests.workflow.test_evidence_selection \
  tests.application.test_logic_graph \
  tests.workflow.test_project_intent \
  tests.research_core.test_reflections.ReflectionWorkflowTest.test_roster_and_single_open_wave_are_enforced \
  tests.research_core.test_reflections.ReflectionWorkflowTest.test_reflection_signal_blocks_new_work_and_publish_resets_it \
  tests.research_core.test_reflections.ReflectionWorkflowTest.test_consolidation_records_every_branch_and_runner_verified_ancestry \
  tests.research_core.test_reflections.ReflectionWorkflowTest.test_reviewer_snapshot_contains_each_lens_and_rejects_producer
```

Log: `/private/tmp/merv-corpus-reference-20260915.log`.

A separate retained local probe also passed: later claim-status changes and
newly terminal work do not alter a saved corpus; failed tasks are included;
all-vs-new selection stays separate; current-attempt latest-per-role selection
ignores newer historical-attempt rows; task-only drift does not create experiment
debt; missing/truncated hydration stays explicit. Script and output:
`/private/tmp/merv-corpus-boundary-probe-20260915.py` and
`/private/tmp/merv-corpus-boundary-probe-20260915.json`.
