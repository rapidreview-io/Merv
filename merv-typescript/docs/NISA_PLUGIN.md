# Nisa through generic MCP Mounts

Merv connects to Nisa's six-tool MCP server through `@merv/mounts`. Nisa owns
its tool schemas, authentication, retrieval and durable Q&A operations. The
Merv-specific two-tool REST adapter (`@merv/nisa`) was removed on 2026-09-14
after repeating the cross-repository local integration test and Nisa MCP tests.
Production deployment and real service/model verification remain open.

## Configure the integration

Run a Nisa checkout containing `project/mcp` and the authenticated plugin API.
The MCP listener defaults to `http://127.0.0.1:8091/mcp`; its backend must have
`NISA_PLUGIN_ENABLED=1`. Consult `project/mcp/README.md` and
`project/backend/plugin_api/README.md` in that Nisa checkout for server setup,
persistent Q&A storage and model configuration.

Add this entry alongside Merv's existing native providers. If Mounts already
exists for Sandboxes, add the Nisa item to its `config.mounts` array; do not add
a second Mounts provider.

```json
{
  "id": "mounts",
  "name": "@merv/mounts",
  "required": false,
  "config": {
    "mounts": [
      {
        "id": "nisa",
        "url": "http://127.0.0.1:8091/mcp",
        "tools": ["search", "paper", "excerpts", "qa.ask", "qa.get", "qa.cancel"],
        "discovery": {
          "projectId": "PROJECT_ID",
          "actorId": "DISCOVERY_ACTOR_ID"
        }
      }
    ]
  }
}
```

Nisa authenticates discovery as well as calls. Give the discovery actor and
every invoking actor explicit Access grants for the selected raw tool names and
an exact upstream credential binding. Add entries to the Scope and Mounts
providers rather than duplicating those plugins. Example entries for one actor:

```json
{
  "grant": {
    "projectId": "PROJECT_ID",
    "actorId": "ACTOR_ID",
    "mountId": "nisa",
    "tools": ["search", "paper", "excerpts", "qa.ask", "qa.get", "qa.cancel"]
  },
  "binding": {
    "id": "nisa-actor",
    "projectId": "PROJECT_ID",
    "actorId": "ACTOR_ID",
    "mountId": "nisa",
    "secretRef": "env:NISA_ACTOR_KEY",
    "headers": { "x-nisa-account-id": "VERIFIED_NISA_ACCOUNT_ID" }
  }
}
```

Place `grant` in Scope's `config.grants` and `binding` in Mounts'
`config.bindings`. Use that actor's Nisa credential in the referenced server
environment variable. The optional account header asserts the verified Nisa
identity; it cannot grant authority. Shared Merv–Nisa login is still a rollout
step. Merv actor tokens are not Nisa tokens.

## Migrate an older configuration

1. Remove the plugin entry whose `name` is `@merv/nisa`.
2. Configure the Nisa MCP mount above, retaining mount ID `nisa` if desired.
3. Configure authenticated discovery and review each actor's grants/binding.
   Existing search/paper grants do not grant excerpts or Q&A automatically.
4. Rediscover the tool catalog and update callers for Nisa's published schemas
   and `_<mountId>.<toolName>` naming. Old `mount__nisa__*` names are no longer supported.
   With the same mount ID, names `_nisa.search` and `_nisa.paper`
   are published in the new underscore/dot format; their argument/result contracts are not assumed identical to the
   removed REST adapter. Mounts forwards Nisa's MCP results without the old
   Merv-specific REST translation.
5. Replace any `app.ctx.nisa` lifecycle controls with the mount controls below.

```ts
await app.ctx.mounts.setEnabled('nisa', false);
await app.ctx.mounts.setEnabled('nisa', true);
```

Disabling removes the six local tools and drains admitted transport calls.
Accepted research remains owned by Nisa, and reconnecting can retrieve the same
result without rerunning it. Use `qa.cancel` for explicit operation cancellation.
Account/quota inspection and collection tools are not exposed.

## Verify locally

From `merv-typescript`, with Nisa's MCP dependencies installed and Python backend
dependencies available:

```sh
MERV_NISA_CHECKOUT=/absolute/Nisa-checkout \
MERV_NISA_PYTHON=/absolute/python-with-Nisa-dependencies \
npm run test:nisa-mcp
```

`npm run test:nisa` runs the same scenario. Both commands require the checkout
and fail if it is missing. The optional test in `npm test` skips explicitly
unless `MERV_NISA_CHECKOUT` is provided; include it to verify the full stack.

The scenario starts the actual Nisa API/operation service and MCP server with
synthetic identity, corpus and model providers. It checks six-tool discovery,
search/paper/excerpts, Q&A, account isolation, quota denial, cancellation and
33 → 27 → 33 tools in the explicit configuration with the browser layer during mount removal/restoration. Native task/review/feed
work and the same sandbox fixture connection continue; the accepted question
returns the same answer and does not run twice.

This proves local integration, not deployment or real-model success. The retired
REST live harness is no longer used. Historical Step 7 reports and Fable review
records remain preserved, with their original scope and outcomes. See
[implementation and limits](NISA_PLUGIN_IMPLEMENTATION.md) and
[verification history](../verification/README.md).
