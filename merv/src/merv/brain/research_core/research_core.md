# Research Core

## Purpose and boundary

`research_core` owns projects, claims, native research records, reviews, artifact
associations and candidate lineage. It supplies project-scoped verified facts and
transactional record bindings to Workflows, which owns graph decisions and agent briefs.
Application composes modules; Surface owns auth and transport. Generic Artifacts owns
immutable content, Feed publishes observations, and merv-sandboxes runs workloads and
stores ML objects; Research records their producer. `Research` is the public root, built
from `BaseStateStore` and `ResearchArtifacts`; Surface also injects `Workflows`. Every
native record runs on one engine; its service keeps only that kind's own rules.

## Files
- `records.py`: the engine every native record runs on. Workflows declares a `RecordKind`
  beside each graph — table, id prefix, insert and JSON columns, which UPDATE each action
  writes, whether dependency rows apply, any status projection — and this is the runtime
  that interprets it: one create (also on a caller's connection), one hydration, one gate
  evaluation, one `RecordKnowledge`, one commit. `RecordHooks` carries the per-kind steps
  that need the open transaction, and `read_fact` a reference only that kind knows.
- `artifacts.py`: research-owned associations, role/target policy, accepted evidence,
  replacement visibility, immutable submission members. `artifact_models.py`: association
  projections and snapshot references.
- `research.py`: public root; only what crosses the kinds — project, claim and candidate
  writes, snapshots, project context, membership, events, graph refs. One kind is reached at `experiments`/`tasks`/`reflections`/`reviews`, never forwarded through here.
- `experiments.py`: what is true of experiments alone — the create blocks (active cap,
  reserved wave name, reflection debt), claim links, the attempt clock, the metrics
  exhibit. `tasks.py`: the immutable goal, its pinned brief, and delivery parsing.
- `dependencies.py`: the wave DAG (`node_dependencies`): edges with cycle checks, and the
  per-node dependency and dependent rows the shared gate and the UI read.
- `reflections.py`: the wave's own machinery — single-open-wave guard, the rows behind its
  fixed corpus, lens pinning, reserved names, change-spec materialization and drift facts;
  its reads are declared in `definitions/reflection_corpus.py`.
- `reviews.py`: review requests, one-time capabilities, isolated sessions, pinned snapshots,
  verdicts, return routing. `association_targets.py`: target resolution. `objects.py`:
  `ResearchObjects` — the object facade's lifecycle hook and its `ProducedObject` snapshot.
- `policy.py`: the record kinds and their status vocabulary read off the graphs, plus
  validation, snapshot identity, review-return routing, reflection signal, limits, and one
  resolver per declared requirement kind — artifact, record, dependencies, review — each
  returning one checklist item keyed `artifact:`/`record:`/`review:` plus the role; only
  the review gate reads rows, the rest read the evaluation the graph produced. `models.py`:
  typed state shapes and `public_record`, the one projection every presenter applies to a
  `Public` declaration. `__init__.py`: narrow imports.
- `content_summaries.py`: deterministic TLDRs of submitted documents. `paths.py`: safe experiment folder names. `tools.py`: the experiment/task/reflection/consolidation/review/claim/candidate/litreview MCP contracts, their enums and prose read off the graphs above; the support registry merges the table. `persistence.py`: every research table, its read-path indexes, and the `research_artifacts` view that joins a link row to the immutable content it names.

## Experiment lifecycle

The graph uses `planned -> design_review -> running -> experiment_review -> complete`;
failure and abandonment are terminal outcomes. Passing design review immediately enters
execution. Dependencies gate dispatch; actual activation starts the attempt clock. Graph
decisions, native state, and evidence sealing commit together. Rejected design work returns
to `planned` and increments the attempt; a rejected execution review returns to `planned`
(new attempt) or `running` (keep the approved plan).

A task is scoped non-experiment work with no claim: `in_progress -> in_review -> done`,
`failed` the only other ending. Goal prose + deliverables (each verifiable as written) are
IMMUTABLE structure at create, rendered and pinned as brief.md; brief submissions are
refused. The delivery answers one confirmation per deliverable ("not delivered — why" is
legal) plus Notes; resubmissions are complete versions, one review per version:
`needs_changes` returns, `fail` or `mark_failed` ends. State parses the delivery (entry →
state/evidence/how); `dependents` sits beside `dependencies`. Both node kinds share
`node_dependencies`: an experiment enters `running` after approval and waits for
dependencies before dispatch; tasks also wait before dispatch and `submit_delivery`.

## Reflection and review lifecycle

A reflection moves `reflecting -> synthesizing -> reflection_review -> consolidating ->
consolidation_review -> published`; the row has no column for the last review state, so a
declared projection keeps every reader on `consolidating`. Review makes its research
artifacts authoritative. A separate consolidator covers every experiment, a separate
reviewer approves the exact code proposal, and the runner binds it to the Merv-owned
central Git ref through Agent Sessions' receipt; only then does publication atomically materialize the change spec and pin
the graph. Code review returns only to consolidation.

A review capability is random, expiring, returned once, and stored only as a hash; a new
request supersedes older open requests for the same gate. Review start enforces tenant
scope, producer/reviewer separation, an unchanged target snapshot, and the one-time
capability or an exact assigned reviewer session; submission rechecks that snapshot before
a verdict can route a workflow.

## Read model and invariants

`Research.snapshot` is the canonical transaction-consistent project read: it hydrates
experiment, task, and reflection state in batches and returns gate evaluations with the
records they govern. Focused reads may be smaller but keep the same project scope, attempt
rules, and snapshot identity. Candidates point to an Artifact, a merv-sandboxes object, or
pathless experiment workspace awaiting evaluator staging; staging and promotions are
append-only, and promotion needs durable bytes, a reason, and compare-and-swap against the
observed champion.

All writes resolve a project through `BaseStateStore`; lookups include project ownership. Events commit with their state mutations. Review snapshots are byte-stable
identities of the target state and submitted evidence. Research seals explicit association
IDs on its own transaction; generic content stays immutable and reusable. Reflection
publication materializes its reviewed change spec; its experiments and tasks pass through
the same creation invariants as direct ones, a proposed task's brief is pinned from the
spec, and `depends_on` becomes DAG edges.

## Maintenance rule

Keep record invariants here, workflow decisions in Workflows; at most 100 lines.
