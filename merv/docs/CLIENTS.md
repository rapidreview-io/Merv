# Client Support

The plugin targets nine agentic clients from one canonical content tree.
Everything heavy — state, gates, capability-based reviews, sandbox
provisioning — lives in the client-neutral brain service (localhost
`merv-http`, or the hosted brain). Every client — local Claude Code, cloud
Codex, Cursor, Gemini CLI, OpenCode, Kilo, Hermes Agent, OpenHands, and
Replit Agent — connects directly to the brain's `POST /mcp` endpoint. Bundled clients
for Codex, Claude Code, Cursor, and Gemini CLI default to native MCP OAuth. Their
manifests contain the URL and no credential header; the client discovers Merv's
DCR + PKCE flow and refreshes tokens without exposing a key to the user. Static
`MERV_MCP_KEY` authentication remains for headless clients and the agent runner.
Either grant can cover one project or the owner's whole account. Agents start
with `project(action="list")`; a project-scoped grant may also use
`project(action="current")`. They pass the selected id explicitly, and the
gateway rejects ids outside the credential's scope. Agents never send a checkout
root. Each client gets a thin adapter on top of the same `bin/`, `skills/`, and
`agents/` content:

| Client | Adapter | MCP registration | Skills | Reviewer subagents |
|---|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` + `.mcp.json` | URL-only http server → `<base>/mcp`; native OAuth | `skills/` auto-discovered | `agents/` auto-discovered (`merv:` namespace) |
| Codex | `.codex-plugin/plugin.json` (inline MCP entry) | URL-only http server → `<base>/mcp`; native OAuth | `skills/` via manifest | spawned via review skills |
| Cursor | `.cursor-plugin/plugin.json` + `mcp.json` | URL-only http server → `<base>/mcp`; native OAuth | `skills/` auto-discovered (Agent Skills standard) | `agents/` auto-discovered |
| Gemini CLI | `gemini-extension.json` + `GEMINI.md` | URL-only http server → `<base>/mcp`; native OAuth | `skills/` auto-discovered (Agent Skills standard) | `agents/` auto-discovered |
| OpenCode | `clients/opencode/` (installer + agents + config example) | `opencode.json` `mcp` block → `<base>/mcp` (same header) | symlinked into `~/.config/opencode/skills/` | symlinked into `~/.config/opencode/agents/` |
| Kilo | `clients/kilo/` (installer + config example) | `kilo.jsonc` `mcp` block → `<base>/mcp` (same header) | symlinked into `~/.kilo/skills/`; also reads repo `.agents/skills/` | shared OpenCode wrappers symlinked into `~/.config/kilo/agent/` |
| Hermes Agent | `clients/hermes/` (installer + guide) | `config.yaml` `mcp_servers` entry → `<base>/mcp` (bearer header or OAuth) | `skills.external_dirs`, or POSIX installer symlinks | `delegate_task` with the handoff prompt |
| OpenHands | `AGENTS.md` + `clients/openhands/README.md` | local `config.toml` / CLI, or Cloud **Settings → MCP** | root `AGENTS.md`; optional repo skill directories at `.agents/skills/<name>/SKILL.md` | none; second session/agent or inline |
| Replit Agent | `clients/replit/README.md` | account **MCP Servers** settings → `<base>/mcp` | no Merv skills installed by the connection | none; second session/agent or inline |

Shared invariants across all clients:

- The project comes from the credential and the call, never from a checkout
  path. An agent passes `project_id` explicitly on every project-scoped call.
  Where it learns that id depends on the grant's scope: an account-scoped grant
  calls `project(action="list")` and picks from the result (ids with names,
  summaries, and creation dates); a project-scoped grant learns its one project
  via `project current` and may pass no other. Agents never send a repo root,
  and no client needs to point Merv at a project directory.
- One OAuth grant is enough for every project you belong to in a platform.
  Approve **All my projects** at consent. OAuth access tokens last an hour and
  refresh silently on a rolling 30-day window, so a client that stays in use
  never re-consents. Tokens are stored by each platform and are not copied
  between platforms.
- The MCP connection is plain HTTP, so a client needs no local Merv runtime to
  reach the brain — just an HTTP MCP server entry. The brain is the single
  source of truth for tool schemas (`contracts.py` TOOL_MANIFEST, served via
  `tools/list`); there is no checked-in client-side tool catalog. The
  `merv-client` onboarding CLI, `merv-http`, and brain remain Python 3.11+; a
  venv is needed only for those surfaces when the machine does not already
  provide 3.11+. Agent-run byte transfers — the tokenized `curl` for
  `artifact.submit`, attachment-bearing `feed.post`, `storage.submit`, and
  `storage.fetch` (download), plus the `rsync` for `sandbox.pull_outputs` —
  rely on the machine's `curl`, OpenSSH client, and `rsync`.
- Skills follow the cross-tool Agent Skills layout (`skills/<name>/SKILL.md`
  with `name` + `description` frontmatter), which Claude Code, Codex, Cursor,
  Gemini CLI, OpenCode, Kilo, and Hermes Agent all read natively. OpenHands loads
  repository skill directories at `.agents/skills/<name>/SKILL.md` as on-demand
  AgentSkills (keyword activation needs explicit `triggers` frontmatter, which
  Merv's canonical skills do not carry); copy the relevant skill directories
  into that layout when needed. Replit's account connection does not install
  Merv skills.
- Shared agent files in `agents/` keep frontmatter to the common subset
  (`name`, `description`) so Claude Code, Cursor, and Gemini CLI can all load
  them. OpenCode needs `mode`/`permission` frontmatter, so it has its own thin
  agent wrappers in `clients/opencode/agents/` that load the matching review
  skill. Kilo's agent files use the same frontmatter, so its installer links
  those wrappers unchanged.
- The committed manifests pin every bundled client to the hosted brain
  `https://experiments.rapidreview.io/mcp`, so out of the box each client dials
  the hosted brain and runs no local brain. They intentionally contain no
  `headers` block, allowing a 401 to start native OAuth discovery. For a local
  deployment, point the `url` at `http://127.0.0.1:8787/mcp` and start
  `bin/merv-http`; local mode is auth-free. `merv-client env` remains the
  static-key config generator for runners and other headless surfaces.

