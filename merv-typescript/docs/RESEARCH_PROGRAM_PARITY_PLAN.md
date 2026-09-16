# Research-program parity: implementation order

Source audit: 2026-09-15. Claims and the production Experiments implementation
are integrated and verified through native workers and the browser; the remaining
research integrations below stay open. Finish each bounded integration and its checks
before starting the next one.

The first complete research slice is a real **Experiment**: create a research
question, review its plan, execute the approved plan, retain the attempt's
results, independently review them, and record completion or a precise return
path. An ordinary task using the `experiment.plan` recipe does not supply these
records or transitions. A standalone demonstration Code workflow would not
supply them either.

## Current foundation and missing domain

State, Scope, Artifacts/Blobs, Workflows, Reviews, Context Builder, Domain Events,
Sessions and the machine Runner provide usable infrastructure. Claims now adds
real project research statements through its provider, tools and UI. Tasks implements
its own managed program. Workflows already provides revision checks, dependency
gates, assignments, first activation, fixed tool authority and lease hooks.

Code commit receipts, proposal sealing, generic review routing and explicit
review return paths are integrated **prerequisites**. Use them from actual
domain commands. `Code.seal` does not create an experiment, a reflection corpus,
a consolidation decision, or permission to publish central. Generic live
fixtures prove their stated mechanisms only. See [Code publication ordering](CODE_PUBLICATION_PLAN.md).

The current task recipes explicitly remain planning/reflection tasks:
[definitions](../packages/tasks/src/definitions.ts),
[Context Builder limits](../packages/context-builder/README.md).
The [Claims foundation](CLAIMS.md) is integrated. Experiments now provides real records, attempts, evidence, both review stages,
recovery recipes and scoped tools/UI. Project-knowledge and Reflections providers
remain open. Review routing and sealing passed the
[553-test checkpoint and native acceptance](../verification/code-proposals.json).
That support acceptance permits the domain work below; it does not replace it.
The later [return-path prerequisite](REVIEW_RETURN_PATHS.md) passed the 574-test
checkpoint. The [exact Experiment reference](EXPERIMENTS_PARITY_REFERENCE.md)
now records the current Python fields, artifact/metrics contracts and attempt
semantics from 41 passing reference tests. Experiments passes 610 full-suite
tests; four fresh native workers and browser acceptance also pass. The overall parity
goal is active.

## Proposed ownership

Use domain providers, with ordinary internal modules for their smaller parts:

| Owner                                    | Owns                                                                                                                                                               | Requires                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Existing Claims provider                 | Project-scoped claim facts and changes                                                                                                                             | State, Scope                                                                                                           |
| Experiments, implemented managed program | Experiments, attempts, evidence associations, immutable submission rounds, deterministic metrics exhibits, experiment graph reads, review application and recovery | State, Scope, Claims, Artifacts, Workflows, Reviews, Context Builder; existing generic lifecycle hooks supply recovery |
| Existing Artifacts                       | Immutable content and file metadata                                                                                                                                | Existing dependencies; no experiment state in Blobs                                                                    |
| Existing Reviews                         | Exact evidence manifests, independent claims, immutable assessments, dispatch to one registered domain owner                                                       | Existing dependencies; no experiment transition switch in Reviews                                                      |
| Existing Workflows                       | Generic graph/revision/dependency/assignment/lease machinery                                                                                                       | Existing dependencies; Experiments supplies its rules                                                                  |
| Reflections, a later managed program     | Frozen research corpus, lens children, synthesis, approved research, experiment decision coverage and domain publication                                           | Experiments, Tasks, Claims, Artifacts, Workflows, Reviews, Context Builder, Code and the reviewed-publication contract |

Names for new packages are proposed; these ownership boundaries are the
requirement. Do not create separate Attempts, Metrics, Plan Context or Review
Context plugins. Keep their code with Experiments until another real consumer
justifies extracting a shared capability. Register context recipes from the
owning program. Transport/UI adapters consume public contracts only.

Experiments can use Code's public receipt contract when its execution produces
reviewable code; it must declare that provider dependency if it calls the
service. The machine Runner remains separate and uses authenticated HTTP.
Neither Experiments nor Reflections launches processes or reads a host checkout.

## Ordered integrations

### 0. Existing support prerequisite — verified

