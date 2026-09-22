# Code

Code is an optional Git utility for parallel research. It retains exact revisions, project
repository bindings, unit facts and writer generations; owns repository files and Git
execution; and provides optional GitHub authentication and transport. It depends only on
**State and Scope**. It does not load Workflows, Reviews, Sessions, or research policies.

The core service is `ctx.code`. Its repository, unit and writer APIs are technical building
blocks. Callers choose what to retain and supply immutable facts inside their own transaction.
Core checks integrity and concurrency; it does not decide research acceptance, scheduling,
review requirements, or which experiment's work belongs in a project.

The optional [Code research integration](../code-research/README.md) provides those connections
and the user-facing tools, machine API and UI. Research can run without either plugin.
GitHub is separately optional: a local repository does not require a GitHub connection.

## Composition and ownership

| Component              | Responsibilities                                                                                   | Required services                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `@merv/code`           | Repository ownership, retained Git facts, fencing, GitHub connection                               | State, Scope                                                      |
| `@merv/code-research`  | Research dependencies, evidence, review provenance, workspace handoff and publication coordination | Code, State, Scope, Sessions, Artifacts, Workflows, Domain Events |
| Code research adapters | Existing `code.*` tools, `/code/*` controls and Code UI                                            | CodeResearch plus Tools, API or UI                                |

The utility owns repository locks and the GitHub client. The integration releases its own
operations when unloaded. Technical changes to bindings and writers notify optional
projections within the same transaction; failure rolls back both the fact and projection.
Unloading a projection never deletes facts. Reattachment rebuilds derived research state.

`repositories.root`, `quotaBytes` and `reservedFreeBytes` belong to the core configuration.
`finalizeGraceSeconds` also belongs to Code, so every writer uses the same timeout.
Import maintenance, drain timing, automatic base merging, mirroring and
backup settings belong to the integration's `repositories` configuration. Existing database
migration identities and retained workflow evidence remain unchanged by the split.

The machine [Code workspace driver](src/driver/index.ts) supports isolated checkouts and
cross-machine handoff. The [Runner](../runner/README.md) loads it only when enabled;
`workspaceDrivers: []` supports research execution without Code or Git.

See [Code operations](../../docs/CODE_OPERATIONS.md),
[GitHub connections](../../docs/GITHUB_REPOSITORIES.md), and the
[cleanup scope and verification](../../docs/CODE_UTILITY_CLEANUP.md).
