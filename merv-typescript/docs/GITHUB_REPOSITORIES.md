# GitHub repositories, runner transport and consolidation PRs

GitHub belongs to the existing **Code** plugin. Its required injections remain `state`, `scope`, `sessions`, `artifacts`. No new plugin or agent-management layer is introduced.

## From connection to merge

1. A signed-in project operator connects a GitHub account and selects one repository available to both that account and the installed App.
2. The connection owner explicitly chooses a base branch and automation mode: **off**, **read**, or **write**. Linking alone grants no runner access. Any project operator may disable automation; enabling it requires the connecting human.
3. A trusted Runner configured with `"workspace": { "github": true }` fetches the linked repository into its private Git store. Every assignment pins its repository, connection revision and base commit before credentials are issued. Reviewers can fetch exact proposal commits on a different runner.
4. `code.commit` freezes a checkpoint through the existing durable command. The runner pushes an immutable `merv/checkpoints/<command>` branch and Code checks GitHub's exact commit and tree before acknowledging success. Final workspace captures use `merv/captures/<session>`.
5. Sealing a GitHub consolidation proposal atomically creates a publication intent. An authorized runner poll, or **Sync with GitHub** in Code, creates `merv/proposals/<proposal>` and its draft PR. The branch must be absent or already contain that exact commit; Merv never replaces a different head.
6. Consolidation records the independent verdict in the same transaction as its existing review/workflow update. A pass readies the PR; a return closes it. A revised proposal gets a new immutable record and branch. Code cannot invent a review verdict through HTTP or MCP.
7. A signed-in project operator explicitly merges the reviewed head using a **merge commit**. Merv rechecks head, repository, base branch, observed base and CI results. GitHub enforces branch protection. The resulting merge SHA is recorded.

Workflow completion means independent review passed. It does not claim GitHub publication or merging succeeded. PRs, errors and merge receipts are separately visible on the Code page. External outages can be retried without reopening the completed workflow.

Sealing records local, verified facts even if GitHub credentials are temporarily unavailable or automation has been disabled. Reconciliation checks current authority before contacting GitHub. Rejected proposals first recover any PR created during an uncertain earlier attempt before closing it. Closed PRs leave the polling queue. Imported commit refs and proposal branches are retained for audit; this release does not automatically prune that history.

GitHub's merge API atomically checks the expected **head**, but does not offer an expected-base compare-and-swap. Merv checks the displayed base before requesting a merge and records the actual result; the base can still advance concurrently. Use GitHub branch protection when the repository requires up-to-date CI or additional GitHub reviews. Merv does not impersonate a GitHub reviewer or bypass protection. Squash/rebase are not offered for consolidation publication because preserving the reviewed ancestry matters.

## Authorization and credentials

OAuth uses the existing browser-bound PKCE flow, human identity/project binding and encrypted single-use exchange state. Expiring user access/refresh tokens remain AES-256-GCM encrypted on the server. Refresh is claimed transactionally before network I/O. An uncertain refresh requires reconnection rather than replaying a consumed refresh token.

Automation stores the original owner's stable Scope delegation separately from token rotation. Before live operations, both the caller and that owner's current Merv membership are checked. GitHub must still grant the owner the required read/push permission and expose the repository through the selected installation. Normal OAuth refresh preserves publication authority; relinking, disconnecting or changing automation increments the connection revision and invalidates outstanding authority.

Only the trusted runner controller receives an installation token restricted to **one repository** and **Contents read or write**. The user's OAuth token never leaves the server. The token is passed only to the fixed Git child's process environment through Git's environment configuration; it is absent from command arguments, saved Git config, journals, worker context and worker environment. Remote Git runs without ambient credentials, hooks, filters, redirects, alternate protocols or recursive submodules. The runner attempts token revocation after each transfer; GitHub expiry bounds failed revocation.

The runner host is a trust boundary. A malicious process with the same OS user may inspect another process's environment or files; this mechanism is not an OS sandbox. Use separate accounts/containers for mutually untrusted workloads. A Contents-write installation token is repository-wide, so only the trusted controller receives it and exposes fixed operations.

Existing local-source runner configuration (`repository` plus `baseRef`) remains supported. Switching a runner to another repository/base requires a fresh runner directory; it must not silently reuse another repository's checkout journal. GitHub.com only is supported. Git LFS, recursive submodules, repository administration and Actions workflow editing are outside this feature.

