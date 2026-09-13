# @merv/credentials

An independent Cordis credential provider. It injects only `scope` and exposes no HTTP or MCP operations. Public interfaces live in `@merv/credentials/types`.

Configure `credentialsPlugin` with `{ bindings: [...] }`; the default is an empty list. Each binding selects exactly one project, actor, and mount:

```ts
{
  id: 'sandbox-alice',
  projectId: 'project_example',
  actorId: 'actor_alice',
  mountId: 'sandboxes',
  secretRef: 'env:MERV_SANDBOX_ALICE_TOKEN',
  headers: { 'x-namespace': 'project-example', 'x-subject': 'alice' },
}
```

The environment variable must contain an upstream-issued bearer token. `resolve(caller, mountId)` checks current Scope authorization and the exact binding, then reads the environment variable anew. There are no wildcards, role-based credentials, or inherited operator authority. `replace(bindings)` atomically validates and replaces the complete configuration; removing a binding denies subsequent resolution immediately. This method is for trusted in-process configuration administration.

The returned immutable snapshot exposes an opaque `identityKey`. Its hash includes the project, actor, mount, binding, normalized selectors, and current secret, so identity changes and secret rotation select a new connection. JSON serialization and Node inspection expose only that key. The bearer and selectors are held in a JavaScript private field; only an explicit `headers()` call returns them. Server code must resolve again before each new invocation and must not log or return those headers. Existing snapshots represent already resolved authority.

Only `env:NAME` references are accepted. Raw authorization, cookie, transport/protocol headers, and sensitive `x-*` header names are rejected. Optional headers are fixed nonsecret `x-*` selectors with printable ASCII values; authentication prefixes and secret references are rejected there. Operators remain responsible for keeping ordinary selector values nonsecret. Header names normalize to lowercase and case-insensitive duplicates are rejected.

An active local Merv bearer token is rejected if accidentally configured as an upstream token. This check does not establish issuance of an unknown or revoked token. Inbound request credentials are never an input to this provider. Missing, malformed, or revoked selections return fixed error messages without secret values.
