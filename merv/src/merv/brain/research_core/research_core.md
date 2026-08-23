# Research Core

## Purpose and boundary

`research_core` is the authoritative domain center for a research project. It
owns projects, the problem tree, claims, experiments, tasks, the wave DAG,
reflection waves, reviews, lifecycle gates, candidates/champion lineage, and
the transactions that keep those records consistent: what research state exists
and whether a state change is legal. Workflow declarations name each gate's
agent action, tools, template, and review skill. Application orchestrates and
formats guidance; Surface owns auth and wire presentation; Sandbox executes,
Artifacts owns evidence, Feed publishes, Object Storage owns heavy bytes,
Literature literature.

`Research` is the one concrete public root, built from a `BaseStateStore` and
`Artifacts`; the experiment, task, problem, reflection, and review services
are private collaborators.

## Files
- `research.py`: public root; project, claim, candidate writes, workflow delegation,
  snapshots, project context, membership, events, graph refs.
- `experiments.py`: creation invariants, state machine, gates, sealing, attempts,
  MLflow run state, tracking-delivery ledger. `tasks.py`: the same for tasks.
- `problems.py`: the problem tree — root charter (statement immutable, details
  versioned in events); statuses open → attempting|decomposed → solved|failed|
  stuck|moot; attempts as problem↔work many-to-many with per-problem verdicts;
  revisits full (solved/failed/stuck/next) or interim (continue/moot/resolve,
  never next); the moot cascade (terminal beats moot) reports orphaned work for
  the application layer to end. In tree mode, direct creates are refused.
- `dependencies.py`: the wave DAG — edges with cycle checks, per-node
  dependency/dependent rows for the shared gate and UI.
- `reflections.py`: reflection state machine, corpus snapshots, lens coverage,
  graph comparison, change-spec validation/materialization, drift signal.
- `reviews.py`: requests, one-time capabilities, isolated sessions, pinned
  snapshots, verdicts, routing. `association_targets.py`: target resolution.
- `experiment_workflow.py`, `task_workflow.py`, `reflection_workflow.py`: the
  three declared lifecycles (shared dependency need in the experiment file).
  `workflow_schema.py`: passive workflow values and declaration validation.
- `policy.py`: vocabulary, validation, gate evaluation, snapshot identity,
  reflection signal, limits. `evidence.py`: evidence selection, document
  checks/parsing, brief rendering. `models.py`: typed state shapes.

## Experiment lifecycle

The forward path is `planned -> design_review -> ready_to_run -> running ->
experiment_review -> complete`; failure and abandonment are terminal exits.
Every forward transition evaluates the declared gate and seals the artifact
composition in the same transaction; rejected design review returns to
`planned` (new attempt), rejected execution review to `planned` or `running`.

Tracking outcomes update experiment state and append an event atomically; a
keyed delivery writes `tracking_deliveries` there, its unique key proving the
delivery committed and preventing duplicate external runs.

A task is scoped non-experiment work with no claim: `in_progress -> in_review
-> done`, `failed` the only other ending. Goal prose + deliverables (each
verifiable as written) are IMMUTABLE at create, rendered and pinned as brief.md
(brief submissions refused). The delivery answers one confirmation per
deliverable ("not delivered — why" is legal) plus Notes; one review per
complete version (`needs_changes` returns, `fail`/`mark_failed` end). Both node
kinds share `node_dependencies`: an experiment waits at `ready_to_run`, a task
before `submit_delivery`, until every dependency succeeded (else `dependency_failed`).

## Reflection and review lifecycle

A reflection moves `reflecting -> synthesizing -> reflection_review ->
consolidating -> published`; review makes its research artifacts authoritative,
a separate consolidator covers every experiment, a separate reviewer approves
the exact code proposal, the runner binds it to the central Git ref, and only
then does publication materialize the change spec and pin the graph. Code
review returns only to consolidation. Retired for `problem_tree` projects.

A review capability is random, expiring, returned once, and stored only as a
hash; a new request supersedes older open requests for the same gate. Start
enforces tenant scope, producer/reviewer separation, an unchanged target
snapshot, and the one-time capability or exact assigned reviewer session;
submission rechecks that snapshot before a verdict can route a workflow.

## Read model and invariants

`Research.snapshot` is the canonical transaction-consistent project read: it
hydrates experiment, task, reflection, and problem-tree state in batches and
returns gate evaluations with the records they govern; focused reads stay
project-scoped with the same attempt rules and snapshot identity. Candidates
point to an Artifact, Object Storage object, or pathless experiment workspace
awaiting evaluator staging; staging and promotions are append-only, and
promotion needs durable bytes, a reason, and compare-and-swap on the champion.

All writes resolve a project through `BaseStateStore`; target lookups include
project ownership. Events commit with their state mutations. Review snapshots
are byte-stable identities of target state plus submitted evidence; artifact
sealing uses the caller's Research transaction. Reflection publication and
problem attempts create work through the same creation invariants as direct
creates (task briefs pinned, `depends_on` becomes DAG edges). Compatibility
reads may hydrate older rows; new writes follow current invariants.

## Maintenance rule

Keep domain decisions here, connectivity elsewhere; stay current, dense, free of
migration history, and at most 100 lines.
