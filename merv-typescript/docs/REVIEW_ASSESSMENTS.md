# Review assessments

Reviews now preserves a short synopsis, per-criterion findings and structured
observations alongside its verdict. Tasks integrates this contract with the
existing workflow, context and UI. Generic domain routing now also retains an
optional explicit `returnTo`; see [review return paths](REVIEW_RETURN_PATHS.md).
No plugin or public tool is added.

## Review format and submission

Each review request pins `formatVersion` with the producer, subject revision,
criteria and artifact manifest. Format 2 is the only format, and a request that
omits the field gets it. Format 1, which a verdict could satisfy without findings
and which a request reached only by omitting the field, was retired on 2026-09-22:
reviews migration 10 deleted the reviews of retired work items and fails closed if
a format 1 review remains.

Submission requires the existing verdict and notes plus:

- `synopsis`: a plain single paragraph of 40–420 characters explaining the overall
  verdict. No headings, backticks or internal entity IDs; use human names.
- `findings`: exactly one finding for each numbered criterion, with no duplicate,
  unknown or missing numbers. Each records `criterionNumber`, `status`, pinned
  `evidenceIds`, and nonblank `notes` describing verification, required correction
  or an explicit waiver reason.
- Optional `evidence`: structured JSON observations or metrics. This is bounded
  to 64,000 encoded bytes and finite, acyclic JSON, not a replacement for artifact
  storage. An optional nonempty `evidence.outcome` supplies the accepted outcome.

Optional `returnTo` is independent of assessment format. It is a bounded workflow
state identifier whose allowed/required values belong to the selected domain
owner. Omission, including explicit undefined in an in-process call, retains
the old wire and replay shape. No null field is inserted into old responses or
receipts. A supplied route participates in command identity and is immutable
with the submitted verdict.

Example finding:

```json
{
  "criterionNumber": 1,
  "status": "met",
  "evidenceIds": ["art_execution_receipt"],
  "notes": "Independently recomputed the four inputs from the retained receipt; their sum is 20."
}
```

The finding statuses distinguish evidence from reviewer judgment:

| Status         | Meaning and requirements                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `met`          | The reviewer verified the criterion. Cite at least one artifact pinned in this review and explain the check.                         |
| `not_met`      | The criterion fails. Explain the observation and required correction; cite pinned evidence where applicable.                         |
| `not_verified` | The reviewer could not establish the result. State what could not be verified and why.                                               |
| `waived`       | The reviewer explicitly decides the criterion is unnecessary for achieving the goal. Record the reason; do not falsely label it met. |

A `pass` requires every finding to be `met` or explicitly `waived`. It also remains
the reviewer's responsibility to judge the overall goal. A `needs_changes` or
`fail` can record met individual checks while rejecting an overall integration
or goal problem in the synopsis and notes. Structural validation does not prove
that the reviewer performed the checks or that its judgment is true.

Some criteria are too important to the requesting domain to be waived. The
domain service that requests the review may name them in `requiredCriteria`, a
sorted list of criterion numbers. A `pass` then needs each
of them `met`, which already needs retained evidence; `waived` is refused with
`criterion_not_waivable`, and the way out is `needs_changes`. Other criteria on
the same review stay waivable, and `needs_changes` and `fail` are unaffected.
The field is set only at request (`review.request` is not a tool), is immutable,
is part of the snapshot hash when supplied, is carried onto a reissued review
and is returned by `review.get`, so the reviewer sees it beside the numbered
criteria. Reviews does not know what a required criterion means: Experiments
requires the feasibility criterion of a design review. The rule runs where a verdict is
submitted, inside the committing transaction, not in verdict-free guidance.

Evidence IDs must be distinct within each finding and belong to the immutable
review snapshot. Unsubmitted same-project files and foreign artifacts are not
accepted as finding references. To replace the actual submission, the producer
must revise and submit a new delivery, producing a new pinned review.

Format 1 keeps its earlier notes/verdict contract. Optional new fields are
validated if supplied. Older command receipts retain their stored result; reads
of their replayed result supply the new fields' default values without rewriting
the receipt or inventing historical findings.

## Program integration

Reviews remains generic: it stores and validates an assessment without depending
on Tasks or Workflows. Its public submit tool routes through exactly one
registered domain owner in the shared transaction. Tasks owns its fixed mapping:

