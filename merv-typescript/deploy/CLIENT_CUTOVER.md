# Connecting after the TypeScript cutover

Use the same Supabase account at https://experiments.rapidreview.io/ui/. Project memberships are preserved. Old research is in **Research → Research history**; unfinished work was excluded at the user's request. Create new work through the current tools.

## Existing Codex / Claude Code users

Disable the old Merv plugin (the legacy bundle is version 0.1.5), including its skills. Its OAuth setup and tool instructions target the Python backend. Uninstall it only if the client cannot disable it. Do not keep both old and new Merv connections enabled. Other plugins, including Nisa, do not need to be removed.

There is not yet a replacement published Merv plugin bundle. Use the direct HTTP MCP connection below. Merely reinstalling the old bundle will not update its contract. Existing runner installers and skill-download URLs are retained for rollback; that does not make them compatible with the new backend.

1. Sign into the production UI and open the account menu → **Manage machine keys**.
2. Create a **project-scoped** key for the project the agent will use. Give it a recognizable label. This avoids requiring project-selection headers. Account-scoped keys are available but require explicit project selection.
3. Store the key privately as `MERV_TOKEN` in the environment of the process launching your client. Restart the client so it receives the variable. Do not put the literal key in source control, a chat, or a command saved to shell history. Keys created in the staging rehearsal are not production keys.
4. Configure the new connection, then verify that `actor.whoami` reports the expected project and that `workflow.status_and_next` responds.

Your Supabase password/account does not change. Old OAuth sessions, agent sessions and bearer credentials are not migrated. Reconnection creates new native sessions when requested; it does not resume discarded work.

## Codex

With `MERV_TOKEN` available to the client process:

```sh
codex mcp add merv-typescript --url https://experiments.rapidreview.io/mcp --bearer-token-env-var MERV_TOKEN
```

Equivalent user configuration in `~/.codex/config.toml`:

```toml
[mcp_servers.merv-typescript]
url = "https://experiments.rapidreview.io/mcp"
bearer_token_env_var = "MERV_TOKEN"
```

This config refers to the environment variable; it does not contain the secret. A desktop app must also inherit that variable through its launch environment. See the official [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Code

Merge this entry into the appropriate `.mcp.json`; preserve unrelated servers:

```json
{
  "mcpServers": {
    "merv-typescript": {
      "type": "http",
      "url": "https://experiments.rapidreview.io/mcp",
      "headers": {
        "Authorization": "Bearer ${MERV_TOKEN}"
      }
    }
  }
}
```

Keep `${MERV_TOKEN}` literal in the file. Claude Code expands it from its environment. Restart the client, use `/mcp` to check the connection, and run the two read-only checks above. See [Claude Code's documented environment expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson).

## If it fails

- **401:** check that the process received the production key, with no surrounding whitespace, and that it has not expired or been revoked.
- **Project selection required:** use a project-scoped key, or configure `X-Merv-Project-Id` for an account-scoped key.
- **Old tool names / old login flow:** disable the legacy plugin and stale duplicate MCP connection, then restart the client.
- **Project missing:** verify that the browser and key belong to the same Supabase account and that its project membership is active.
