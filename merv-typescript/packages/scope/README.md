# Scope

Scope owns project membership, actors, local credentials, delegation and permissions. Its `toolPolicy` module also owns exact remote-tool grants; session tool enforcement registers with the tool registry instead. Scope injects only State; it does not depend on Sessions, Tools, API or Mounts.

## Tool policy

Configure grants on the existing Scope entry:

```json
{
  "id": "scope",
  "name": "@merv/scope",
  "config": {
    "grants": [
      {
        "projectId": "project_example",
        "actorId": "actor_example",
        "mountId": "research",
        "tools": ["search", "paper.get"]
      }
    ]
  }
}
```

Grants default to an empty list. Each exact project/actor/mount/tool combination must be granted, including for operators. Tool names are the raw upstream names, before the mounted prefix is applied; wildcards and role-derived grants are not supported. Grants neither create credentials nor change local project permissions.

`scope.toolPolicy.require()` checks current Scope authority and the grant; `allows()` returns false for ordinary authentication or permission failures and propagates infrastructure errors. Session callers resolve through their current delegation owner. Revocation and membership changes are checked again on later calls.

Trusted application code can call `scope.toolPolicy.replace(grants)`. Replacement validates and copies the full input before publishing it, so malformed or subsequently mutated inputs cannot change the active grants. Grants remain configuration-backed in memory; reinstalling Scope restores its configured grants rather than runtime replacements.

Session tool calls are admitted by the Sessions provider through the tool registry (`ctx.tools.registerSessionPolicy()`), not through `toolPolicy`. Scope keeps only its session authority slot (`registerSessionAuthority()`), which lets worker actors resolve without a Scope-to-Sessions dependency.

`ToolPolicy` and `ToolGrant` are public types in `@merv/contracts`. The implementation stays in `src/tool-policy.ts` alongside Scope's other internal modules.

## Migration from the Access plugin

Remove the `@merv/access` configuration entry and move its `config.grants` onto the existing `@merv/scope` entry. Consumers inject `scope` and use `ctx.scope.toolPolicy`; there is no separate `Context.access` service. Import policy types from `@merv/contracts`. Credentials and Identity remain separate plugins.
