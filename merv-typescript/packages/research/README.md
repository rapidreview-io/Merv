# @merv/research

Research coordinates the outer research cycle over work that other plugins own. A cycle pins the project definition from the paper's Problem, waits for its selected tasks and experiments to finish, and opens a reflection wave. Once the wave is approved, the cycle completes, or first injects one consolidation task that brings its accepted code to main. An approved plan can open the next wave of tasks and experiments and the cycle that waits on them. Research launches no workers. See [Research coordinator](../../docs/RESEARCH.md) and [continuous research](../../docs/CONTINUOUS_RESEARCH.md).

## Where it sits

```mermaid
flowchart LR
  subgraph people["People & agents"]
    owner["Project owner"]
  end
  subgraph logic["Research logic"]
    research["Research<br/><small>cycle coordinator</small>"]
    paper["Paper<br/><small>living paper</small>"]
    tasks["Tasks"]
    experiments["Experiments"]
    reflections["Reflections<br/><small>lens waves</small>"]
  end
  subgraph foundations["Foundations"]
    workflows["Workflows<br/><small>durable workflow engine</small>"]
    domainEvents["Domain Events"]
    artifacts["Artifacts"]
    codeWork["Code Work<br/><small>managed Git</small>"]
    ui["UI"]
    scope["Scope"]
    state["State"]
  end
  subgraph external["External"]
    postgres[("PostgreSQL")]
  end
  owner -- "calls research.advance" --> research
  research -- "registers research workflow, publishes automation blockers" --> workflows
  research -- "reads Problem" --> paper
  research -- "waits on, creates tasks" --> tasks
  research -- "waits on, creates experiments" --> experiments
  research -- "creates reflection wave" --> reflections
  research -- "opens next cycle" --> research
  research -- "subscribes workflow.transition" --> domainEvents
  research -- "writes cycle digest" --> artifacts
  research -- "publishes to main" --> codeWork
  research -- "registers /work page" --> ui
  research -- "injects" --> scope
  research -- "injects" --> state
  state -- "reads/writes" --> postgres
  class research self
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
```

Research drives the cycle of tasks, experiments and reflections, each of which keeps its own workflow; it registers only `research`. Every plugin it points to is required, and in automatic mode workflow events advance a cycle without the owner.

## Surface

- `@merv/research`: the `research` service. It registers `research@6` with Workflows and subscribes through Domain Events to workflow, code, paper and research events to advance automatic cycles.
- `@merv/research/tools`: `research.create`, `research.list`, `research.get`, `research.lineage`, `research.replan`, `research.end` and `research.advance`.
- `@merv/research/ui`: the `/work` page, framed by its cycle, and the `/research` cycles page. Its part of `ui.home`, which Home and the rail poll, is `research.home`: the open cycles and the newest that ended, so the poll does not grow with every cycle run.
