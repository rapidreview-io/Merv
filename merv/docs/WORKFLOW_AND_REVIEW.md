# Workflow and review

The Workflows layer owns versioned graphs for experiments, tasks, reflections,
and individual reflection lenses. Their executable declarations live in
`workflows/definitions/`; Research Core supplies domain records and facts through
bindings. `workflow.assignment` returns a node's starting brief, exact evidence
references, prerequisites, and available actions. `workflow.status_and_next`
retains the experiment, task, and project orientation views.

Experiments and tasks are the two node kinds of a wave. The line between them
is one question: does the work exist to change confidence in a research claim?
Yes → experiment (evidence, reviewed for validity; it can succeed by failing).
No → task (a deliverable, checked against its brief; it succeeds only if the
thing it promised exists). Tasks never carry a claim.

## Experiment workflow

```text
planned -> design_review -> running -> experiment_review -> complete
            |                                      |
            +-> planned                            +-> running
                                                   +-> planned

failed and abandoned are explicit terminal exits.
```

The backward paths are deliberate:

- a rejected design returns to `planned` with revision context;
- an execution review returns to `running` when the plan stands but execution
  or the conclusion needs work;
- it returns to `planned` and starts a new attempt when the plan itself is
  flawed.

The main graph transitions are:

1. **Plan** — a submitted, size-bounded plan with the required sections.
2. **Design review** — a passing independent design review pinned to that plan.
3. **Execution evidence** — current-attempt result artifacts.
4. **Report and graph** — a valid report plus an authored DAG-shaped logic
   graph; when a metrics exhibit exists, the report must interpret it.
5. **Experiment review** — a passing independent review of the exact submitted
   attempt snapshot.

A passing design review moves directly to `running`; a passing attempt review
completes the experiment. Review submission commits the verdict and its graph
transition together. Execution prerequisites still gate dispatch, and the work
clock and tracking action start only when an execution agent activates its lease
or an interactive agent calls `workflow.begin` with the current revision.

Transitions seal the current Artifact composition in the same database
transaction as the state change. Editing a checkout file has no effect until
the revised file is submitted again.

A project may have at most seven non-terminal experiments. Experiment creation
is also blocked when project-level reflection has become mandatory.

## Task workflow

```text
in_progress -> in_review -> done
     ^            |
     +------------+  needs_changes (same attempt)
                  +-> failed  (fail verdict; the task ends)

failed is also the owner's explicit exit (mark_failed with a reason).
```

A task is created straight into `in_progress`: there is no planning stage and
no design review. Its gates are:

1. **Goal** — fixed at `task.create` and immutable: short standalone prose
   (what and why) plus `deliverables`, one item per thing that must exist,
   each verifiable as written. Merv renders and pins `brief.md` from them;
   brief submissions against tasks are refused. A reflection-proposed task
   carries the same fields in the change spec.
2. **Dependencies** — every node the task depends on has succeeded.
3. **Delivery** — `delivery.md` (role `delivery`) with a **Confirmations**
   section holding one numbered entry per deliverable — where the thing is
   and ` — how to check: ` how the reviewer verifies it; an honest miss is
   `not delivered — <why>`. Then **Notes** (process prose). Resubmission
   after a send-back is the next version, each version complete. Merv
   enforces the shape only (one entry per deliverable) and parses the
   structure for the UI; the reviewer verifies the substance.
4. **Task review** — a passing independent `task_reviewer` review pinned to
   that delivery. `needs_changes` returns the task to `in_progress` on the
   same attempt; `fail` ends it (`failed_by = reviewer`).

Tasks are uncapped. A task's attempt index never advances; the review return
keeps the same attempt so the artifact and review machinery stays uniform.
Auto-run dispatches both task work and independent task reviews through the
same node assignment contract. A passing task review completes the task; a
separate owner acceptance call is unnecessary.

## The wave DAG

