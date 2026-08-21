# Reflection artifacts

Use these shapes when authoring reflection documents. Let the artifact and
reflection tool contracts supply field limits, upload mechanics, and gate
errors.

## Lens reflection

Each lens agent writes and submits its own Markdown document as
`reflection_lens_doc` with the roster's exact `lens_id`.

```markdown
# <Lens title>

## Summary
Two or three plain-language sentences stating the most important finding, what
it changes about the project view, and the main uncertainty.

## Analysis
The evidence examined, the lens-specific interpretation, contradictions or
surprises, and anything that could not be verified. Cite record ids or paths.

## Implications
What the project should preserve, stop, test, or reconsider from this lens.
```

For the `avoid` lens, include a cumulative negative-knowledge ledger:

```markdown
| direction tested | setting | what happened | why it failed | retry only if |
|---|---|---|---|---|
| <direction> | <evidence> | <result> | <cause> | <changed condition> |
```

Re-verify inherited rows so the current ledger stands alone.

## Project logic graph

Submit the reconciled project state as `project_graph`. Start from the prior
published graph returned by `reflection.get` when one exists; otherwise author
the first graph. Follow
[the graph template](../research-workflow/graph-template.md) for the enforced
JSON envelope.

Represent the current logic—not chronology or dataflow—with brief lessons,
dead-end patterns, established beliefs, and open questions. Use references for
detail. Prune or combine stale nodes to make the new story coherent within the
graph budget.

## Reflection document

Submit a concise Markdown `reflection_doc`:

```markdown
# Reflection

## Summary
What this wave changes about the project's current understanding.

## Critical reading
What survives verification, what was ruled out, what remains uncertain, and
where the lenses disagreed.

## Decision / future directions
Why the proposed claim changes and the next wave — its experiments and tasks —
follow from that reading.
```

Do not paste together the five lens documents. Use compact tables, bullets, or
evidence-bearing figures only when they make the scientific argument easier to
inspect.

## Change spec

Submit the belief-state update as `change_spec`. Use new-claim `key` values when
an experiment in the same spec tests a claim being created. An experiment may
omit `tested_claim_refs` when it does not test a tracked claim; when provided,
each reference must name an existing claim id or a new-claim key from the same
spec.

The decision is the next wave: a DAG of experiments and tasks. Propose at most
three experiments (tasks are uncapped; a wave may be tasks only — the project's
first wave usually is). Use `depends_on` — keys from this spec, or existing
`exp_`/`task_` ids — when a node must not start before another has succeeded:
an experiment waits at `ready_to_run`, a task before it delivers. Node names
must be unique across the wave. Tasks may follow anything; an experiment may
follow tasks only — never another experiment of this spec, directly or through
a chain of tasks. Sequential experiments belong to the next reflection, after
the first one's results are in.

A task is scoped work with a verifiable finish line and no claim: a literature
sweep, data acquisition and preparation, an evaluation harness, a memo. Be
specific about outcomes, silent about method: `goal` says what and why,
`done_when` lists checks — each states what must be true when the task is done
and how it can be verified — and optional `scope`/`context` bound the work.
Write the goal in the brief's shape (one headline line, `Deliver:` bullets,
`So that <why>`) and STANDALONE: the task is read on its own page, so name the
experiments and datasets it serves by name, never "the wave" or "this
reflection". Publication pins each task's brief from these fields, so the
executor starts from the contract you wrote.

```json
{
  "version": 1,
  "claim_changes": [
    {
      "op": "update",
      "claim_id": "claim_existing",
      "status": "supported",
      "confidence": "high",
      "rationale": "The reviewed evidence that warrants this change."
    },
    {
      "op": "create",
      "key": "new_claim_key",
      "statement": "A testable project belief.",
      "scope": "Where the belief is intended to hold.",
      "confidence": "medium",
      "rationale": "Why the project should now track it."
    }
  ],
  "decision": {
    "type": "create_experiments",
    "tasks": [
      {
        "key": "prep_data",
        "name": "prep-data",
        "goal": "Prepare dataset D with clean, deduplicated splits.\n\nDeliver:\n- train/val/test parquet files under out/\n- a data card\n\nSo that the distill-resnet18 and scratch-resnet18 experiments train on identical splits.",
        "done_when": [
          "train/val/test parquet files exist under out/ — verify: row counts match the data card",
          "no id appears in more than one split — verify: run check_overlap.py, expect 0"
        ],
        "scope": "No new data sources.",
        "context": "Raw dump lives in storage object sto_....",
        "depends_on": []
      }
    ],
    "experiments": [
      {
        "key": "experiment_key",
        "name": "folder-safe-name",
        "intent": "The precise question this experiment will test.",
        "details": "Optional: givens, boundaries, preferences, budgets for whoever plans it.",
        "tested_claim_refs": ["new_claim_key"],
        "depends_on": ["prep_data"]
      }
    ]
  }
}
```

The reflection proposes the next wave; it does not create experiments or tasks
directly or decide to terminate the project. Publication materializes the
reviewed spec: claims, tasks (with pinned briefs), experiments, and the
dependency edges between them.
