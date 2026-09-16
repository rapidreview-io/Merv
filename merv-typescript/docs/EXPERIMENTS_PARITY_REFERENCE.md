# Experiment implementation reference

Source audit: 2026-09-15. This records the current Python contract for the next
complete TypeScript Experiment increment. It is an implementation reference,
not a claim that Experiments have been implemented. The broader order remains
in [the research program plan](RESEARCH_PROGRAM_PARITY_PLAN.md).

## Public commands and creation

Python uses snake_case. Reuse the TypeScript stack's camelCase, authenticated
Caller, strict inputs, revision checks and stable request receipts.

| Python command          | Exact domain input                                                                                                                                      | Result / visibility                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `experiment.create`     | Required `project_id`, `name`, `intent`; optional `details=""`, `tested_claim_ids=[]`, `depends_on=[]`. Both lists also accept a single string or null. | Public. `{id, name, status, folder, next}`; initial status `planned`, folder `experiments/<name>/`, next includes plan role, upload action/tool and required sections. |
| `experiment.transition` | `project_id`, `experiment_id`, `transition`, optional `evidence` object.                                                                                | Public owner actions only. Receipt includes experiment ID, transition, from/to/status, attempt index, event ID and accepted time; optional metrics/feed receipts.      |
| `experiment.exhibit`    | `project_id`, `experiment_id`.                                                                                                                          | Public read-only preview, valid only while `running`; elsewhere refuses and points to a pinned exhibit if one exists.                                                  |
| `experiment.list`       | `project_id`.                                                                                                                                           | Internal inventory, not an ordinary external MCP tool.                                                                                                                 |
| `experiment.get_state`  | `project_id`, `experiment_id`, optional `review_id=""`.                                                                                                 | Internal detailed read. Public agents primarily receive workflow guidance/assignment and artifact reads.                                                               |
| `artifact.upload`       | `project_id`, `path` (1–1,000 chars), optional `title` (max 1,000), `discover_figures=false`, `attach_to={target_type, target_id, role, lens_id?}`.     | Returns upload instructions; attachment activates only after retained bytes complete.                                                                                  |
| `artifact.attach`       | `project_id`, `artifact_id`, `target_type`, `target_id`, `role`, optional `lens_id=""`.                                                                 | Associates existing complete immutable content. Experiment evidence does not use a lens ID.                                                                            |

Sources: [research tool inputs and contracts](../../merv/src/merv/brain/research_core/tools.py)
lines 125–160 and 430–459; [artifact tools](../../merv/src/merv/brain/artifacts/tools.py)
lines 20–46; [creation receipt](../../merv/src/merv/brain/application/experiments/create.py)
lines 17–48; [transition receipt](../../merv/src/merv/brain/application/experiments/transition.py)
lines 28–40 and 69–100.

- Trim name, intent and details. Name is 3–48 ASCII characters, starts with a
  letter/digit, then letters/digits/`.`/`_`/`-`; uniqueness is case-insensitive
  within the project. Intent must be nonempty. Python does not impose a maximum
  on intent/details or a claim-list count. These are immutable creation fields;
  method belongs in the plan.
- Claim IDs must exist in the same project; deduplicate without reordering.
  Claims remain linked records, not copied mutable claim state.
- Dependencies name existing same-project experiments or tasks. Deduplicate;
  reject self-dependency and cycles. Python ignores empty dependency IDs.
  Only successful completion settles a prerequisite: `complete` experiments
  and `done` tasks. Failed/abandoned prerequisites stay blocking.
- Creation writes the record, linked claims, dependency edges, creation event
  and workflow instance in one transaction. Initial attempt is **1** and initial
  workflow revision is **0**.
- Python caps active experiments at **7**, including slots reserved by reviewed
  reflection proposals. It also protects their reserved names. Its reflection
  freshness policy blocks new experiments at five terminal experiments not
  covered by publication. Introduce that block only with the usable reflection
  recovery/publication path; the TypeScript plan deliberately postpones it.

Sources: [creation and claim validation](../../merv/src/merv/brain/research_core/experiments.py)
lines 41–107 and 122–166; [record creation](../../merv/src/merv/brain/research_core/records.py)
lines 118–154; [name/cap constants](../../merv/src/merv/brain/workflows/definitions/research_contracts.py)
lines 48–96; [dependencies](../../merv/src/merv/brain/research_core/dependencies.py)
lines 46–55 and 177–218.

