# GitHub repositories and publication PRs

GitHub belongs to the **Code** utility (`@merv/code`), which needs only State and Scope. Code's own repository on the server is the authority for a project's history; GitHub receives copies and pull requests. No runner ever holds a GitHub credential.

## From connection to merge

1. A signed-in project operator connects a GitHub account and selects one repository available to both that account and the installed App.
2. The connection owner explicitly chooses a base branch and automation mode: **off**, **read**, or **write**. Linking alone grants nothing. Any project operator may disable automation; enabling it requires the connecting human.
3. `code.repository.prepare` binds the project to that repository and imports the selected branch into Code's repository on the server. Runners prepare checkouts from Code's repository and move history only as bundles through `/code/v2/*` (see [Code operations](CODE_OPERATIONS.md)).
4. With **write** automation, Code's mirror copies its `refs/merv/*` work, accepted and base refs to `merv/*` branches. It never forces a ref: a branch moved by someone else waits for an operator.
5. A unit accepted to publish opens a publication with its passing review already sealed. Code syncs it every 30 seconds as the project owner, and an open PR every ten minutes; **Sync with GitHub** (`code.publication.sync`) does the same at once. A sync creates `merv/proposals/<publication>` and its draft PR, sets the `merv/consolidation-approved` status on that exact head and readies the PR. The branch must be absent or already contain that exact commit; Merv never replaces a different head.
6. A signed-in project operator explicitly merges the reviewed head using a **merge commit**. Merv rechecks head, repository, base branch, observed base, the approval status, branch rules and CI results. GitHub enforces branch protection. Merv then verifies that the merge commit's tree is the reviewed tree before recording it and advancing main.

Acceptance means independent review passed. It does not claim GitHub publication or merging succeeded. PRs, errors and merge receipts are separately visible on the Code page. External outages can be retried without reopening the accepted work.

A publication records local, verified facts even if GitHub credentials are temporarily unavailable or automation has been disabled. Reconciliation checks current authority before contacting GitHub. Closed PRs leave the polling queue. Imported commit refs and publication branches are retained for audit; this release does not automatically prune that history.

GitHub's merge API atomically checks the expected **head**, but does not offer an expected-base compare-and-swap. Merv checks the displayed base before requesting a merge and records the actual result; the base can still advance concurrently. When main moves past the reviewed base, the PR is closed and the publication marked stale. Merv does not impersonate a GitHub reviewer or bypass protection. Squash/rebase are not offered because preserving the reviewed ancestry matters.

## Authorization and credentials

OAuth uses the existing browser-bound PKCE flow, human identity/project binding and encrypted single-use exchange state. Expiring user access/refresh tokens remain AES-256-GCM encrypted on the server. Refresh is claimed transactionally before network I/O. An uncertain refresh requires reconnection rather than replaying a consumed refresh token.

Automation stores the original owner's stable Scope delegation separately from token rotation. Before live operations, both the caller and that owner's current Merv membership are checked. GitHub must still grant the owner the required read/push permission and expose the repository through the selected installation. Normal OAuth refresh preserves publication authority. Explicit reconnect by the same Merv and GitHub user retains the repository, base branch and automation settings; a different identity starts with no repository and automation off. Reconnect still increments the connection revision and fences outstanding authority, as do relinking, disconnecting and changing automation. Every repository operation rechecks live user and App permissions.

Installation tokens restricted to **one repository** are minted on the server for one import, mirror push or publication operation and revoked when it ends; GitHub expiry bounds a failed revocation. Neither they nor the user's OAuth token leave the server. A token is passed only to the fixed Git child's process environment through Git's environment configuration; it is absent from command arguments, saved Git config, journals and every worker.

Runners have no local source repository; the former `repository` plus `baseRef` configuration was removed. GitHub.com only is supported. Git LFS, recursive submodules, repository administration and Actions workflow editing are outside this feature.

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

| Owner                                 | Responsibility                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| Scope                                 | Merv identity, live permissions and original owner's delegation                   |
| Code `github.ts` / `github-client.ts` | Connection, authority, bounded GitHub API operations and scoped token minting     |
| Code `store/mirror.ts`                | Copies Merv's refs to the linked repository, never forcing a ref                  |
| Code workspace driver (`driver/`)     | Runner checkouts prepared from, and uploaded to, Code's repository as bundles     |
| Code work `publications.ts`           | Durable unit-publication-to-PR binding, reconciliation and explicit guarded merge |
| Code work `publication-host.ts`       | Approval, branch-rule and merged-tree checks against Code's repository            |
| Existing API / UI adapters            | Authenticated transport and repository/PR views                                   |

## HTTP controls

All controls require a bearer and selected project, except the browser-bound public callback. Worker credentials cannot use the controller/publication HTTP routes.

| Route                                                            | Purpose                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `GET /code/github`                                               | Safe persisted status, repository, base and automation |
| `POST /code/github/begin`, `POST /finish`, `GET /callback`       | Bound OAuth flow                                       |
| `GET /code/github/repositories`                                  | Connection owner's installed repository picker         |
| `POST /code/github/repository`, `POST /disconnect`               | Revision-checked link/unlink/disconnect                |
| `POST /code/github/automation`                                   | Revision-checked mode/base change                      |
| `GET /code/github/branches`, `GET /pulls`, `GET /pulls/<number>` | Owner's live repository/PR inspection                  |
| `GET /code/publications`, `GET /<publication>`                   | Project publication records and exact PR details       |
| `POST /code/publications/sync`                                   | Reconcile every due publication now                    |
| `POST /code/publications/merge`                                  | Signed-in operator's exact-head merge request          |

Remote writes use deterministic refs and recovery reads. A lost PR-create reply is reconciled by its exact branch; a lost merge reply is reconciled against the same PR/head and actual merge SHA. Network work stays outside database writers. Code aborts and drains admitted network work on unload. GitHub replies have bounded size/pagination and safe diagnostics that omit upstream bodies and secrets.

## Verification

`code-github*.test.ts`, `code-publications.test.ts`, `code-publish-unit.test.ts` and `code-mirror.test.ts` cover connection authority, rotation/revocation, uncertain replies, publication locks, changed heads and checks, and the unit publication path against a real Code repository. `MERV_TEST_POSTGRES_URL` enables PostgreSQL cases. These simulated/local checks do not substitute for a live GitHub activation test.

Primary references: [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [pull request API](https://docs.github.com/en/rest/pulls/pulls), [check runs](https://docs.github.com/en/rest/checks/runs), [Git push leases](https://git-scm.com/docs/git-push).
