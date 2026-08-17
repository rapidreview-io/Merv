---
name: project-reflection-review
description: >-
  Perform a read-only adversarial review of a Merv project-reflection wave.
  Check the project graph, reflection document, and change spec against the
  snapshotted corpus, previous graph, and five lens reflections, then submit
  the verdict and correct return path.
---

# Project Reflection Review

Protect the honesty of the project's distilled memory. Judge whether the
reflection absorbed the new evidence, reconciled its five lenses, and proposed
a safe next experiment wave.

## Start read-only

Call `agent.hello` once first — this review is its own context window — and pass
the returned `agent_id` in every Merv call that follows.

Require the handoff's `reflection_id`, `review_request_id`, and
`reviewer_capability`. If one is missing, ask the producer for it.

Call `review.start` with the supplied request and capability, your own stable
`caller_session_id`—never the producer's—and optional `declared_agent`. It
returns the pinned project context, reflection context, and submitted
artifacts. Use those snapshots rather than live experiment state. Read a
listed artifact id only when a load-bearing summary needs exact verification.

Operate read-only by procedure: the capability protects the review protocol,
not unrelated tools. Do not mutate claims, experiments, reflections,
artifacts, sandboxes, or workflow state. Your only permitted mutation is
`review.submit`.

## Review the four evidence layers

Read:

1. The snapshotted claims, experiments, reports, graphs, and review history.
2. The previous published project graph and reflection, when present.
3. All five current lens documents.
4. The submitted project graph, reflection document, and change spec.

Treat lens documents as unverified arguments. Check important assertions
against the underlying snapshot.

## Judge the reflection

- **New signal:** Did `new_terminal_experiments` materially affect the graph,
  reflection, or decision where warranted? A wave that could have been written
  before them did not do its job.
- **Honest graph:** Does the graph preserve contested findings, negative
  results, dead ends, and current uncertainty? Verify load-bearing nodes
  against their references. Judge substance, not the author's vocabulary.
- **Real reconciliation:** Were lens disagreements resolved against evidence
  or carried forward explicitly, rather than averaged or copied?
- **Consequential coverage:** Did synthesis preserve important negative
  knowledge and omit only editorially minor material?
- **Critical document:** Is the reflection concise and scientific—what
  changed, what remains uncertain, where lenses disagree, and why the next
  direction follows—rather than a paste-up of five summaries?
- **Distinct lenses:** Did the five lenses produce genuinely different
  analyses? Near-duplicate or charter-ignoring inputs are a lens failure.
- **Belief update:** Are claim changes warranted by reviewed evidence and
  scoped honestly?
- **Next wave:** Do the proposed experiments address live research questions,
  avoid known dead ends unless conditions changed, and contain enough intent
  to materialize? Claim references are optional, but every provided reference
  must genuinely match what the experiment tests. Multi-experiment waves must
  be genuinely independent.

## Choose the verdict and return

- `pass`: the graph is honest, the reflection is critical, and the change spec
  is authoritative enough to hand to the separate code-consolidation phase.
- `needs_changes` or `fail`: reject with exactly one return path.

Use `return_to: "synthesizing"` when the lens inputs stand but the graph,
reflection document, claim changes, or experiment proposals need revision.
Use `return_to: "reflecting"` only when the lens inputs themselves are
inadequate; this advances the attempt and requires all five lenses again.

Do not rerun five agents to repair a synthesis error.

## Submit the review

Write a `synopsis` of one to three plain sentences for the researcher: what the
wave concluded and the verdict's consequence. Use human names, at most one
decisive comparison, and no entity ids, markdown, or internal jargon.

Submit only the fields accepted by `review.submit`:
`review_session_id`, `verdict`, required `return_to` unless passing,
`synopsis`, concise `notes`, actionable `findings`, and optional structured
`evidence` naming what was checked.

Each finding should identify the specific graph node, claim, lens document, or
record that demonstrates the issue and recommend the smallest correction.
After submission, return a brief summary to the orchestrator. Do not perform
any other mutation.
