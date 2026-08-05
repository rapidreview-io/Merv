# Research Core

## Purpose and boundary

`research_core` is the authoritative domain center for a research project. It
owns projects, claims, experiments, reflection waves, reviews, lifecycle gates,
project candidates/champion lineage, and the transactions that keep those
records consistent. It answers what research state exists and whether a state
change is legal.

The workflow declarations also name the agent action, tools, template, and
review skill for each gate. Application owns cross-module orchestration and
formats that guidance. Surface owns authentication, access checks, and wire
presentation. Sandbox executes work, Artifacts owns evidence, Feed publishes
observations, Object Storage owns heavy bytes, and Literature owns literature.

## Public boundary

`Research` is the one concrete public root. Composition constructs it with a
`BaseStateStore` and `Artifacts`; callers import it from `research_core`, not
from implementation files. Experiment, reflection, and review services are
private collaborators selected by `Research`, never an alternate public path.

## Files

- `research.py`: public root; project, claim, and candidate writes, workflow
  delegation, snapshots, project context, membership, events, and graph refs.
- `experiments.py`: shared experiment-creation invariants, experiment state
  machine, gate evaluation, artifact sealing, attempt handling, MLflow run
  state, and idempotent tracking-delivery ledger.
- `reflections.py`: reflection state machine, corpus snapshots, lens coverage,
  graph comparison, change-spec validation/materialization, drift signal.
- `reviews.py`: review requests, one-time capabilities, isolated sessions,
  pinned snapshots, verdict submission, and return routing.
- `association_targets.py`: Research-owned target resolution and publication
  protection used by Artifacts.
- `experiment_workflow.py`: the complete experiment lifecycle and guidance.
- `reflection_workflow.py`: the complete reflection lifecycle and start policy.
- `workflow_schema.py`: passive workflow values and declaration validation;
  persisted workflow states and transitions live only in those declarations.
- `policy.py`: pure vocabulary, validation, gate evaluation, snapshot identity,
  reflection signal, and limits.
- `evidence.py`: pure evidence selection and document/graph envelope checks.
- `models.py`: shared immutable results and typed state shapes.
- `__init__.py`: deliberately narrow package import surface.

## Experiment lifecycle

The forward path is `planned -> design_review -> ready_to_run -> running ->
experiment_review -> complete`; failure and abandonment are terminal exits.
Every forward transition evaluates the declared gate and seals the current
artifact composition on the same database transaction as the state change.
Rejected design work returns to `planned` and increments the attempt. A rejected
execution review returns to `planned` for a new plan attempt or to `running` to
revise execution without invalidating the approved plan.

Tracking outcomes update experiment state and append an event atomically. A
keyed delivery also writes `tracking_deliveries` in that transaction; its unique
key proves that a delivery committed and prevents duplicate external runs.

## Reflection and review lifecycle

A reflection moves `reflecting -> synthesizing -> reflection_review ->
consolidating -> published`. Reflection review makes its research artifacts
authoritative. A separate consolidator covers every experiment, a separate
reviewer approves the exact code proposal, and the runner binds it to the
Merv-owned central Git ref. Only then does publication atomically materialize
the change spec and pin the graph. Code review can return only to consolidation;
it can never reopen reflection.

A review capability is random, expiring, returned once, and stored only as a
hash. A new request supersedes older open requests for the same gate. Review
start enforces tenant scope, producer/reviewer separation, an unchanged target
snapshot, and either the one-time capability or an exact assigned reviewer
session. Submission rechecks that snapshot before a verdict can route a workflow.

## Read model and invariants

`Research.snapshot` is the canonical transaction-consistent project read. It
hydrates experiment and reflection state in batches and returns gate evaluations
with the records they govern. Focused reads may be smaller but must preserve the
same project scope, attempt rules, and snapshot identity.

Candidates point to an Artifact, Object Storage object, or pathless experiment
workspace awaiting evaluator staging. Staging and promotions are append-only;
promotion requires durable bytes, a reason, and compare-and-swap against the
observed champion. Overview is bounded; `candidate.list` retains full history.

All writes resolve a project through `BaseStateStore`; target lookups include
project ownership. Events commit with their state mutations. Review snapshots
are byte-stable identities of the target state and submitted evidence. Artifact
sealing uses the caller's Research transaction. Reflection publication is the
only path that materializes its reviewed change spec, and its experiments pass
through the same creation invariants as direct experiments. Compatibility reads
may hydrate older rows; new writes follow the current invariants.

## Maintenance rule

Keep domain decisions here and connectivity elsewhere. Keep this guide current,
dense, free of migration history, and at most 100 lines.
