# Research Core

## Purpose and boundary

`research_core` owns projects, claims, native records, reviews, artifact associations
and candidate lineage. It supplies project-scoped facts and transactional bindings to
Workflows, which owns graph decisions and agent briefs. Application composes modules;
Surface owns auth and transport. Artifacts owns immutable content, Feed observations,
and merv-sandboxes workloads and ML objects. Research records their producer.
`Research` is the public root, built from `BaseStateStore`, `ResearchArtifacts`, its
`Program` and injected `Workflows`. Native records pin their kind's workflow version;
instance/kind mismatches fail before checklist evaluation or native writes.

## Files

- `records.py`: one engine interprets each graph's `RecordKind`: creation, hydration,
  gates, typed construction, `RecordKnowledge`, column writes and sealing.
  `RecordKind.creation_requires` checks transaction-bound creation facts; reserved creates
  retain their existing guard bypass. `ReflectionFreshness` owns experiment creation debt. `RecordHooks.before_write` and
  `RecordHooks.after_write` both run inside the caller's transaction. `read_fact` supplies
  kind-specific facts; `bindings` supplies graphs without native rows. Duplicate kinds fail.
- `artifacts.py`: research associations, role/target policy, accepted evidence, replacement
  visibility and submission members. `artifact_models.py`: association projections.
- `research.py`: projects, claims, candidates, snapshots, membership and events; one loop
  binds `program.kinds`. Its transactional claim writer also serves reflection, preserving
  omitted fields and writing identical claim events plus explicit reflection provenance.
- `experiments.py`: active cap, reserved names, reflection debt facts, claim links, attempt clock
  and metrics exhibit. `tasks.py`: immutable goals, pinned briefs and parsed deliveries.
- `dependencies.py`: wave DAG edges, cycle checks, dependency and dependent rows.
- `reflections.py`: fixed corpus, lens pinning, reserved names, materialization, drift facts,
  and lens/wave bindings. It alone writes reflection-to-claim associations.
- `reviews.py`: capabilities, sessions, snapshots, verdicts and return routing. It reads
  SQL and project settings into one scoped review fact shared within an evaluation.
  The fact includes latest verdict, independence, request status, validity and expiry.
- `policy.py`: pure validation, snapshot identity, review decisions, reflection signals,
  limits and `RESOLVERS`. Each requirement class formats one checklist item from the
  same verified facts and graph issues enforcement uses; policy contains no persistence.
- `association_targets.py`: target resolution. `objects.py`: completion lifecycle and
  `ProducedObject` snapshots. `models.py`: research snapshots and `public_record` serialization.
- `content_summaries.py`: document TLDRs. `paths.py`: safe experiment folder names.
  `tools.py`: research tool contracts, read from graph declarations where applicable.
  `persistence.py`: research tables, migrations, indexes and the `research_artifacts` view.

## Lifecycles

Experiments follow `planned -> design_review -> running -> experiment_review -> complete`;
failure and abandonment are terminal. `action:experiment.approve_design` enters execution;
dependencies gate dispatch and activation starts the attempt clock. A rejected design
returns to planned with a new attempt. Execution review can return to planned with a new
attempt or running with its approved plan. Native state, graph history and sealing commit
atomically. `role:experiment.design_reviewer` follows `skill:experiment-design-review`.

Tasks follow `in_progress -> in_review -> done`, with failed as the other ending.
Goal and deliverables are immutable; creation renders and pins the brief, and manual brief
submissions are refused. Delivery answers each deliverable with evidence or an explicit
non-delivery reason, plus notes. `action:task.submit_delivery` waits for dependencies;
needs_changes returns to work, while fail or `action:task.mark_failed` ends the task.
Both node kinds share the dependency DAG; completed tasks supply context, not experiment debt.

Reflection follows `reflecting -> synthesizing -> reflection_review -> consolidating ->
consolidation_review -> published`; both consolidation states project to consolidating in
the native row. Independent reviewers approve research and then the exact code proposal;
code review returns only to consolidation. The runner binds the central Git advance through
Agent Sessions before `action:reflection.publish` atomically materializes the approved spec.
Reservations share one namespace, but only experiment names consume active-cap slots.
Migration 71 defaults existing names to one slot; initialization reads their pinned spec
bytes to classify task-only names as zero. Unreadable or unknown names remain one.
Publication materializes from the pin before releasing reservations, on the same transaction;
its already-reserved creates bypass mutable capacity checks. Failure restores every write.

## Read model and invariants

`Research.snapshot` hydrates native records and gates in one transaction-consistent project
read. State values live beside their graphs in `definitions/research_state.py`; reflection
keeps native status separate from workflow state. Focused reads preserve snapshot identity.
Capabilities expire, are returned once and stored as hashes. A fresh request supersedes
open requests for the same gate. `tool:review.start` verifies tenant, producer separation,
snapshot and capability or assigned session; submission rechecks the immutable snapshot.
Expired requests are pending, never reusable runtime capabilities. Attested passes satisfy
non-strict policy; strict policy requires verified independence in both runtime and checklist.
Claims change via `tool:claim.update` or approved reflection edits, never prose heuristics.
Candidates reference durable artifacts, service objects or workspaces awaiting staging;
staging and promotion are append-only, with reasons and compare-and-swap at promotion.
All writes and lookups enforce project ownership. Events commit with their mutations;
sealing uses explicit association IDs while generic content stays immutable and reusable.

## Maintenance

Keep this note under 100 lines. Named actions, roles, tools and skills use qualified inline
references as above; the documentation ratchet resolves them against their declarations.
