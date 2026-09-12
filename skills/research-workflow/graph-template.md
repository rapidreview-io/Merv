# Logic graph

Author `graph.json` as the qualitative reasoning path of an experiment: the
questions that mattered, decisions and their rationale, pivots, consequences,
and lessons. Submit it as the experiment's `graph` artifact.

## Tell the reasoning story

Structure the graph as:

```text
question → decision → consequence → lesson
```

Events and metrics may anchor reasoning, but they are not the structure.

- Do not draw a pipeline, component map, or provenance diagram.
- Do not dump metrics; a number earns a node only when it changed a decision.
- Do not generate the graph from logs or result files. Selecting what mattered
  is the authorship.

Choose node kinds, edge labels, and structure freely. Include a development
only when it helps explain what had to be learned or decided and why.

## Keep evidence behind the story

Keep labels brief and use `refs` for depth. References may point to submitted
artifacts, reviews, claims, experiments, runs, or relevant local paths. Link a
problem to the evidence that revealed it and a pivot to the review or result
that forced it.

Start the graph early and update it when reasoning changes. Resubmit after any
edit that should become visible to the workflow. When an important development
would exceed the node budget, prune or combine weaker nodes rather than hiding
the new information.

## Required envelope

The submitted JSON must:

- have `"version": 1`;
- contain a non-empty `nodes` list;
- give every node a unique string `id` and non-empty string `label`;
- contain no more than 16 nodes;
- use edges whose `from` and `to` reference existing nodes;
- contain no self-loop or cycle; and
- stay below the artifact size limit.

`kind`, `detail`, `refs`, edge `label`, and other fields are editorial. The
server checks the envelope; the reviewer judges whether the story is honest.

## Shape

```json
{
  "version": 1,
  "title": "A short title for the reasoning story",
  "nodes": [
    {
      "id": "question",
      "kind": "question",
      "label": "What determines the observed gap?",
      "refs": ["claim_..."]
    },
    {
      "id": "decision",
      "kind": "pivot",
      "label": "Rerun with the confounder removed",
      "detail": "The clean comparison was cheaper than interpreting tainted runs.",
      "refs": ["rev_...", "art_..."]
    }
  ],
  "edges": [
    {
      "from": "question",
      "to": "decision",
      "label": "resolved by"
    }
  ]
}
```
