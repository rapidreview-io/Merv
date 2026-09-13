# Mounts

Mounts owns upstream MCP discovery and connections. API owns the downstream HTTP/MCP transport and tool registry; Mounts consumes that registry through the public `@merv/api/types` contract. Access and Credentials independently supply caller grants and server-side credential selection.

The public `@merv/mounts/types` contract defines `Context.mounts`, `Mounts`, `MountConfig`, `MountsConfig`, and `MountStatus`. `status()` reports each mount's ID, endpoint origin, state, published tool count, and an optional error code. Status never includes endpoint paths, query strings, headers, or credentials. `reconnect(id)` waits for a new forced discovery attempt for a configured mount. It queues behind an active refresh and rejects if the mount stops before that attempt.

Configuration explicitly selects raw upstream tool names:

```json
{
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

The plugin configuration defaults to an empty `mounts` array; the application default list does not install this optional plugin. Tool selection does not grant access: individual callers still need exact Access grants and matching Credentials bindings. Discovery can use the optional local identity; invocation resolves the actual caller's credentials. Credentials remain references in the separate Credentials configuration.

The following helper modules now belong to this package:

- `@merv/mounts/remote-catalog` exports `collectRemoteCatalog` and `RemoteCatalog`. Collection is bounded by page, tool, and time limits. Catalog replacement validates a complete generation before publication, and controller shutdown withdraws tools before waiting for admitted calls. The controller owns its client's `tools/list_changed` handler.
- `@merv/mounts/credential-client` exports `ScopedRemoteClients`. The pool isolates connections by mount, endpoint, actor, project, and credential identity. It rechecks grants and credentials after connection setup, retires changed identities, and drains admitted calls during shutdown.

These helpers were relocated from API without changing their tool transport behavior. Pool shutdown also retains earlier retirement cleanup failures so a later close cannot incorrectly report success. They contain upstream SDK transport ownership, while the public types module remains free of runtime code.

A configured mount refreshes its catalog when notified and by bounded polling. A failed connection or unusable selected catalog withdraws its tools; exponential backoff is capped at 60 seconds. Successful polling uses `reconnectMs`; `timeoutMs` bounds connection, catalog, call, and cleanup operations. Opening the notification GET is bounded, but an established stream stays open until lifecycle cancellation so catalog notifications are not lost at each request deadline. No remote operation is retried. Discovery checks current grants and credentials before and after asynchronous work. A configured discovery credential that changes causes a new discovery connection.

Shutdown starts withdrawal for every namespace synchronously, including when another plugin is still draining a call to Mounts' status service. Admitted calls finish before invocation clients close. All client cleanups are attempted; failures produce fixed error codes. The upstream Cordis loader may log rather than propagate disposer failures, so use the direct manager result/status when diagnosing cleanup errors.

Run `npm run test:mounts` for fixture regressions and `npm run test:mount-unload` for a whole-application removal report. The latter loads this package through application configuration, forwards an authenticated upstream call, removes the loader entry while that call is held, completes native task/review/feed work, and restores the same configured mount with a fresh connection. This is controlled integration evidence; authenticated real sandbox evidence is a separate gate.
