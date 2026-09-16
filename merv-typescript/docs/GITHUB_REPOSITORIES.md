# GitHub repositories in Code

GitHub is an optional feature of the existing Code plugin. The standalone `Merv GitHub` prototype has been rewritten in TypeScript inside `packages/code`; Merv does not import or deploy that sibling project. No new Cordis plugins, dependencies, agent tools, or separate servers were added.

## Product behavior

A human project operator can connect GitHub from the Code page, list repositories accessible to both their GitHub account and the installed App, and link one repository to the selected Merv project. The stored reference includes the stable GitHub repository ID, installation ID, full name, web URL, default branch and private/public flag.

Each project has its own optional connection. Only the connecting human can browse repositories using that connection. Other project operators can deliberately replace or disconnect it; project readers can see the saved repository reference. Reconnecting clears the selection so access from a different GitHub account cannot silently inherit it. Disconnecting clears local credentials and pending flows while retaining the repository reference; unlinking removes that reference. Neither operation uninstalls the GitHub App or revokes another project's authorization.

Code continues to own checkpoint requests, receipts and proposals. Runner continues to own local Git execution and worktrees. Linking a repository does not clone/fetch it, change an active checkout, distribute GitHub credentials to agents, push branches, or publish pull requests. Those are separate Runner features.

## Ownership and implementation

| Owner                         | Responsibility                                                               |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Identity / Scope              | Existing Merv login, live project membership and operator authorization      |
| Code                          | GitHub OAuth flow, encrypted user credentials and project repository binding |
| State                         | Code-owned tables and audit events, using SQLite or PostgreSQL               |
| Existing Code API/UI adapters | Browser connection and repository controls                                   |
| Runner                        | Existing local repository, branches and worktrees                            |

Code's required injections remain `state`, `scope`, `sessions`, `artifacts`.

- `packages/code/src/github-client.ts`: fixed GitHub.com endpoints, OAuth/PKCE, user-scoped repository enumeration, encryption and token refresh/revocation.
- `packages/code/src/github.ts`: project ownership, persistent authorization flow, revisions and transactional updates.
- `packages/api/src/code-github.ts`: HTTP transport only.
- `packages/ui/web/views/github.tsx`: connection controls within the Code view.

The browser starts a flow through an authenticated POST. Code stores the initiating user and project, expected revision, encrypted PKCE verifier, cookie digest and ten-minute expiry. The public callback can only save the one-time code for that browser. A fresh authenticated POST from the original user/project exchanges it. OAuth cancellation returns to the UI.

GitHub access and refresh tokens are AES-256-GCM encrypted with associated data binding them to the project and token version. Tokens, verifiers and codes never enter JSON responses, events, repository URLs or browser storage. The flow cookie is HttpOnly, SameSite=Lax, limited to `/code/github`, and Secure on HTTPS. Flow payloads are erased before exchange; completed flow metadata supports bounded retries. Expired flows are purged at startup and during connection reads/starts.

Before refreshing a single-use token, State atomically claims it and removes the old ciphertext. Other processes cannot exchange it again. Failed/uncertain refresh or a crash requires reconnecting. Disconnect and revision checks prevent delayed responses from restoring a removed connection. Newly issued tokens that cannot be saved are revoked best-effort. Merv authority is rechecked after network calls. Code disposal stops admission, aborts GitHub requests, and drains admitted work before storage closes.

The prototype's App JWT, installation private key, installation-wide repository listing, webhook listener, standalone cookies and JSON store are not carried over. User-authorized repository endpoints enforce current GitHub access directly; Merv does not keep a webhook-derived authorization cache.

## Configuration

With all GitHub variables absent, the feature is disabled and the rest of Code works normally. Partial or malformed configuration fails activation with a redacted error.

| Environment variable         | Value                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `MERV_TS_PUBLIC_ORIGIN`      | Exact HTTPS browser origin; HTTP localhost/127.0.0.1 allowed for development |
| `MERV_GITHUB_APP_SLUG`       | GitHub App slug                                                              |
| `MERV_GITHUB_CLIENT_ID`      | GitHub App OAuth client ID                                                   |
| `MERV_GITHUB_CLIENT_SECRET`  | Server-side OAuth client secret                                              |
| `MERV_GITHUB_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hexadecimal characters                         |

Keep the secret and encryption key in the deployment secret environment. Preserve the encryption key across restarts. Changing it without re-encrypting records requires reconnecting existing connections.

Register/configure a GitHub App with:

- Homepage and optional setup URL: `https://experiments.rapidreview.io/ui/code`.
- OAuth callback: `https://experiments.rapidreview.io/code/github/callback` (substitute the configured origin for development).
- Expiring user tokens enabled. Automatic user authorization during installation off; Merv starts its own bound OAuth flow.
- Metadata read-only permissions for this repository-selection feature, and selected repositories during installation. Contents access is only needed when source reading/cloning is implemented. No write permissions, App private key or webhook are needed here.

The user can choose repositories on GitHub in a separate tab, then refresh the picker in Merv. This version supports GitHub.com only.

## HTTP interface

All controls require a bearer-authenticated, selected Merv project. Mutations and repository enumeration additionally require a human operator. The callback alone is public.

| Method / route                  | Purpose                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `GET /code/github`              | Safe saved status and reference; no GitHub network call                       |
| `POST /code/github/begin`       | Start OAuth with `expectedRevision`; sets flow cookie                         |
| `GET /code/github/callback`     | Browser-bound OAuth callback                                                  |
| `POST /code/github/finish`      | Complete authorization with `{}` and flow cookie                              |
| `GET /code/github/repositories` | Enumerate user-accessible installed repositories                              |
| `POST /code/github/repository`  | Link with installationId/repositoryId/expectedRevision; both IDs null unlinks |
| `POST /code/github/disconnect`  | Remove local credentials with expectedRevision                                |

Saved status is not a continuous GitHub health check. Live list/link operations check GitHub; an invalid user token changes status to `needs_reconnect`. Listing is bounded, refuses redirects, caps response size and uses timeouts. Upstream errors omit response bodies and secrets.

## Validation

`tests/code-github.test.ts` covers the HTTP flow, browser/user/project binding, expiry and callback replay, permission changes during I/O, private repository authorization, ciphertext isolation, concurrent refresh, disconnect races, restart persistence, cancellation, unload/drain, and PostgreSQL. Set `MERV_TEST_POSTGRES_URL` to an isolated test database to include PostgreSQL.

The implementation has been tested against simulated GitHub responses, including the browser repository picker. Production configuration and a real private-repository connection were verified on 2026-09-16: OAuth, repository enumeration, project binding, and persistence after reload passed. The live test also exposed GitHub's issuer callback parameter; the API now validates its exact value when present. See the [activation record](../deploy/GITHUB_2026-09-16.md) for configuration, recovery, and verification evidence.

Primary references: [GitHub App user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [user-authorized repository listing](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token), [single-token revocation](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token).
