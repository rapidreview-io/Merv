# Code work integration

This optional adapter connects research decisions to the [Code utility](../code/README.md).
Research owners decide dependencies, accepted outcomes, review requirements and publication
obligations. The adapter translates those decisions into exact code pins, isolated writers,
retained evidence, dependency blockers, conflict-resolution work and publication operations.
It never makes Code itself depend on a research service.

It provides `ctx.codeWork`; Tasks, Experiments, Research, Consolidation and Knowledge
bind to that capability only when present. Reviews and Sandboxes are optional collaborators.
A review-dependent action remains unavailable while its provider is absent; a missing plugin
never grants acceptance or erases an existing Git obligation.

| Module                  | Dependencies    | Interface                                                                      |
| ----------------------- | --------------- | ------------------------------------------------------------------------------ |
| `@merv/code-work/tools` | CodeWork, Tools | `code.*` tools                                                                 |
| `@merv/code-work/ui`    | CodeWork, UI    | Repository connection, selected base, retained operations, Home's person moves |
| `@merv/code-work/api`   | CodeWork, API   | The `/code/*` machine and GitHub routes                                        |

The API adapter mounts `/code`, with GitHub's OAuth callback public. Unloading CodeWork withdraws those routes, which then answer 503, without stopping the API.

## Where it sits

```mermaid
flowchart LR
  subgraph people["People & agents"]
    worker["Worker agent<br/><small>leased session</small>"]
  end
  subgraph researchLayer["Research logic"]
    tasks[Tasks]
    experiments[Experiments]
    research[Research]
  end
  subgraph foundations["Foundations"]
    codeWork["Code work<br/><small>research to Git</small>"]
    code["Code<br/><small>Git utility</small>"]
    sessions[Sessions]
    workflows[Workflows]
    domainEvents[Domain Events]
    reviews[Reviews]
    sandboxes[Sandboxes]
    api["API<br/><small>HTTP and tool registry</small>"]
    ui[UI]
  end
  subgraph external["External"]
    github[GitHub]
  end
  tasks -- "injects if present" --> codeWork
  experiments -- "injects if present" --> codeWork
  research -- "injects if present" --> codeWork
  codeWork -- "injects" --> code
  codeWork -- "injects" --> sessions
  codeWork -- "injects" --> workflows
  codeWork -- "subscribes to events" --> domainEvents
  codeWork -- "reads review provenance" --> reviews
  codeWork -- "runs project checks" --> sandboxes
  codeWork -- "mounts /code, code.* tools" --> api
  codeWork -- "row, Running part" --> ui
  ui -- "imports @merv/code-work/models" --> codeWork
  worker -- "calls code.* tools" --> api
  code -- "App auth, Git transport" --> github
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
  class codeWork self
```

Code work is the one bridge between research decisions and Git: Tasks, Experiments and Research bind to it when it is present, and it alone drives Code. Through Domain Events it initializes each new project, opens and ends a session's writer generation as its workspace attaches and closes, and reconciles research state on every workflow transition.

## Composition

The default composition enables the integration, with both Code and CodeWork optional.
Disable Code to suspend all its adapters. Code builds its repository journal and mirror;
CodeWork opens them with its callbacks (what imported history changes, which sessions hold a
workspace) and runs imports and the `/code/v2` workspace protocol on them, so disabling it keeps Code's records, repository files and GitHub connection but stops that
work and withdraws every `code.*` tool and `/code` route until it is enabled again. Use [the no-Code configuration](../../config/no-code.example.json) to start research
without any Code entries. Existing Git work waits for restoration; code-free research can
complete its full review and reflection lifecycle.

GitHub's default branch and the branch selected for Merv are different settings. The selected
branch is the project's base, whatever its name. Each running unit keeps its exact starting
commit, so changing the project base cannot rewrite work already pinned to an older commit.
Connection, retained server history, accepted changes and remote publication remain visible
as distinct states. Connecting a repository is not approval to merge a research outcome.

Review provenance is read through the Reviews service rather than its private tables.

The adapter owns research unit declarations, dependency-derived pins, acceptance bodies and
hashes, reviewed rounds, resolution provenance, and publication obligations. Its records
compose Code's generic workspace and retained-commit API; Code receives commit identities
and durable repository holds, without interpreting research workflow state.

See the [ownership boundary and upgrade behavior](../../docs/CODE_WORK_BOUNDARY.md).
