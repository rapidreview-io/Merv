---
name: research-workflow
description: >-
  Operate the Merv research workflow: select a project, follow
  workflow.status_and_next, create and run experiments and tasks, submit
  evidence, and coordinate required design, attempt, or task reviews. Use for
  experiment- and task-level work and for resuming work already in progress.
---

# Research Workflow

Treat Merv as the authority for research state. Local files are working
material; they affect the workflow only after submission through MCP.

## Follow the state machine

The experiment lifecycle is:

```text
plan → design review → run → submit results → attempt review → complete
 ↑          │          ↑                         │
 └──────────┘          └─────────────────────────┘
```

A rejected design returns to planning. A rejected attempt returns either to
execution when the design still stands or to planning when the design itself
was flawed. Follow the returned state and `next_action`; never infer a
transition from memory.

Operate in this loop:

0. If this context window has no `agent_id` yet, call `agent.hello` once and
   pass the returned `agent_id` in every Merv call below. Subagents call it
   themselves (with your id as `parent_agent_id`); never share an id.
1. If the project is unknown, call `project(action="list")` and select the one
   the user means. Never guess an id. Use `current` only when the credential is
   known to be bound to exactly one project.
2. Call `workflow.status_and_next(project_id, experiment_id?)`.
3. Read its context, gates, allowed actions, missing evidence, and next action.
4. Do that work locally or through the specialist skill it names.
5. Submit mutations and evidence through MCP.
6. Call `workflow.status_and_next` again after every transition or review.

Pass the selected `project_id` explicitly to every project-scoped operation.
Use `project(action="overview", project_id=...)` when you need the whole
project picture or must check that a proposed claim, experiment, or task is
not a duplicate of settled work.

## Experiment or task?

Two kinds of work node exist, and the line between them is one question: does
this work exist to change confidence in a research claim?

- Yes → an **experiment**: a claim, a pre-registered plan, adversarial design
  and attempt reviews, evidence. It can succeed by failing — a refuted claim
  is a good experiment.
- No → a **task**: scoped work with a verifiable finish line — a literature
  sweep, data acquisition and preparation, an evaluation harness, a memo, a
  write-up. It succeeds only if the thing it promised exists. Tasks never carry
  a claim and never move claim status; the reflection reads their outcomes.

Tasks are uncapped; experiments keep their cap. Both may depend on other wave
nodes (`depends_on`): an experiment does not start running, and a task does not
deliver, until every dependency has succeeded. A failed dependency shows up as
`dependency_failed` — end the dependent node with a reason, or leave it for the
next reflection to replan.

## Run a task

The task lifecycle is:

```text
in_progress → submit delivery → in_review → accept → done
     ↑                              │
     └───── needs_changes ──────────┤
                                    └── fail ──→ failed
```

Two working states, two endings. `task.create(name, goal, deliverables,
depends_on?)` puts a task straight into `in_progress`; there is no planning
stage and no design review. The goal (short standalone prose) and the
deliverables (each verifiable as written) are IMMUTABLE — Merv renders and
pins `brief.md` from them at creation, and brief submissions are refused. A
wrong goal is an honest miss in the delivery, or the owner ends the task and
creates a better one.

1. **Goal and deliverables** are fixed at `task.create`: goal = 2-4 sentences,
   what needs to be done and why, standalone (name concrete datasets, tools,
   and experiments — never "the wave" or "this reflection"); deliverables =
   one item per thing that must exist, each carrying its own acceptance
   criterion in the sentence (counts, tolerances, required sections), no
   bundles, no vague nouns; 1-7 items is the rule of thumb.
2. **Do the work** however fits — locally, in a sandbox, in the task folder.
   Keep evidence as you go: files, run receipts, storage objects.
3. **Delivery** (`tasks/<name>/delivery.md`, role `delivery`,
   [delivery-template.md](delivery-template.md)): a **Confirmations** section
   with one numbered entry per deliverable, same numbering — where the thing
   is and how the reviewer can check it, pointing at durable things (files,
   storage objects, lit-review sections, run receipts); an honest miss is
   stated plainly as `not delivered — <why>`. Then **Notes**: a short
   paragraph on how the task was performed, anything else needed to verify,
   and what not to trust blindly. Merv enforces only the shape (one entry per
   deliverable); the reviewer verifies the substance.
4. `task.transition(submit_delivery)` → `review.request(target_type="task",
   role="task_reviewer")` → hand the returned handoff to a separate read-only
   agent running `task-review`. `needs_changes` sends the task back to
   `in_progress` with the reviewer's notes in `revision_context`: fix the
   delivery and resubmit. A `fail` verdict ends the task.
5. After a passing review, `task.transition(accept, evidence={"outcome": ...})`.
   The owner may end a task at any point with
   `task.transition(mark_failed, evidence={"reason": ...})`.

Use `workflow.status_and_next(project_id, task_id=...)` for the task's gate,
checks, brief, delivery, and dependencies. A closed task refuses new artifacts.

## Keep one experiment folder

Create the folder returned by `experiment.create`, normally
`experiments/<name>/`, before writing experiment files. Keep its plan, code,
configuration, compact results, figures, report, and logic graph together.
Choose a short experiment name that distinguishes it from sibling
experiments. Write the `intent` as the ask, standalone: what this tests and
why the project needs it, naming the datasets, tasks, and sibling experiments
involved by their own names — another agent may write the plan from it alone.
Put anything else the planner should have — givens, boundaries with siblings,
preferences, budgets, warnings — in the optional `details` field. Both are
immutable once created; the approved plan supersedes `details` on anything
about how.