## Long runs (merv_run) per client

Long sandbox work is client-neutral in core: launch with
`merv_run <label> -- <command>` over SSH, then check `sandbox.runs` — either a
`wait_seconds` long-poll inside the session or a plain call when next attending
the experiment. The long-poll cap is 300s server-side, but most MCP clients cut
tool calls around ~60s; unless you know your client's tool timeout is higher,
pass `wait_seconds<=45` (the same bound `sandbox.request` uses) and call again.
Run-oriented sandbox responses include compact receipts; `sandbox.runs` is the
authoritative status/readback call, and on HTTP surfaces configured with a wait
key its rows carry the `wait_url` that lets a client be *woken* by the run
instead of polling for it.

## Waking on run completion

On the hosted and local HTTP surfaces (any composition holding a wait key),
each `sandbox.runs` row carries a `wait_url`: a per-run URL signed for exactly
that `(sandbox_uid, label)` pair, served by an auth-exempt route, so an agent
can wait on a run without holding a credential. It reveals only that the run
ended and how (`status`, `exit_code`) — logs, outputs and receipts stay behind
the authenticated tools — and it stops answering roughly six hours after the
brain last observed a terminal run, or once the sandbox lease plus a day has
passed. Anyone holding the URL can read that much, so treat it like a status
pager rather than a secret: fine to hand to a local background process, not
something to paste anywhere public.

