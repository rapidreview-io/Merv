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
  consent page is account-wide and needs no project membership or selection.
  `/ui/account/keys` permits revocation even with zero projects.
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
  node --import tsx --test tests/oauth.test.ts tests/oauth-admission.test.ts tests/client-bundles.test.ts \
  tests/credential-lock.test.ts tests/user-key-api.test.ts \
  tests/credential-auth.test.ts tests/api.test.ts
node --test deploy/render-config.test.mjs
npm run typecheck:ui
npm run build:ui
npm run build
```

The focused command passed 52 tests; deployment rendering passed 16 tests. Server
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
bundled-plugin runtime loading. The separate model harness below establishes bundled runtime loading locally.
Production acceptance still requires the deployed package and browser identity flow.

## Fresh model sessions through the installed plugin

Version 0.5.1 was tested with Codex CLI **0.155.0-alpha.2** and Claude Code
**2.1.304**, using two new model processes per client after one native OAuth login.
All four sessions loaded the research skill, called the bundled project-list and
project-read tools, and reported the exact synthetic project name and operator
role. No direct MCP registration or injected Merv API key was used. No global
client configuration or binary was changed.

```sh
MERV_ALLOW_MODEL_TESTS=1 \
MERV_TEST_POSTGRES_URL=postgres://postgres:oauth-local-test@127.0.0.1:55441/postgres \
  node --import tsx scripts/oauth-plugin-model-smoke.ts
```

This opt-in harness makes paid model calls. It privately copies existing Codex
model authentication into a temporary directory and reads Claude model OAuth
from macOS Keychain into child-process memory. It never prints these credentials.
Merv consent remains synthetic; native clients perform DCR, PKCE and token storage.
The four model sessions originally used native app-server OAuth for Codex. A
separate follow-up verified ordinary terminal login for the installed bundle,
and the harness now uses that command. Configuration directories are removed afterward.

Both Codex 0.155.0-alpha.2 and desktop 0.163.0-alpha.10.2 silently omitted bundled
MCP when root portable manifests shadowed the compatibility manifest. The bundle
therefore ships only `.codex-plugin/plugin.json` and `.mcp.json`. Regression tests
prevent reintroducing the shadowing files. Nonproduction MCP server names, plugin
names and marketplace names all receive the same origin-specific suffix.

Follow-up security checks cover authorization-code replay revocation (only after
validating the original client, resource, callback and PKCE proof), stripping
client-supplied registration response fields, and bounded public-route admission.

## Terminal-only bundled sign-in follow-up

On the same installed CLI versions, an isolated plugin install followed by
`codex mcp login <bundled-server-name>` completed native DCR, PKCE, callback and
credential saving with exit code 0. No `mcp add`, desktop app, app-server helper,
model credentials or model call was involved. Claude also passed native
`claude mcp login plugin:<name>:<name> --no-browser` with exit code 0.
For production the Codex command is `codex mcp login merv`; the served guide
stamps the origin-specific server name for other deployments.

Reproduce the native login checks without using model credentials or paid calls:

```sh
MERV_TEST_POSTGRES_URL=postgres://postgres:oauth-local-test@127.0.0.1:55441/postgres \
  node --import tsx scripts/oauth-plugin-model-smoke.ts --login-only