There is no automatic synchronization between the checkout, a sandbox, and
Merv. Pull remote outputs into the experiment folder before submitting them.
Use durable object storage for large binary outputs.

## Maintain the project champion

The ordinary project manager, not an experiment worker, owns candidate
selection. Whenever experiment output looks promising against the current
champion, the manager must immediately call `candidate.submit`; do not wait for
the campaign deadline. Use `source_kind=experiment_workspace` when the external
evaluator still needs to capture task-defined output from that experiment—the
caller sets `source_ref` to the experiment id, never a filesystem path. The
evaluator will append the verified staging receipt through `candidate.stage`.

Before promotion, call `candidate.list`, compare the staged candidate against
the untouched champion on the project-level objective and meaningful shift or
robustness checks, then call `candidate.promote` with the observed champion id
(or `""` when none) and a substantive reason. Refresh and reconsider if the CAS
fails. A pending workspace nomination is visible but cannot become champion.
Keep submitting later challengers as they arrive; promotion never ends research.
Put small candidate files in Artifacts and large model/checkpoint bytes in
Object Storage—never Git.

## Author the experiment record

Use the bundled templates only when creating their corresponding documents:

- [plan-template.md](plan-template.md) for `plan.md`. Pre-register the
  hypothesis, method, comparison, decision rule, success threshold, and
  invalidation conditions before execution.
- [report-template.md](report-template.md) for `report.md`. Interpret the
  submitted results against the plan's decision rule, disclose deviations and
  failures, and keep conclusions within the tested scope.
- [graph-template.md](graph-template.md) for `graph.json`. Record the reasoning
  path—questions, decisions, pivots, consequences, and lessons—not a pipeline,
  event log, or generated metrics diagram.

Start the graph early and update it when reasoning changes. Write the plan,
report, and graph for a human reader; raw data and logs belong in separate
result artifacts.

Prefer the smallest experiment capable of producing a credible,
decision-relevant signal about its intent. Start with the minimum data, scale,
variants, seeds, compute, and infrastructure needed to distinguish the
hypothesis or address a known validity risk. In the plan, explain why that
scope is sufficient and what result would justify a larger follow-up; do not
add work merely to make the first experiment exhaustive.

When findings from earlier project experiments materially inspire the plan,
cite their `exp_...` ids and identify the finding being carried forward. When
a research paper materially informs the hypothesis, method, baseline, or
evaluation, keep the living literature review current and cite the paper in a
portable, source-native form: an arXiv id such as `arXiv:2401.12345`, a DOI
such as `doi:10.1145/3290605.3300233`, or a stable canonical source URL
(prefer `[Paper title](URL)`). Do not cite Merv's internal `paper_...` id in an
experiment plan. Omit prior-work references when the design is genuinely
independent; do not add decorative citations.

## Preserve honest evidence

For quantitative work, save compact machine-readable results and the figures
used to reach the conclusion. Include enough provenance to identify the run,
configuration, data or evaluation slice, seed, metric, and metric direction.
Retain every attempted seed or configuration, including failed, partial, and
aborted runs. Never submit only the favorable rows.

Treat the plan's Evaluation section as the contract. The report interprets the
record; it does not replace it. A conclusion is ready only when the submitted
results support it under the pre-registered rule.

## Submit artifacts

Follow `artifact_guidance` and the `artifact.submit` tool contract for roles,
fields, limits, figures, and upload commands. The durable evidence is the
uploaded content, not the current local file:

1. Write or update the local file.
2. Submit its metadata with the exact target and role requested by the
   workflow.
3. Run every returned upload command, including figure uploads.
4. After any edit that should affect a gate, resubmit and upload the file.

Use artifact ids already returned in authoritative context. Batch focused
reads with `artifact.find`; request full content only when summaries cannot
answer the question.

## Route specialist work

- Load `sandbox-operation` before provisioning or operating a sandbox. Use it
  for provider selection, caller-owned keys, durable runs, observation,
  retention, recovery, extension, and release.
- Load `feed-posting` at the start of a session and post as work happens: a
  result, a kill, a number that moved, a paper, an idea, a question.
- Load `project-reflection` when project-level reflection is requested or
  `workflow.status_and_next` reports reflection work or a reflection gate.
- Keep the living literature review current when a paper materially informs a
  claim, plan, or conclusion: cite it, inspect the outline, and edit only the
  relevant section. Literature guidance is advisory, not an experiment gate.

Run lightweight safe checks locally. Use a sandbox for expensive, isolated,
long-running, data-intensive, or GPU work.

## Coordinate reviews

When the workflow requests review, use `review.request` and pass its returned
handoff unchanged to a separate read-only agent:

- `experiment-design-review` before execution.
- `experiment-attempt-review` after result submission.
- `task-review` after a task's delivery is submitted.

The reviewer owns `review.start` and `review.submit`; the producing agent must
not review its own work. Preserve the capability long enough to hand it off,
and do not replace a still-valid request merely because review started.

After submission, call `workflow.status_and_next` and follow its return state.
Revise and resubmit the affected artifacts before retrying a rejected gate.

## Complete only through MCP

Complete an experiment only after:

- the required plan, result, report, and logic-graph evidence is submitted;
- required reviews have passed;
- the conclusion is grounded in the submitted record; and
- MCP accepts the completion transition.

If MCP rejects an action, follow its reported gate and next action. Do not work
around the state machine.
