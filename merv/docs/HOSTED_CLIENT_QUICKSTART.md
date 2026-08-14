# Hosted client quickstart

Set up a machine that runs agents against the hosted brain while keeping repo
access and caller SSH keys local.

## Interactive setup: OAuth, no Merv key

Agent clients connect directly to the hosted brain over HTTP. There is no local
proxy, Python package, or repository clone. Install one platform integration:

```bash
# Codex
codex plugin marketplace add rapidreview-io/Merv
codex plugin add merv@rapidreview
codex mcp login merv

# GitHub Copilot CLI; then run /mcp auth merv in Copilot
copilot plugin marketplace add rapidreview-io/Merv
copilot plugin install merv@rapidreview

# Claude Code
claude plugin marketplace add rapidreview-io/Merv
claude plugin install merv@rapidreview
claude mcp login plugin:merv:merv

# Gemini CLI; then run /mcp auth merv in Gemini
gemini extensions install https://github.com/rapidreview-io/Merv \
  --ref merv-client --auto-update

# Qwen Code; then open /mcp in Qwen and sign in to Merv
qwen extensions install rapidreview-io/Merv --ref=merv-client

# Cursor; then install merv from rapidreview in /plugin and Connect in Customize
cursor-agent plugin marketplace add https://github.com/rapidreview-io/Merv

# Kilo Code
kilo plugin 'github:rapidreview-io/Merv#merv-client' --global
kilo mcp auth merv

# Hermes Agent
hermes plugins install rapidreview-io/merv-hermes-client --enable
hermes mcp add merv --url https://experiments.rapidreview.io/mcp --auth oauth

# OpenCode
opencode plugin 'github:rapidreview-io/Merv#merv-client' --global
opencode mcp auth merv
```

The bundled MCP entry contains only
`https://experiments.rapidreview.io/mcp`. The client receives a 401, discovers
Merv's OAuth endpoints, opens the browser, stores the token, and refreshes it.
The user never sees or mints the underlying credential.

Enable RapidReview marketplace auto-update once in Claude's `/plugin` screen.
Gemini's `--auto-update` flag is sufficient. Qwen prompts when the tracked
branch changes and updates with `qwen extensions update merv`. Codex repository marketplaces
currently use `codex plugin marketplace upgrade rapidreview` followed by
`codex plugin add merv@rapidreview`. Copilot updates with
`copilot plugin update merv@rapidreview`. Cursor has no non-interactive plugin install
command and no documented automatic-update guarantee for an individual custom
marketplace; its team marketplace supports Auto Refresh. Kilo checks the
hosted, content-versioned Merv skill catalog when a session starts; `/reload`
refreshes a session that is already running. Hermes updates with
`hermes plugins update merv` when Merv announces an update. OpenCode refreshes
the hosted, content-versioned skill catalog when a session starts; rerun its
plugin command only when Merv announces an adapter update.

## Headless setup: static key

Install the non-interactive runner independently of the agent plugin or
extension:

```bash
curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh
```

This verifies and installs the standalone runner under `~/.merv`, starts its
loopback pairing service, and prints the token requested by Settings → Auto
running. It needs Python 3.11+ and Git, but no Merv repository clone or package
installation. Rerun the command to update it. For a remote runner, forward the
settings port while pairing: `ssh -L 8791:127.0.0.1:8791 HOST`.

The browser setup mints a project-scoped `mk_` key and writes it directly to
the paired runner's owner-only credential file; it never appears in the copied
command or browser storage. Manual runner setup and CI can still create one at
[rapidreview.io/merv](https://rapidreview.io/merv) and export it without placing
it in shell history:

```bash
printf 'Paste the Merv key: '
IFS= read -r -s MERV_MCP_KEY
printf '\n'
export MERV_MCP_KEY
```

Treat the key as a password. Keep it out of shared config, logs, and version
control. `~/Merv/merv/bin/merv-client env` prints the header-based MCP snippet
for a headless client. To point the runner at a self-hosted brain:

```bash
~/Merv/merv/bin/merv-client configure \
  --control-url https://your-control-plane.example.com
```

## The `merv-client` CLI

The onboarding CLI configures the connection and optional local agent
platforms:

```bash
CLI=$HOME/.merv/bin/merv-client
$CLI configure   # write machine config (e.g. which brain to target)
$CLI env         # print the .mcp.json http snippet for this machine
$CLI agent codex --enable --command codex --parallelism 2
$CLI agent claude --enable --command claude --model opus
$CLI agent hermes --enable --command hermes
$CLI agents      # print the configured local platforms
$CLI workspace --repository /path/to/repo --strategy git_worktree
```

The older `merv-client login`, `link`, `links`, `route`, and `unlink`
subcommands are gone. Interactive sign-in belongs to the platform's native MCP
OAuth command; headless project reach comes from the static grant plus explicit
`project_id` arguments.

Agent-platform settings live beside `control_url` in the private
`~/.merv/client.json`. Commands are stored as argv arrays and are never run
through a shell. To let Merv fill a reviewed experiment wave with separate
local sessions:

```bash
$HOME/.merv/bin/merv-agent-runner --project proj_123
```

Native non-interactive process adapters cover Codex, Claude Code, Gemini CLI,
Cursor Agent, OpenCode, GitHub Copilot CLI, Qwen Code, and Hermes Agent. A named
platform using the `command` adapter can launch another coding agent as long as
it reads the Merv instruction from standard input and emits JSONL interactions
on stdout. The runner removes its own Merv credentials before launch; each
child receives only `MERV_AGENT_SESSION_KEY`. Codex and Claude Code receive an
isolated MCP configuration for that credential. Hermes and the other agents use
`merv-client call TOOL --arguments JSON`; this bridge reads the same key from
the environment and calls Merv's MCP-shaped endpoint without a shell.

Auto-run recordings stay on the executor at
`~/.merv/agent-traces/<agent-session-id>/`: `metadata.json` binds the work item
to its harness/model setup, `trace.jsonl` is the native provider event stream,
and `stderr.log` holds diagnostics. Aider is intentionally unsupported for
auto-run because it cannot emit the required complete structured trace.

The runner requires Git worktrees. It initializes a Merv-owned bare repository
and central ref, gives each experiment a persistent branch under
`~/.merv/worktrees`, and reuses that branch across agent sessions. Consolidation
has its own persistent worktree; detached reviewer worktrees are temporary.
The user's checkout is never the central ref, and the private bare clone has no
remote, so Merv never pushes to the user's repository. Worktrees prevent Git
collisions; same-user agents can still read one another's files, so use
containers, VMs, or separate OS identities for hostile-agent containment.

To let the hosted Settings page edit the same local file, start the runner's
loopback-only control without dispatching:

```bash
$HOME/.merv/bin/merv-agent-runner --settings-only
```

It prints a generated pairing token, stored owner-only outside `client.json`.
The browser keeps that token in memory and sends it to
`http://127.0.0.1:8791`. The control accepts only paired settings reads/writes,
redacted status, and a write-only runner credential; it intentionally has no
HTTP start/stop operation because the settings contain executable argv. Actual
agent launch remains the explicit `merv-agent-runner --project ...` command.
Treat the pairing token as local-administrator authority and paste it only into
a trusted Merv UI origin.