```

The test-only app-server authentication fixture has been removed. This verifies
the terminal command, not the complete URL-only human onboarding experience:
consent is still supplied by the synthetic test person. In production, keep the
native command running, open its authorization URL, sign in/create an account,
review and approve account consent, and wait for the
client's success message. Then perform the production reads and fresh-chat check.

Official documentation supports [native MCP OAuth login](https://developers.openai.com/codex/mcp).
The installed binary test establishes that the command also resolves this bundle.
No interactive `/plugins` or `/mcp` terminal sign-in path is claimed here.

## Native writes and saved permission checks

On 2026-10-21, seven harmless task records were created and read back through the
installed plugin's actual `task.write`/`task.read` tools against disposable local
PostgreSQL, real Task/Workflow services and local managed Git storage. No worker,
dispatcher, cloud machine or production write was started. The test identity and
OAuth consent were synthetic; native login, client permission dialogs and model
tool calls were real. There were no standalone MCP registrations, global bypass
flags or per-run tool allowlists in these write checks.

| Client/run | Native interaction | Result after restart |
| --- | --- | --- |
| Codex 0.155.0-alpha.2, interactive default | Directory trust once; first `task.write` offered Allow, Allow for this session, Always allow, Cancel. Selected Always allow. Reads did not prompt. | A new `codex exec` process read the old task, created/read a second task without prompting. |
| Codex, saved server policy | Replaced only the isolated plugin's saved per-tool policy with `default_tools_approval_mode = "approve"`. Other configuration stayed unchanged. | Another fresh process created/read a third task without prompting. |
| Claude interactive Auto mode | Theme/onboarding and directory trust once; no tool approvals for harmless create/read. | A fresh interactive process read the old task and created/read another without prompting. |
| Claude 2.1.304, Manual mode | A read prompted with Yes/No only; Yes approved one call, and the next read prompted again. Cancelled, opened `/permissions` → Allow → Add a new rule, entered `mcp__plugin_merv-1e9e436e_merv-1e9e436e__*`, saved to User settings. | The resumed task created/read successfully; a fresh Manual-mode `claude -p` process created/read another task with `permission_denials: []`. No `--allowedTools` was passed. |

The Claude native updater advanced the interactive Auto-mode restart from 2.1.304
to 2.1.306. The subsequent Manual-mode and restart checks explicitly used the
existing 2.1.304 binary with auto-updates disabled for those child processes.
No global permission setting or user configuration was edited by the test.

Codex's Always allow dialog saved exactly this tool-scoped policy:

```toml
[plugins."merv@merv".mcp_servers.merv.tools."task.write"]
approval_mode = "approve"
```

For a one-time decision covering all Merv tools, the separately tested policy is:

```toml
[plugins."merv@merv".mcp_servers.merv]
default_tools_approval_mode = "approve"
```

Claude's native UI appended `mcp__plugin_merv_merv__*` to `permissions.allow` in
user settings (the local fixture used its origin-specific name). It preserved the
existing installed-plugin setting. User scope applies across projects; project
scope would only cover that project. Manual Yes, session-only approval, and OAuth
consent alone are not substitutes for this saved choice. Auto mode can still stop
other actions; no claim is made that it approves every future write. Existing
explicit restrictions and managed policies still take precedence.

These controls are documented in [Codex plugin policy](https://developers.openai.com/codex/mcp)
and [Claude Code MCP permissions](https://code.claude.com/docs/en/permissions#mcp).
The served setup guide now includes the precise one-time choices, with host-specific
names, without silently enabling them during installation.

To reproduce interactively, start the opt-in fixture in one terminal:

```sh
MERV_ALLOW_MODEL_TESTS=1 \
MERV_TEST_POSTGRES_URL=postgres://postgres:oauth-local-test@127.0.0.1:55441/postgres \
  node --import tsx scripts/oauth-plugin-write-fixture.ts
```

Use its printed root as FIXTURE in another terminal. The helper uses existing local
model credentials privately and leaves all tool permission decisions to the native
client. These sessions make paid model calls:

```sh
MERV_ALLOW_MODEL_TESTS=1 python3 tests/fixtures/native-write-client.py FIXTURE codex
MERV_ALLOW_MODEL_TESTS=1 python3 tests/fixtures/native-write-client.py FIXTURE claude --permission-mode default
```

Ask to create and read a harmless task, choose the scoped native permission, exit,
and run a new process with the same fixture root. Repeat the create/read. The fixture
prints successful task tool calls and writes durable `task-records.json` evidence.
Close clients before sending SIGTERM to the fixture PID in `fixture.json`; it removes
its private configuration and database schema. Never point it at production.

## Required combined-release acceptance

1. Integrate this branch with the Git changes; preserve both sides' authorization
   restrictions and rerun relevant tests. The submodule stays pinned to the base
   revision; it has valid worktree-local Git metadata. No root-checkout changes
   or Git chat branch changes were made here.
2. Publish the complete server/UI/client build with explicit `MERV_MCP_OAUTH=true`
   and retired flags removed. Verify public-origin metadata and reverse-proxy
   forwarding. Verify the application admission limits and trusted immediate proxy
   addresses described in CLIENT_CUTOVER.md. Public-directory publication/review is separate; OIDC workspace
   domain-restriction support is not claimed for a public directory submission.
3. In isolated **real** Codex and Claude configurations, follow only the published
   URL, install the plugin, and finish browser sign-in. A human must choose/sign
   into their account and explicitly authorize the displayed client. New users
   may authorize with zero projects; create/join later and list again without reconnecting.
   Do not give the agent passwords,
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


## Account consent without a project (local regression checks)

Scope migration 14 permits a null issuance project only for account grants; existing
key rows and migration texts are retained. OAuth uses verified human identity to issue
an account delegation. Public machine-key issuance still requires a project membership.
Account grants always require an explicit `projectId` for project operations. Issuance
and revocation of unanchored account delegations remain recorded in retained key rows
and the credential ledger; they do not invent a project event or an actor.

The PostgreSQL OAuth tests cover zero-project browser consent, an empty project list,
new memberships appearing in the same grant, producer/reader A→B→A switching, missing
and arbitrary project rejection, immediate membership loss, refresh with zero projects,
and owner revocation after the last membership disappears. A forward-upgrade test boots
scope v13 with a machine key and project-anchored OAuth grant, applies v14, verifies
unchanged key rows and preserved access constraints, then revokes the existing grant.
Existing PKCE, replay, expiry, resource binding, machine-key and credential tests remain.

The rendered browser tests open consent and `/ui/account/keys` with zero projects,
authorize without a project field, and revoke a connection without project-shell reads.
The account key page is also linked from the project chooser. Plugin version 0.5.2
updates both clients' skills and fresh-chat guidance. These checks use local fixtures;
production rollout and real-client consent validation of this change remain release checks.
