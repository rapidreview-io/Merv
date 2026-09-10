# Research Core

## Purpose and boundary

`research_core` owns projects, claims, native research records, reviews,
artifact associations and candidate lineage. It supplies project-scoped verified
facts and transactional record bindings to Workflows, which owns graph decisions
and agent briefs. Application composes modules; Surface owns auth and transport.
Generic Artifacts owns immutable content, Feed publishes observations, Sandbox
executes workloads, and Object Storage tracks ML workload objects.

`Research` is the public root, built from `BaseStateStore` and `ResearchArtifacts`;
Surface also injects `Workflows`. Experiment, task and reflection lifecycles use its
versioned graph/runtime; their record services remain private collaborators.

## Files
- `artifacts.py`: research-owned associations, role/target policy, accepted
  evidence, replacement visibility, and explicit immutable submission members.
  `artifact_models.py`: association projections and snapshot references.
- `research.py`: public root; project, claim, candidate writes, workflow delegation,
  snapshots, project context, membership, events, graph refs.
- `experiments.py`: experiment record binding, creation invariants, verified facts,
  evidence sealing, attempt projection, and idempotent tracking-delivery ledger. `tasks.py`: the
  task record binding, creation invariants, validated facts, and evidence sealing;
  its transitions and review returns commit through `workflows.Runtime`.
- `dependencies.py`: the wave DAG (`node_dependencies`): edges with cycle
  checks, per-node dependency and dependent rows for the shared gate and UI.
- `reflections.py`: reflection record binding, corpus snapshots, lens coverage,
  graph comparison, atomic change-spec materialization and drift facts.
- `reviews.py`: review requests, one-time capabilities, isolated sessions,
  pinned snapshots, verdicts, return routing. `association_targets.py`:
  target resolution and publication protection.
- `*_workflow.py` and `workflow_schema.py`: compatibility views of canonical graphs.
- `policy.py`: vocabulary, validation, gate evaluation, snapshot identity, reflection
  signal, limits. `evidence.py`: compatibility exports of workflow-owned pure
  document validation, evidence selection, and brief rendering. `models.py`: typed state shapes. `__init__.py`: narrow imports.
- `content_summaries.py`: deterministic TLDRs of submitted documents. `paths.py`: safe experiment folder names.

## Experiment lifecycle

The graph uses `planned -> design_review -> running -> experiment_review ->
complete`; failure and abandonment are terminal outcomes. Passing design review
immediately enters execution. Dependencies gate dispatch; actual activation starts
the attempt clock and tracking. Graph decisions, native state, and evidence sealing
commit together. Rejected design work
returns to `planned` and increments the attempt; a rejected execution review
returns to `planned` (new attempt) or `running` (keep the approved plan).

Tracking outcomes update experiment state and append an event atomically; a
keyed delivery also writes `tracking_deliveries` there, so its unique key proves
the delivery committed and prevents duplicate external runs.

A task is scoped non-experiment work with no claim: `in_progress -> in_review
-> done`, `failed` the only other ending. Goal prose + deliverables (each
verifiable as written) are IMMUTABLE structure at create (migration 53),
rendered and pinned as brief.md; brief submissions are refused. The delivery
answers one confirmation per deliverable ("not delivered — why" is legal) plus
Notes; resubmissions are complete versions, one review per version:
`needs_changes` returns, `fail` or `mark_failed` ends. State parses the
delivery (entry → state/evidence/how); `dependents` sits beside `dependencies`. Both node kinds share `node_dependencies`: an experiment
enters `running` after approval and waits for dependencies before dispatch; tasks
also wait before dispatch and `submit_delivery` (else `dependency_failed`).

## Reflection and review lifecycle

A reflection moves `reflecting -> synthesizing -> reflection_review ->
consolidating -> consolidation_review -> published`. Review makes its research artifacts
authoritative. A separate consolidator covers every experiment, a separate
reviewer approves the exact code proposal, and the runner binds it to the
Merv-owned central Git ref; only then does publication atomically materialize
the change spec and pin the graph. Code review returns only to consolidation.

A review capability is random, expiring, returned once, and stored only as a
hash; a new request supersedes older open requests for the same gate. Review
start enforces tenant scope, producer/reviewer separation, an unchanged target
snapshot, and the one-time capability or an exact assigned reviewer session;
submission rechecks that snapshot before a verdict can route a workflow.

## Read model and invariants

`Research.snapshot` is the canonical transaction-consistent project read: it
hydrates experiment, task, and reflection state in batches and returns gate
evaluations with the records they govern. Focused reads may be smaller but keep
the same project scope, attempt rules, and snapshot identity. Candidates point
to an Artifact, Object Storage object, or pathless experiment workspace awaiting
evaluator staging; staging and promotions are append-only, and promotion needs
durable bytes, a reason, and compare-and-swap against the observed champion.

All writes resolve a project through `BaseStateStore`; target lookups include
project ownership. Events commit with their state mutations. Review snapshots
are byte-stable identities of the target state and submitted evidence. Research
seals explicit association IDs on its own transaction; generic content stays
immutable and reusable. Reflection publication materializes its reviewed change
spec; its experiments and tasks pass through the same creation invariants as direct ones, a proposed task's
brief is pinned from the spec, and `depends_on` becomes DAG edges.
Compatibility reads may hydrate older rows; new writes follow current invariants.

## Maintenance rule

Keep record invariants here, workflow decisions in Workflows; at most 100 lines.
