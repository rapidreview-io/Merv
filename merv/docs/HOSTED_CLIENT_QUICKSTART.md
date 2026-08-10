# Hosted client quickstart

Set up a machine that runs agents against the hosted brain while keeping repo
access and caller SSH keys local.

## Interactive setup: OAuth, no Merv key

Agent clients connect directly to the hosted brain over HTTP. There is no local
proxy, Python package, or repository clone. Install one platform integration:

```bash
# Codex
codex plugin marketplace add NGXT-Inc/Merv
codex plugin add merv@rapidreview
codex mcp login merv

# Claude Code
claude plugin marketplace add NGXT-Inc/Merv
claude plugin install merv@rapidreview
claude mcp login plugin:merv:merv

# Gemini CLI; then run /mcp auth merv in Gemini
gemini extensions install https://github.com/NGXT-Inc/Merv \
  --ref merv-client --auto-update

# Cursor; then install merv from rapidreview in /plugin and Connect in Customize
cursor-agent plugin marketplace add https://github.com/NGXT-Inc/Merv
```

The bundled MCP entry contains only
`https://experiments.rapidreview.io/mcp`. The client receives a 401, discovers
Merv's OAuth endpoints, opens the browser, stores the token, and refreshes it.
The user never sees or mints the underlying credential.

Enable RapidReview marketplace auto-update once in Claude's `/plugin` screen.
Gemini's `--auto-update` flag is sufficient. Codex repository marketplaces
currently use `codex plugin marketplace upgrade rapidreview` followed by
`codex plugin add merv@rapidreview`. Cursor has no non-interactive plugin install
command and no documented automatic-update guarantee for an individual custom
marketplace; its team marketplace supports Auto Refresh.

## Headless setup: static key

Clone the repository only for self-hosting, client development, or the
non-interactive agent runner:

```bash
git clone https://github.com/NGXT-Inc/Merv.git ~/Merv
```

The runner and CI cannot rely on a browser callback, so they still use a scoped
`mk_` key. Create one at [rapidreview.io/merv](https://rapidreview.io/merv),
prefer **All my projects** unless deliberate project confinement is needed, and
export it without placing it in shell history:

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
CLI=~/Merv/merv/bin/merv-client
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
~/Merv/merv/bin/merv-agent-runner --project proj_123
```

Native non-interactive process adapters cover Codex, Claude Code, Gemini CLI,
Cursor Agent, OpenCode, Aider, GitHub Copilot CLI, Qwen Code, and Hermes Agent.
A named platform using the `command` adapter can launch another coding agent as
long as it reads the Merv instruction from standard input. The runner removes
its own Merv credentials before launch; each child receives only
`MERV_AGENT_SESSION_KEY`. Codex and Claude Code receive an isolated MCP
configuration for that credential. Hermes and the other agents use
`merv-client call TOOL --arguments JSON`; this bridge reads the same key from
the environment and calls Merv's MCP-shaped endpoint without a shell.

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
~/Merv/merv/bin/merv-agent-runner --settings-only
```

It prints a generated pairing token, stored owner-only outside `client.json`.
The browser keeps that token in memory and sends it to
`http://127.0.0.1:8791`. The control accepts only paired settings reads/writes
and redacted status; it intentionally has no HTTP start/stop operation because
the settings contain executable argv. Actual agent launch remains the explicit
`merv-agent-runner --project ...` command. Treat the pairing token as
local-administrator authority and paste it only into a trusted Merv UI origin.
