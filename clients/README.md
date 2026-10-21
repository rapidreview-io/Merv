# Merv client plugins

Tell your agent to read **https://experiments.rapidreview.io/connect/agent.md**.
The guide downloads an ordinary plugin package, installs it in Codex or Claude
Code, and starts the client's browser sign-in. No local connector runs. The
connection and credentials belong to the client and persist across chats.

The 0.5.1 bundles combine remote MCP and three concise skills. Codex uses
`.codex-plugin/plugin.json` + `.mcp.json`; Claude Code uses `.claude-plugin/plugin.json` +
`.mcp.json`. The server publishes the same files at `/connect/bundle.tar.gz` and
`/connect/bundle.json`, stamping its origin and a distinct marketplace/plugin name
for nonproduction hosts. Installing Merv does not preapprove every tool.
The setup guide includes a one-time, plugin-scoped permission choice for operation
across fresh chats: Codex saved tool/server policy or Claude Code user-level
`/permissions` rules. OAuth consent alone does not save tool approval.

From a checkout, add `clients/` as a local marketplace, then install `merv@merv`:

- Codex: `codex plugin marketplace add /absolute/path/to/clients`, then
  `codex plugin add merv@merv`, then `codex mcp login merv`. The last command
  authenticates the bundled server in the terminal; no desktop app is needed.
  Complete the displayed browser sign-in and consent before using tools.
- Claude Code: `claude plugin marketplace add /absolute/path/to/clients`, then
  `claude plugin install merv@merv --scope user`. Authenticate from `/mcp`.

Use one bundled or direct MCP connection per origin. If Merv is already connected,
reuse it. Client versions without plugin support need updating or
the documented direct remote MCP fallback; that fallback alone has no skills.

Sign in or create an account through the browser's normal identity flow (Google
sign-in can create an account when enabled), then approve account access. No project
membership or selection is required. The connection follows current project permissions;
new memberships appear without reconnecting and removed memberships lose access.
If the project list is empty, create/join a project on the website and list again.
Research tools work without Git. Revoke access at `/ui/account/keys`, even with zero projects.

In a fresh chat, “use Merv” loads the skills; the agent lists projects and reads
the intended project's brief and workflow status, passing its explicit `projectId`.
Ask the person which project when ambiguous; never silently reuse another chat's selection.
Switch between permitted projects without reconnecting. If needed, reconnect through
the client's sign-in action. Never put a token in chat or plugin files.

See [migration and deployment](../merv-typescript/deploy/CLIENT_CUTOVER.md) and
[validation evidence](../merv-typescript/docs/MCP_OAUTH_VALIDATION.md).

Edit skills in `claude-code/skills/` and copy to `codex/skills/`. After editing any
bundle file, run `npm run build:clients` in `merv-typescript/`. The generated
server-side bundle is checked against the originals in the bundle tests.
