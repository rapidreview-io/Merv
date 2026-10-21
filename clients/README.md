# Merv plugins for Codex and Claude Code

Merv connects your agent to research projects, experiments, tasks, reviews and Git
through remote MCP with browser sign-in. The plugin includes four skills and the
MCP connection; no local server, API key copy-paste or background daemon is needed.

Install from
[rapidreview-io/merv-plugins](https://github.com/rapidreview-io/merv-plugins).
Both clients keep the
plugin identity **`merv@merv`**, regardless of the GitHub repository name.

## Install and sign in

Use a current client with plugin support. For an existing modern `merv@merv`
installation, update it instead of adding another connection. If you used the old
Python plugin (`merv@rapidreview`), follow the migration note below first.

### Codex

Run in your terminal:

```sh
codex plugin marketplace add rapidreview-io/merv-plugins
codex plugin add merv@merv
codex mcp login merv
```

Complete browser sign-in and consent, then start a fresh Codex chat. The terminal
login authenticates the bundled MCP server; a desktop app is not required.

### Claude Code

Open **Plugins → Marketplaces → Add**, paste **`rapidreview-io/merv-plugins`**,
then install **Merv** for your user account. Or run in your terminal:

```sh
claude plugin marketplace add rapidreview-io/merv-plugins
claude plugin install merv@merv --scope user
```

Start a fresh Claude Code chat, open `/mcp`, select Merv and authenticate through
the browser. Installing the plugin and signing in are separate steps.

### Permissions

Sign-in grants account access; it does not approve every agent action. In Codex,
review tool approval prompts and use its saved server/tool policy if you want
approvals to persist. In Claude Code, review `/permissions` and save only the Merv
tool permissions you intend to allow, at user scope for use across projects.

MCP permissions do not grant shell or filesystem access. Git work also needs an
authorized local workspace and permission to run its Git/Python commands. Keep
receiving keys inside that workspace. If a command or cleanup is denied, the agent
must report it; do not disable permission checks or grant blanket shell access.

## Start using Merv

Tell your agent: **“Use Merv. List my projects.”** Choose the intended project, or
create/join one on the website if the list is empty. Sign-in does not require an
existing project membership. The connection follows your current permissions;
project changes do not require a new login.

Account sign-in persists across chats in the native client. Reconnect through the
client if the grant expires or is revoked. Never put tokens in chat or plugin
files. You can revoke Merv access from
[account settings](https://experiments.rapidreview.io/ui/account/keys).

For code-linked work, the Git skill syncs authorized committed work to a separate
Merv remote, preserves existing remotes and verifies exact remote heads. It reports
uncommitted files and divergence rather than sweeping unrelated work into commits.
Readers can fetch; producers and operators can push permitted user branches.
Branch sync does not advance the reviewed research baseline or change experiment
pins. Research tools also work without Git.

## Updates and older installations

For this marketplace, refresh it and update the installed plugin:

```sh
# Claude Code
claude plugin marketplace update merv
claude plugin update merv@merv --scope user

# Codex
codex plugin marketplace upgrade merv
codex plugin add merv@merv
```

Start a fresh chat after updating. Reuse your saved browser connection.

**Coming from the Python plugin (`merv@rapidreview`)?** Back up your client settings,
disable or uninstall only the old Merv plugin, then install this marketplace and
sign in through the browser. Preserve other plugins, servers and permissions.
Do not copy old API keys into the new plugin or register a duplicate Merv server.
The [migration guide](https://experiments.rapidreview.io/connect/agent.md#migrate-an-older-installation)
covers old standalone connectors and revoking their old keys after the new connection works.

## Other installation paths

For a local checkout of this marketplace, replace `rapidreview-io/merv-plugins` in
the add command with its absolute directory path. In the application source repo,
that directory is `clients/`. Keep the install selector `merv@merv`.

The [connection guide](https://experiments.rapidreview.io/connect/agent.md) offers
server-hosted bundles and direct MCP setup. A direct connection alone has no
plugin skills. Server-hosted bundles can lag a plugin-only publication; check the
version before switching installation sources.

## Maintaining the bundle

Edit skills in `claude-code/skills/` and copy them to `codex/skills/`. In the
application source repo, run `npm run build:clients` from `merv-typescript/` to
regenerate the embedded bundle and run the focused client tests.

The standalone marketplace can be published independently of Main. Publication
does not update the deployed `/connect/bundle.*` or setup guide and requires no
Main image rebuild. The application repository exports only an explicit allowlist from `clients/`
through `tools/export_plugins.py`. Its client publication workflow targets this
standalone repository and does not build the application.

Version 0.5.7 keeps the canonical Python blocks free of curly braces to avoid a
Claude shell parser false-positive. Temporary receiving keys stay in an authorized
workspace. Credential storage, Git operations, verification and cleanup run in one
live invocation; later batches mint fresh credentials through saved MCP sign-in.