Code's immutable sealing and the single Reviews verdict router are integrated. Preserve
Tasks behavior and the fixed-session checks during unload/restart. Do not add a
new standalone Code program to claim research coverage. Native tests of support
remain separate from the future experiment acceptance.

The [review-application return choice](REVIEW_RETURN_PATHS.md) is now integrated
as optional `returnTo`. The selected program validates its meaning; Reviews
retains it with the immutable verdict. Old omitted/undefined input and receipt
shapes are preserved, while Tasks refuses any supplied route before replay.
Experiments must require `planned` versus `running` for both `needs_changes`
and `fail`; do not infer that choice from prose or reuse Tasks' terminal fail
mapping.

This prerequisite passed 574 full-suite tests, 30 focused checks and 17
independent checks. Two fresh native reviewers completed seven successful MCP
calls with no failures and read all three pinned artifacts in full. They routed
`fail → planned` and `needs_changes → running` through a synthetic owner. The
producer and approved plan were seeded; these destinations end that fixture.
This is not production Experiment or four-stage scientific acceptance.

### 1. Claim facts — integrated

The independent Claims provider and `claim.create`, `claim.list`, `claim.update`
are implemented with State/Scope only. Records have project identity, statement,
prose scope, status/confidence, revision, creator/updater and timestamps. Initial
status is `active`; confidence defaults to `medium`. Public updates change only
status/confidence, with revision CAS and stable original request receipts.
Every accepted new update, including the same values, records an event and
advances revision. Current authorization is required even for replay.

Core and HTTP/MCP checks cover permissions, foreign IDs, conflicts, rollback,
concurrent writers, restart, fixed session tools and plugin unload. The full
checkpoint passed 566 tests, including 13 Claims-specific tests; two fresh native
agents completed nine successful MCP calls with no failures. A role-aware Claims
UI passed built-browser checks for exact retry recovery, stale revision conflicts,
project switching and reader permissions using synthetic local credentials.
The 566-test suite also passed after the UI retry fix. Real provider login was
not exercised. See [the implemented contract and limits](CLAIMS.md).

Later reflection publication still needs a trusted transaction-taking writer
for reviewed statement/scope changes and publication provenance. Linked
experiment evidence and belief-history UI also remain open. A passing experiment
must not automatically mark a claim supported. None of these gaps turns claim
status into a workflow lifecycle or creates a Claims dependency on Reflections.

Experiments uses these real claim IDs; its acceptance evidence follows below.
[Claim source][py-claims], [contracts][py-contracts].

### 2. Complete experiment vertical slice — integrated

The following increments are implemented. Each increment includes tools,
the registered workflow rules, context and the existing plugin-driven UI. All increments pass the [610-test, native and browser checkpoint](../verification/experiments.json).
Use [EXPERIMENTS_PARITY_REFERENCE.md](EXPERIMENTS_PARITY_REFERENCE.md) for the
source-backed command fields, byte caps, exact review return rules, immutable
rounds, graph shape and deterministic metrics record. It distinguishes deliberate
TypeScript revision/path/JSON strengthening from legacy Python behavior.

**2a. Records and evidence ownership.** Add experiment creation/reads, an attempt
record, current evidence slots and immutable submission history. Creation stores
the immutable name/intent/details, linked claims, original owner and generic
work dependencies in one transaction. Names are folder-safe and unique within
the project; linked claims and dependencies must be in that project. Preserve
the Python active-experiment cap of seven. Separate the logical owner from the
actual worker that authored each plan/result submission.

**2b. Plan and independent design review.** Accept a complete plan, seal its
exact artifact selection and create the design review while moving to
`design_review`. A pass pins the approved plan and moves directly to `running`.
A rejection returns to `planned` with a new attempt; it does not permit
execution. The planning/design phase can proceed before execution dependencies
finish. `running` assignments, activation and result submission must respect
those dependencies; there is no additional `ready` state.

**2c. Execution, quantitative evidence and attempt review.** Execute the pinned
plan, retain all relevant results, build the deterministic exhibit described
below, and seal result/report/graph evidence into a new submission round.
Create an independent attempt review and move to `experiment_review` in the
same transaction. Its pass completes the experiment; its rejection explicitly
returns to plan revision or execution repair. Add interruption retry and the
terminal abandon/failure commands before calling this lifecycle complete.

