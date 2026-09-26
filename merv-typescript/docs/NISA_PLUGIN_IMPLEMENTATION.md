# Nisa-owned MCP plugin

History: this page records the Nisa-owned MCP route through generic Mounts, as
verified locally on 2026-09-14. Since 2026-09-26 the supported route is the
native `@merv/nisa` plugin over Nisa's public `/api/sdk` routes, which reaches
Pi and every worker: see [Nisa literature search](NISA_PLUGIN.md).

The six-tool plugin is implemented and verified through real local HTTP/MCP:
`search`, `paper`, `excerpts`, `qa.ask`, `qa.get`, and `qa.cancel`. Account/quota
inspection and collection tools are excluded.

Nisa owns retrieval, authentication, Q&A admission/execution and durable results.
Merv uses generic Cordis Mounts with exact project/actor tool grants and credential
bindings. No new Nisa-specific provider was added to Merv. The old two-tool REST
adapter was removed on 2026-09-14 after repeating the local cross-repository
verification. See [configuration and migration](NISA_PLUGIN.md).

```
Merv: Scope (tool policy) -> Tools -> generic Mounts (upstream credentials)
                                                |
                                    Nisa MCP (six tools)
                                                |
                              authenticated Nisa plugin API
                                  /                  \
                 metadata + Tantivy             durable Q&A ledger
                                                      |
                                             restricted research agent
```

The Nisa work is on `codex/nisa-mcp-plugin` in `/private/tmp/nisa-mcp-plugin`,
based on `3489d7d`; its canonical main checkout is unchanged. Merv changes are on
`codex/cordis-stack`. The runnable Nisa setup and configuration are documented in
`project/mcp/README.md` and `project/backend/plugin_api/README.md` in that checkout.

## Verified behavior

The [saved integration report](../verification/nisa-plugin-integration.json)
records the original **33 -> 27 -> 33 tools**. With the four workflow tools retired,
the current scenario verifies **29 -> 23 -> 29 tools**, recorded in the
[workflow-tool removal check](../verification/workflow-tools-removal.json). Merv removed only Nisa's mount while an accepted
Q&A operation stayed running on Nisa. A native task, evidence delivery, independent
review and feed activity completed during its absence; sandbox clients and
unrelated Cordis providers kept the same instances. Reattachment returned the
same complete answer, sources and usage. Instrumented runner entries prove the
question did not run again. Cross-account reads/cancels, quota denial and an
independent cancellation were also exercised.

Original 2026-09-13 validation: **174 Python tests, 13 Nisa MCP tests and 193 Merv checks**, all
passing with no skips. Typechecks, Merv build, formatting and boundary checks
pass. The full Merv suite was run with the Nisa checkout enabled; the optional
cross-repository test skips explicitly only when that checkout is not provided.

After the 2026-09-14 REST removal, the full Merv suite passed **171 checks with
zero skips**; Nisa MCP again passed **13 tests** and typecheck. Merv typecheck,
build and formatting also passed. [Removal verification](../verification/nisa-rest-removal.json).

The actual agent-core loop was tested separately with simulated model providers.
The cross-repository scenario uses synthetic identities, corpus/index and model
execution behind the actual API, operation ledger and MCP servers. Neither test
is a real-model or deployed-service proof.

## Review and run

The approved Claude Fable review completed against the exact frozen five-file
packet. It found concrete storage/result issues, which were corrected with
regressions and independent local review. [Findings and dispositions](reviews/nisa-plugin-fable-2026-09-13.md)
distinguish the reviewed snapshot from later fixes; no second Fable review or
blanket approval of the final code is claimed. The prior approval blocks are
resolved; no saved credential was read or sent to test the implementation.

From `merv-typescript`, using a Nisa checkout with `project/mcp` dependencies
installed and a Python interpreter with the backend dependencies:

```sh
MERV_NISA_CHECKOUT=/absolute/Nisa-checkout \
MERV_NISA_PYTHON=/absolute/python \
npm run test:nisa-mcp
```

Trusted controls are `app.ctx.mounts.setEnabled('nisa', false)` and `true`.
Disabling withdraws new local calls, drains admitted transport calls, and leaves
accepted Nisa-owned research running. Explicit `qa.cancel` is a separate action.

## Deployment limits

- Shared login remains a rollout step. Current Merv actor tokens are not Nisa
  tokens; explicit bindings use a Nisa-verified account and may pin its subject.
- The operation database and lease files require persistent local storage on one
  host. This is not a distributed scheduler. Dead work becomes interrupted or
  uncertain and is never automatically replayed.
- Signed-in allowance defaults to unlimited, matching current Nisa. An injected
  finite account/period policy is enforced for this plugin channel only. Legacy
  chat must share admission before claiming a product-wide finite limit.
  Anonymous users are rejected through the plugin.
- Evidence and answer limits preserve ordinary records fully. Oversized results
  stop new reads, drain admitted reads, and expose explicit omission/digest and
  completeness markers. The 4 MiB default limit applies to the backend HTTP
  response; the MCP wire message also includes a text copy and can be larger.
- The production Nisa domain has not been deployed with these routes by this
  task. Real service/model verification remains open; the original Step 7 REST
  harness is retired with its adapter. No production sandbox operation was invoked.