Both node kinds may depend on other nodes of the same project
(`node_dependencies`, written by `task.create`, `experiment.create`, and
reflection publish from the change spec's `depends_on`). Execution-node leases
wait until every dependency has succeeded (`complete` / `done`), even when an
experiment is already `running` or a task is `in_progress`. Task delivery also
checks those dependencies. A dependency that ended without succeeding
surfaces as `dependency_failed`: the dependent node is ended with a reason, or
left for the next reflection to replan. Edges must not form a cycle.

## Reflection workflow

```text
reflecting -> synthesizing -> reflection_review -> consolidating -> consolidation_review -> published
    ^               ^                |
    |               +----------------+  return_to=synthesizing
    +--------------------------------+  return_to=reflecting

abandoned is the explicit terminal exit.
```

One reflection wave may be open per project. Its gates are:

1. **Roster** — exactly five lenses: `amplify`, `avoid`, `entropy`, and two
   wave-specific lenses with distinct charters.
2. **Lens coverage** — five independent child workflows submit their own
   current-attempt `reflection_lens_doc`; the parent joins their pinned outputs
   and moves to synthesis automatically.
3. **Synthesis** — a project graph, concise reflection document, and
   materializable change spec: claim changes plus the next wave — at most
   three experiments and any number of tasks, with `depends_on` edges.
4. **Reflection review** — a passing independent review pinned to that exact
   synthesis.

Passing reflection review makes the research decision authoritative and enters
code consolidation. One immutable proposal must account for every experiment;
a separate `consolidation_reviewer` checks it. The runner then
compare-and-swaps the exact proposal into Merv's central Git ref. Publishing is
atomic only after that receipt: it records the graph version, applies approved
claim changes, creates the approved wave — tasks with their briefs pinned,
experiments, and the dependency edges between them — and records the event.

A rejection to `synthesizing` retains the lens work. A rejection to
`reflecting` advances the attempt and repeats the fan-out.

## Project-level state

The project has no independent mutable status column. Its effective state is
derived from open reflections, active experiments, and reflection drift:

- an open reflection takes priority in project-level guidance;
- otherwise active experiments and tasks determine the current work;
- after three newly terminal experiments, or a claim becoming contradicted,
  reflection is suggested;
- when the project is idle (no live experiments or tasks) and has new
  completed work — a finished experiment or task the last published
  reflection never saw — reflection is recommended;
- after five newly terminal experiments, a published reflection is required
  before another experiment can be created.

Experiment- and task-scoped status calls remain focused on that node and carry
any project reflection signal alongside it. Finished tasks enter the reflection
corpus as inputs to read; they never count toward the experiment debt that
nudges or blocks.

## Review boundary

The five workflow roles are `design_reviewer`, `experiment_reviewer`,
`task_reviewer`, `reflection_reviewer`, and `consolidation_reviewer`.

1. The producer calls `review.request`.
2. Research Core pins the target snapshot and returns a short-lived capability
   once, together with a reviewer handoff prompt.
3. A distinct reviewer session calls `review.start` and receives the pinned
   evidence plus bounded context.
4. The reviewer submits one verdict and synopsis through `review.submit`.
5. Submission rechecks that the request and snapshot are still current before
   routing a rejection or satisfying a gate.

Capabilities are stored only as hashes. Declared producer and reviewer session
IDs must differ, but those caller-supplied strings are a workflow separation,
not cryptographic proof of independent execution. See
[REVIEW_IDENTITY.md](REVIEW_IDENTITY.md) for the security boundary and
[MCP_SERVER_CONTRACT.md](MCP_SERVER_CONTRACT.md) for wire shapes.

## Ownership

- Research Core declares states, transitions, gates, attempts, and transaction
  invariants.
- Artifacts owns submitted evidence and immutable sealing.
- Application combines Research facts with Sandbox, Feed, and other modules
  to format guidance.
- Surface owns authentication, authorization, MCP/HTTP schemas, and response
  presentation.
- Skills tell agents how to perform the work; they do not define legal state
  transitions.
