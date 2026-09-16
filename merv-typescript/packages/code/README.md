# Code

Code stores live worker Git checkpoint requests, immutable results and sealed proposal manifests. It also owns an optional GitHub connection and repository reference for each project. It depends on State, Scope, Sessions and Artifacts. The separate machine Runner executes fixed Git operations through source-authenticated HTTP controls.

| Adapter            | Dependencies | Interface                                                            |
| ------------------ | ------------ | -------------------------------------------------------------------- |
| `@merv/code/tools` | Code, Tools  | `code.commit`, `code.operation`                                      |
| `@merv/code/api`   | Code, API    | `/code/commands/next`, `/code/commands/complete`, `/code/github/*`   |
| `@merv/code/ui`    | Code, UI     | GitHub repository connection, recent operations and sealed proposals |

Only an active writable Git session with the appropriate workflow grants can request a commit. Exact replay returns the same operation; each session has at most one outstanding request. Source/runner/host ownership controls completion, including recovery after the session closes. Removing Code suspends these adapters while retaining its durable records.

Receipts identify a named checkpoint and the original worker. They do not approve or publish code. The server validates source authority and immutable identity, not Git objects independently.

`Code.seal(caller, input, admission, tx)` is a production service API for an admitting domain program. It requires that program command's existing session invocation and writer transaction, resolves a successful commit from the same worker assignment, verifies evidence bytes and authorship, and retains the canonical manifest as an immutable Artifact. The manifest pins the commit receipt, producer, workflow policy, evidence and domain-supplied provenance. Its hash is the SHA-256 of the actual manifest bytes. `proposal` and `proposals` provide project-scoped reads; the UI displays sealed records alongside operations.

The domain program chooses pinned inputs, review criteria and workflow transitions. It can seal a proposal, request independent review and advance its own workflow in one transaction. Code creates no standalone workflow and exposes no `code.seal` or `code.propose` agent tool. The synthetic native acceptance workflow exercises these production APIs; it is not the production reflection/consolidation program. Central publication and cross-machine Git object transport remain separate work.

Read the [command and recovery contract](../../docs/CODE_OPERATIONS.md) and [ordered publication plan](../../docs/CODE_PUBLICATION_PLAN.md).

See [GitHub repository connections](../../docs/GITHUB_REPOSITORIES.md) for setup, access rules and tested behavior. GitHub is internal to Code and adds no agent tools.
