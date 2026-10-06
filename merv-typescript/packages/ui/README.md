# @merv/ui

UI is the shell every other plugin draws into. Its server plugin keeps a registry of sidebar rows and Running-page parts that feature adapters register, mounts the built web client at `/ui`, and answers the page's own reads through `ui.*` tools. The web client (`web/`) is a React app that calls tools over the same `POST /tools/<name>` endpoint agents use and draws each row's page from its view `kind`. The plugin injects `api` and `tools`, provides `ui`, and is optional in the default composition.

## Where it sits

```mermaid
flowchart LR
  subgraph people["People & agents"]
    person["Person<br/><small>browser</small>"]
  end
  subgraph research["Research logic"]
    tasks[Tasks]
    experiments[Experiments]
    paper[Paper]
  end
  subgraph foundations["Foundations"]
    ui["UI<br/><small>shell and web client</small>"]
    api["API<br/><small>HTTP and tool registry</small>"]
    sessions[Sessions]
    fleet[Fleet]
    artifacts[Artifacts]
    workflows[Workflows]
  end
  person -- "HTTP /ui, /tools" --> api
  ui -- "mounts /ui, registers ui.*" --> api
  ui -- "reads open gates, work records' workflows" --> workflows
  tasks -- "row, Running part" --> ui
  experiments -- "row, Running part" --> ui
  sessions -- "row, Running part" --> ui
  fleet -- "row, Running part" --> ui
  paper -- "registers row" --> ui
  artifacts -- "registers row" --> ui
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
  class ui self
```

UI owns no research or work records: research and foundation plugins inject `ui` from their optional `/ui` adapters to add rows and Running parts, and withdraw them when they unload. A person's browser loads the bundle from `/ui` and then reads `ui.shell`, `ui.home` and each row's own tools through the API.

## Surface

- `ctx.ui.register(row)`: a sidebar row with an id, group, order, path and view, and an optional live `status` and `read`; disposing it removes the row at once.
- `ctx.ui.contribute(part)`: one owner's part of the Running page. An owner of work records declares their `workflows`, and a `work:` key's sidebar is asked only of the owner of its record's workflow.
- Tools: `ui.shell`, `ui.home`, `ui.running` and `ui.running_panel`, which no agent conversation is offered, and `ui.read`, which returns a row's data when the row has no domain tool of its own.
- Route: `/ui`, public, serving the built bundle.
- Row: `settings`.
