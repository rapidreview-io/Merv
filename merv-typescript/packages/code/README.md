# Code

Code is an optional Git utility. It retains exact commits, project repository bindings,
workspace inputs and writer generations; owns repository files and Git
execution; and provides optional GitHub authentication and transport. It depends only on
**State and Scope**. It does not load Workflows, Reviews, Sessions, or research policies.

The core service is `ctx.code`. Its repository, workspace and writer APIs are technical building
blocks. Callers retain commits under opaque keys and pin workspace inputs inside their own
transaction. Retention keys preserve every commit across repository transfers and rebinding.
Core checks integrity and concurrency; it does not decide research acceptance, scheduling,
review requirements, or which experiment's work belongs in a project.

The optional [Code research integration](../code-research/README.md) provides those connections
and the user-facing tools, machine API and UI. Research can run without either plugin.
GitHub is separately optional: a local repository does not require a GitHub connection.

## Composition and ownership

| Component              | Responsibilities                                                                                   | Required services                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@merv/code`           | Repository ownership, retained Git facts, fencing, GitHub connection                               | State, Scope                                           |
| `@merv/code-research`  | Research dependencies, evidence, review provenance, workspace handoff and publication coordination | Code, State, Scope, Sessions, Workflows, Domain Events |
| Code research adapters | Existing `code.*` tools, `/code/*` controls and Code UI                                            | CodeResearch plus Tools, API or UI                     |

The utility owns repository locks and the GitHub client. The integration releases its own
operations when unloaded. Technical changes to bindings and writers notify optional
projections within the same transaction; failure rolls back both the fact and projection.
Unloading a projection never deletes facts. Persistent repository holds preserve transfer
and rebinding restrictions when an integration is unloaded. Reattachment rebuilds derived
research state.

`repositories.root`, `quotaBytes` and `reservedFreeBytes` belong to the core configuration.
`finalizeGraceSeconds` also belongs to Code, so every writer uses the same timeout.
Import maintenance, drain timing, automatic base merging and mirroring belong to the
integration's `repositories` configuration. Disaster backup and restoration belong to
[deployment operations](../../docs/RECOVERY_SNAPSHOTS.md), outside both plugins. Historical migration text and retained workflow evidence remain unchanged. A separate generic
storage migration creates technical workspace, commit retention and repository hold records.
Legacy installations hold repository changes until the research compatibility migration has
transferred their retained Git facts; standalone Code never interprets acceptance or reviews.

The machine [Code workspace driver](src/driver/index.ts) supports isolated checkouts and
cross-machine handoff. The [Runner](../runner/README.md) loads it only when enabled;
`workspaceDrivers: []` supports research execution without Code or Git.

See [Code operations](../../docs/CODE_OPERATIONS.md),
[GitHub connections](../../docs/GITHUB_REPOSITORIES.md), and the
[ownership boundary and upgrade behavior](../../docs/CODE_RESEARCH_BOUNDARY.md).
