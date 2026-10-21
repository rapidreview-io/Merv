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
Python plugin (`merv@rapidreview`), you can update it in place as described below.
Keep only one Merv plugin enabled.

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

**Already using `merv@rapidreview`?** The old marketplace is now a compatibility
entry that fetches the same current plugin from `rapidreview-io/merv-plugins`.
Refresh the old marketplace and update your existing installation:

```sh
# Claude Code
claude plugin marketplace update rapidreview
claude plugin update merv@rapidreview --scope user

# Codex
codex plugin marketplace upgrade rapidreview
codex plugin add merv@rapidreview
```

Start a fresh chat and use browser sign-in if prompted. The identity stays
`merv@rapidreview`; this is an update, not an automatic rename. You get the current
four skills and OAuth MCP connection, including board tools, without installing a
second Merv plugin. The legacy marketplace catalog still lives in the application
repository, so refreshing that old catalog can fetch its repository; the installed
plugin itself comes only from the small dedicated plugin repository.

**For new installations, use `merv@merv`.** To migrate an existing installation to
that canonical identity, back up your client settings, disable or uninstall only
`merv@rapidreview`, then install `merv@merv` from the commands above. Keep only one
Merv plugin enabled and remove old standalone Merv MCP entries. Preserve other
plugins, servers and permissions. Reuse browser sign-in when the client can; it
may require consent again under the new identity. Never copy old API keys into
the plugin. Revoke old keys only after the new connection works.

The compatibility entry follows the same published `main` bundle, so there is no
separate legacy implementation or version number to maintain. Existing clients
must refresh/update their marketplace; this does not silently replace a cached
plugin in an already-open chat.

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
