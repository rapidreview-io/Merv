# @merv/reflections

Reflections judges the project's live research. A wave opens five independent lens workflows (evidence, theory, methods, synthesis and next steps), then one synthesis of their reports with a change specification, which an independent reviewer approves or returns. That reviewer also updates the paper's Methods and Results. While a wave is open, new tasks and experiments wait; work already started continues. The pause is the `reflection` definition's `blocksStarts: ['task', 'experiment']`, which Workflows applies to every start, so Reflections calls neither Tasks nor Experiments. See [Reflections over live research](../../docs/REFLECTIONS.md).

## Where it sits

```mermaid
flowchart LR
  subgraph people["People & agents"]
    worker["Worker agent<br/><small>lens, synthesis, reviewer</small>"]
  end
  subgraph logic["Research logic"]
    reflections["Reflections<br/><small>lens waves</small>"]
    research["Research<br/><small>cycle coordinator</small>"]
    paper["Paper<br/><small>living paper</small>"]
    experiments["Experiments"]
  end
  subgraph foundations["Foundations"]
    workflows["Workflows<br/><small>durable workflow engine</small>"]
    reviews["Reviews<br/><small>independent verdicts</small>"]
    contextBuilder["Context Builder<br/><small>assignment context</small>"]
    artifacts["Artifacts<br/><small>lens reports</small>"]
    sessions["Sessions<br/><small>agent continuity</small>"]
    domainEvents["Domain Events"]
    scope["Scope<br/><small>projects</small>"]
    ui["UI"]
    state["State"]
  end
  subgraph external["External"]
    postgres[("PostgreSQL")]
  end
  worker -- "calls reflection.* tools" --> reflections
  research -- "creates reflection wave" --> reflections
  reflections -- "registers wave, lens workflows; an open wave blocks task and experiment starts" --> workflows
  reflections -- "requests synthesis review" --> reviews
  reflections -- "registers three recipes" --> contextBuilder
  reflections -- "applies paper changes" --> paper
  reflections -- "imports @merv/experiments/rules" --> experiments
  reflections -- "reads reports" --> artifacts
  reflections -. "registers lens continuity" .-> sessions
  reflections -- "subscribes lease release" --> domainEvents
  reflections -- "injects" --> scope
  reflections -- "registers /reflections page" --> ui
  reflections -- "injects" --> state
  state -- "reads/writes" --> postgres
  class reflections self
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
```

Reflections is the judging step of each research cycle, built from two workflows it registers, `reflection` and `reflection.lens`. Research opens the wave once the cycle's work has finished, and turns the approved change specification into the next cycle's tasks and experiments; the dotted arrow is an optional binding.

## Surface

- `@merv/reflections`: the `reflections` service. It registers `reflection@4` and `reflection.lens@3` with Workflows, the lens, synthesis and review recipes with Context Builder, and the synthesis review owner with Reviews.
- `@merv/reflections/tools`: `reflection.create`, `reflection.list`, `reflection.get`, `reflection.lens`, `reflection.submit_lens`, `reflection.submit` and `reflection.end`.
- `@merv/reflections/ui`: the `/reflections` page, and the open wave at the head of the Running page's work lane.
