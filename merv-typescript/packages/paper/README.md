# @merv/paper

Paper stores the living project paper: four documents, Problem, Literature, Methods and Results, with citations and immutable revision history. It creates no workflow, assignment or lease. The owner's main agent edits any document with `paper.patch`; scientific reviewers in Experiments and Reflections land their Methods and Results changes inside their own review transaction. The Problem is the source of the project Introduction that every assignment carries. See [Living paper](../../docs/LIVING_PAPER.md).

## Where it sits

```mermaid
flowchart LR
  subgraph people["People & agents"]
    agent["Main agent<br/><small>acting for the owner</small>"]
  end
  subgraph logic["Research logic"]
    paper["Paper<br/><small>living paper</small>"]
    experiments["Experiments"]
    reflections["Reflections"]
    tasks["Tasks"]
    research["Research<br/><small>cycle coordinator</small>"]
  end
  subgraph foundations["Foundations"]
    scope["Scope<br/><small>projects</small>"]
    artifacts["Artifacts"]
    ui["UI"]
    state["State"]
  end
  subgraph external["External"]
    postgres[("PostgreSQL")]
  end
  agent -- "calls paper.patch" --> paper
  experiments -- "applies paper changes" --> paper
  reflections -- "applies paper changes" --> paper
  tasks -- "reads paper sections" --> paper
  research -. "reads Problem" .-> paper
  paper -- "emits paper.patched" --> research
  paper -- "writes project Introduction" --> scope
  paper -- "checks cited artifacts" --> artifacts
  paper -- "registers /paper page" --> ui
  paper -- "injects" --> state
  state -- "reads/writes" --> postgres
  class paper self
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
```

Paper is the one document the research cycle reads and writes: reviewers in Experiments and Reflections revise Methods and Results through it, and Tasks reads it into each assignment. A Problem patch rewrites the project Introduction and wakes a research cycle still defining; the dotted arrow is Research's optional binding.

## Surface

- `@merv/paper`: the `paper` service. It requires State, Scope and Artifacts, and records `paper.patched`, `paper.cited` and `paper.reviewed` events.
- `@merv/paper/tools`: `paper.read`, `paper.patch` and `paper.cite`.
- `@merv/paper/ui`: the `/paper` page.
