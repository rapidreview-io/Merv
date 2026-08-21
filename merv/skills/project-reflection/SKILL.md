---
name: project-reflection
description: >-
  Run a Merv project-reflection wave across completed experiments: create the
  five-lens roster, fan out independent lens agents, reconcile their findings
  into the project graph, reflection document, and change spec, coordinate
  independent review, and hand approved research to code consolidation. Use
  when the user requests reflection or
  workflow.status_and_next reports stale project knowledge or a reflection
  gate.
---

# Project Reflection

Use reflection to update the project's distilled memory and choose the next
experiment wave. Act as the orchestrator: own transitions and synthesis, but
let each lens agent author and submit its own reflection.

## Follow the reflection state machine

```text
create → reflecting → synthesizing → reflection review → consolidating
            ↑              ↑                 │
            └──────────────┴─────────────────┘
```

A rejection returns to `synthesizing` when the five lens reflections stand but
the graph, reflection document, or change spec needs revision. It returns to
`reflecting` when the lens inputs themselves are inadequate; that starts a new
attempt and requires all five lenses again.

Pass the selected `project_id` to every project-scoped operation. If the
project is unknown, call `project(action="list")` and choose the one the user
means. Never guess an id. If this context window has no `agent_id` yet, call
`agent.hello` once first and pass the returned `agent_id` in every Merv call.

## Create the wave

Read `project(action="overview", project_id=...)` once to orient before opening
the wave. Then call `reflection.create` with the required roster:

- The three core lens ids returned by the contract: `amplify`, `avoid`, and
  `entropy`. Let the server supply their charters.
- Two authored lenses aimed at this project's actual blind spots. Give each a
  focused charter and explain why it differs from all other lenses.

Once created, the reflection's snapshotted corpus is authoritative. Do not
substitute later live project or experiment reads for that snapshot.

## Fan out five independent lenses

Launch one read-only agent per roster entry, in parallel when possible. Give
each agent:

- its server-returned lens charter and the other four lens names, so it stays
  in its lane;
- `new_terminal_experiments` and `new_terminal_tasks`, framed as the new
  signal that triggered this wave rather than the only evidence worth reading
  (a finished task's brief and delivery are inputs to read, not evidence about
  a claim);
- its previous reflection summary when the snapshot provides one;
- the reflection id, project id, and instruction to use the snapshotted corpus;
- the instruction to call `agent.hello` itself first (passing your `agent_id`
  as `parent_agent_id`) and carry its own `agent_id` in every Merv call — a
  lens agent is its own context window and never borrows yours; and
- the requirement to write and submit its own `reflection_lens_doc` with its
  exact `lens_id`, following
  [reflection-artifacts-template.md](reflection-artifacts-template.md).

Lens agents must not mutate project state, read a checkout, or replace the
snapshot with live experiment state. Start from the bounded summaries and use
`reflection.get(include_content=true)` only when a load-bearing conclusion
needs exact snapshotted evidence.

Every current lens document must stand alone. Recheck inherited conclusions
against the present corpus rather than referring vaguely to a prior wave.
When all five submissions are present, make the allowed transition to
`synthesizing`.

## Reconcile the lenses

Read all current lens documents and the previous published graph and reflection
through `reflection.get(include_content=true)`. Treat lens outputs as
independent arguments, not truth and not votes.

Reconcile them against the snapshotted records:

- Preserve strong positive evidence without inflating its scope.
- Preserve negative knowledge and eliminated avenues, not only wins.
- Resolve disagreements where the evidence permits; otherwise make the
  uncertainty explicit.
- Make the new terminal experiments materially affect the result when their
  evidence warrants it.
- Select a coherent next wave rather than concatenating every suggested idea.

Produce the three artifacts defined in the template:

1. `project_graph`: the current project logic state, revised from the prior
   published graph when one exists.
2. `reflection_doc`: the concise scientific reading of what changed, what
   remains uncertain, and why the direction follows.
3. `change_spec`: the reviewed claim updates and the next wave — up to three
   proposed experiments plus any number of tasks (lit review, data prep,
   harness work, memos), with `depends_on` edges between them. An experiment may sit downstream of tasks only, never of another proposed experiment (through tasks included) — sequential experiments are the next wave's proposal.

Do not create or modify claims, experiments, or tasks directly. Successful publication
materializes the reviewed change spec. Follow the artifact and reflection tool
contracts for fields, upload commands, lints, and allowed transitions; after
editing an artifact, resubmit its bytes before retrying a gate.

## Coordinate independent review

Once `reflection.get` reports the three synthesis artifacts ready, transition
to reflection review. Request the `reflection_reviewer` review and pass its
returned handoff unchanged to a separate agent using
`project-reflection-review`.

The reviewer owns `review.start` and `review.submit`; the orchestrator must not
review its own synthesis. Preserve the returned capability long enough to hand
it off and do not supersede a valid request merely because review has started.

After review:

- On `pass`, call the `begin_consolidation` reflection transition and stop.
  Merv dispatches a separate consolidator, then a separate
  `consolidation-review` agent. Only after that review passes does the runner
  advance the Merv-owned central Git ref and publish. Do not consolidate code,
  review the consolidation, or call `publish` from this reflection session.
- On return to `synthesizing`, revise only the rejected synthesis artifacts,
  resubmit them, and request a new review.
- On return to `reflecting`, launch all five lens agents again for the new
  attempt, addressing the review's criticism.

The reflection is authoritative once its review passes. Consolidation may
select, adapt, supersede, or omit experiment code, but it cannot return to this
wave or revise its graph, reflection document, or change spec.
