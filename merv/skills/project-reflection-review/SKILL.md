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

Use the assigned `reflection_id` and `review_request_id`. In an auto-run session,
call `review.start` with `reviewer_capability="assigned"` and
`caller_session_id="assigned"`; Merv resolves your authenticated identity.
For an interactive handoff, use its exact capability and your own stable
`caller_session_id`, distinct from the producer's. The session binds to your
`agent_id`: only this context window can submit its verdict. It returns the
project context, reflection context, and submitted artifacts. Use those
snapshots rather than live experiment state. Read a listed artifact id with
`artifact.read include_content=true` only when a load-bearing summary needs
exact verification.

Operate read-only: auto-run credentials enforce it, a general project key
relies on you. Only `review.start` and `review.submit` mutate anything; the
verdict's route ends your assignment.

## Review the four evidence layers

Read:

1. The snapshotted claims, experiments, reports, graphs, and review history.
2. The previous published project graph and reflection, when present.
3. All five current lens documents.
4. The submitted project graph, reflection document, and change spec.

Treat lens documents as unverified arguments. Check important assertions
against the underlying snapshot, distinguishing experimental confirmation from
useful task output. Verify that the next tests could distinguish the stated explanations.

## Judge the reflection

- **New signal:** Did `new_terminal_experiments` (and `new_terminal_tasks`)
  materially affect the graph, reflection, or decision where warranted? A wave
  that could have been written before them did not do its job.
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
  must genuinely match what the experiment tests. Are the proposed tasks
  scoped and not over-prescribed — a goal, checks an executor can meet and a
  reviewer can verify, no method dressed up as a check — and does the
  `depends_on` DAG order the wave sensibly (data before the experiment that
  trains on it) without inventing dependencies that only serialize work? A
  task that exists to test a claim is an experiment in disguise.

## Choose the verdict and return

- `pass`: the graph is honest, the reflection is critical, and the change spec
  is authoritative; the verdict moves the wave to `consolidating` for a
  separate consolidator.
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
record that demonstrates the issue and recommend the smallest correction. Report
the receipt's `target.status_before`/`status_after` and `next_action` with a
brief verdict summary.
