# Access

`accessPlugin` provides `Context.access` and depends only on Scope. Its strict configuration defaults to `{ "grants": [] }`, which denies every remote tool. Public types live in `@merv/access/types`.

Each grant names one project, actor, mount, and an explicit array of raw remote tool names:

```json
{
  "grants": [
    {
      "projectId": "project_example",
      "actorId": "actor_example",
      "mountId": "research",
      "tools": ["search", "paper.get"]
    }
  ]
}
```

Matching is exact and case-sensitive. Tool names have no `mount__` prefix added by this policy and no wildcard expansion. Multiple entries combine their explicit tools. An empty tools array grants nothing. Operators and readers need the same explicit grants; roles and remote annotations such as `readOnlyHint` never create authority.

`allows(caller, mountId, toolName)` returns false for an ungranted tool or a caller that Scope rejects with an authentication or access error. Other Scope failures propagate. `require` checks the same current Scope and grant state, throwing `tool_forbidden` (HTTP 403) for a missing grant. Scope remains responsible for rejecting revoked actors and cross-project callers on every check.

`replace(grants)` is trusted in-process configuration administration. It validates and copies the whole replacement before publishing it, so invalid input leaves the previous policy intact and later mutation of input arrays has no effect. Removed grants stop authorizing the next check immediately. The service exposes no HTTP management tool and does not change an actor's ordinary Merv permissions.

Grants remain in memory. Reinstalling the plugin starts from its supplied configuration. This component does not own credentials, accounts, OAuth, sessions, persistence, remote catalogs, or transports.
