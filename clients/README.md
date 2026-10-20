# Merv client plugins

Connect first: tell your agent _Connect to Merv using https://<your-merv>/connect_. That page has
the agent install Merv's connector, which registers a `merv` MCP server with Claude Code, Codex
and Cursor and signs the machine in with a code Merv emails you; the agent never sees a key.

These plugins add three skills on top (research, operations, acting for the person); they do not
connect. `manifest.json` is the source of truth: name, version, the `/connect` page and skills; a
test in `merv-typescript/tests/client-bundles.test.ts` keeps both bundles matching it and every
tool a skill names registered.

- **Claude Code:** `claude plugin marketplace add ./clients` and `claude plugin install merv@merv`
  (or `claude --plugin-dir clients/claude-code` for one session).
- **Codex:** `codex plugin marketplace add ./clients` and `codex plugin add merv@merv`.

Machines, CI and VMs connect with a key from Settings → Keys instead.

Edit a skill in `claude-code/skills/` and copy it to `codex/skills/`; the test fails while they differ.
