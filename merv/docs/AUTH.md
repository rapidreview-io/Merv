# Authentication & project membership

The hosted research suite authenticates against the **same Supabase project as
RapidReview** — same accounts, same `rr_sk_` API keys. Localhost is auth-free:
`build_local_server` passes no verifier, so the local brain never reads
`SUPABASE_*` env, never imports PyJWT, and serves every request as the
implicit local principal exactly as before.

## How it works

One `Authorization: Bearer <credential>` header, three credential shapes,
dispatched by prefix (RapidReview's contract, reimplemented in
`src/merv/brain/surface/auth.py`):

- **Supabase session JWT** — browser sign-in via supabase-js in the UI.
  Verified locally (HS256, `SUPABASE_JWT_SECRET`, audience `authenticated`);
  anonymous sessions are rejected. No Supabase round-trip per request.
- **`rr_sk_` API key** — RapidReview-minted, owner-scoped; everything headless
  (direct `/mcp` clients, agents, curl). sha256-hashed and looked up in
  the shared `api_keys` table over PostgREST (`SUPABASE_SERVICE_KEY`), cached 60s.
  These keys are minted/revoked in RapidReview.
- **`mk_` key** — minted/revoked **in this repo** via the key-mint UI and
  stored in the `project_api_keys` table. Its `grant_scope` is immutable and is
  one of two shapes:
  - `project` — binds one project. The gateway rejects any request whose
    `project_id` argument does not equal that project.
  - `account` — reaches every project its owner is a member of. It carries no
    project confinement, so membership is the only gate; its `project_id`
    column names the *home* project it is listed and revoked under, which is
    never a limit on its reach.

  Either way the key is external, so it can never create projects or touch
  operator diagnostics. OAuth (DCR + PKCE) mints audience-confined `mk_`
  access tokens (+ `mrt_` refresh) for interactive MCP clients, including
  Codex, Claude Code, GitHub Copilot CLI, Cursor, Gemini CLI, Qwen Code, Kilo
  Code, and Replit; the consent screen chooses
  the scope, and every rotation inherits it.

Enforcement lives in the `attach_principal` middleware
(`src/merv/brain/surface/transport/api/app.py`): OPTIONS, `/health`, `/api/meta`, and
the token-bearing upload routes stay open; the 426 version floor runs before auth so
stale clients get "upgrade", not "login". A verified credential becomes
`Principal(user_id=<supabase sub>)`.

**Project membership** is the authorization layer: `project_members`
(project_id, user_id) in the research store. Authenticated requests see only
member projects — enforced at two funnels: the HTTP path gate
(`/api/projects/{id}/...` → 404 for non-members; `/api/activity` +
`/api/debug/*` additionally require `?project_id=`) and the MCP funnel
(`route_call_tool`, including review tools via their resolved project).
Creating a project records the creator as its first member. Share/assign via:

```
POST   /api/projects/{id}/members   {"user_id": "<supabase auth.users uuid>"}
DELETE /api/projects/{id}/members/{user_id}
GET    /api/projects/{id}/members
```

The POST route also accepts `{"email": "person@example.com"}` when a user
directory is configured.

Any member can manage members (two-trusted-users model; no roles).

The web UI can add members by email when the HTTP composition receives a user
directory. The directory is deliberately tiny and provider-neutral: it exposes
`find_user_by_email(email)` and `user_profiles(user_ids)`, and returns IDs from
the same namespace as the authentication verifier. `build_control_server` uses
the shared Supabase service-role RPCs; a self-hosted deployment with another
identity provider passes its own directory to
`create_fastapi_app(user_directory=...)`. With no directory, UUID-based
membership remains available and `/api/meta` advertises
`project_member_directory: false`. Custom authentication must return the same
opaque IDs and use Merv's existing `Principal(client_id="jwt:...")` convention
for signed-in people; machine credentials remain unable to change membership.

## Client setup

- **Web UI**: `/api/meta` advertises `auth: {required, supabase_url,
  supabase_anon_key}`; the AuthGate then shows sign-in (email/password or
  Google). Nothing is baked into the bundle; local backends advertise
  `required: false` and the UI never loads supabase-js.
- **Interactive MCP clients** (Codex, Claude Code, GitHub Copilot CLI, Cursor,
  Gemini CLI, Qwen Code, Kilo Code, Replit):
  every agent connects directly to the brain's `POST /mcp` endpoint. The
  committed manifests contain the URL and no credential header. A 401 response
  leads the client through RFC 9728/8414 discovery, dynamic client registration,
  PKCE browser consent, secure token storage, and refresh. The user never sees
  or mints the underlying `mk_` access token.
- **Headless MCP clients and the Merv agent runner** use an explicitly minted
  `mk_` key. Headless clients receive it through `MERV_MCP_KEY`;
  `merv-client configure` writes machine settings and `merv-client env` prints
  the header-based config for those non-interactive surfaces. The runner reads
  `~/.merv/agent-runner.key` first and falls back to `MERV_MCP_KEY` only when no
  paired credential exists. Pairing writes that file: the runner generates the
  key itself, presents only its sha256 digest with a short device code, and an
  owner's approval on the Auto-run page registers the digest as a
  project-scoped key labelled `auto-run · <hostname>` — the plaintext never
  leaves the machine and is never shown. Never inline a key into a committed
  file.

In either path the agent passes `project_id` explicitly. An account-scoped
grant discovers ids with `project(action="list")`; a project-scoped grant may
only pass its bound project. Project membership remains the authorization
boundary.

## When a static key is still required

Use browser OAuth by default. Mint a static `mk_` key only when there is no
interactive browser/redirect loop or when a long-running parent process must
mint narrower child sessions:

- `merv-agent-runner`, which holds the parent credential and gives each child a
  short-lived `MERV_AGENT_SESSION_KEY`;
- CI jobs, unattended services, containers, and remote SSH sessions that cannot
  complete a localhost OAuth callback;
- a client that does not implement MCP OAuth discovery, DCR, PKCE, and refresh;
- direct scripts such as `curl` or the full `mcp_conformance.py` keyed probe.

At [rapidreview.io/merv](https://rapidreview.io/merv), open a project, create a
key, choose **All my projects** unless deliberate project confinement is needed,
and expose it to the process as `MERV_MCP_KEY`. Treat it as a password and keep
it out of shell history, logs, and version control.
## Hosted configuration

Set `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_KEY`,
`SUPABASE_ANON_KEY`, and `MERV_REQUIRE_AUTH=1`. Existing databases must contain
one `project_members` row for each authorized user/project pair. Interactive
users then sign in through MCP OAuth; headless callers mint a scoped key.
Email sharing also expects the service-role-only `lookup_user_for_share` and
`user_display_profiles` RPCs already installed in the shared authentication
Supabase project.

Keep Supabase secrets and service credentials in managed secret storage. Rotate
them through the Supabase and deployment runbooks, not through application
code.

## Notes

- SSE under auth: EventSource cannot send the header; the hosted stream 401s
  and the UI's ETag-polling fallback carries updates (~3s latency). Stream
  tickets are a known follow-up if realtime matters.
- `/api/admin/*` is an operator surface and should remain network-restricted
  even when authentication is enabled.
- Same accounts ≠ SSO: users sign in once per product origin.
