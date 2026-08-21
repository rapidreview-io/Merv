# Research Core

## Purpose and boundary

`research_core` is the authoritative domain center for a research project. It
owns projects, claims, experiments, tasks, the wave DAG between them, reflection
waves, reviews, lifecycle gates, candidates/champion lineage, and the
transactions that keep those records consistent: what research state exists and
whether a state change is legal. The workflow declarations also name the agent
action, tools, template, and review skill for each gate. Application orchestrates
across modules and formats that guidance; Surface owns auth and wire presentation;
Sandbox executes work, Artifacts owns evidence, Feed publishes observations,
Object Storage owns heavy bytes, Literature literature.

`Research` is the one concrete public root, built from a `BaseStateStore` and
`Artifacts`, imported from `research_core` only; the experiment, task,
reflection, and review services are private collaborators.

## Files
- `research.py`: public root; project, claim, candidate writes, workflow delegation,
  snapshots, project context, membership, events, graph refs.
- `experiments.py`: experiment creation invariants, state machine, gates, sealing,
  attempts, MLflow run state, idempotent tracking-delivery ledger. `tasks.py`: the
  same for tasks (creation invariants, state machine, gates, review routing).
- `dependencies.py`: the wave DAG (`node_dependencies`): edges with cycle
  checks, per-node dependency and dependent rows for the shared gate and UI.
- `reflections.py`: reflection state machine, corpus snapshots, lens coverage,
  graph comparison, change-spec validation/materialization, drift signal.
- `reviews.py`: review requests, one-time capabilities, isolated sessions,
  pinned snapshots, verdicts, return routing. `association_targets.py`:
  target resolution and publication protection.
- `experiment_workflow.py`, `task_workflow.py`, `reflection_workflow.py`: the
  three lifecycles; the shared dependency need lives with the experiment file.
- `workflow_schema.py`: passive workflow values and declaration validation.
- `policy.py`: vocabulary, validation, gate evaluation, snapshot identity, reflection
  signal, limits. `evidence.py`: evidence selection, document checks and parsing,
  brief rendering. `models.py`: typed state shapes. `__init__.py`: narrow imports.

## Experiment lifecycle

The forward path is `planned -> design_review -> ready_to_run -> running ->
experiment_review -> complete`; failure and abandonment are terminal exits.
Every forward transition evaluates the declared gate and seals the artifact
composition in the same transaction as the state change. Rejected design work
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
waits at `ready_to_run`, a task before `submit_delivery`, until every dependency
succeeded (else `dependency_failed`).

## Reflection and review lifecycle

A reflection moves `reflecting -> synthesizing -> reflection_review ->
consolidating -> published`. Reflection review makes its research artifacts
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
are byte-stable identities of the target state and submitted evidence. Artifact
sealing uses the caller's Research transaction. Reflection publication is the
only path that materializes its reviewed change spec; its experiments and tasks
pass through the same creation invariants as direct ones, a proposed task's
brief is pinned from the spec, and `depends_on` becomes DAG edges.
Compatibility reads may hydrate older rows; new writes follow current invariants.

## Maintenance rule

Keep domain decisions here, connectivity elsewhere; stay current, dense, free of
migration history, and at most 100 lines.
