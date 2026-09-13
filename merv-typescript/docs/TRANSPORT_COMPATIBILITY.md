# MCP transport compatibility

Checked 2026-09-13 during execution-plan step 4. These observations distinguish
running software from declared support. Public discovery does not establish
authorization to invoke resource tools.

## Compatibility matrix

| Participant                                 | Version                                                                               | Protocol evidence                                                                                                                                             | Status                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Installed TypeScript SDK                    | `@modelcontextprotocol/sdk@1.30.0`                                                    | Runtime exports declare `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and `2024-10-07`; latest is `2025-11-25`.                                     | Executed version inspection; real remote connection tested below.                                            |
| Merv TypeScript `/mcp`                      | Workspace using SDK `1.30.0`                                                          | Uses the SDK's legacy Streamable HTTP transport. The application rejects unsupported version headers/envelopes instead of treating them as supported traffic. | SDK integration, protocol tests, and a real Codex task/review run passed; the agent negotiated `2025-06-18`. |
| Intended remote service                     | `https://sandboxes.rapidreview.io/mcp`, identifies itself as `merv-sandboxes@1.0.0a0` | Legacy `initialize` negotiated `2025-11-25`. A separate `2026-07-28` `server/discover` request also succeeded.                                                | Both public protocol probes executed successfully; the service is not modern-only.                           |
| Installed SDK client → real sandbox service | SDK `1.30.0`                                                                          | `initialize`, `notifications/initialized`, and `tools/list` completed over `2025-11-25`; subsequent HTTP requests carried that header.                        | Executed; 31 tools returned, no `nextCursor`. No resource tool invoked.                                      |
| Installed target agent                      | `codex-cli 0.155.0-alpha.2`                                                           | All three live agent phases offered and negotiated `2025-06-18`, then sent that version header on requests.                                                   | Wire-tested: producer, independent reviewer, and observer exited successfully across application restarts.   |
| Official TypeScript SDK v2                  | `@modelcontextprotocol/client`, `server`, `core`, and `node`: `2.0.0`                 | Official documentation describes modern and legacy operation; npm metadata requires Node `>=20`.                                                              | Metadata and official source inspected. These packages were not installed or exercised in this step.         |

The public-service observations are retained in
[transport-discovery-2026-09-13.json](transport-discovery-2026-09-13.json).
The protocol recorder in [protocol-proxy.ts](../scripts/protocol-proxy.ts) forwards
to a loopback origin and records only RPC method, protocol identifiers, client
name/version, HTTP status, negotiated version, and header names. Recorded observations
exclude bearer values, tool arguments, and tool results. Its JSON/SSE preservation and
secret-exclusion checks are in [protocol-proxy.test.ts](../tests/protocol-proxy.test.ts).

## Version behavior and the smallest adaptation

The installed SDK's `Server._oninitialize` selects the requested supported legacy
version, otherwise offers `2025-11-25`. Its HTTP transport rejects an unsupported
`MCP-Protocol-Version` with HTTP 400; its client rejects an initialization result
containing an unsupported version. The application's explicit guard also checks
the modern envelope's version, which SDK v1 does not implement. An unsupported
request must not dispatch a tool merely because its JSON-RPC shape resembles an
older request. See [protocol.ts](../packages/api/src/protocol.ts) and its tests.

Keep SDK v1 for this connection: a working `2025-11-25` overlap was observed with
the real target. This is a verified compatibility choice, not an assertion that
Merv supports the 2026 protocol. Reject newer-only traffic explicitly and keep
future adaptation inside the API/client transport boundary.

If a future required peer is modern-only, migrate the affected transport using
official SDK v2. Its client requires explicit `versionNegotiation: { mode: 'auto' }`
or a modern pin; ordinary construction remains legacy. Its `createMcpHandler`
entry can serve both eras, while a plain legacy Streamable HTTP transport cannot.
The migration includes discovery, per-request envelopes, routing headers, result
codecs, subscriptions, and cache semantics. Changing a version string or merely
installing v2 does not supply these behaviors.
[Official protocol migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

The v1 maintenance branch targets the November 2025 specification; modern
revision implementation belongs to v2. The released 2026 specification introduces
a stateless core, multi-round-trip requests, and cacheable catalogs.
[SDK roadmap](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/ROADMAP.md),
[2026 specification announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).
The v2 package split and migration surface are documented separately; production
client, server, schema, and Node adapter dependencies should match actual imports.
[SDK package migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md).

## Sandbox endpoint and authority

The documented service origin is
[sandboxes.rapidreview.io](https://sandboxes.rapidreview.io), also referenced in
[the existing Merv deployment guide](../../merv/deploy/README.md). The independent
local sandbox checkout at revision `c7b9582` mounts exactly `/mcp` in
`control/src/merv_sandboxes/api/app.py`. Its dependency declaration requires
`mcp>=2.1,<3`; the inspected environment contains Python `mcp` and `mcp-types`
`2.1.1`. That SDK routes both legacy handshake traffic and modern requests.

In `control/src/merv_sandboxes/mcp_server.py`, each resource tool calls
`principal_for`: it extracts `Authorization: Bearer …`, plus optional
`X-Sandbox-Namespace` and `X-Sandbox-Subject`, and authenticates through the same
token service as REST. The service's test source asserts 31 catalog entries and
an MCP tool error for a bad token; those service tests were inspected, not run.
The 31-entry count was independently observed from the deployed catalog.

The existing Merv REST adapter keeps per-project upstream consumer grants,
validates `/v1/auth/me`, and forwards the namespace and subject selectors. This
establishes the existing REST contract; it does not prove that any particular
stored credential is accepted by the deployed MCP endpoint. No credentials were
read and no authenticated resource call was made for this compatibility check.
[Integration contract](../../merv/docs/INFRASTRUCTURE_INTEGRATION_CONTRACT.md),
[REST client implementation](../../merv/src/merv/brain/infrastructure/client.py).

## Agent verification and remaining limits

Official OpenAI documentation confirms local Codex Streamable HTTP, bearer-token,
and OAuth support, including `bearer_token_env_var`. It does not provide an exact
protocol-version matrix for this installed binary.
[Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The [sanitized live-agent report](../verification/step-04-live-agents.json) records
three successful phases using `2025-06-18`: 28 native MCP calls, 25 successes, and
three expected authorization refusals, with independent review and retained
evidence verified across two application restarts. Modern vocabulary in the
installed binary does not establish that this run used the modern protocol.

The remote schema audit compiled 61 of 62 advertised schemas: all 31 outputs and
30 inputs. `workflow_submit` input fails with `invalid_schema` because the strict
validator does not support its `discriminator` keyword. A whole-catalog import
would therefore reject atomically; select supported tools before publication.
The planned read-only subset can exclude this mutating tool. No catalog was
registered by the audit.

The public remote catalog returned one page. This is not a pagination or live
catalog-refresh test; controlled fixture tests must cover those paths. Public
discovery also does not verify upstream grant selection, revocation, resource
authorization, or every schema/result shape. Those remain separate integration
checks in the execution plan.
