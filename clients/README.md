# Merv client plugins

Plugins that connect your own agent to Merv's MCP server with three skills (research, operations, acting for the person). `manifest.json` is the source of truth: name, version, MCP URL, key variable and skills; a test in `merv-typescript/tests/client-bundles.test.ts` keeps both bundles matching it and every tool a skill names registered.

Create a project key in Merv (Settings → Keys) and export it as `MERV_KEY`. The URL is your Merv's `/mcp` address, shown beside the key.

- **Claude Code:** `export MERV_URL=https://<your-merv>/mcp`, then `claude plugin marketplace add ./clients` and `claude plugin install merv@merv` (or `claude --plugin-dir clients/claude-code` for one session).
- **Codex:** set `url` in `clients/codex/.mcp.json` to your Merv's `/mcp`, then `codex plugin marketplace add ./clients` and `codex plugin add merv@merv`. Codex sends `MERV_KEY` as the bearer token.

Edit a skill in `claude-code/skills/` and copy it to `codex/skills/`; the test fails while they differ.