## State, attempts and independent review

| Current state         | Action or verdict                                             | Result                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned`             | Owner `submit_design`                                         | Validate and seal the plan; enter `design_review` and create its independent review.                                                                                      |
| `design_review`       | Independent `pass`                                            | Enter `running`; freeze the exact approved plan submission/review. Approval does not start execution time.                                                                |
| `design_review`       | `needs_changes` **or `fail`**                                 | Return to `planned`, increment attempt, retain feedback/history, clear approved plan and execution window. `return_to` may be omitted or `planned`; `running` is refused. |
| `running`             | Owner `submit_results`                                        | Validate result/report and dependencies; pin any exhibit, seal the exact selection, enter `experiment_review`, request independent review.                                |
| `running`             | Owner `retry_running`                                         | Stay `running`, advance workflow revision, preserve attempt/approved plan/first start; append recovery guidance.                                                          |
| `experiment_review`   | Independent `pass`                                            | Enter terminal `complete`, record conclusion from the reviewed evidence.                                                                                                  |
| `experiment_review`   | `needs_changes` **or `fail`**, explicit `return_to="running"` | Same attempt and approved plan; execution/conclusion repair with another results submission round.                                                                        |
| `experiment_review`   | `needs_changes` **or `fail`**, explicit `return_to="planned"` | New attempt and new design review required; clear approval/window and preserve rejected history.                                                                          |
| Any nonterminal state | Owner `abandon` or `mark_failed`                              | Terminal `abandoned` or `failed`. No automatic retry or reopening transition.                                                                                             |

**A failed experiment review does not terminally fail the experiment.** Its
explicit return choice distinguishes a flawed plan from flawed execution.
`mark_failed` is the owner action that ends the experiment. Passing reviews
reject any `return_to`. Do not copy Task's `fail → failed` review route.

Design/planning may proceed while dependencies are pending. Design pass still
enters `running`, with no intermediate `ready` state. Running assignment,
activation/dispatch and result submission remain blocked until prerequisites
succeed. Failed prerequisites produce actionable failure/replanning guidance.

There are three distinct counters/facts: workflow revision, attempt index, and
immutable submission rounds. More than one results round can belong to one
attempt. Python's generic record commit also seals on forward actions such as
retry, approval and termination; only `revise_plan`, `revise_execution` and
migration are seal-exempt. The indispensable parity fact is explicit identity
for the evidence each review graded, not an accidental count of all seal rows.

The execution window starts at the first actual `workflow.work_started` in the
attempt's `running` state. New workers and infrastructure retries do not reset
it. Returning to `planned` starts a new attempt and clears that window. The
running assignment reads the approved plan, never the latest unapproved upload.

`retry_running.evidence` recognizes `reason`, `detail` (legacy aliases `notes`
and `note`); omitted reason defaults to “infrastructure failure.” It appends
earlier feedback and instructs successors to recover completed jobs and retained
outputs before rerunning. Terminal actions document a reason input but Python
does not actually require it; TypeScript should require a bounded nonempty
reason deliberately.

On pass, conclusion precedence is review evidence's nonempty `conclusion`,
then the reviewed report's Conclusion section, then review notes. `complete`
means the research survived review; it does not imply the tested hypothesis
won. Completion does not automatically update linked Claims.

Sources: [complete graph and change functions](../../merv/src/merv/brain/workflows/definitions/experiment.py)
lines 75–80, 130–170, 177–247 and 280–287;
[return-input validation](../../merv/src/merv/brain/workflows/definitions/review.py)
lines 51–88; [actual execution clock](../../merv/src/merv/brain/research_core/experiments.py)
lines 198–217; [dependency gate](../../merv/src/merv/brain/workflows/graph.py)
lines 294–323; [transactional sealing](../../merv/src/merv/brain/research_core/records.py)
lines 328–367.

## Evidence and immutable rounds

Retired by the 2026-09-16 ruling: the agent-authored `graph` role is absent from
the table below by decision, not as an unimplemented parity gap. A process graph
is derived from records instead, so nothing here is owed.

| Role      | Agent writable?                | Required shape / cap                                                                                                                                               |
| --------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `plan`    | Yes, for plan submission.      | UTF-8 Markdown, max **16,000 bytes**; nonempty Summary, Objective & hypothesis, Evaluation sections.                                                               |
| `result`  | Yes, for results submission.   | At least one retained result; max **16,000 bytes per artifact**. Machine-readable JSON produces the exhibit; qualitative evidence is allowed.                      |
| `report`  | Yes, for results submission.   | UTF-8 Markdown, max **16,000 bytes**; nonempty Summary, Results, Deviations from plan, Conclusion sections; reference the exhibit filename when pinned.            |
| `exhibit` | **No.** System-generated only. | Deterministic metrics document at `experiments/<name>/metrics_exhibit.json`. Python's submittable-role caps do not assign the generated exhibit a 16,000-byte cap. |

Markdown checks normalize headings, match their expected prefixes, require a
nonempty body and strip HTML comments. They are structural gates; independent
review must determine scientific adequacy. Plan/report image references must
have retained figure bytes and pass the figure-link policy. A filename mention
outside comments satisfies Python's exhibit-reference check; that check does
not prove numerical interpretation.

Attachment identity includes project, experiment, current attempt, role, lens
and path. A new upload replaces the current logical slot; older content and
sealed selections remain retained. No filesystem read occurs in the server.
An upload started in one attempt cannot finish against another. Terminal
experiments reject new evidence. Submission validates selected associations
and complete content, then stores immutable submission-to-association joins on
the transition transaction.

Python permits new uploads while a review is pending; these change its current
snapshot and make the old reviewer stale. TypeScript should make any such
behavior explicit: reject review-stage mutation or supersede/reissue the
review atomically, never silently let a frozen review grade changed evidence.
Keep the review's exact submission ID directly; Python's `_graded_round` finds
the latest seal in the attempt, an inference the new domain need not repeat.

`plan.md` and `report.md` are recommended filenames, not enforced
Python gate identities. `_clean_path` only trims, normalizes backslashes and
removes leading slashes: it accepts `../plan.md` and paths outside the suggested
experiment folder because the path is a provenance/display label. Requiring
safe logical relative paths, rejecting traversal and fencing attachments with
expected revision/attempt are deliberate TypeScript improvements.

Sources: [role caps](../../merv/src/merv/brain/workflows/definitions/artifact_roles.py)
lines 29–36 and 71–96; [document validation](../../merv/src/merv/brain/workflows/definitions/documents.py)
lines 59–88, 225–298, 313–317, 382–397 and 621–653;
[association/seal/replacement](../../merv/src/merv/brain/research_core/artifacts.py)
lines 119–170, 361–412 and 492–548;
[target closure](../../merv/src/merv/brain/research_core/association_targets.py)
lines 53–115; [path cleaner](../../merv/src/merv/brain/artifacts/artifacts.py)
lines 364–368; [review freshness and graded round](../../merv/src/merv/brain/research_core/reviews.py)
lines 85–94 and 398–425.

## Metrics exhibit: observations with provenance

```json
{
  "kind": "metrics_exhibit",
  "project_id": "proj_…",
  "experiment_id": "exp_…",
  "attempt_index": 1,
  "window": { "started_at": "first actual running start, or empty" },
  "result_files": [
    {
      "path": "experiments/example/results.json",
      "data": { "accuracy": 0.72 },
      "source": {
        "type": "result_file",
        "path": "experiments/example/results.json",
        "artifact_id": "art_…",
        "sha256": "retained content digest",
        "submitted_at": "retained submission time"
      }
    }
  ],
  "verdict": { "result_files": 1 }
}
```

Select role `result`, current attempt, newest artifact per `(lens_id,path)`,
ordered by path and submission order. Parse retained UTF-8 bytes as JSON and
keep artifact ID/hash/submission time beside the original data. Python does
**not parse CSV**, despite its running-node guidance saying JSON or CSV.

The Python pin condition is at least one parsed JSON value other than null;
`false`, `0`, strings, empty arrays and objects all qualify. Invalid JSON or
invalid UTF-8 becomes null and can bypass pinning as “qualitative.” Do not copy
that ambiguity for explicitly declared JSON. Require finite strict JSON and
distinguish malformed quantitative input from intentionally qualitative data.
The exhibit does not calculate scores, compare thresholds or decide success.
Its `verdict` is only a result-file count, including unparsed source entries.

Preview and final construction use identical data. Canonical bytes are sorted,
indented JSON plus a trailing newline; the generation instant is excluded so
unchanged sources yield unchanged bytes. Pinning reuses identical content in
the attempt. A later result submission cannot rewrite a sealed earlier exhibit.

Python prepares bytes before the write transaction, rechecks workflow revision,
attempt and the exact non-exhibit source IDs before pinning, then submits with
the revision observed before preparation. Its native coordinator pins in a
separate transaction before the transition; a later gate refusal can leave the
prepared exhibit/event. TypeScript can strengthen this by committing exhibit
association, submission, review request, transition and replay receipt together,
with external byte preparation followed by one source-manifest recheck.

Sources: [source selection and pin condition](../../merv/src/merv/brain/application/experiments/exhibits.py)
lines 83–146; [exhibit schema/canonical bytes](../../merv/src/merv/brain/application/experiments/metrics_exhibit.py)
lines 19–57; [preparation orchestration](../../merv/src/merv/brain/application/experiments/transition.py)
lines 138–155 and 190–214; [transactional source checks](../../merv/src/merv/brain/research_core/experiments.py)
lines 219–244.

## Integration decisions and source differences

- Keep one Experiments program and four context formulas: planning, design
  review, execution, attempt review. Use existing Workflows, Reviews, Context
  Builder, Artifacts, Scope and State. Attempts/rounds/exhibits are domain facts,
  not new service plugins. Code receipts are prerequisites for code-aware
  research; a generic Code fixture or Task recipe is not an Experiment.
- Separate logical owner, actual producing worker and reviewer. Python's
  experiment table has no owner column; adding durable ownership and preserving
  worker/session provenance is a TypeScript authority decision. Preserve the
  existing same-source, different-worker independence model.
- Reuse current revision/request-ID contracts. Legacy native experiment
  transition inputs lack both; their implementation chooses the current
  revision and generates a new request ID. This is not a safe replay contract
  to reproduce. Authenticate before returning any mutation replay.
- Keep the exact plan and submitted evidence in review context. Use fixed
  execution grants, current lease/claim fencing and metadata-only dispatch;
  dead workers must lose ownership without deleting evidence. Review verdict,
  domain route and all related records/events must commit together.
- The broader plan's public `experiment.list/get_state` table is a proposed
  TypeScript surface, not an exact Python public MCP inventory. Its strict
  relative paths, bounded schemas, explicit revisions, ownership records and
  malformed-JSON rejection are intended improvements, not legacy behavior.
- Leave cloud execution, reflection corpus/publication, project synthesis,
  candidate promotion and cross-machine Git transport explicitly separate.
  Do not enable an unreachable reflection-debt gate to claim completeness.

Sources: [experiment persistence](../../merv/src/merv/brain/research_core/persistence.py)
lines 33–54; [native transition request identity](../../merv/src/merv/brain/research_core/records.py)
lines 328–341; [atomic review application](../../merv/src/merv/brain/research_core/reviews.py)
lines 42–80; [four assignment formulas and fixed execution policy](../../merv/src/merv/brain/workflows/definitions/experiment.py)
lines 103–137 and 205–227;
[execution declarations](../../merv/src/merv/brain/workflows/definitions/execution.py)
lines 34–70.

## Reference validation

**41 Python tests passed in 3.663 seconds** on 2026-09-15. This validates the
reference behavior, not the future TypeScript implementation. The suite uses
temporary local state and fixtures; no live Merv MCP or external provider was
invoked.

```sh
# From Merv/merv
PYTHONPATH=src:. /opt/anaconda3/bin/python -m unittest -v \
  tests.research_core.test_experiments \
  tests.research_core.test_experiment_runtime \
  tests.state.test_submission_attempts \
  tests.workflow.test_metrics_exhibit \
  > /private/tmp/merv-experiments-reference-20260915.log 2>&1
```

Coverage includes exact approved-plan retention, dependency/clock semantics,
both attempt returns, immutable same-attempt result rounds, stale preparation,
exhibit provenance and qualitative behavior, and figure/document gates. Sources
are the
[creation/review tests](../../merv/tests/research_core/test_experiments.py),
[runtime tests](../../merv/tests/research_core/test_experiment_runtime.py),
[submission-round tests](../../merv/tests/state/test_submission_attempts.py) and
[exhibit tests](../../merv/tests/workflow/test_metrics_exhibit.py).

A supplemental local fixture/pure-function probe confirmed all 18 combinations
of review role/verdict/return choice, permissive legacy path labels, pinning of
non-null scalar JSON and acceptance of terminal actions without a reason.
Its output is `/private/tmp/merv-experiments-boundary-probe-20260915.json`.