`bin/merv-runs-wait` (in the client bundle) is the portable watcher. It blocks
until the run settles and its **exit** is the wake signal; stdout carries
exactly one line, `MERV_RUNS_WAIT <state> <label> [status=... exit_code=...]`,
with heartbeats confined to stderr. One exception the contract names: a watcher
killed outright (SIGKILL, a signal during interpreter startup, a broken Python
install) exits with no line at all — treat a missing line exactly like
`poll_error`: read truth with one authenticated `sandbox.runs`, then re-arm.
Arming it right after a launch is what keeps a finished run from billing idle
until someone looks. Per-client
recipes — documentation only, nothing in core depends on them:

- **Claude Code**: run `merv-runs-wait --url <wait_url>` as a background Bash
  task (`run_in_background`). The turn ends immediately; the task's exit fires
  the client's native background-task notification and brings the agent back.
  Works from subagents too. On a machine with no bundle, `curl -N <wait_url>`
  streams the same final line, but the exit codes are curl's, not the
  contract's.
- **Cursor (3.0+)**: background shell with notify-on-output armed on the
  sentinel regex `^MERV_RUNS_WAIT `; the shell's exit or the matched line
  resumes the agent. If a long-idle reattach fails, re-run the watcher or fall
  back to a stop-hook loop.
- **Codex CLI**: run the watcher in the foreground blocking terminal (raise
  `background_terminal_max_timeout` when holds outlast the default), or use a
  background terminal plus an empty `write_stdin` poll, which unblocks the
  instant the process exits.
- **Hermes Agent**: start the watcher with the background terminal and
  completion notification enabled. Its exit wakes the agent; then read
  `sandbox.runs` for authoritative status and receipts.
- **Kilo**: `background_process` with `ready.pattern` `^MERV_RUNS_WAIT `
  (block-until-sentinel).
- **No-shell surfaces** (Claude Desktop and similar MCP-only clients): no
  watcher is possible. Long-poll `sandbox.runs` with `wait_seconds` and never
  call tighter than 60s apart; abandoning that loop leaves the box billing with
  nobody reading the receipts.

Rows minted by surfaces that have no caller-reachable base URL or no wait key
(library and direct callers) carry no `wait_url`. The same binary then polls
`sandbox.runs` with `MERV_MCP_KEY` and produces the same final line:

```bash
merv-runs-wait --project-id <project_id> --sandbox-uid <sandbox_uid> \
  --label <label> [--deadline 3600]
```

The exit code is the state, in both modes:

| Exit | State | Meaning |
|---|---|---|
| 0 | `done` | terminal observation — read `status=`/`exit_code=` on the line; exit 0 never means the workload succeeded |
| 2 | `still_running` | the server's hold cap (60 min) or `--deadline` elapsed; re-arm the same command |
| 3 | `poll_error` | the wait itself failed (transport, auth, rate limit); read truth with one authenticated `sandbox.runs`, then re-arm |
| 4 | `no_such_run` | absence OR an expired/rejected URL — in URL mode the run may still exist behind auth; read truth with one authenticated `sandbox.runs`, and conclude absence only when that row is missing past keyed registration grace |

## Packaging the client bundle (maintainers)

The plugin root (`merv/`) doubles as the monorepo — it carries the full backend
(`src/merv/brain`) and the test suite (`tests/`) that a thin HTTP-MCP client
never runs. The generated *slim* bundle keeps distribution independent from
the backend and test tree.

[`scripts/build_client_bundle.py`](../scripts/build_client_bundle.py) assembles
that bundle (skills, agents, manifests, `.mcp.json`, `bin/merv-client` and
`bin/merv-runs-wait` plus their self-contained `src/merv/{client,shared}`, and
the conformance probe) from
the real sources — nothing is duplicated in git, and
`tests/surface/test_client_bundle.py` fails if the backend or tests ever leak in
or a new skill/agent is left out.

```bash
python3 scripts/build_client_bundle.py --out dist/plugin   # gitignored
```

