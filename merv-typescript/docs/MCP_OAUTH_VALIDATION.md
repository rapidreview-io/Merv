# Remote MCP OAuth validation and release handoff

Snapshot: 2026-10-21. This implementation has **not been deployed**. Local protocol
checks do not establish launch readiness. The parent integration/release chat owns
combined deployment and real production-agent acceptance.

## Implemented contract

- Protected-resource discovery at `/.well-known/oauth-protected-resource/mcp`
  (also the root alias), with the exact canonical `<publicOrigin>/mcp` audience.
  Unauthenticated/expired MCP requests return a resource-metadata Bearer challenge.
- Authorization-server metadata at `/.well-known/oauth-authorization-server`.
  Public DCR clients (`token_endpoint_auth_method=none`), exact registered HTTPS or
  HTTP loopback callbacks, authorization-code flow with mandatory S256 PKCE,
  response `state` and `iss`, and explicit `resource` binding. CIMD is not advertised.
- Existing browser identity sign-in leads to `/ui/connect/<request-id>`. The
  existing website handles project creation/invitation acceptance and selection.
  Consent displays the self-reported client name and callback address, requires
  a human identity bearer plus same-origin POST, and cannot be framed.
- Opaque access and refresh tokens are hashed at rest. Access lasts one hour;
  refresh rotates, replay revokes the entire grant, and consent expires after
  an absolute 30 days. Refresh and access verify the stored resource audience.
  Revocation works through `/oauth/revoke` and the human's Settings → Keys page.
- Grants delegate current account memberships through the existing user-key
  authorization path. No new independent actor/reviewer identity is introduced.
  The internal backing key's secret is discarded. Existing machine credentials,
  account/project membership records, immutable migration text and email-login
  issuance evidence are preserved. OAuth bearers cannot use account/admin routes.
- `/connect/agent.md`, `/connect`, and downloadable `bundle.tar.gz`/`bundle.json`
  make setup possible from just the URL. Packages contain manifests and skills,
  not an executable connector. Staging origins receive distinct package names.
  The separate public `/start/agent.md` workflow is unchanged.

## Local evidence

Use a disposable PostgreSQL database. The test helper creates/drops isolated
schemas; do not point it at production. Example local-only database:

```sh
docker run --name merv-oauth-tests --rm -d \
  -e POSTGRES_PASSWORD=oauth-local-test -p 127.0.0.1:55441:5432 postgres:17-alpine
```

From `merv-typescript/`:

```sh
MERV_TEST_POSTGRES_URL=postgres://postgres:oauth-local-test@127.0.0.1:55441/postgres \
  node --import tsx --test tests/oauth.test.ts tests/client-bundles.test.ts \
  tests/credential-lock.test.ts tests/user-key-api.test.ts \
  tests/credential-auth.test.ts tests/api.test.ts
node --test deploy/render-config.test.mjs
npm run typecheck:ui
npm run build:ui
npm run build
```

The focused command passed 47 tests; deployment rendering passed 15 tests. Server
build, UI typecheck and UI build passed (the UI retains existing bundle-size warnings).

The focused suite covers code/callback/PKCE/resource/client binding, code reuse,
concurrent exchanges, expiry, refresh rotation and replay, independent revocation,
restart of the OAuth service against persisted state, role/membership changes,
insufficient permissions, human-only credential operations, and preservation of
an unrelated CI key. HTTP checks cover discovery/challenges, same-origin human
consent, retired endpoints and a reversible SQL note written through the real MCP
transport and Scope permission checks. **That note is a test tool, not proof of
production experiment/task/paper workflows.** Bundle tests check source parity,
remote-only wiring and tar extraction. Renderer tests require explicit cutover.

## Real installed CLI checks — synthetic consent boundary

Binaries tested: **Codex CLI 0.155.0-alpha.2**, **Claude Code 2.1.304**.

