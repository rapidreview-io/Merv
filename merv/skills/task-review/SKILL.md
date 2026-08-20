---
name: task-review
description: >-
  Perform a read-only review of a completed Merv task delivery. Verify each
  Done-when check in the brief against the delivery's evidence — by checking,
  not by reading — judge whether the checks met mean the goal is achieved,
  then submit pass, needs_changes (back to in_progress), or fail (the task
  ends).
---

# Task Review

Judge whether the delivery meets the brief. The brief's `Done when` checks are
the contract; the delivery is evidence per check; you verify, you do not read
and nod.

## Start read-only

Call `agent.hello` once first — this review is its own context window — and
pass the returned `agent_id` in every Merv call that follows.

Require the handoff's `task_id`, `review_request_id`, and
`reviewer_capability`. If one is missing, ask the producer for it.

Call `review.start` with the supplied request and capability, your own stable
`caller_session_id`—never the producer's—and optional `declared_agent`. Begin
with its pinned project context, the task context (goal, checks, brief,
delivery, dependencies), and the submitted artifacts. Use `artifact.find` and
`storage.fetch` for the files the delivery points at, and `sandbox.runs` or
`sandbox.terminal` when a receipt names a command worth replaying.

Operate read-only by procedure: the capability protects the review protocol,
not unrelated tools. Do not mutate claims, experiments, tasks, artifacts,
sandboxes, or workflow state. Your only permitted mutation is `review.submit`.

## Verify the delivery

Go deliverable by deliverable, in the goal's numbering:

1. **Is there a confirmation?** Each deliverable's entry must say where the
   thing is and how to check it — files, storage objects, lit-review
   sections, run receipts. Prose asserting success is not a confirmation.
2. **Does the evidence hold?** Follow the delivery's "how to check": open the
   file, count the rows, replay the command from its receipt, fetch the
   object. If you cannot verify a check with what you were given, that check
   is not met — say so and send it back; "couldn't verify" is a legitimate
   finding.
3. **Honest misses:** an entry that says `not delivered — <why>` is honest,
   not automatically fatal. Decide whether the goal survives without it and
   whether the reason is real; the reviewer may waive a deliverable on the
   record in `notes`, and only the reviewer may. Any other entry claims
   delivered — hold it to that.
4. **Do the deliverables, confirmed, mean the goal is achieved?** This is
   the design review a task never had. The goal is immutable, so weak or
   unverifiable deliverables cannot be rewritten — if they were too weak to
   secure the goal (a leak between splits nothing checks, a survey that
   counts papers but covers one venue), or the goal only makes sense inside
   Merv's plumbing ("the wave's experiments"), say so in the review: fail the
   task if the gap is fatal, or pass with the gap on the record; the owner's
   fix is a better task, not an edited goal.
5. **Is it safe to build on?** Look for what a downstream experiment would
   inherit: wrong dataset version, leakage, an unpinned dependency, coverage
   that is three papers and a shrug. Read the Notes as claims
   to check, not as disclosures that settle the matter.

## Choose the verdict

- `pass`: every check is met (or waived by you, on the record) and the goal is
  achieved; the task's outputs are safe to build on.
- `needs_changes`: something specific is wrong or could not be verified. The
  task returns to `in_progress` with your notes; the executor fixes the
  delivery and resubmits. This is the normal rejection — omit `return_to`.
- `fail`: the goal cannot be met within the task's scope — a wrong premise, a
  resource that no longer exists, a dependency that died. The task ends. Do
  not use `fail` for a fixable delivery.

## Submit the review

Write a `synopsis` of one to three plain sentences for the researcher: what
the task set out to deliver, what actually exists, and the verdict's
consequence. Use human names, no entity ids, markdown, or internal jargon.

Submit only the fields accepted by `review.submit`: `review_session_id`,
`verdict`, `synopsis`, concise `notes`, actionable `findings`, and optional
structured `evidence`. Each finding names the check number, states what could
not be verified or what is wrong, cites the file, command, or observed fact,
and recommends the smallest correction. After submission, return a brief
summary to the producing agent. Do not perform any other mutation.