The repository workflow builds and force-publishes this output to the dedicated
generated `merv-client` branch after every update to `main`. Gemini installs
that branch and tracks its HEAD with `--auto-update`; nobody edits the generated
branch by hand. Codex, Claude Code, and Cursor consume their marketplace
manifests from `main`, whose entries resolve the canonical `merv/` source tree.
Release changes that alter skills or manifests therefore reach every
provider-independent distribution source without waiting for a provider review.

## Verify a connection

Every platform reaches the brain over the same Streamable-HTTP MCP wire, so one
platform-neutral probe validates any of them. [`scripts/mcp_conformance.py`](../scripts/mcp_conformance.py)
speaks JSON-RPC to `POST /mcp` with nothing but the standard library:

```bash
# Anonymous half — validates the OAuth native-connect surface (no key needed):
python3 scripts/mcp_conformance.py

# Full keyed loop (initialize -> tools/list -> project(current) -> status_and_next):
MERV_MCP_KEY=mk_... python3 scripts/mcp_conformance.py

# Against a local or self-hosted brain:
python3 scripts/mcp_conformance.py --base http://127.0.0.1:8787
```

A green keyed run is the exact signal any platform's MCP client sees, so it
isolates setup problems (key, endpoint, network) from platform-specific config.

## Reviewer handoff per client

`workflow.status_and_next` reports the active review gate and tells the main
agent when to request or launch a reviewer. The capability does **not** come
from that status response. The main agent calls `review.request`; that response
returns the short-lived `reviewer_capability` and a
`reviewer_handoff.spawn_prompt` containing the matching skill, request id, and
capability. What differs per client is only how the separate read-only reviewer
agent is spawned with that prompt:

- **Claude Code**: Agent tool with `subagent_type` set to
  `merv:experiment-design-review` / `merv:experiment-attempt-review` /
  `merv:project-reflection-review`.
- **Codex**: spawn a reviewer agent with the matching review skill.
- **Cursor**: delegate to the plugin subagent (`/experiment-design-review`, or natural
  language); subagents run with a clean context window.
- **Gemini CLI**: the extension's agents are exposed as tools; the main agent
  delegates automatically, or the user forces it with `@experiment-design-review`.
- **OpenCode**: the main agent delegates via the task tool to the installed
  subagent (or the user @-mentions it, e.g. `@experiment-design-review`).
- **Kilo**: the main agent delegates via the task tool to the installed
  subagent (the shared OpenCode-format wrappers, `mode: subagent`).
- **Hermes Agent**: pass `reviewer_handoff.spawn_prompt` unchanged to a fresh
  `delegate_task` child. Reflection lenses use `delegate_task(tasks=[...])`;
  the default concurrency of three runs five lenses in two waves.
- **OpenHands**: no reviewer-subagent auto-discovery; start a second session or
  agent with the matching review skill and handoff prompt, or follow it inline.
- **Replit Agent**: no reviewer-subagent auto-discovery; start a second session
  or agent with the matching review skill and handoff prompt, or follow it
  inline.

The reviewer begins with `review.start`, passing the request id, capability,
and its own non-empty `caller_session_id`. That id is required and must differ
from the `producer_session_id` recorded by `review.request`. The brain stores
only a hash of the capability, pins the request to the target snapshot, rejects
stale or superseded requests, and rechecks the snapshot at submission. A
successful start returns bounded project orientation, the target's slim
experiment/reflection context, and full content for the pinned submission being
reviewed.

New sessions that pass the distinct-id check are recorded as
`verified_agent_review`; `attested_agent_review` remains only on legacy rows.
The session ids are supplied by the clients, so this is workflow-level
separation rather than cryptographic proof of separate execution. See
[REVIEW_IDENTITY.md](REVIEW_IDENTITY.md).

## Use with Claude Code

The repository is its own third-party marketplace. Install the plugin and sign
in through the namespaced plugin MCP server:

```bash
claude plugin marketplace add NGXT-Inc/Merv
claude plugin install merv@rapidreview
claude mcp login plugin:merv:merv
```