| Verdict         | Task route    | Retained result                                                                                                    |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pass`          | `done`        | Outcome prefers `evidence.outcome`, then synopsis, then legacy notes.                                              |
| `needs_changes` | `in_progress` | Existing revision notes plus the pinned review's detailed findings and observations are available to the producer. |
| `fail`          | `failed`      | Terminal rejection and its complete assessment remain readable.                                                    |

Task preflight and direct submission reject any supplied `returnTo` before
command replay. Other domains may require a destination even for `fail`; the
generic verdict does not imply a terminal state. Reviews records the route,
while the domain validates and applies it through Workflows.

`workflow.status_and_next` lists the required review input fields: verdict,
notes, synopsis and findings. Preflight and actual submission check the same reviewer,
claim, subject and supplied task revision as well as the assessment. The verdict,
workflow transition/history, events and request receipts commit together. A failure
in the final task event rolls the entire operation back.

The task review UI displays the synopsis, each numbered finding, evidence links
and structured observations. Work and review context refer to the same retained
review. When work returns for changes, the optional feedback section includes
its canonical assessment. Large feedback may exceed the recipe budget and be
omitted; the required task section retains revision notes and the review ID, and
guidance tells the producer to read the prior review's findings through
`review.get`. Saved context requests still replay their original snapshot after
current assignment authorization is rechecked.

Revocation releases only an unfinished review claim. It preserves the required
format, criteria, manifest and snapshot hash, and the next reviewer gets a new
claim ID. Submitted assessments remain immutable and cannot be reissued. Reissue
replaces an unsubmitted request and preserves its evidence and format; a later domain
submission creates a separate request without earlier findings, verdict or route.

## Python parity and limits

Python already had a required short synopsis, optional findings and arbitrary
structured evidence. Its task-review procedure explicitly permitted a reasoned
waiver when the goal remained achieved. Those capabilities are retained here.
The new numbered findings are a stricter typed representation of assessment,
not a claim that the Python API required a per-check matrix.

Useful source references:

- [Python synopsis and routing](../../merv/src/merv/brain/workflows/definitions/review.py)
- [Python task verdict effects](../../merv/src/merv/brain/workflows/definitions/task.py)
- [Python reviewer procedure and waivers](../../merv/skills/task-review/SKILL.md)

Task routes are still the three task routes. Generic explicit return choices,
[workflow assignment and begin](WORKFLOW_ASSIGNMENT_PLAN.md),
[session-bound authority and expiry](SESSION_LEASES.md) and
[machine Runner coordination](MACHINE_RUNNER.md) are now integrated.
Production Experiment and Reflection review programs remain open. The
[audited Experiment reference](EXPERIMENTS_PARITY_REFERENCE.md) distinguishes
plan revision from execution repair: both negative verdicts require that choice,
while owner `mark_failed` alone supplies terminal failure. The next complete
research increment is the production Experiment lifecycle.

## Independent design consultation

Fable reviewed a standalone generic protocol question, with no source files sent.
Its concerns were checked locally: claim fencing and hash-bound evidence are
already enforced; explicit reviewer waivers preserve Python's delegated authority.
The UI surfaces waiver counts beside verdicts. Criteria a pass cannot waive are
the `requiredCriteria` above. Reviewer-owned artifact attachments and execution
lineage remain future work; structured
observations are already retained. See [the consultation and dispositions](reviews/review-assessments-fable-design.md).
The earlier full source packet remains pending specific approval.

## Verification

The original assessment checkpoint passed 251 tests, including actual local HTTP/MCP, prepared Nisa integration,
recovery, historical schema/receipts and atomic rollback. Backend/UI builds and
typechecks pass. Three fresh agents completed the structured task/review loop
through two restarts: 34 calls, 31 successes and three expected role refusals,
with no transport errors. The verifier checks submitted-versus-retained findings
and that the reviewer read every pinned artifact before its verdict.
[Checkpoint](../verification/review-assessments.json) and
[live acceptance](../verification/review-assessments-live.json).

The 2026-09-15 explicit-return prerequisite passed **574/574** full-suite tests,
**30/30** focused checks and **17/17** independent checks. A native fixture used
two fresh leased reviewers and seven successful MCP calls, with no failures;
all three pinned artifacts were read in full before verdicts. It exercised
`fail → planned` and `needs_changes → running` through a synthetic registered
owner, using seeded producer evidence and an approved-plan document. The fixture
ends at those destinations; it does not implement production experiments,
attempt records or subsequent execution. The inventory and tool count are
unchanged. See [return-path semantics](REVIEW_RETURN_PATHS.md) and
[current verification](../VERIFICATION.md).
