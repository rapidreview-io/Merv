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

The plugin configuration defaults to empty `mounts` and `bindings` arrays; the application default list does not install this optional plugin. Tool selection does not grant access: individual callers still need exact Scope tool grants and matching upstream credential bindings. Discovery can use the optional local identity; invocation resolves the actual caller's credentials. Credential bindings live in this same configuration; secret values remain in the server environment.

Discovery, invocation, and notification requests refuse HTTP redirects. Configure the final MCP endpoint directly: a redirect does not authorize forwarding tool arguments, selector headers, or MCP session headers to another destination.

The following helper modules now belong to this package:

- `@merv/mounts/remote-catalog` exports `collectRemoteCatalog` and `RemoteCatalog`. Collection is bounded by page, tool, and time limits. Catalog replacement validates a complete generation before publication, and controller shutdown withdraws tools before waiting for admitted calls. The controller owns its client's `tools/list_changed` handler.
- `@merv/mounts/credential-client` exports `ScopedRemoteClients`. The pool isolates connections by mount, endpoint, actor, project, and credential identity. It rechecks grants and credentials after connection setup, retires changed identities, and drains admitted calls during shutdown.

These helpers were relocated from API without changing their tool transport behavior. Pool shutdown also retains earlier retirement cleanup failures so a later close cannot incorrectly report success. They contain upstream SDK transport ownership, while the public types module remains free of runtime code.

A configured mount refreshes its catalog when notified and by bounded polling. A failed connection or unusable selected catalog withdraws its tools; exponential backoff is capped at 60 seconds. Successful polling uses `reconnectMs`; `timeoutMs` bounds connection, catalog, call, and cleanup operations. Opening the notification GET is bounded, but an established stream stays open until lifecycle cancellation so catalog notifications are not lost at each request deadline. No remote operation is retried. Discovery checks current grants and credentials before and after asynchronous work. A configured discovery credential that changes causes a new discovery connection.

Shutdown starts withdrawal for every namespace synchronously, including when another plugin is still draining a call to Mounts' status service. Admitted calls finish before invocation clients close. All client cleanups are attempted; failures produce fixed error codes. The upstream Cordis loader may log rather than propagate disposer failures, so use the direct manager result/status when diagnosing cleanup errors.

Run `npm run test:mounts` for fixture regressions and `npm run test:mount-unload` for a whole-application removal report. The latter loads this package through application configuration, forwards an authenticated upstream call, removes the loader entry while that call is held, completes native task/review/feed work, and restores the same configured mount with a fresh connection. This is controlled integration evidence; authenticated real sandbox evidence is a separate gate.

Mounted tools are published as `_<mountId>.<upstreamToolName>`; Nisa `qa.ask`
becomes `_nisa.qa.ask`. Tool selection and grants still use raw upstream names.
The mount ID comes from configuration; dots in an upstream name are preserved.

## Credential ownership and migration

Remove the old `@merv/credentials` plugin entry and move its `config.bindings` into the `@merv/mounts` entry’s `config.bindings`, alongside `config.mounts`. There is no `ctx.credentials` service. Reload the Mounts entry to apply binding changes; unload withdraws catalogs and drains admitted calls before closing connections. Scope grants stay in Scope.

The internal resolver selects exact project/actor/mount bindings and checks current Scope authority. Agent sessions resolve against their authority actor. Secrets are read from `env:NAME` on every resolution; known local Merv credentials are rejected, including revoked or rotated credentials. Bindings accept only fixed nonsecret selector headers. Missing or invalid credentials produce sanitized errors.

Secret snapshots hide headers from JSON and diagnostic inspection. Their opaque identity includes the binding and current secret, so rotation selects a different connection. The client rechecks authority and credential identity after connection setup, before dispatch. Upstream tokens never become agent-facing tool results. This move adds no OAuth flow or automatic token refresh.

Resolution rejects bindings or secrets changed while local-token validation is pending. Environment-backed snapshots also supply a synchronous `assertCurrent()` fence, checked after the final policy await and at the HTTP transport boundary, including discovery. Custom mutable credential providers can supply the same optional fence. Equivalent binding replacements keep cached connections usable; requests already sent can drain with their original identity.
