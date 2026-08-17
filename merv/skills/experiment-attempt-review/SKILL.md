---
name: experiment-attempt-review
description: >-
  Perform a read-only adversarial review of a completed Merv experiment
  attempt. Verify execution, submitted results, metrics, graph, and conclusions
  against the approved plan, then submit the verdict and correct return path.
---

# Experiment Attempt Review

Judge whether the submitted attempt supports its conclusion under the approved
plan. Treat the plan's Evaluation section as the pre-registered contract.

## Start read-only

Call `agent.hello` once first — this review is its own context window — and pass
the returned `agent_id` in every Merv call that follows.

Require the handoff's `experiment_id`, `review_request_id`, and
`reviewer_capability`. If one is missing, ask the producer for it.

Call `review.start` with the supplied request and capability, your own stable
`caller_session_id`—never the producer's—and optional `declared_agent`. Begin
with its pinned project context, plan, report, and artifact references. Batch
the listed result, graph, and exhibit ids through `artifact.find` only when
their full submitted evidence is needed.

Operate read-only by procedure: the capability protects the review protocol,
not unrelated tools. Do not mutate claims, experiments, artifacts, sandboxes,
or workflow state. Your only permitted mutation is `review.submit`.

## Verify the attempt

Check the attempt as one evidence chain:

1. **Plan conformance:** Did execution follow the approved method, outputs,
   metrics, data population, baseline, seeds, decision rule, success threshold,
   and invalidation conditions?
2. **Numeric record:** Do machine-readable results and any system exhibit agree
   with the report? Account for every submitted row, including failed, aborted,
   partial, and unfavorable runs. Unexplained discrepancies or selective
   reporting require rejection.
3. **Semantic validity:** Inspect code or exact artifacts when needed to detect
   leakage, evaluation on training data, invalid normalization, mislabeled
   populations, broken baselines, or metrics that are numerically plausible
   but scientifically false.
4. **Deviations:** Are all departures from the approved plan disclosed and
   justified? Decide whether they invalidate execution or the design itself.
5. **Logic graph:** Does it honestly capture the questions, decisions, pivots,
   failures, and lessons? Reject a generated metrics diagram, pipeline,
   provenance map, or story that hides known rework. Do not prescribe its
   vocabulary or layout.
6. **Conclusion:** Apply the registered decision rule to the observed record.
   Reject goalpost changes, cherry-picking, or claims broader than the tested
   scope.

The report is interpretation; submitted results are the numeric record. An
empty or materially incomplete record cannot support a quantitative
conclusion.

## Choose the verdict and return

- `pass`: the attempt supports the conclusion at its claimed scope.
- `needs_changes`: the attempt needs repair, rerun, or a narrower conclusion.
- `fail`: the attempt is invalid or cannot support its conclusion.

For every rejection, select exactly one return path:

- `return_to: "running"` when the plan stands but execution, evidence, or
  interpretation is flawed. Preserve the approved design and current attempt.
- `return_to: "planned"` when the plan itself is wrong: method, metric,
  baseline, decision rule, or testability must change. This advances the
  attempt and requires a new design review.

Do not send a sound plan back to planning for an execution mistake.

## Submit the review

Write a `synopsis` of one to three plain sentences for the researcher: what was
tried, what happened, and the verdict's consequence. Use human names, at most
one decisive comparison, and no entity ids, markdown, or internal jargon.

Submit only the fields accepted by `review.submit`:
`review_session_id`, `verdict`, required `return_to` unless passing,
`synopsis`, concise `notes`, actionable `findings`, and optional structured
`evidence`. Use evidence to state what a next attempt should reuse and change.

Each finding should name the concrete issue, cite the submitted file, metric,
command, or observed fact, and recommend the smallest correction. After
submission, return a brief summary to the producing agent. Do not perform any
other mutation.