```sh
MERV_TEST_POSTGRES_URL=postgres://postgres:oauth-local-test@127.0.0.1:55441/postgres \
  node --import tsx scripts/oauth-client-smoke.ts
```

This starts a loopback server on port 55442 with a synthetic test person. It
creates temporary per-client configuration directories (`CODEX_HOME` and
`CLAUDE_CONFIG_DIR` in child processes only), writes the served package to a
private temporary marketplace, and runs native marketplace/install/remove,
remote MCP add/login/get/logout commands. Codex uses file credential storage in
that temporary directory. Claude's manual callback uses a test-only PTY bridge.
No credential files are read, copied or printed. Logout and directory/schema
cleanup run at the end. Run this harness only where native clients are installed.

Results:

| Check                                                              | Codex                                     | Claude Code                       |
| ------------------------------------------------------------------ | ----------------------------------------- | --------------------------------- |
| Add local marketplace and install plugin                           | passed                                    | passed                            |
| Remove plugin before direct registration                           | passed                                    | passed                            |
| Native DCR, authorization URL, PKCE exchange and credential saving | passed                                    | passed                            |
| New CLI process finds saved direct registration                    | passed                                    | passed                            |
| New process authenticates actual MCP requests                      | not established by `mcp get` (0 requests) | passed (5 authenticated requests) |
| Bundled endpoint appears in `mcp list`                             | not shown by this command                 | shown                             |
| Preserve an unrelated configured MCP entry                         | checked and passed                        | not independently asserted        |

**The harness approves consent in-process as a synthetic account.** It does not
exercise Supabase browser sign-in, a human clicking consent, model authentication,
a fresh model chat, or production. Codex's `mcp list/get` evidence cannot establish
bundled-plugin runtime loading. Both portable and legacy Codex manifest layouts
are supplied; they are alternatives, not two independently registered servers.
The production test must check the installed plugin in the actual desktop/CLI
runtime. Do not interpret a successful plugin install as successful MCP usage.

## Required combined-release acceptance

1. Integrate this branch with the Git changes; preserve both sides' authorization
   restrictions and rerun relevant tests. The submodule stays pinned to the base
   revision; it has valid worktree-local Git metadata. No root-checkout changes
   or Git chat branch changes were made here.
2. Publish the complete server/UI/client build with explicit `MERV_MCP_OAUTH=true`
   and retired flags removed. Verify public-origin metadata and reverse-proxy
   forwarding. Rate-limit unauthenticated OAuth registration/authorization at
   ingress. Public-directory publication/review is separate; OIDC workspace
   domain-restriction support is not claimed for a public directory submission.
3. In isolated **real** Codex and Claude configurations, follow only the published
   URL, install the plugin, and finish browser sign-in. A human must choose/sign
   into their account and explicitly authorize the displayed client. New users
   must create/join a project on the website; do not give the agent passwords,
   email codes, tokens or account-administration credentials.
4. Verify permitted reads and reversible domain writes (tasks, experiments,
   papers/artifacts as appropriate) with and without a Git repository. Verify
   reader restrictions, project switching and reviewer independence.
5. Restart each actual client, open a fresh model chat and say “use Merv”. Verify
   saved **plugin** reuse, selected identity/project and actual reads. Avoid adding
   a direct server as well as the plugin-bundled server.
6. Exercise real refresh/reconnect, website revocation, expiry, and cancellation.
   Check user/project-scope duplicate removal and migrated installations, keeping
   unrelated configuration byte-for-byte where not managed by a native command.
   Revoke only connector-specific legacy keys after OAuth works; preserve Git/CI
   keys and other origins. Follow [CLIENT_CUTOVER.md](../deploy/CLIENT_CUTOVER.md).

## Official contracts consulted

- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [OpenAI MCP OAuth authentication](https://developers.openai.com/plugins/build/auth)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

Installed-client help was also checked. In this Codex build `mcp add --url` can
start authentication immediately. Claude's `mcp login --no-browser` still requires
a terminal for pasting the callback; it is not a noninteractive bypass of consent.
