# Merv TypeScript implementation

Scope: nine independent Cordis component packages, durable task/evidence/review loop, project feed, HTTP and MCP, live tests by fresh Codex processes, and feed removal during an active MCP call. Existing Python code is untouched. No UI or automatic runner is required in this slice.

Shared contracts live in `packages/contracts`. Components import sibling interfaces only from contracts; bootstrap alone imports concrete plugins. Feature adapters are owned by their component and inject `tools` plus their own service. Core services never require the tool registry. Synchronous SQLite transactions are explicitly passed across component interfaces when a task transition and review verdict must commit together. Runtime unload never deletes durable records.

Validation must cover real SQLite persistence/restart, migrations, immutable bytes, cross-project authorization, review independence and snapshot pinning, workflow versioning and request deduplication, atomic task/review routing, registry disposal, HTTP/MCP clients, and fresh Codex producer/reviewer sessions.

Feed depends only on state, scope, and artifacts. No other domain service depends on feed. Its optional adapter owns four tools and waits for admitted calls when disposed. Removing the provider must let Cordis suspend the adapter automatically, without restarting unrelated services; reinstalling the provider must reactivate that same adapter and expose retained posts and activity. The repeatable acceptance scenario uses real HTTP/MCP and one explicit handler barrier to guarantee overlap with disposal.