**2d. Real Sessions/Runner, recovery and UI.** Register all four node assignments
and bounded policies. Use existing generic lease hooks for exact producer work
ownership and Reviews claims. Register the program as the sole submit owner for
its reviews. Native execution, metadata dispatch and context selection must
observe the same state and authority as commands. Add the experiment list/detail,
gate guidance, current attempt, sealed history, review feedback and graph view.
Surface committed domain events in Feed. Optional UI/Feed unload must not break
the experiment's domain transactions.

Do not activate an unfulfillable reflection-debt creation block during this
slice. Record/read the terminal-work facts needed later, and document that the
Python reflection-freshness gate is still pending until its actual repair path
can run. The active cap remains enforceable without Reflections.

### 3. Add authoritative project knowledge and corpus queries

Build the read model needed by actual reflection: project introduction, claims,
all terminal experiments and their sealed attempts, completed tasks, and the
latest published graph/reflection references. Keep unpublished research clearly
separate from the last publication. A project with no published reflection has
no authoritative published graph; do not manufacture one from a recipe result.

Add stable capture IDs and exact Git object references for code-producing
attempts. Consume trusted Session workspace results or accepted live Code
receipts with project/instance/attempt/revision/worker provenance. Do not use a
mutable latest-head lookup as the definition of what a later agent reviewed.
Provide the same scoped graph-reference resolver for experiment and project
views; unresolved references remain explicit.

This stage supplies a query and immutable source-selection contract for the
next program. It does not yet claim the full Methods/Results authoring or
literature-maintenance programs. Those remain separate parity work.

### 4. Implement actual reflection through approved research

Only after real experiments exist, implement one open reflection per project,
its five-lens roster, versioned child workflows, join and synthesis. Freeze at
wave creation: **all** terminal experiments, terminal tasks, claims, previous
published graph/reflection and previous lens references. Track newly terminal
work separately as the reason for the wave; it is not the whole corpus.

Require lens coverage plus the project graph, reflection document and validated
change spec. Independent reflection review can return to synthesis in the same
attempt or reopen lenses in a new attempt. Its pass freezes the authoritative
research and enters consolidation. Context comes from these server records,
never the caller-supplied `project.reflection` task inputs.

Integrate reserved names, prospective experiment-cap slots and same-project
change-spec validation before publication can depend on them. Enable the
reflection creation/freshness policy only with a usable end-to-end route;
Python recommends at one newly terminal experiment, nudges at three, and blocks
new experiments at five. Keep actual unresolved publication work visible.

### 5. Implement reflection-owned consolidation and publication

The approved reflection program admits the consolidator. It calls Code sealing
inside its own proposal transaction, adds one decision for every experiment in
the frozen corpus, and requests the exact independent consolidation review.
Tasks are corpus inputs, not experiment decision subjects. Rejection returns
only to consolidation; it cannot reopen the approved research.

Then implement reviewed publication intent, repository authority, runner CAS
and immutable receipt reconciliation, followed by separate retryable domain
publication. Publication applies the approved graph/claim changes and creates
the planned tasks/experiments plus dependency edges atomically. Validate the
change-spec rule that new experiments cannot depend on sibling experiments,
including through a task; prior-wave lineage is not an implicit dependency.
No local Git merge, Code receipt or passing review alone marks the reflection
published. Follow [the publication plan](CODE_PUBLICATION_PLAN.md).

## The experiment records that must exist

These are domain facts, not necessarily one table each. Keep a single canonical
owner for each; do not duplicate workflow state or artifact bytes.

| Record                 | Required facts and invariants                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Experiment             | Project, name, immutable intent/details, logical owner, tested claim IDs, workflow ID/version, conclusion and creation provenance. Workflows owns current state/revision and dependency edges.                        |
| Attempt                | Monotonic index starting at one, revision feedback, exact approved-plan submission/review IDs, first actual execution start, prior-attempt link. A return to `planned` creates the next attempt.                      |
| Evidence association   | Artifact ID/hash, experiment/attempt, role, logical relative path, submitting actor/session, order and current-slot status. The server never reads this path from an agent filesystem. Artifacts owns bytes/metadata. |
| Submission round       | Immutable ID, experiment/attempt, stage, workflow revision, exact evidence manifest/hash, producer actor/session, creation event. More than one results round may belong to one attempt.                              |
| Review association     | Design or attempt stage, exact submission and criteria, Reviews request/claim IDs, current expected workflow revision, actual producer and independently assigned reviewer.                                           |
| Exhibit                | System-authored immutable artifact derived from exact result IDs/hashes, attempt and execution-start window. Preparation/revision checks and the selected result set are retained.                                    |
| Code/capture reference | When applicable: immutable command/capture identity, repository/workspace IDs, full base/head/tree OIDs and producing session/attempt/revision; never a guessed branch head.                                          |

