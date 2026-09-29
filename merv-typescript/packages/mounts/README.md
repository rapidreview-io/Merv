# Mounts

Mounts owns upstream MCP discovery and connections. API owns the downstream HTTP/MCP transport and tool registry; Mounts consumes that registry through the public `@merv/api/types` contract. Scope supplies caller tool policy through `scope.toolPolicy`. Mounts owns server-side credential selection in its internal `credentials.ts` module. Its only Cordis dependencies are Tools and Scope.

The public `@merv/mounts/types` contract defines `Context.mounts`, `Mounts`, `MountConfig`, `MountsConfig`, and `MountStatus`. `status()` reports each mount's ID, endpoint origin, state, published tool count, and an optional error code. Status never includes endpoint paths, query strings, headers, or credentials. `reconnect(id)` waits for a new forced discovery attempt for a configured mount. It queues behind an active refresh and rejects if the mount stops before that attempt.

Configuration explicitly selects raw upstream tool names:

```json
{
  "bindings": [
    {
      "id": "research-example",
      "actorId": "actor_example",
      "projectId": "project_example",
      "mountId": "research",
      "secretRef": "env:MERV_RESEARCH_TOKEN"
    }
  ],
  "mounts": [
    {
      "id": "research",
      "url": "http://127.0.0.1:4000/mcp",
      "tools": ["search", "paper.get"],
      "discovery": {
        "actorId": "actor_example",
        "projectId": "project_example"
      },
      "timeoutMs": 5000,
      "reconnectMs": 5000
    }
  ]
}
```

The plugin configuration defaults to empty `mounts` and `bindings` arrays; the application default list does not install this optional plugin. Tool selection does not grant access: individual callers still need exact Scope tool grants and matching upstream credential bindings. Discovery can use the optional local identity; each invocation uses the calling actor's own binding. Credential bindings live in this same configuration; secret values remain in the server environment.

Discovery, invocation, and notification requests refuse HTTP redirects. Configure the final MCP endpoint directly: a redirect does not authorize forwarding tool arguments, selector headers, or MCP session headers to another destination.

The following helper modules now belong to this package:

- `@merv/mounts/remote-catalog` exports `collectRemoteCatalog`. Collection keeps only the selected names, stops once it has found them all, bounds each page by the request timeout and a whole collection by 20 pages, and returns upstream descriptions without handlers; each mount attaches a handler that routes every call through its scoped pool. Catalog replacement validates a complete generation before publication, and catalog disposal withdraws tools before waiting for admitted calls.
- `@merv/mounts/upstream` exports `Invocations`. One pool serves one mount endpoint and keeps one connection per caller (project, actor), carrying the binding selected for that caller; connections are never shared across actors, even when two bindings use the same secret. The registry admits every call immediately before its handler, so a call on a connected lane goes straight upstream. A call that waited (binding selection or connection setup) re-checks the caller's grant, and a session's arguments, first. A connection ends after five idle minutes. Closing the pool refuses new calls and ends every connection. Ending a connection sends the MCP DELETE, capped at one second, before closing it.

These helpers contain upstream SDK transport ownership, while the public types module remains free of runtime code.

A configured mount refreshes its catalog when notified and by bounded polling. A failed connection or unusable selected catalog withdraws its tools; exponential backoff is capped at 60 seconds. Successful polling uses `reconnectMs`; `timeoutMs` bounds connection, catalog, call, and cleanup operations. Invocation connections open no notification stream. Discovery's notification stream stays open until lifecycle cancellation so catalog notifications are not lost at each request deadline. No remote operation is retried. Discovery lists metadata only and needs no tool grants. Each round first requires the discovery actor to read the project, so a removed actor fails the next round and its discovery session ends. The discovery credential is resolved once per discovery connection; a rotated discovery secret applies to the next one.

Shutdown starts withdrawal for every namespace synchronously, including when another plugin is still draining a call to Mounts' status service. Admitted calls finish before invocation clients close. All client cleanups are attempted; failures produce fixed error codes. The upstream Cordis loader may log rather than propagate disposer failures, so use the direct manager result/status when diagnosing cleanup errors.

Run `npm run test:mounts` for fixture regressions and `npm run test:mount-unload` for a whole-application removal report. The latter loads this package through application configuration, forwards an authenticated upstream call, removes the loader entry while that call is held, completes native task/review/feed work, and restores the same configured mount with a fresh connection. This is controlled integration evidence; authenticated real sandbox evidence is a separate gate.

Mounted tools are published as `_<mountId>.<upstreamToolName>`; Nisa `qa.ask`
becomes `_nisa.qa.ask`. Tool selection and grants still use raw upstream names.
The mount ID comes from configuration; dots in an upstream name are preserved.

## Credential ownership and migration

Remove the old `@merv/credentials` plugin entry and move its `config.bindings` into the `@merv/mounts` entry’s `config.bindings`, alongside `config.mounts`. There is no `ctx.credentials` service. Reload the Mounts entry to apply binding changes; unload withdraws catalogs and drains admitted calls before closing connections. Scope grants stay in Scope.

The internal `Bindings` selects the exact project/actor/mount binding; the registry, not the selection, authorizes the caller. Agent sessions use their authority actor's binding. The secret is read from `env:NAME` once per connection and handed only to that connection's transport; known local Merv credentials are rejected, including revoked or rotated credentials. Bindings accept only fixed nonsecret selector headers. Missing or invalid credentials produce sanitized errors. Upstream tokens never become agent-facing tool results. This move adds no OAuth flow or automatic token refresh.

Bindings are fixed for each load of the Mounts entry. A secret rotated in the environment applies to the next connection, after an idle close or a reload of the entry.
