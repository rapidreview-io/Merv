# Connecting after the TypeScript cutover

Your Merv account and project memberships are preserved. Old research is in
**Research → Research history**; unfinished legacy work was not migrated. Create
new work through the current tools.

## Connect a personal agent

1. Disable the old Python-backend Merv plugin and its skills (legacy bundle 0.1.5)
   and any duplicate Merv MCP connection. Other plugins can stay enabled.
2. Tell Claude Code, Codex or Cursor: _Connect to Merv using
   https://experiments.rapidreview.io/connect_. The agent follows that page's installer,
   which registers the local connector as `merv`. Restart the client when asked.
3. Give the agent the email you use for Merv. It calls `connector.login` to start
   sign-in. Check that the request words match the email, then read the emailed
   **8-digit code** to the agent so it can finish. No browser sign-in or pasted key
   is needed. Email codes are sent only to accounts belonging to a project.
4. The agent calls `project.read` with `{"action":"list","list":{}}`, selects a
   returned project, then passes its `projectId` on subsequent calls. Start with
   `project.read` (`brief`) and `workflow.read` (`status`):

   ```json
   { "projectId": "<project id>", "action": "brief", "brief": {} }
   ```

   ```json
   { "projectId": "<project id>", "action": "status", "status": {} }
   ```

The connector keeps one account key per machine and Merv server, shared by the
clients and projects there. It never prints the key. The private store is
`~/.merv/connect`; agents should not read it. Keys expire after at most 90 days
without renewal, are labelled with client and host, send a sign-in notice, and
can be revoked from Settings → Keys. An expired or revoked key needs a new email
sign-in. See [agent sign-in configuration](../docs/PROJECT_INVITATIONS.md#agent-sign-in).

## Tool approval and optional skills

The installer sets `default_tools_approval_mode = "approve"` on Codex's Merv MCP
server entry and adds `mcp__merv` to Claude Code's `permissions.allow`. Merv tools
then run without individual client approval prompts; server permissions still
apply on every action. Staging uses `merv-staging` and `mcp__merv-staging`.
`merv-connect uninstall` removes the connector's server registrations and the
approval entries it added, preserving unrelated configuration and permissions.

The [0.4.0 client bundles](../../clients/README.md) add skills only. They do not
create another server connection. Personal agents use the noun tools and nested
action inputs described in the [tool overview](../README.md#agent-tools), such as
`{"action":"get","get":{"taskId":"<task id>"}}` for `task.read`.
Retired names run as aliases for one release. Leased workers retain the aliases
and inputs in their pinned workflows; those workflows are unchanged.

## Machines, CI and servers without agent sign-in

Use a key from Settings → Keys. A project key fixes the project; an account key
can list projects with `project.read` (`list`) and requires a selected `projectId`
on project calls. Store the key privately in the environment of the client
process, for example as `MERV_TOKEN`, and restart that process. Never paste it in
chat, source control or shell history.

Codex can register a direct HTTP connection:

```sh
codex mcp add merv --url https://experiments.rapidreview.io/mcp --bearer-token-env-var MERV_TOKEN
```

For Claude Code, merge this into the appropriate `.mcp.json`, preserving other servers:

```json
{
  "mcpServers": {
    "merv": {
      "type": "http",
      "url": "https://experiments.rapidreview.io/mcp",
      "headers": { "Authorization": "Bearer ${MERV_TOKEN}" }
    }
  }
}
```

Keep `${MERV_TOKEN}` literal. Use this direct connection only when the connector
is not registered under that name. Manual setup does not run the installer's
approval configuration. Verify with the same project reads above.

## If it fails

- **Not signed in:** use `connector.login` with your email and the new emailed code.
- **401 on a direct connection:** check that the client inherited the production
  key and that it has not expired or been revoked.
- **Project selection required:** list projects, then pass `projectId` on the call.
- **Old tool list or login flow:** disable the legacy plugin and duplicate MCP
  connections, then restart the client.
- **Project missing:** check that the sign-in email belongs to the intended Merv
  account and that its project membership is active.
