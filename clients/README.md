# Merv client plugins

Tell your agent: _Connect to Merv using https://experiments.rapidreview.io/connect_
(or your server's `/connect` URL). The agent installs the connector, asks for your
Merv email, then asks you to read back the emailed 8-digit code. Match the request
words in the email to the sign-in the agent started. Restart the client once when
installation asks. Sign-in needs no browser and no API key pasted into chat.

The connector registers one `merv` MCP server for Claude Code, Codex and Cursor.
It stores one account key per machine, shared across the clients and projects on
that server. The agent calls `project.read` with `{"action":"list","list":{}}`,
then passes the selected `projectId` on subsequent calls. Keys expire after at most
90 days and can be revoked in Settings → Keys. Do not read or print the key store.

Installation pre-approves Merv's tools: Codex's Merv server entry gets
`default_tools_approval_mode = "approve"`; Claude Code's `permissions.allow` gains
`mcp__merv`. Server-side role and workflow checks still apply. `merv-connect uninstall`
removes the connector's registrations and approval entries, preserving unrelated
settings and permissions. Staging uses its own server name and permission.

These optional plugins add three skills: research, operations and acting for the
person. They do not register another MCP server. Disable the old Python-backend
plugin and its skills before using them.

- **Claude Code:** `claude plugin marketplace add ./clients` and
  `claude plugin install merv@merv` (or `claude --plugin-dir clients/claude-code`).
- **Codex:** `codex plugin marketplace add ./clients` and `codex plugin add merv@merv`.

Machines, CI and VMs may use keys from Settings → Keys; see
[connection details](../merv-typescript/deploy/CLIENT_CUTOVER.md).

`manifest.json` is the source of truth for the bundles. Edit a skill in
`claude-code/skills/` and copy it to `codex/skills/`.
`merv-typescript/tests/client-bundles.test.ts` checks that they match and name listed tools.