Claude stores and refreshes the OAuth tokens. In `/plugin` → **Marketplaces** →
**RapidReview**, select **Enable auto-update** once; Claude deliberately leaves
third-party marketplace auto-update off by default. Without that toggle, update
manually with `claude plugin marketplace update rapidreview` and
`claude plugin update merv@rapidreview`.

Claude namespaces a plugin-provided server as `plugin:merv:merv`, which is why
the login command uses that full name. The `/mcp` screen provides the same
browser sign-in without needing to remember it.

## Use with Codex

Codex uses the repository marketplace at `.agents/plugins/marketplace.json`.
The plugin bundles its skills and URL-only HTTP MCP registration:

```bash
codex plugin marketplace add NGXT-Inc/Merv
codex plugin add merv@rapidreview
codex mcp login merv
```

All bundled `merv:` skills are then discoverable. Codex stores and refreshes the
OAuth tokens; there is no separate `codex mcp add` and no `MERV_MCP_KEY` for an
interactive user.

Codex currently documents explicit refresh rather than automatic updates for a
Git repository marketplace:

```bash
codex plugin marketplace upgrade rapidreview
codex plugin add merv@rapidreview
```

For headless `codex exec`, add an MCP-only server with
`--bearer-token-env-var MERV_MCP_KEY`. The bundled Codex config sets
`default_tools_approval_mode="approve"` so non-interactive tool calls do not die
on an approval prompt.

## Use with Cursor

The plugin ships a Cursor plugin bundle: [.cursor-plugin/plugin.json](../.cursor-plugin/plugin.json)
plus [mcp.json](../mcp.json) at plugin root; `skills/` and `agents/` are
auto-discovered from the same locations all other clients use. The repository
also exposes `.cursor-plugin/marketplace.json`, so no clone or bundle build is
needed for an ordinary install:

```bash
cursor-agent plugin marketplace add https://github.com/NGXT-Inc/Merv
cursor-agent
```

Inside Cursor Agent, open `/plugin`, choose the **rapidreview** marketplace,
install **merv** at user scope, and then select **Connect** for Merv in
**Customize**. Cursor receives the URL-only MCP config and runs its OAuth flow;
the user never supplies a key.

Cursor does not currently expose a non-interactive `plugin install` command.
For an individual custom marketplace it also does not document an automatic
update guarantee. Teams and Enterprise admins can import this repository as a
team marketplace, enable **Auto Refresh**, and set Merv to Default On or
Required. That is the only provider-independent Cursor path with native
automatic distribution today.

For local development, build the slim bundle into Cursor's local-plugin
directory and enable it in Customize:

```bash
python3 /path/to/merv/scripts/build_client_bundle.py --out ~/.cursor/plugins/local/merv
```

This copies only what a client needs (skills, agents, MCP config, onboarding
CLI) — not the backend or test suite. Re-run the same command after
`git pull` to update. Cursor rejects symlinks whose target is outside
`~/.cursor/plugins/local` (you would see `loadUserLocalPlugin merv rejected:
symlink target ... is outside ...` in the Cursor Plugins log), so the bundle
is copied as a real directory rather than symlinked.

Two Cursor-specific notes:

1. **MCP server.** Cursor registers Merv as an HTTP MCP server. The bundled
   [mcp.json](../mcp.json) contains only the hosted URL:

```json
{
  "mcpServers": {
    "merv": {
      "type": "http",
      "url": "https://experiments.rapidreview.io/mcp"
    }
  }
}
```

   The initial 401 starts OAuth. To point one workspace at a different brain
   (for example local `http://127.0.0.1:8787/mcp`), edit the `url` in the
   project's `.cursor/mcp.json`; local mode does not require authentication.

2. **Tool ceiling.** Cursor's approximately 40-tool limit applies across all
   active MCP servers. Merv's catalog nearly fills it when optional Storage is
   enabled. Merv hides
   UI/internal tools such as `project.list`, `experiment.get_state`, and `review.status` from the
   agent-facing catalog; if tools disappear when several MCP servers are
   enabled, disable servers or tools that are not in use.

