---
name: consolidation-review
description: >-
  Independently review a Merv reflection-wave code consolidation after the
  reflection is approved. Verify the immutable proposal, its tests, and its
  decision for every experiment, then submit pass or return it only to code
  consolidation. Use for the consolidation_reviewer gate.
---

# Consolidation Review

Review code integration, not the research conclusion. The approved reflection
is authoritative and cannot be reopened from this gate.

## Start the pinned review

Call `agent.hello` once first — this review is its own context window — and pass
the returned `agent_id` in every Merv call that follows.

Use the assigned `review_request_id` with `review.start`. In an assigned agent
session, pass `reviewer_capability="assigned"` and
`caller_session_id="assigned"`. Otherwise use the exact handoff values and a
reviewer identity distinct from the producer.

Work from the returned proposal snapshot and `consolidation.get`. Do not edit,
commit, submit artifacts, change research state, or advance Git. Running
read-only checks and tests in the detached proposal checkout is allowed.

## Check the proposal

Verify:

- The proposal SHA is the commit checked out and descends from, or equals, the
  declared central base.
- The proposal implements the approved reflection and change spec without
  silently changing their scientific decisions.
- Every experiment in the reflection corpus has exactly one decision with a
  concrete rationale.
- `used_as_is` and `adapted` decisions identify a real integration mechanism;
  `reviewed_not_used` and `superseded` carry no code, and superseded decisions
  name the covering experiment.
- The stated integration kind matches the diff and branch history. The runner
  will verify ancestry independently; do not call a rewrite or cherry-pick a
  merge.
- Important experiment changes were not omitted accidentally, and omitted work
  has an evidence-based reason.
- The consolidation is coherent as one central change: no duplicate
  implementations, unresolved conflicts, stray generated files, credentials,
  or experiment-only scaffolding.
- The submitted validation is credible. Rerun the smallest checks needed to
  verify risky or load-bearing changes.

Prefer a smaller coherent integration over mechanically merging every branch.
“Reviewed, nothing carried over” is a valid result when its rationale is real.

## Submit one verdict

Use `pass` only when the exact proposal is safe to advance.

For `needs_changes` or `fail`, set `return_to="consolidating"` and identify the
smallest code, validation, or decision correction required. Never return to
`reflecting` or `synthesizing`, and never ask the reflection wave to restart.

Submit through `review.submit` with a concise researcher-facing synopsis,
specific findings, and optional structured evidence. Stop after submission.
The runner—not the reviewer—performs the central compare-and-swap.