## Server and App configuration

Existing connection variables:

- `MERV_TS_PUBLIC_ORIGIN` — exact public origin.
- `MERV_GITHUB_APP_SLUG`, `MERV_GITHUB_CLIENT_ID`, `MERV_GITHUB_CLIENT_SECRET`.
- `MERV_GITHUB_ENCRYPTION_KEY` — 32 bytes encoded as 64 hexadecimal characters; preserve across restarts/backups.

Optional automation variable:

- `MERV_GITHUB_PRIVATE_KEY_BASE64` — base64-encoded RSA PEM App key, held in the protected server secret environment. Absent keys preserve metadata connection behavior and disable enabling automation.

App repository permissions: **Metadata read**, **Contents write**, **Pull requests write**, **Checks read**, **Commit statuses read**. Install only on selected repositories. No administration, Actions/workflow-write permission or webhook is needed. The OAuth callback remains `<origin>/code/github/callback`, with expiring user tokens and Merv-initiated authorization.

The previously verified production deployment had metadata-only permissions. Do not infer that write automation is active until a subsequent activation record confirms permissions, private-key installation and a real isolated-repository test.

## Ownership and files

| Owner                                 | Responsibility                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Scope                                 | Merv identity, live permissions and original owner's delegation                                       |
| Code `github.ts` / `github-client.ts` | Connection, authority, bounded GitHub API operations and scoped token minting                         |
| Code `transport.ts`                   | Per-assignment binding, controller authorization, immutable push intents and remote verification      |
| Runner `workspaces.ts`                | Private Git stores, exact object transfer, worktrees, branch ownership and restartable local commands |
| Code `publications.ts`                | Durable proposal-to-PR binding, reconciliation and explicit guarded merge                             |
| Consolidation                         | Proposal submission, independent review and workflow completion                                       |
| Existing API / UI adapters            | Authenticated transport and repository/PR views                                                       |

## HTTP controls

All controls require a bearer and selected project, except the browser-bound public callback. Worker credentials cannot use the controller/publication HTTP routes.

| Route                                                            | Purpose                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /code/github`                                               | Safe persisted status, repository, base and automation       |
| `POST /code/github/begin`, `POST /finish`, `GET /callback`       | Bound OAuth flow                                             |
| `GET /code/github/repositories`                                  | Connection owner's installed repository picker               |
| `POST /code/github/repository`, `POST /disconnect`               | Revision-checked link/unlink/disconnect                      |
| `POST /code/github/automation`                                   | Revision-checked mode/base change                            |
| `GET /code/github/branches`, `GET /pulls`, `GET /pulls/<number>` | Owner's live repository/PR inspection                        |
| `POST /code/transport/grant`, `POST /verify`                     | Source-owned runner controls for fetch/checkpoint/capture    |
| `GET /code/publications`, `GET /<proposal>`                      | Project publication records and exact PR details             |
| `POST /code/publications/sync`                                   | Reconcile one queued publication; runners poll automatically |
| `POST /code/publications/merge`                                  | Signed-in operator's exact-head merge request                |

Remote writes use deterministic refs and recovery reads. A lost PR-create reply is reconciled by its exact branch; a lost merge reply is reconciled against the same PR/head and actual merge SHA. Network work stays outside database writers. Code aborts and drains admitted network work on unload. GitHub replies have bounded size/pagination and safe diagnostics that omit upstream bodies and secrets.

## Verification

`code-github*.test.ts`, `code-transport.test.ts`, `code-publications.test.ts`, `runner-github.test.ts` and `consolidation.test.ts` cover connection authority, rotation/revocation, immutable targets, source/launch isolation, missing/changed remote objects, uncertain replies, review rollback, changed heads and checks, and the full consolidation transaction path. The real Git test uses independent runner object stores and a local bare remote. `MERV_TEST_POSTGRES_URL` enables PostgreSQL cases. These simulated/local checks do not substitute for a live GitHub activation test.

Primary references: [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [pull request API](https://docs.github.com/en/rest/pulls/pulls), [check runs](https://docs.github.com/en/rest/checks/runs), [Git push leases](https://git-scm.com/docs/git-push).