Cursor's MCP settings may show a naming warning for dotted tools such as
`workflow.status_and_next`; the client still calls those tools normally.

## Use with Gemini CLI

The plugin ships a Gemini CLI extension: [gemini-extension.json](../gemini-extension.json)
bundles the MCP server (an HTTP server pointed at the brain's `/mcp` endpoint,
with OAuth discovered from the initial 401) and loads [GEMINI.md](../GEMINI.md)
as always-on context. `skills/` and `agents/` are auto-discovered from the
extension directory.

Install the generated slim client branch with automatic updates:

```bash
gemini extensions install https://github.com/NGXT-Inc/Merv \
  --ref merv-client --auto-update
```

Then start Gemini and run `/mcp auth merv`. Gemini discovers the authorization
and token endpoints, opens a browser, stores the tokens, and refreshes them.
`--auto-update` tracks the generated branch's HEAD, which the repository workflow
rebuilds after every `main` update.

For development, use `gemini extensions link /path/to/merv`. Reviewer subagents
can be given genuinely separate MCP sessions on Gemini: an agent's inline
`mcpServers` frontmatter opens its own connection to the brain. The shared agent
files do not use this (they stay client-common); the capability +
producer-session checks remain the load-bearing independence mechanism.


## Use with OpenCode

OpenCode has no declarative plugin bundle, so the adapter is an installer:

```bash
/path/to/merv/clients/opencode/install.sh
```

It symlinks the canonical skills into `~/.config/opencode/skills/`, the
OpenCode reviewer agents into `~/.config/opencode/agents/`, and prints the
`opencode.json` `mcp` block to add (see
[clients/opencode/opencode.json.example](../clients/opencode/opencode.json.example)).

Notes:

