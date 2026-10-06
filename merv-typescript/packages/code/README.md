# Code

Code is the Git utility. It retains exact commits, project repository bindings,
workspace inputs and writer generations; owns repository files and Git
execution; and provides optional GitHub authentication and transport. It depends only on
**State, Scope and Domain Events**: it follows session attach and close events to open and end
writer generations (subscription `code.writers.v1`). It does not load Workflows, Reviews,
Sessions, or research policies.

The core service is `ctx.code`. Its repository, workspace and writer APIs are technical building
blocks. Callers retain commits under opaque keys and pin workspace inputs inside their own
transaction. Retention keys preserve every commit across repository transfers and rebinding.
Core checks integrity and concurrency; it does not decide research acceptance, scheduling,
review requirements, or which experiment's work belongs in a project.

The [Code work integration](../code-work/README.md) provides those connections
and the user-facing tools, machine API and UI. Tasks, Experiments, Knowledge and Research
require it, so every composition that loads them loads both plugins. GitHub is optional: a local repository does not require a GitHub connection.

## Where it sits

```mermaid
flowchart LR
  subgraph research["Research logic"]
    tasks[Tasks]
    experiments[Experiments]
  end
  subgraph foundations["Foundations"]
    codeWork["Code work<br/><small>research integration</small>"]
    code["Code<br/><small>Git utility</small>"]
    runner["Runner<br/><small>machine workspace driver</small>"]
    scope[Scope]
    state[State]
    domainEvents[Domain Events]
  end
  subgraph external["External"]
    postgres[PostgreSQL]
    repositories["Repository files<br/><small>repositories.root</small>"]
    github[GitHub]
  end
  tasks -- "injects" --> codeWork
  experiments -- "injects" --> codeWork
  codeWork -- "injects" --> code
  runner -- "loads workspace driver" --> code
  code -- "injects" --> scope
  code -- "injects" --> state
  code -- "subscribes to session events" --> domainEvents
  state -- "reads/writes" --> postgres
  code -- "reads/writes" --> repositories
  code -- "App auth, Git transport" --> github
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
  class code self
```

Code sits at the bottom of the Git path: only Code work injects it, and research plugins reach Git through Code work, never through Code. The browser reaches Code's store types only through Code work's models. Code keeps the facts, the repository files and the GitHub connection; whether a commit is accepted is decided above it.

## Composition and ownership

| Component          | Responsibilities                                                                                   | Required services                                               |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `@merv/code`       | Repository ownership, retained Git facts, fencing, GitHub connection                               | State, Scope, Domain Events                                     |
| `@merv/code-work`  | Research dependencies, evidence, review provenance, workspace handoff and publication coordination | Code, State, Scope, Sessions, Workflows, Reviews, Domain Events |
| Code work adapters | Existing `code.*` tools, `/code/*` controls and Code UI                                            | CodeWork plus Tools, API or UI                                  |

The utility owns repository locks and the GitHub client. The integration releases its own
operations when unloaded. Technical changes to bindings and writers notify optional
projections within the same transaction; failure rolls back both the fact and projection.
Unloading a projection never deletes facts. Persistent repository holds preserve transfer
and rebinding restrictions when an integration is unloaded. Reattachment rebuilds derived
research state.

`repositories.root`, `quotaBytes` and `reservedFreeBytes` belong to the core configuration.
`finalizeGraceSeconds` also belongs to Code, so every writer uses the same timeout.
Code builds the repository journal and its mirror, and the integration opens them with
`openStore`, lending the callbacks only it can answer, and closes them when it unloads.
Import maintenance (every 300 s), drain timing (45 s) and mirroring (every 30 s) run on
Code's defaults; only automatic base merging is the integration's to switch off. Disaster backup and restoration belong to
[deployment operations](../../docs/RECOVERY_SNAPSHOTS.md), outside both plugins. Historical migration text and retained workflow evidence remain unchanged. A separate generic
storage migration creates technical workspace, commit retention and repository hold records;
standalone Code never interprets acceptance or reviews.

Code owns the [store protocol](src/store/protocol.ts) (`@merv/code/store/protocol`): what Code
itself parses (the import, rebind, upload fence, fence and mirror inputs and the workspace
manifest), the store, mirror and writer statuses, and their size limits. The machine routes'
own bodies and the repository preparation belong to Code work.

The machine [Code workspace driver](src/driver/index.ts) supports isolated checkouts and
cross-machine handoff. The [Runner](../runner/README.md) loads it only when enabled;
`workspaceDrivers: []` supports execution without Code or Git. It is the only driver: the
former local repository driver, for a runner with a repository of its own, was removed.

See [Code operations](../../docs/CODE_OPERATIONS.md),
[GitHub connections](../../docs/GITHUB_REPOSITORIES.md), and the
[ownership boundary and upgrade behavior](../../docs/CODE_WORK_BOUNDARY.md).
