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

On a remote machine over SSH, the browser's consent redirect cannot reach the
client's loopback listener. Use device pairing instead: run
`curl -fsSL https://rapidreview.io/merv/pair_mcp.py -o /tmp/pair_mcp.py &&
python3 /tmp/pair_mcp.py` on that machine and approve the printed code in any
signed-in browser — nothing ever addresses the machine. Details and the SSH
port-forward fallback in [AUTH.md](AUTH.md#remote-machines).

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

## Auto-run runner: pair with a code

Install the non-interactive runner independently of the agent plugin or
extension, on whichever machine should run your agents — the laptop in front
of you, a remote box over SSH, it makes no difference:

```bash
curl -fsSL https://rapidreview.io/merv/runner/install.sh | sh
```

This verifies and installs the standalone runner under `~/.merv`, then starts
it. On a machine that is not paired yet the runner generates its own `mk_` key
locally, sends only the key's digest to the brain, and prints an 8-character
code such as `7Q2K-M4B9`. Enter that code on the Auto-run page (the empty state,
or **Pair a machine** under Machines); approving it registers the digest as a
project key labelled `auto-run · <hostname>` and the runner starts dispatching
for that project on its next poll — no browser ever addresses the machine, no
port forwarding, nothing to paste from the terminal but the code. It needs
Python 3.11+ and Git, but no Merv repository clone or package installation.
Rerun the command to update it; `merv-agent-runner pair` starts a fresh
pairing on an already-installed machine.

The plaintext key never leaves the machine and never appears in the browser.
Until approval it lives only in an owner-only pairing file; a restart resumes
an unfinished exchange, an expired code is discarded, and a revoked key stops
the runner with a re-pair instruction instead of re-enrolling silently.

Once paired, everything else happens in the brain: the runner heartbeats its
non-secret inventory (which agents it has and whether their executables
resolve, workspace paths, local session counts, the settings version it has
applied), and the Auto-run page's machine drawer saves the tuning an owner wants
(enabled/model/effort/parallelism per native platform, repository, worktree
root, base ref). The runner pulls that on its next heartbeat and applies it in
place; disabled platforms drain instead of vanishing under live sessions and a
workspace change waits for an idle cycle, so the page can honestly show
*Settings pending* until it is really in effect. Executable argv and custom
`command`-adapter agents are never held by the brain: edit those on the
machine with `merv-client agent`. A freshly paired machine with no agents yet
is a valid state — it heartbeats and starts claiming as soon as one is enabled.

For CI or scripted installs that must not pair interactively, pass
`--install-only` (`curl -fsSL … | sh -s -- --install-only`), create a project
key at [rapidreview.io/merv](https://rapidreview.io/merv), export it without
placing it in shell history, and start the runner with an explicit `--project`:

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
$CLI harness     # install the Merv skills and check each harness is ready
```

The older `merv-client login`, `link`, `links`, `route`, and `unlink`
subcommands are gone. Interactive sign-in belongs to the platform's native MCP
OAuth command; headless project reach comes from the static grant plus explicit
`project_id` arguments.

Agent-platform settings live beside `control_url` in the private
`~/.merv/client.json`. Commands are stored as argv arrays and are never run
through a shell. A paired machine dispatches with plain `merv-agent-runner`;
the headless key path names the project explicitly:

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

That isolation also hides the user's Merv plugin from every child, so the runner
carries the plugin's skills itself. On first start it installs them under
`~/.merv/skills/<skill>/SKILL.md` (refreshed whenever the runner build changes),
links them into each Codex workspace as `.agents/skills/<skill>` and each
Claude Code workspace as `.claude/skills/<skill>` (listed in the private central
repository's `info/exclude`, so a WIP capture never commits them), and appends
one line to every instruction naming the install path; children also get
`MERV_SKILLS_DIR`. `merv-client harness` performs the same install and prints,
per configured platform, whether the executable resolves, its version, and how
it will reach Merv tools and skills; it exits non-zero when an enabled platform
is not ready, and the running runner reports the same facts in its heartbeat
inventory (`harness`) for the Auto-run page.

Auto-run recordings stay on the executor at
`~/.merv/agent-traces/<agent-session-id>/`: `metadata.json` binds the work item
to its harness/model setup, `trace.jsonl` is the native provider event stream,
and `stderr.log` holds diagnostics. The runner mirrors one bounded, redacted
excerpt per job to the brain — the last few events and the tail of stderr, with
secret-shaped keys and values masked — so the Auto-run job card can show what
an agent is doing or why it stopped; the full trace never leaves the machine.
Aider is intentionally unsupported for auto-run because it cannot emit the
required complete structured trace.

The runner requires Git worktrees. It initializes a Merv-owned bare repository
and central ref, gives each experiment a persistent branch under
`~/.merv/worktrees`, and reuses that branch across agent sessions. Consolidation
has its own persistent worktree; detached reviewer worktrees are temporary.
The user's checkout is never the central ref, and the private bare clone has no
remote, so Merv never pushes to the user's repository. Worktrees prevent Git
collisions; same-user agents can still read one another's files, so use
containers, VMs, or separate OS identities for hostile-agent containment.

What the brain holds and what stays on the machine:

- **Brain (`agent_runners` row per paired machine):** the runner's non-secret
  heartbeat inventory, the owner's desired tuning (`enabled`, `model`,
  `effort`, `parallelism` per native platform; `repository`, `root`,
  `base_ref`), and the desired/applied version pair the page uses to show
  *Settings pending* honestly. The schema is closed: a payload carrying
  `command`, `adapter`, or any unknown key is rejected whole, on both sides.
- **Machine (`~/.merv/`):** `client.json` (including executable argv and any
  custom `command`-adapter agents), `agent-runner.key` (the paired credential,
  preferred over an inherited `MERV_MCP_KEY` so a shell variable for another
  project cannot silently override it), `agent-runner.secret`,
  `agent-sessions.json`, and the traces.

`merv-agent-runner` reads the paired project from `client.json`; `--project`
remains as an override for the headless key path and for a loopback brain,
which has no auth and therefore no pairing.