Slot replacement is not deletion. Before sealing, the newest evidence in a
logical slot is current; older sealed selections stay reachable through their
submission IDs. Reject stale uploads/attachments across attempt or workflow
revision changes. A newer uploaded plan never replaces the approved plan in
execution context. Preserve evidence on actor/session loss; release only the
dead work/review ownership and build successor context from explicit receipts.

## Exact lifecycle and gates

| From                  | Authorized event/action                          | To and effect                                                                                    |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `planned`             | Owner submits a valid plan                       | `design_review`; seal plan, request independent review                                           |
| `design_review`       | Independent pass                                 | `running`; pin the exact approved plan; do not start execution time yet                          |
| `design_review`       | Rejection                                        | `planned`; increment attempt, clear approval/start, retain feedback/history                      |
| `running`             | Owner submits complete evidence                  | `experiment_review`; pin exhibit/evidence and independent review                                 |
| `running`             | Infrastructure retry                             | `running`; advance workflow revision, keep attempt/approval/first start, append recovery context |
| `experiment_review`   | Independent pass                                 | `complete`; retain conclusion and assessed outcome                                               |
| `experiment_review`   | Rejection with `returnTo=running`                | `running`; same attempt/approved plan, new evidence round permitted                              |
| `experiment_review`   | Rejection with `returnTo=planned`                | `planned`; new attempt and a new design review required                                          |
| Any nonterminal state | Authorized `abandon` / `mark_failed` with reason | `abandoned` / `failed`; close open reviews/leases safely, retain evidence                        |

Reviewers must grade the exact immutable submission. Plan review and attempt
review have different criteria and context. Their recorded producer is the
worker who authored that submission, not the source human or whichever lease
was most recent. Approved plans and explicitly selected recovery inputs are
pinned inputs; all remaining output evidence must have valid author provenance.
Same-human separate workers can be independent; one producing worker cannot
review its own submission. Generic Reviews validates assessment shape, while
Experiments owns the target checks and route in the same transaction.

### Evidence and metrics

- Plan Markdown requires **Summary**, **Objective & hypothesis**, **Evaluation**.
  Structural validation does not decide whether the experiment is scientifically
  useful; design review does.
- Results require `result`, `report`, `graph` evidence. Report requires **Summary**,
  **Results**, **Deviations from plan**, **Conclusion**, with retained figure
  references. When an exhibit is pinned, the report must reference and interpret
  it. Keep raw runs/logs in artifacts, not the report.
- The logic graph is versioned JSON with unique labeled node IDs and valid
  directed edges, no self-loop/cycle, and bounded size. Python uses version 1,
  at most 16 nodes and 16,000 bytes. Resolve evidence/claim references through
  project-scoped services; graph validity is not proof of the hypothesis.
- Current Python metrics are **a deterministic observation bundle**, not an
  optimizer, metric database or automatic scientific verdict. The exhibit
  contains project/experiment/attempt, execution-start window, and result files
  with parsed data plus path/artifact/hash/submission provenance. Identical
  inputs give identical bytes. Retain failed/aborted runs as evidence too.
- Its current parser is JSON; descriptions mention CSV, but the implementation
  does not parse CSV. Implement bounded finite JSON faithfully first. CSV support
  must be an explicit additional contract, not an assumed existing capability.
  Qualitative result artifacts can proceed without an exhibit. Distinguish an
  intentionally qualitative artifact from invalid declared JSON rather than
  silently treating malformed quantitative evidence as qualitative.
- Prepare byte reads outside the write transaction when needed, then recheck
  revision, attempt and the exact source manifest before pinning/submission.
  Preview must not mutate workflow state. Only the system may author/replace
  the metrics exhibit; agents cannot bypass its provenance by uploading that role.

### Minimal public surface