- The `opencode.json` `mcp` block registers Merv as a remote HTTP MCP server
  (the brain's `/mcp` endpoint with `Authorization: Bearer ${MERV_MCP_KEY}`),
  so there is no local process to spawn.
- The reviewer agents run as subagents (`mode: subagent`) with `edit`/`bash`
  denied; they load the matching review skill via OpenCode's native skill
  tool and submit through `review.start` / `review.submit`. Subagents get
  their own child session ids — pass them as `caller_session_id` for
  `verified_agent_review` status.
- OpenCode also reads `.claude/skills/` and `CLAUDE.md` as compatibility
  fallbacks, so repos already set up for Claude Code degrade gracefully.

## Use with Kilo

Kilo (the VS Code extension and the OpenCode-derived CLI) reads the Agent
Skills standard natively and registers remote MCP servers from `kilo.jsonc`.
It has no declarative plugin bundle, so the adapter is an installer:

```bash
/path/to/merv/clients/kilo/install.sh
```

It symlinks the canonical skills into `~/.kilo/skills/`, the shared
reviewer-agent wrappers into `~/.config/kilo/agent/`, and registers the MCP
server: a missing global `~/.config/kilo/kilo.jsonc` is written outright
(see [clients/kilo/kilo.jsonc.example](../clients/kilo/kilo.jsonc.example));
an existing one is never edited in place — the `mcp` block to merge is
printed instead.

Notes:

- The `mcp` block registers Merv as a remote HTTP MCP server (the brain's
  `/mcp` endpoint with `Authorization: Bearer {env:MERV_MCP_KEY}`), so there
  is no local process to spawn. A project-level `.kilo/kilo.jsonc` takes
  precedence over the global `~/.config/kilo/kilo.jsonc`.
- Kilo's agent files use the same `description`/`mode: subagent`/`permission`
  frontmatter as OpenCode's, so the installer links the wrappers from
  `clients/opencode/agents/` unchanged; they load the matching review skill
  and submit through `review.start` / `review.submit` with their own child
  session ids.
- Kilo also loads project-level `.agents/skills/` (the open agent standard) by
  default, so a repo that vendors the Merv skills there needs no global
  install.
- Older Kilo Code extension builds predate the unified config: they read
  `~/.kilocode/skills/` and register MCP servers in `.kilocode/mcp.json`
  (`mcpServers` map, `"type": "streamable-http"`). If skills or the server do
  not appear after install, check which generation the extension is on and
  mirror the same content there.

## Use with Hermes Agent

Hermes reads the standard Merv skill tree and connects to remote Streamable
HTTP MCP servers from `config.yaml`. Prefer a read-only `skills.external_dirs`
entry pointing at Merv's canonical `skills/` directory. On POSIX systems, the
bundled installer can instead link those skills into the normal Hermes
location; it also prints both supported MCP authentication forms:

```bash
./clients/hermes/install.sh
```

For bearer auth, export `MERV_MCP_KEY` and use a `mcp_servers.merv` entry whose
header is `Authorization: "Bearer ${MERV_MCP_KEY}"`. For native OAuth, set
`auth: oauth` instead and run `hermes mcp login merv`. Hermes prefixes MCP tool
names, so `workflow.status_and_next` appears as
`mcp_merv_workflow_status_and_next`.

Hermes' `delegate_task` provides the separate child context needed by review
gates and the five-lens reflection wave. Its scripted `hermes -z` mode is also
available through the Merv agent runner:

```bash
merv-client agent hermes --enable --command hermes
```

Hermes currently has no per-run MCP configuration flag. Runner-owned sessions
therefore use the session-scoped `merv-client call` bridge named in their
instruction; normal interactive Hermes sessions still use native MCP. See
[`clients/hermes/README.md`](../clients/hermes/README.md) for the full config,
review handoff, watcher, and runner details.

## Use with OpenHands

OpenHands uses Streamable HTTP. For the Local GUI/config-file surface, put the
server in `config.toml`:

```toml
[mcp]
shttp_servers = [
  { url = "https://experiments.rapidreview.io/mcp", api_key = "paste the key" }
]
```

The `api_key` value is sent exactly as `Authorization: Bearer <value>`.
Environment-variable interpolation in that TOML value is unconfirmed, so paste
the project key minted in the RapidReview UI. The CLI is a separate surface
with its own store (`~/.openhands/mcp.json`):

```bash
openhands mcp add merv --transport http \
  --header "Authorization: Bearer <project-key>" \
  https://experiments.rapidreview.io/mcp
```

For OAuth, replace `api_key` with `auth = "oauth"` (TOML) or `--header` with
`--auth oauth` (CLI); the interactive browser flow is unsuitable headless, so
prefer the project key.

On OpenHands Cloud, **Settings → MCP** is the only setup path. The MCP
connection cannot be shipped in a repository. Repository-root
[AGENTS.md](../AGENTS.md) supplies always-on Merv context, and research repos
may copy canonical skill directories into `.agents/skills/<name>/SKILL.md`
(on-demand AgentSkills; keyword activation needs explicit `triggers`
frontmatter). Full steps:
[clients/openhands/README.md](../clients/openhands/README.md).

## Use with Replit Agent

Replit's custom remote MCP support is configured under **MCP Servers**:
select **+ Add MCP server**, enter a display name and
`https://experiments.rapidreview.io/mcp`, then select **Test & save**. Merv
advertises OAuth 2.1 dynamic client registration with PKCE through RFC 8414
discovery and the RFC 9728 protected-resource challenge, so Replit registers it
and guides the browser sign-in and consent flow.

Advanced settings accept custom header name/value pairs for static keys.
Replit's documentation demonstrates `X-API-Key`; accepting a literal
`Authorization: Bearer ...` pair is **unconfirmed**, so OAuth is the primary
path. Connections are account-scoped across repls and cannot be pre-wired by a
template or `.replit`. All MCP traffic passes Replit's security scanner; no
per-tool grants or tool-count ceiling are documented. Full steps:
[clients/replit/README.md](../clients/replit/README.md).
