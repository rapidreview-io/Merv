---
name: experiment-design-review
description: >-
  Perform a read-only adversarial review of a Merv experiment design before
  execution. Check whether the submitted plan can test its claim, then submit
  the verdict through the review capability.
---

# Design Review

Review whether the proposed experiment can answer its stated question. Do not
improve the plan on the producer's behalf; identify the smallest changes
required before execution.

## Start read-only

Call `agent.hello` once first — this review is its own context window — and pass
the returned `agent_id` in every Merv call that follows.

Use the assigned `experiment_id` and `review_request_id`. In an auto-run session,
call `review.start` with `reviewer_capability="assigned"` and
`caller_session_id="assigned"`; Merv resolves your authenticated identity.
For an interactive handoff, use its exact capability and your own stable
`caller_session_id`, distinct from the producer's. The session binds to your
`agent_id`: only this context window can submit its verdict. Use the returned
`project_context` and experiment `context` as the default evidence; read a
listed artifact id (the logic graph, an exhibit) with `artifact.read
include_content=true` when a load-bearing detail needs it. On a revised plan,
inspect previous findings and reused evidence before demanding new work;
identify what evidence would disprove the claim and whether the plan can produce it.

Operate read-only. Auto-run credentials enforce this boundary; interactive
reviewers must follow it when using a general project key. Do not mutate the
work, its artifacts, sandboxes, or workflow directly. Use only `review.start`
and `review.submit` for review mutations. `review.submit` applies the verdict's
route itself and ends your assignment.

## Judge the design

The server already checks that required headings exist. Judge whether their
content is scientifically sufficient:

- **Summary:** Does a human reader understand what will be tested and why?
- **The ask:** Does the plan answer the experiment's `intent`? Where the
  creator supplied `details`, does the plan engage them — adopting each point
  or stating why not? A plan that tests something adjacent to the intent is a
  send-back.
- **Objective and hypothesis:** Is the claim explicit and scoped? Is the
  expected direction and motivation clear?
- **Evaluation:** Are the metrics, comparison or baseline, decision rule,
  success threshold, and invalidation conditions concrete and appropriate?
  Would meeting them actually justify the proposed conclusion?
- **Method:** Is the procedure executable, appropriately sized, and capable of
  isolating the claim?
- **Right-sizing:** Is this the smallest credible experiment that can produce a
  decision-relevant signal about the intent? Are additional data, scale,
  variants, seeds, compute, or infrastructure justified by a necessary
  distinction or known validity risk?
- **Prior work and provenance:** When earlier project findings or research
  papers materially inspire the design, does the plan cite the relevant
  `exp_...` experiments and use portable, source-native paper references
  (arXiv id, DOI, or stable canonical source URL), while identifying what is
  being carried forward? An internal `paper_...` id does not satisfy this
  check. Omission is acceptable when the design is genuinely independent.
- **Outputs:** Are the evidence files that must survive execution named?
- **Risks and confounders:** Are material failure modes, leakage risks, and
  alternative explanations addressed?

Reject vague evaluation criteria, moving-goalpost designs, methods that cannot
distinguish the claim, or plans whose promised conclusion exceeds what their
evidence could establish. Request simplification when time or resource
commitments do not materially improve decisiveness or validity. Do not demand
exhaustive evidence when a scoped signal-finding experiment is sufficient.

## Submit the verdict

- `pass`: the design is executable and can test the claim; the verdict moves the
  experiment to `running` for a fresh agent.
- `needs_changes`: specific revisions can make it valid.
- `fail`: the design cannot answer the claim or is fundamentally invalid.

Write a `synopsis` of one to three plain sentences for the researcher: what the
plan tests and the verdict's consequence. Use human names, no entity ids,
markdown, or internal jargon.

Submit only the fields accepted by `review.submit`:
`review_session_id`, `verdict`, `synopsis`, concise `notes`, actionable
`findings`, and optional structured `evidence`. Omit `return_to`; a rejected
design returns to planning automatically.

Each finding should name the issue, cite the exact plan section or missing
evidence, assign severity when useful, and recommend the smallest correction.
The receipt carries `target.status_before`/`status_after` and a `next_action`;
report those with a brief verdict summary. The producer never applies the
approval itself.