Keep the Python domain vocabulary where useful; proposed TypeScript names follow
current casing. All mutations have strict schemas and stable `requestId`; target
mutations carry `expectedRevision`. Session bindings supply actor/project/current
assignment authority, never model-selected identity.

| Interface                                            | Purpose                                                                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experiment.create`                                  | Name, intent, details, testedClaimIds, dependsOn; returns the native experiment and next gate                                                                                                                               |
| `experiment.list`, `experiment.get_state`            | Native record, attempt, evidence/submission metadata and reviews; no artifact-byte reads                                                                                                                                    |
| `artifact.create/read/get` plus `experiment.attach`  | Reuse content services; the new program-owned attachment command records role/path/current attempt and checks authority. A shared attachment capability can be extracted later when another domain needs the same contract. |
| `experiment.transition`                              | Only owner actions: submit_design, submit_results, retry_running, abandon, mark_failed; no producer approve/complete action                                                                                                 |
| `experiment.exhibit`                                 | Read-only preview of the current running attempt's deterministic exhibit                                                                                                                                                    |
| Existing `review.get/start/submit`                   | One generic tool provider; Experiments registers ownership and applies its two review kinds/routes                                                                                                                          |
| Existing `workflow.status_and_next/assignment/begin` | Shared canonical guidance, node context and first activation; program commands remain authoritative                                                                                                                         |

Four context formulas belong to Experiments: plan, design review, execution,
attempt review. No separate adapter plugins. Reviewer context includes the
pinned submission and exact approved plan. Running context includes recovery
receipts and completed work so replacement workers do not blindly rerun it.

A code-reviewing node must pin a real `code` reference before offering a Git
checkout. It may use a completed live Code receipt before handoff; document-only
review can explicitly use workspace mode `none`. Never add an implicit central
fallback for a missing `reference:code`, or review a later final capture as if it
were the original submitted commit.

## Experiment implementation constraints

- Register the four domain recipes as `experiment.design`,
  `experiment.design_review`, `experiment.execute` and
  `experiment.attempt_review`. Do not collide with the existing Tasks
  `experiment.plan@1` recipe or treat that task recipe as the new program.
  These formulas live in Experiments; no context-adapter plugins are needed.
- Review lease source admission checks `Scope.require(source, 'review')` and
  domain eligibility, not `Reviews.checkStart(source)`. The newly created worker
  acquires the review claim. This preserves separate worker independence under
  the same source account/key without treating the source as the reviewer.
- Lease release uses its exact original receipt and original claim ID. A delayed
  release must never locate and release whichever successor claim happens to be
  current. Preserve all evidence and assessment history when ownership ends.
- Derive the attempt's first actual execution time from `Workflows.workStarts`
  within that attempt's revision interval. Design approval and later worker
  activation/retry must not replace its first running start.
- Freeze recovery association metadata in the offered assignment. Only verified
  current-worker outputs may extend those references. Compute review
  `pinnedInputIds` on the server from approved domain inputs; caller-supplied
  IDs must not turn somebody else's output into authorized producer evidence.
- Fence production owner writes while the current revision has a live lease.
  A general logical-owner credential must not write around the active worker's
  ownership. Keep source authority, worker identity, revision and exact claim
  checks in the same transaction as evidence and transition changes.
- Keep `experiment.get_state` metadata-only, with no artifact byte reads or
  implicit context rebuilding. Explicit artifact reads, exhibit construction,
  workflow gate validation and Context Builder own those separate operations.

## Completion evidence before moving to reflection

1. Deterministic domain tests cover the whole lifecycle, both rejection routes,
   same-attempt result rounds, exact approved-plan retention, qualitative and
   quantitative evidence, stale metric preparation, dependencies and terminal exits.
2. HTTP/MCP tests use the actual program tools, fixed grants, same-account
   independent workers, expired source/claims, request replay and wrong-project
   refusals. A forged `plan_present` or raw outcome never bypasses evidence gates.
3. Restart/unload tests retain experiment/attempt/submission/review records;
   returning providers restore the same program version. Recovery leaves previous
   evidence intact and fences retired workers. Metadata dispatch does not read
   artifact bytes or render context.
4. Native acceptance uses **the production Experiments program**, an actual claim,
   a small falsifiable local experiment and four fresh leased stages: designer,
   design reviewer, executor, attempt reviewer. Verify real retained result data,
   report/graph, exhibit, actual verdicts and source attribution. No fixture-only
   `step.*` routes or task recipes count as this proof. Long/cloud computation
   remains with the independent sandbox service; a local first slice must state
   that limitation rather than rebuilding sandbox orchestration inside Experiments.
5. UI shows the same gate, pinned plan, attempt/result rounds and verdict as the
   server; Feed displays committed events. Record this acceptance separately from
   the existing Code/Runner demonstrations.

## Reference evidence

The following current Python modules/tests define the behavior above. These are
source references, not instructions to copy Python's storage layout verbatim.

| Concern                                             | Source and focused tests                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| States, gates, attempt returns, assignment formulas | [Experiment definition][py-experiment-graph]; [graph tests][py-experiment-graph-tests], [runtime tests][py-experiment-runtime], [experiment tests][py-experiment-tests]                    |
| Creation, claims, active cap, actual execution time | [Experiment records][py-experiments], [claim writer][py-claims], [constants][py-contracts]                                                                                                 |
| Evidence associations and immutable rounds          | [Research artifacts][py-artifacts], [submission model][py-artifact-models]; [attempt tests][py-attempt-tests]                                                                              |
| Deterministic metrics and preparation fencing       | [exhibit builder][py-exhibit], [source selection][py-exhibit-sources], [transition coordinator][py-experiment-transition]; [metrics tests][py-metric-tests]                                |
| Graph validation and scoped read models             | [document schemas][py-documents]; [graph read tests][py-graph-tests]                                                                                                                       |
| Reflection corpus, children and publication         | [reflection records][py-reflections], [corpus][py-corpus], [reflection graph][py-reflection-graph]; [reflection tests][py-reflection-tests], [child/wave tests][py-reflection-graph-tests] |

On 2026-09-15, **41 Python reference tests passed in 3.501 seconds** using:

```sh
cd ../merv
PYTHONPATH=src:. /opt/anaconda3/bin/python -m unittest -v \
  tests.research_core.test_experiments \
  tests.research_core.test_experiment_runtime \
  tests.state.test_submission_attempts \
  tests.workflow.test_metrics_exhibit \
  tests.workflow.test_experiment_graph \
  tests.application.test_logic_graph
```

Local log: `/private/tmp/merv-research-program-reference-tests.log`. These tests
exercise Python only; no new TypeScript research capability or native-agent run
was performed for this plan. The separate proposal/review audit passed 22 tests
and is recorded at `/private/tmp/merv-code-proposal-reference-tests.log`.

[py-experiment-graph]: ../../merv/src/merv/brain/workflows/definitions/experiment.py
[py-experiments]: ../../merv/src/merv/brain/research_core/experiments.py
[py-claims]: ../../merv/src/merv/brain/research_core/research.py
[py-contracts]: ../../merv/src/merv/brain/workflows/definitions/research_contracts.py
[py-artifacts]: ../../merv/src/merv/brain/research_core/artifacts.py
[py-artifact-models]: ../../merv/src/merv/brain/research_core/artifact_models.py
[py-documents]: ../../merv/src/merv/brain/workflows/definitions/documents.py
[py-exhibit]: ../../merv/src/merv/brain/application/experiments/metrics_exhibit.py
[py-exhibit-sources]: ../../merv/src/merv/brain/application/experiments/exhibits.py
[py-experiment-transition]: ../../merv/src/merv/brain/application/experiments/transition.py
[py-reflections]: ../../merv/src/merv/brain/research_core/reflections.py
[py-corpus]: ../../merv/src/merv/brain/workflows/definitions/reflection_corpus.py
[py-reflection-graph]: ../../merv/src/merv/brain/workflows/definitions/reflection.py
[py-experiment-tests]: ../../merv/tests/research_core/test_experiments.py
[py-experiment-runtime]: ../../merv/tests/research_core/test_experiment_runtime.py
[py-experiment-graph-tests]: ../../merv/tests/workflow/test_experiment_graph.py
[py-attempt-tests]: ../../merv/tests/state/test_submission_attempts.py
[py-metric-tests]: ../../merv/tests/workflow/test_metrics_exhibit.py
[py-graph-tests]: ../../merv/tests/application/test_logic_graph.py
[py-reflection-tests]: ../../merv/tests/research_core/test_reflections.py
[py-reflection-graph-tests]: ../../merv/tests/workflow/test_reflection_graph.py
