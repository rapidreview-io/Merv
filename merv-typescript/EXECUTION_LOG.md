# Execution evidence

The acceptance criteria and ordering are in [EXECUTION_PLAN.md](EXECUTION_PLAN.md). A step is complete only when its gate is verified. The existing Python application is separate from this implementation.

## Current position

- Live reflection reads are implemented. New waves use existing research/read tools,
  omit corpus and paper copies from assignments, and pause new task/experiment creation
  until approval while existing work continues. No new tools, plugins or dependency
  edges. Full regression: 684 passed, zero failed, one optional skip; final targeted
  verification also passed. See [Reflections](docs/REFLECTIONS.md).

- Paper/consolidation responsibility refactor is complete: Paper is a document store,
  scientific reviews own paper updates, and Consolidation consumes retained artifacts
  without Reflections. Full regression: 682 passed, zero failed, one optional skip.
  UI and all 144 dependency edges are verified. See
  [current verification and compatibility](docs/PAPER_WORKFLOW_REFACTOR.md).
  The living-research wave below is the preceding architecture checkpoint.

- The living-research wave is integrated: Paper, Reflections, Consolidation and
  Research use the existing workflow/context/session machinery. Full regression:
  681 passed, zero failed, one optional skip; 39 successful synthetic HTTP calls
  and production-bundle browser acceptance also pass. The independent synthesis
  authority finding is fixed. See [acceptance](docs/LIVING_RESEARCH_VERIFICATION.md)
  and [remaining parity](docs/REMAINING_PARITY.md). The older counts below are
  historical checkpoints, not current missing-feature claims.

- Step 1: complete; clean-checkout installation, tests, CLI, authentication, restart, and cleanup verified.
- Step 2: complete; lifecycle fixes pass the full 60-check suite, feed-removal scenario, and independent review.
- Step 3: complete; upstream loader configuration, replacement, diagnostics, and public plugin contracts verified.
- Step 4: complete; remote catalogs/results, protocol compatibility, full integration checks, and fresh agents verified.
- Step 5: complete; independent Access/Credentials providers and scoped upstream clients pass the integration gate.
- Step 6: complete — controlled lifecycle integration, authorized real-service fresh-agent proof, and Fable consultation are complete; reproduced findings are fixed and all 165 checks pass.
- Step 7: superseded by the locally verified Nisa-owned six-tool MCP integration. The old REST adapter and its live harness were removed on 2026-09-14 after repeating MCP verification. Production deployment and real service/model verification remain open; the historical REST checkpoints below are retained as evidence.
- Later parity waves below integrated the optional browser layer, workflow guidance and assignments, identity/keys, Sessions, dispatch controls, native Runner processes/workspaces, Code proposals, Claims, generic review return paths, production Experiments and corpus references. The new living-research checkpoint above adds the research programs. Central publication and full Python parity remain open.

## Step 1 — reproducible baseline

Branch: `codex/cordis-stack`.

- `5941a55d`: captured the existing Cordis prototype, tests, lockfile, and execution plan as a subtree.
- `3bc7d446`: separately applied formatting, pinned Prettier, declared the development runtime, and protected credential files in custom data directories.
- Existing baseline typecheck and build pass. All **56 checks** pass with loopback permission; the first restricted run could not bind HTTP listeners, and the unrestricted repeat verified all tests rather than skipping them.
- Independent manifest audit found consistent workspace and lockfile entries, relative workspace links, registry tarball integrity metadata, and no private runtime files in the tracked baseline.
- Runtime verified locally: Node 22.13.1, npm 11.1.0, Cordis 4.0.0-rc.10, MCP SDK 1.30.0, TypeScript 5.9.3, tsx 4.23.13, Zod 3.25.76, Prettier 3.9.6.

Independent clean-checkout verification passed at exact commit `3bc7d446b0df36b286542782553f581fe43b5ef3`. A fresh sparse checkout installed 115 packages from the committed lockfile and passed formatting, typecheck, build, and all 56 tests. Documented CLI commands initialized a project and producer/reviewer/reader credentials. Both server starts exposed 26 tools; all four identities authenticated, unauthenticated access was refused, and foreign project scope was denied. A synthetic artifact and its project survived the restart. Both server processes and listeners were confirmed stopped; the checkout remained clean. The second shutdown used SIGTERM and exited successfully.

[Machine-readable baseline report](verification/step-01-baseline.json) records exact commands, statuses, and cleanup evidence without credentials.

## Step 2 — lifecycle repairs

- Failed SQLite initialization now closes the acquired handle before rethrowing the original error. Three regressions first failed against the original constructor, then passed. They exercise a real malformed SQLite schema, verify the captured native handle refuses further use, preserve the original diagnostic if cleanup throws, and verify a failed Cordis provider publishes no service or duplicate cleanup.
- Workflow tools now have independent registration effects. The new HTTP/MCP regression first reproduced the old failure: `workflow.catalog` was withdrawn while `workflow.get`, `workflow.history`, and `workflow.list` still admitted calls. The fixed adapter withdraws all four, waits for the held call, and restores the existing adapter without duplicate tools after provider replacement.
- The workflow test also verifies unchanged unrelated service instances and successful scope/artifact/feed calls. Tasks correctly depend on workflows and are allowed to suspend with them.
- Reviewed all five other tool adapters: scope, artifacts, reviews, tasks, and feed already register independent effects. Resource-owning state, workflows, registry, and HTTP providers retain grouped withdrawal-before-close ordering.
- Formatting, typecheck, build, and all **60 checks** passed. The separate `npm run test:feed-unload` scenario again completed a task and its independent review while feed was absent, with 26 → 22 → 26 tools and retained posts/activity.
- Independent review passed. The reviewer reran all four new checks and independently reproduced the baseline constructor leaving its native handle usable after initialization failure.

[Feed removal report](verification/step-02-feed-unload.json) retains the synthetic integration evidence without credentials.

## Step 3 — upstream loader and configuration

- Pinned `@cordisjs/plugin-loader@1.0.0-rc.7`, compatible with the installed Cordis `4.0.0-rc.10`. The full sixteen-entry composition now comes from validated configuration. `serve --config PATH` resolves relative plugins beside that file and reports safe lifecycle fields without configuration values.
- The upstream loader joins asynchronous tree initialization. Application readiness separately rejects failed or pending required entries, including the upstream case where configuration validation rejects but the fiber still reports `PENDING`. Missing dependencies are reported by capability name. Optional unavailable plugins remain visible without preventing unrelated work.
- A separately configured fixture provider and consumer load without bootstrap edits. Two disable/restore cycles verify current provider handles, dependency reactivation, and resource cleanup. Failed activation releases its resource; malformed plugin configuration fails before resource acquisition.
- Feed owns its public types and Context declaration. Boundary checks permit verified type-only public contract imports while rejecting runtime implementation imports and disguised reexports.
- Both workflow and feed removal scenarios now use the loader's stable entry IDs. All exposed tools withdraw before admitted calls drain. Feed restoration uses a new provider fiber, reactivates its adapter, retains three posts and activity, and restores 26 unique tools after a task and independent review complete during its absence.
- Formatting, typecheck, build, and all **86 checks** passed (78 top-level tests and eight component-boot subtests), with no failures or skips. The separate feed-removal integration also passed. Independent review found no new material correctness issues.
- Configuration changes are administrative in-memory operations; source-file watching is not introduced. Cordis itself currently logs/swallows some disposer exceptions, so these checks do not establish propagation of every possible cleanup failure.

[Loader feed-removal report](verification/step-03-feed-unload.json) records synthetic integration evidence without credentials.

## Step 4 — remote tool transport

- The API plugin owns native and remote tool contracts, catalog ownership, and MCP result types. Native Zod handlers retain their existing behavior. Remote catalogs preserve JSON Schemas, descriptions, annotations, content blocks, structured results, error status, and protocol metadata; local project selection is separate from remote `projectId` arguments.
- Catalog namespaces are deterministic and reserved. Full candidate catalogs validate before publication; replacement withdraws a complete old generation and drains its admitted calls. Disposal tracks all overlapping generations and does not remove a newer mount with the same ID.
- The connected-client catalog helper bounds pages, tool count, collection time, and call time. It rejects duplicate names/cursors, handles upstream catalog notifications serially, cancels collection on close, and preserves the working catalog after an invalid refresh. One controller owns a client's notification handler until it closes.
- Independent real HTTP/SSE fixtures exercise pagination, schema and output validation, multimedia and structured results, errors, project selection, catalog refresh, and held-call withdrawal. Unsupported incoming versions are refused before dispatch, including newer metadata inside a batch. The installed client rejects an incompatible upstream initialization before discovery.
- Actual deployed sandbox discovery negotiated `2025-11-25` with SDK `1.30.0` and returned 31 tools. A separate modern discovery probe also succeeded. Of 62 advertised input/output schemas, 61 compile; mutating `workflow_submit` uses an explicitly unsupported `discriminator` keyword. No resource tool was called or credential read by this probe. The intended first read-only subset has a supported transport/schema path.
- Three fresh Codex processes completed producer, independent reviewer, and reader phases across two application restarts: 28 native MCP calls, 25 successes, three expected permission denials. Wire observations captured `2025-06-18` negotiation in all phases. The review read the exact pinned evidence before submitting its passing verdict; shutdown completed before the report was saved.
- Formatting, typecheck, build, and all **111 checks** passed (103 top-level tests and eight component-boot subtests), with no failures or skips. The unchanged architecture policy passes after moving tool contracts into `@merv/api/types`. The separate feed-removal scenario again passed 26 → 22 → 26 tools and a completed task/review during feed absence. Independent reviews of registry/schema, transport/project selection, and catalog lifecycle passed after correcting notification-handler ownership. No live mount or upstream authority is enabled by this step.

[Compatibility matrix](docs/TRANSPORT_COMPATIBILITY.md), [public endpoint discovery evidence](docs/transport-discovery-2026-09-13.json), and [sanitized live-agent report](verification/step-04-live-agents.json) retain the observations. The default application still installs only its 26 native tools; credential selection, grants, and the live mount are subsequent steps.

[Step 4 feed-removal report](verification/step-04-feed-unload.json) records the final regression demonstration.

## Step 5 — credentials and explicit tool grants

- Added independent `@merv/access` and `@merv/credentials` plugins, each depending only on Scope and owning its public `/types` contract. The full API composition installs eighteen entries; both new providers default to empty configuration. Domain-only default composition and CLI initialization retain their small provider sets.
- Grants name an exact actor, project, mount, and raw remote tool. HTTP and MCP discovery pass the authenticated Caller to the registry; invocation checks current Scope and grants before admission. Operators and `readOnlyHint` gain no implicit remote authority. A registry without a policy denies remote discovery/invocation while retaining native behavior.
- Credential bindings select an exact actor/project/mount and an `env:NAME` secret reference, with optional nonsecret selector headers. Resolution rechecks Scope and current configuration, reads the environment anew, and rejects a recognized active Merv token. Private immutable snapshots expose only an opaque key through JSON/inspection; explicit header access stays server-side.
- The scoped MCP client consumer separates identities, deduplicates same-identity connection setup, checks authority again after asynchronous setup, retires connections on changed/revoked credentials, and drains admitted calls before closing. Connection/call/cleanup have bounds; failed transport errors are sanitized and operations are not retried.
- Real local HTTP/MCP integration verifies two Merv projects reach distinct upstream identities, direct calls to hidden tools are refused, native role checks remain enforced, actor/grant/binding revocation takes effect without restart, and rotation selects a new connection. Focused tests also cover revocation during a held initialize, rotation during a held call, failure cleanup, timeouts, and secret exclusion.
- Formatting, typecheck, build, and all **141 checks** passed (131 top-level tests and ten independent component subtests), with no failures or skips. The separate feed-removal scenario passed again, completing its task/review during feed absence and restoring 26 unique tools with retained posts. Independent reviews found no credential-isolation or access bypass.
- `npm run test:credentials` is the focused runnable integration demonstration. It uses controlled authenticated upstream fixtures; no cloud resource operation was made. Live service mounting follows this gate. Runtime grant/binding replacement is trusted in-process administration; persistence and user-facing session administration remain later steps.

[Step 5 feed-removal report](verification/step-05-feed-unload.json) records the final lifecycle regression. The credential source package is explicitly included in version control while runtime credential directories, credential JSON files, and dependencies remain ignored.

## Step 6 — optional Mounts integration and real sandbox proof

- Added `@merv/mounts`, with public `/types` and exact dependencies on Tools, Credentials, and Access. Upstream catalog/client helpers moved from API to their owning transport plugin; API retains the downstream registry and protocol. Package boundaries allow SDK/HTTP ownership only in API and Mounts while continuing to reject cross-package implementation imports.
- The plugin loads through an additional configuration entry without changing `app.ts`. Every mount selects exact raw tool names before schema compilation. Optional public discovery or a separately configured discovery caller supplies the catalog; invocation always resolves the current actual caller's authority. Revoked/changed discovery credentials are checked before and after asynchronous discovery and cannot publish stale privileged results.
- Catalog notifications, bounded polling, capped reconnect backoff, initialization/call/cleanup bounds, physical connection loss, and explicit reconnection are integrated. Discovery retries never retry a remote operation. Status contains origin and fixed codes without credentials or upstream error text.
- Removal begins every namespace's withdrawal before waiting for any admitted call or dependent status consumer. Held calls drain, then caller/discovery clients close. Independent review identified swallowed cleanup errors; the fix attempts all cleanups and retains failures from earlier retired clients. Regression tests reproduced the previous incorrect success before passing against the fix. Upstream Cordis may still log rather than propagate disposer failures; direct manager errors and status remain the diagnostic evidence.
- The whole application uses the real loader, SQLite, HTTP/MCP, and an independently authenticated fixture: **27 → 26 → 27** tools, one admitted upstream call during removal, new mounted calls refused before upstream dispatch, a completed native task and independent review, and three retained feed posts. Restoration creates a fresh upstream connection without replacing native services or duplicating dispatch. The separate feed-removal scenario also passes **26 → 22 → 26**.
- Public deployed sandbox discovery returns 31 tools. Source inspection selects only `usage_report({})`, with a supported input/output schema and a resource/accounting read path. `providers_list` is excluded because Modal health checks can create an application; `storage_usage` is excluded because it can initialize a storage-account row. Normal token last-use bookkeeping remains part of authenticated access.
- Formatting, typecheck, build, and all **160 checks** passed (150 top-level tests and ten component-boot subtests), with no failures or skips. Eight mocked-fetch harness tests verify offline preparation, exact-origin and one-call limits, scoped result delivery, JSON/SSE preservation, and cancellation without using real credentials or network. Independent review found no remaining concrete defects in the reviewed runtime, scenario, or live harness.
- After the user explicitly approved both pending actions, the live harness passed against the real sandbox service. It made one consumer identity request and exactly one upstream `usage_report({})` dispatch through the actual configured Mounts plugin. A fresh ephemeral Codex session completed that one call and received matching account, namespace, and member data. The host retained only counts and verification booleans. The process exited successfully; application and child shutdown, environment restoration, and removal of the temporary directory were verified. The original rejected attempt sent nothing. [Live sandbox report](verification/step-06-live-sandbox.json).
- The user requested Claude Fable consultation after significant waves and allowed UI delegation to Fable. This preference is recorded in the plan. A pinned `claude-fable-5` review of the Mounts wave was prepared, but automatic approval review rejected sending the specific private source/test packet before the process launched. The user subsequently explicitly authorized the prepared packet; the pinned Fable process completed successfully. It found one medium notification-stream issue and one low reconnect timing issue, both independently reproduced and fixed. A requested partial-constructor cleanup regression was added with corrected catalog-ownership expectations. See the [actual review and disposition](docs/reviews/step-06-fable.md).

[Controlled mount-removal evidence](verification/step-06-controlled-mount-unload.json), [feed regression](verification/step-06-feed-unload.json), and [real sandbox preparation and command](docs/READ_ONLY_SANDBOX_MOUNT.md) separate controlled lifecycle verification from the completed real-service read proof.

- Post-review verification passes formatting, typecheck, build, and **165 checks** (155 top-level plus ten component-boot subtests). Established discovery notification streams now use lifecycle cancellation after a bounded opening handshake. Explicit reconnect promises wait for their own new discovery attempt. Regressions verify both fixes, stop/failure interactions, and preservation of another manager's catalog after partial construction failure. The final controlled removal scenario again passes 27 → 26 → 27. Together with the separately committed live proof, this closes step 6.

## Step 7 — independent Nisa search and paper adapter (historical)

This phase records the now-removed REST adapter and its original gate. Current Nisa integration uses generic MCP Mounts; see the 2026-09-14 removal checkpoint below.

- Verified installed Nisa CLI 0.3.0 and sibling source `Nisa@3489d7d`. The supported direct endpoints are authenticated `POST /api/sdk/search` and public `GET /api/sdk/paper/<arxiv_id>`. No compatible MCP implementation was found in the inspected backend, Rust CLI, and Python SDK source. The adapter uses those REST endpoints directly; search sends literal `enrich: false` to prohibit background agent enrichment.
- Added `@merv/nisa`, requiring only Tools, Access, and Credentials. It owns its public `/types` contract, static search/paper catalog, strict input/configuration schemas, fixed-path HTTP requests, complete-body deadlines, byte limits, and sanitized failures. Both locally exposed tools require exact current grants and credential bindings. Invocation resolves the actual caller's credential each time; no ambient CLI login, connection cache, retries, or generic registry/bootstrap changes are involved.
- Search and paper results retain the complete upstream object under `data` and provide explicit arXiv references in `sources`, identically represented in MCP text and structured content. Independent source review found legacy search IDs with underscores; the regression failed before the fix and now verifies modern, slash, and underscore forms without changing raw records. A second independently reproduced configuration defect allowed a misleading `127.example.com` host; the corrected check requires an actual loopback IP.
- The complete configured application passes **29 → 27 → 29** tools while a real loopback REST search overlaps Nisa removal. Both Nisa tools withdraw before draining. The same authenticated sandbox fixture connection and native providers remain active; a task, independent review, and three feed posts complete during Nisa absence. Reinstallation creates a fresh Nisa provider without duplicate tools. All 15 scenario checks pass. [Controlled report](verification/step-07-controlled-nisa-unload.json).
- All **177 checks** pass (167 top-level plus ten component boot checks). Focused tests cover project/grant isolation, per-call credential rotation and revocation, unsupported arguments, result preservation, redirect refusal, malformed/oversized responses, full-body timeouts, constructor/publication failure cleanup, and strict origin validation.
- The prepared live harness allows exactly one `flash attention` search and one returned-paper lookup through an actual local MCP client, with public sandbox discovery only and no authenticated sandbox tool call. The first attempt stopped on an expired saved OAuth access token before any harness network request. One standard installed-CLI paper preflight, which owns the normal refresh flow, exited 1; its payload was suppressed and not retained. The next harness preflight still found the access token expired. No live Nisa search through Merv has been claimed. [Live preparation status](verification/step-07-live-nisa-preparation.json).
- A concrete 24-file source/test packet was prepared for pinned Claude Fable. Automatic approval review initially rejected submission before launch. The user subsequently replied “Approved”; the exact unchanged packet was submitted once and Fable completed successfully. It found no supported high- or medium-severity defect and recommended three meaningful response-boundary regressions. Its actual feedback and model provenance are recorded in [the completed review](docs/reviews/step-07-fable.md). No replacement reviewer is described as Fable.
- The user requested the current dependency network. [The image](docs/architecture/current-dependencies.png) is rendered deterministically from extracted dependency declarations: 20 plugins, 14 providers, six adapters, and 42 direct edges. Nisa is correctly marked under verification. The corrected PNG was uploaded to the user's My Drive and its MIME type and byte size verified. An earlier generated preview had incorrect arrows and is not the saved architecture artifact.

- During the approved review, an independent local audit reproduced a live-harness guard bypass for prebuilt `Request` objects and non-string POST bodies. The installed SDK currently sends URL-plus-string requests and did not trigger that path. The corrected guard normalizes the effective request, enforces sandbox method/path/RPC limits, refuses redirects at every allowed origin, and preserves one-search/one-paper admission limits across concurrency and failed dispatch. Seven new offline regressions cover this correction. Fable reviewed the frozen pre-correction packet, not this later patch; a separate implementation agent reviewed the final guard.
- Fable's test gaps are covered by rejecting a chunked response without Content-Length after it exceeds the cumulative byte limit, refusing a different valid paper ID, and refusing a non-JSON media type even when its body is otherwise valid JSON. These extend behavior coverage; no production adapter defect was asserted for these three existing guards.
- One separate unauthenticated `HEAD` request to the public sandbox `/mcp` returned 405 with no redirect or Location header. It invoked no tool and sent no credential. The saved Nisa OAuth token remains expired; no new live harness request or CLI refresh was attempted during this approved review turn.

- Final post-review verification passes typecheck, build, formatting, and all **187 checks** (177 top-level plus ten component-boot subtests), with no failures or skips. This includes the complete controlled removal scenario and the ten additional response/harness regressions. [Post-review checkpoint](verification/step-07-post-review.json).

Step 8 has not begun. Step 7 closes only after the real Nisa verification succeeds with a renewed login or explicitly supplied API key.

## Approved Nisa-owned plugin extension — incomplete checkpoint

- The user approved building search, paper, excerpts, Q&A ask/get/cancel. Work is
  isolated in Nisa's `codex/nisa-mcp-plugin` worktree at
  `/private/tmp/nisa-mcp-plugin`, based on `3489d7d`; canonical Nisa main remains
  unchanged. Merv changes remain on `codex/cordis-stack`.
- Implemented Nisa retrieval composition, authenticated plugin API, durable
  same-host operation admission/results, fixed research-tool authority and
  operation-scoped cancellation. Recovery never replays uncertain work. Available
  evidence and usage survive failed/cancelled runs. Actual fork tests reject
  inherited operation ownership while preserving the parent worker.
- Merv now supports trusted per-mount `setEnabled(id, boolean)`. Five new tests
  verify targeted withdrawal/drain/restoration, preservation of independent
  sandbox clients, ordered toggles, shutdown races and cleanup failure handling.
- The final combined Nisa backend run passed **82 tests** (new tests plus 41
  existing retrieval/schema regressions). The six-tool MCP catalog passed **3
  tests** and typecheck. Merv passed **192 checks**, typecheck and build; one
  cross-repository integration test explicitly skips because its actual MCP host
  has not been implemented. That scenario is prepared, not verified.
- Automatic approval review rejected the draft MCP bearer-forwarding code even
  after pinning its production destination to `https://api.rapidreview.io`. The
  exact forwarding behavior is awaiting user authorization; no server/CLI was
  written after rejection and no credential was read or sent. Automatic review
  separately rejected sending a frozen five-file backend packet to Claude Fable;
  exact-packet approval is pending, and no Fable response exists for this wave.
  Later local PID/partial-result fixes are newer than that frozen review packet.
- Changes remain uncommitted pending the required review and integration. No
  full plugin completion, shared-login rollout, product-wide finite quota or
  real-service/model proof is claimed. See [implementation checkpoint](docs/NISA_PLUGIN_IMPLEMENTATION.md)
  and [verification record](verification/nisa-plugin-checkpoint.json).

## Nisa-owned six-tool plugin — implemented and locally verified

- The user explicitly approved both pending actions. The MCP server was then
  implemented with a pinned Nisa destination, fresh bearer verification for each
  request, expected-account checks, strict six-tool schemas, sanitized errors,
  redirect refusal and bounded body/response lifetimes. No saved credential or
  production call was used for the tests.
- The exact approved packet reached **Claude Fable 5** once and its review
  completed successfully. Supported findings were fixed: read-first targeted
  recovery, storage-monitor retry without false cancellation, outcome-preserving
  settlement retries, bounded research evidence/results, source provenance from
  known fields, provider response validation, strict new-plugin inputs, and deep
  pagination within the actual Tantivy 500-row cap. Literal sentinel answers and
  failed acquisition cleanup have regressions. Independent local reviews covered
  the final patches; no second Fable review of the final source is claimed.
- Separate local review found DNS/calendar gaps. DNS now resolves in a bounded,
  reaped startup helper; numeric snapshots keep the original HTTP Host/TLS name
  and one connect/TLS/header/body deadline. Impossible days are rejected at the
  new plugin boundary while legacy date helpers stay compatible. Actual local
  JWT tests verify account identity, expiry, audience and anonymous denial.
- Final combined checks passed: **174 Python**, **13 Nisa MCP**, and **193 Merv**,
  with no failures or skips. Typechecks, Merv build, formatting and architectural
  boundaries pass. The post-review saved integration proves **33 → 27 → 33** tools,
  exactly two runner entries (one completed Alice operation and one cancelled Bob
  operation), a completed native task/delivery/review, two retained feed posts,
  unchanged sandbox clients and complete resource cleanup. Retry/get/reattach
  never ran Alice's question again.
- Nisa source is committed as `0d1ab17` on `codex/nisa-mcp-plugin` in its isolated
  worktree. The canonical main checkout is unchanged. Merv uses its existing
  generic Mounts, extended with per-mount trusted enable/disable; the old REST
  adapter is retained for the current deployment. No further stack wave started.
- Remaining limits are deployment and product scope: shared-login rollout is
  separate, storage is one persistent local host, configured finite quota covers
  only this plugin channel, and real Nisa/model/sandbox proof was not attempted.
  This completes the approved local plugin implementation and controlled
  integration; it does not close the original Step 7 live-service gate.

[Integration evidence](verification/nisa-plugin-integration.json),
[final verification](verification/nisa-plugin-checkpoint.json),
[Fable findings and dispositions](docs/reviews/nisa-plugin-fable-2026-09-13.md), and
[setup and limits](docs/NISA_PLUGIN_IMPLEMENTATION.md) retain the final state.

## Legacy Nisa REST adapter removal — 2026-09-14

- Before deletion, repeated the cross-repository Nisa MCP test with the prepared
  Nisa checkout: **1 passed, zero skips**. Its actual Python API/operation service
  and MCP server verified the six-tool catalog, **33 → 27 → 33** removal cycle,
  durable Q&A without replay, account/quota/cancellation checks, and native work
  plus the same sandbox connections during Nisa's absence. Identity, corpus and
  model providers remained synthetic.
- Nisa's own MCP suite passed **13 tests** and typecheck. The first sandboxed
  attempt could not bind loopback listeners; the permitted repeat passed. No
  production service, saved credential or real model was used.
- Removed `@merv/nisa`, its REST-only tests/fixture and old unload/live scripts,
  lockfile entries and capability declaration. Removed the stale local workspace
  symlink and only generated files belonging to the removed adapter/harness.
  Generic Mounts and the six-tool MCP scenario remain. `test:nisa` now runs that
  scenario and requires an explicit checkout; the old live harness is retired.
- Added migration instructions for authenticated discovery, grants, credential
  bindings and caller schema changes. Regenerated current architecture artifacts:
  **19 plugins, 13 providers, six adapters, 39 dependencies**; 18 entries remain
  in the default configuration. Historical REST reports/reviews remain marked
  as historical records.
- After removal, the full Merv suite with Nisa enabled passed **171 checks, zero
  failures and zero skips**. Typecheck, build, formatting, workspace resolution
  and diff checks passed. This bounded cleanup did not run a new Fable review;
  prior reviews keep their original scope. Production Nisa deployment and real
  service/model verification remain open.

[Removal verification](verification/nisa-rest-removal.json),
[current configuration](docs/NISA_PLUGIN.md), and
[dependency snapshot](docs/architecture/current-dependencies.json).

## Keep Workflows internal — 2026-09-14

- Removed the workflow tool adapter and its default configuration entry. The four
  `workflow.*` tools are no longer discoverable or callable through HTTP/MCP.
  The Workflows service, versioned task program and internal inspection methods
  remain unchanged. Custom configurations must drop `@merv/workflows/tools`.
- Updated live-agent instructions to inspect task status, review records and
  evidence through domain tools. Engine history remains available to the trusted
  in-process verification harness. Removed the adapter's unused Zod dependency
  and stale generated adapter output.
- Adapted the workflow unload regression to hold a task response, verify all six
  task tools withdraw while draining, keep unrelated services available, and
  restore task tools plus durable workflow/task records. The assembled task/review
  test also verifies all four retired names are rejected over HTTP and MCP.
- Current inventory: **22 native tools, 17 default plugins, 18 implemented plugins,
  13 providers, five adapters and 36 dependencies**. Current docs and architecture
  exports reflect this; earlier verification reports retain their original counts.
- Full local suite with Nisa enabled: **171 passed, zero failures/skips**. Typecheck,
  build, formatting and source-to-diagram checks passed. The first run identified
  the old six-adapter expectation in the boundary test; it was updated before the
  successful full repeat. Nisa removal now verifies **29 → 23 → 29 tools**.

[Verification](verification/workflow-tools-removal.json).

## Compact mounted tool names — 2026-09-14

- Mounted names now follow `_<mountId>.<upstreamToolName>`: `_nisa.search`,
  `_nisa.qa.ask` and `_sandbox.usage_report`. The leading underscore is reserved
  for catalogs, and the configured mount ID supplies the plugin prefix. Native
  tools and actor administration behavior are unchanged.
- Remote authority keeps the original mount ID and tool name as explicit metadata
  instead of reconstructing them from the published name. Access grants and
  credential bindings keep their existing raw values. Dots and underscores in
  upstream names are preserved. The full published name retains its 128-character
  bound, and duplicate/invalid catalog entries are still rejected atomically.
- HTTP and MCP recognize the reserved namespace even during withdrawal, preserving
  upstream `projectId` arguments. Old `mount__...` names are absent from discovery
  and rejected when called; clients must rediscover and update saved references.
  Current scripts and documentation use the new format. Historical reports retain
  the names that were actually verified at their original checkpoints.
- Full local suite with Nisa enabled: **172 passed, zero failures or skips**.
  Typecheck, build and formatting pass. Regressions cover exact grant identities,
  dotted/underscored raw names, distinct mounts, old-name refusal through HTTP/MCP,
  and removal while preserving upstream arguments. The real local Nisa API/MCP
  scenario passes all six tools, Q&A, and the **29 → 23 → 29** unload/restore cycle.
  No new production or real-model verification was performed.

[Verification](verification/mounted-tool-names.json).

## Step 8 — browser UI as an optional plugin — 2026-09-14

- Added `@merv/ui`: a `ui` row registry service, a public `/ui` mount on the API
  server, and two read-only tools, `ui.shell` (rows with live status plus the
  loader's plugin table) and `ui.read` (row-owned data). The plugin registers the
  Settings row itself. Six adapters own the other rows: `scope/ui` (People),
  `tasks/ui` (Tasks), `reviews/ui` (Reviews), `artifacts/ui` (Artifacts),
  `feed/ui` (Feed, Activity) and `mounts/ui` (Connections). Each row is registered
  inside a Cordis effect, so it disappears with its feature. All entries are
  optional; the default configuration lists every adapter except `mounts-ui`.
- API changes: `ApiServer.mount(prefix, handler)` for plugin-owned public paths,
  withdrawn by its disposer; the Origin check accepts the server's own origin,
  because browsers send `Origin` on same-origin POSTs. Legacy programmatic
  selection (`api: true`) excludes the browser layer, so existing catalog counts
  hold; `serve` without `--config` now loads `config/default.json`.
- Boundary policy: `ui.ts` adapters are held to the `tools.ts` rules (inject the
  owner and the registry only; no service provision); `ui` is a declared
  capability over `api` and `tools`.
- Browser: React 18 + Vite under `packages/ui/web`, built to `packages/ui/dist`
  (ignored). Sign-in with a local credential; views for tasks, reviews,
  artifacts, feed, activity, people, connections, settings; unknown row kinds
  render an explicit unavailable page. Read-only.
- Verification: `npm run test:ui` passes four tests covering the registry, static
  serving with traversal attempts, same-origin acceptance, per-actor row status,
  feed disable/enable, UI disable/enable with HTTP still serving, the unbuilt
  bundle response and the Connections row against one live and one dead mount.
  Boundary, configuration and CLI tests were updated. Browser checks ran against
  `npm run demo:ui` (seeded project): sign-in, Tasks list, task detail with brief,
  delivery and pinned review, Feed, People forbidden state for a producer,
  Settings plugin table, feed removal and restoration in the sidebar.
- Concurrent work in the same tree (domain events, context builder, review
  claims) was in flight during this step; UI tests compose from
  `config/default.json` so they follow that composition. The architecture
  diagram and its counts were not regenerated here.

## 2026-09-14 — durable recovery and context recipes

Implemented Domain Events (State-backed ordered consumers, atomic handler/progress commits, failure status and retries, replay after unload/restart) and Context Builder (immutable versioned recipes, required-context checks, bounded optional context, source manifests and persisted context packages). Tasks owns its type definitions directly; no context-adapter plugins were added.

Reviews automatically releases revoked actors’ unfinished claims while preserving the evidence snapshot and task revision. Fresh claim IDs fence context, checkpoints and verdicts. Existing open claims migrate to stable legacy claim IDs. `task.context` and `task.checkpoint` are integrated through the existing task tool adapter; review clients now send the claim ID returned by `review.start`.

Recipes cover ordinary work, experiment planning, project reflection and independent review. Replacement context includes recovery cause, saved progress, pinned task background and review evidence. Additional types register recipes directly. Historical packages remain readable after recipe disposal or restart.

Validation: all 185 checks pass (173 top-level tests plus 12 component-boot subtests), with zero failures, cancellations or skips. Typecheck, build, full formatting and whitespace checks pass. The suite includes real loopback HTTP/MCP and the prepared Nisa-owned MCP fixture. Current architecture: 27 plugin entrypoints, including concurrent UI work; 16 providers, five tool adapters, six UI adapters and 56 dependencies. Existing earlier changes were preserved.

No Fable feedback was used. No production service operation or model-agent launch was performed. Runner, work leases and remote cancellation remain separate planned work. [Implementation and usage](docs/RECOVERY_AND_CONTEXT.md) · [Verification record](verification/recovery-context.json).

## 2026-09-14 — Workflow-owned guidance

Implemented the user-approved ownership: Workflows evaluates domain rules
registered by Tasks. Added the single `workflow.status_and_next` tool, project
instance overview and read-only preflight. Delivery, review reissue and verdict
routes use the same guards in their transaction. Reviews exposes shared claim and
submission checks; verdict/transition rollback remains covered.

Task reads and Context Builder's required task input carry the current decision;
the browser renders it in “What happens next”. Added browser-safe guidance types.
The existing graph and recipe versions are unchanged; old command receipts and
saved context remain historical. Program unload withdraws its checks and reports
active stored instances unavailable; engine unload withdraws the guidance tool.

Validation: 187 tests passed with zero skips/failures and the Nisa fixture enabled;
backend build and UI build/typecheck passed. Focused tests cover a custom program,
caller-specific guidance, invalid evidence, changed prerequisites after preflight,
stale revisions/claims, revocation recovery, context inclusion and both terminal
outcomes. HTTP/MCP and the held-call unload scenario include the new tool. Browser
checked two disposable tasks, then the preview was shut down. The live-agent
harness was updated to request guidance; no model-powered agent run was performed
in this slice. No Fable consultation was requested or performed.

Current composition: 25 domain tools (27 with UI); 28 possible plugin entrypoints,
16 service providers, 6 tool adapters, 6 UI adapters and 58 declared dependencies.
Default configuration has 26 entries; API-only selection has 20. The architecture
artifacts were regenerated. See docs/WORKFLOW_GUIDANCE.md and
verification/workflow-guidance.json. Remaining parity items retain their scope.

## 2026-09-14 — Explicit task closure and compatible workflow upgrades

Added `task.mark_failed` to the existing Tasks tool adapter. Producer/operator
permission, active state, reason and revision checks are shared with Workflows
guidance. The command records an attributed terminal reason and task.failed event,
closes any unfinished review, and commits its receipt in one transaction. Evidence,
checkpoints, prior assessments and producer attribution remain unchanged. Task
reads/context payloads include the failure field; UI shows why the task ended.

New instances use task@2. The original task@1 graph remains registered and all
ordinary legacy work stays pinned. Only the new closure command upgrades a legacy
instance, then closes it, within its transaction. Workflows exposes a private
managed-handle additive upgrade: no state remapping, no automatic bulk upgrade,
no new public tool. Version/revision checks, history, events and replay are atomic.
Local independent review also corrected guidance tool-name validation to accept
mounted names such as _nisa.ask, matching the Tools contract.

All 208 tests passed, including real loopback HTTP/MCP and the prepared Nisa fixture,
with zero failures, cancellations or skips. Backend/UI build and typecheck, full
formatting and whitespace checks passed. Architecture extraction remains 28 plugin
entrypoints/58 dependencies; the domain tool count is now 26 (28 with UI).

Fable was attempted through the established restricted CLI, but automatic approval
review rejected sending the exact 19-file source packet without payload-specific
approval. No upload occurred; an approval request is pending. The local reviewer’s
finding is attributed separately. Browser sign-in to the disposable synthetic
preview was also rejected pending specific approval; no completed visual check is
claimed. See docs/reviews/workflow-guidance-fable.md and verification/task-closure.json.
Live model acceptance passed with three fresh Codex sessions and two server
restarts: 30 calls, 27 successes, three expected permission denials, nine successful
guidance calls and zero transport errors. The reviewer read both pinned artifacts
before its verdict, and the observer read the retained delivery. A first attempt
stopped at a harness assertion because its producer prompt did not explicitly
request task.get; the prompt was clarified, assertions retained, and a fresh full
run passed. Sanitized evidence is verification/workflow-guidance-live.json. This
live scenario covers guidance and ordinary completion; deterministic tests cover
withdrawal and upgrades. The blocked browser preview was shut down and cleaned up.
Overall Python parity remains active; no research program/runner/storage gap is
closed by this task slice.

## 2026-09-14 — Work-item dependency gates

Workflows now owns durable project-scoped prerequisites and reverse dependency
views. Programs declare version-pinned success states; edges retain their accepted
success/terminal criteria. Normalization, same-project validation, cycle detection,
private additive composition, revision fencing, replay and rollback are integrated.
Programs select which actions require prerequisites; they can use the same checker
for assignments without imposing a gate on every transition.

Tasks accepts dependsOn at creation, declares done as success, and blocks producer
context/checkpoints and delivery until every prerequisite succeeds. Failed inputs
yield dependency_failed guidance with an independently authorized withdrawal option;
they never automatically fail descendants. Task reads/UI expose Waits on and
Unblocks. Forward prerequisite records enter the existing context recipes.
Reverse links are excluded from pinned assignment context: regression testing
showed that creating downstream work otherwise broke identical context retries.
A second regression ensures operators see authorized failure guidance even though
they cannot submit another producer’s delivery.

All 221 tests passed, with zero failures/cancellations/skips, including the prepared
Nisa-owned fixture and actual HTTP/MCP task dependency calls. Corresponding Python
task/experiment tests passed 29 checks during the parity comparison. Backend/UI
builds, typechecks, formatting and whitespace checks passed. Local independent
source/test review found no further material issue. Plugin composition and exposed
tool counts remain unchanged (28 entrypoints, 58 Cordis dependencies, 26 domain
or 28 UI-inclusive tools).

No new Fable invocation or browser sign-in was attempted: earlier payload/sign-in
approval requests remain pending after automatic approval review rejection. The
last live-model run remains the preceding three-agent guidance checkpoint; this
slice has deterministic and real local transport coverage and does not claim a
new model-driven dependency scenario. Full experiment/reflection, assignment,
session and runner parity remains open. See docs/WORK_ITEM_DEPENDENCIES.md and
verification/work-item-dependencies.json. Structured delivery checks are next.

## 2026-09-14 — Structured task evidence and stable context replay

New tasks use evidenceVersion 2. Merv renders an immutable numbered brief when
briefId is omitted; compatible producer-supplied briefs remain supported. Every
new delivery must declare one met/not_met confirmation per acceptance check,
with verification notes and retained evidence references for met claims. Duplicate,
missing, foreign or unsubmitted references are refused. Merv pins a generated
assessment alongside the evidence before independent review. Valid claims never
automatically complete a task. Existing stored tasks retain evidenceVersion 1 and
their original text-coverage contract; graph versions and old review snapshots
remain unchanged. Guidance computes the correct required fields per task version,
and the task UI displays claims and evidence links.

Independent local review found and reproduced two integration bugs, now fixed:
binary evidence could be submitted but failed context rendering, and deploying
new Task fields broke identical pre-migration context retries. Context Builder
now has explicit text/auto/references modes with hashes and source manifests,
and an owner-scoped replay handle. Tasks rechecks current assignment/revision,
actor, claim and prerequisites before replaying its saved package. New request IDs
refresh context. Generic build still rejects changed explicit inputs. Regression
tests cover large binary references, budgets, cross-project scope, restart,
revocation, recovery and stale claims. No new plugin or public tool was added.

All 236 tests passed (217 top-level groups plus subtests), including real local
HTTP/MCP and the prepared Nisa fixture. Backend/UI builds and typechecks,
formatting and whitespace checks passed. Fifteen new integrated test groups
cover structured evidence, compatibility/rollback, context replay and dynamic
workflow input fields. Local independent review found no further material issue.

Fresh live producer, reviewer and observer agents passed through two server
restarts: 35 calls, 32 successes, three expected role denials, nine guidance calls,
two successful assignment-context builds and no transport errors. The reviewer
read the brief, producer evidence and generated assessment before accepting the
arithmetic result. The observer read retained evidence after the second restart.
Sanitized reports are verification/structured-task-evidence{,-live}.json. Raw
transcripts and isolated synthetic data remain outside the repository; the run
closed its local servers successfully.

Fable source export and browser sign-in were not retried; the previously rejected
exact-payload and sign-in approval requests remain pending. No external review or
new visual verification is claimed. Structured per-check reviewer findings and
assignment/begin work are next; research programs, sessions, runner, shared auth
and storage-provider parity remain open. Overall parity remains active.

## 2026-09-14 — Structured review assessments

Reviews now pins a submission format with each immutable request. New Task
reviews require a human-readable synopsis and one finding per criterion;
findings cite pinned evidence and distinguish met, not_met, not_verified and
explicitly waived criteria. Waivers with reasons preserve Python's delegated
reviewer authority. Generic structured evidence retains independent observations
and an optional outcome. Tasks prefers evidence.outcome, then synopsis, then
legacy notes on acceptance. Rejection context carries the retained assessment,
with review.get references when optional feedback exceeds the recipe budget.
The review UI displays findings, observations and waiver counts beside verdicts.
No new plugin or public tool was added.

Existing reviews default to format 1, retain original snapshot hashes and keep
notes-only submissions. Reissue preserves the previous format; new deliveries
can request format 2. Snapshot fields and submitted assessments remain immutable.
Claim revocation/recovery, deduplicated retries and verdict+target transition
share their established transactional boundaries. New generic and task tests
cover malformed assessment, cross-snapshot evidence, all routes, waivers,
rollback, restart, legacy receipts, recovery and exact transport responses.

Independent local review found the initial typed matrix excluded legitimate
Python reviewer waivers; that behavior was restored. A suspected stale-preflight
gap was disproven by execution: Workflows already rejects supplied stale
revisions before policy evaluation, so the redundant proposed guard was removed.
The regression now verifies both preflight and commit refusal without writes.
Synopsis validation also matches Python's plain-prose/no-entity-ID intent using
both Python and TypeScript identifiers.

All 251 tests pass, with zero failures/cancellations/skips, including real local
HTTP/MCP and the prepared Nisa fixture. Backend/UI builds and typechecks pass.
The fresh producer/reviewer/observer run passed across two restarts: 34 calls,
31 successes, three expected role refusals, nine guidance calls, two assignment
context builds and no transport errors. The verifier compares the actual
reviewer's submitted synopsis/findings/observations with persisted values, as
well as checking that all pinned artifacts were read before the verdict.
See verification/review-assessments{,-live}.json.

Fable consultation completed through a separately approved standalone generic
protocol question (1,830 bytes), with no repository files, project identifiers
or source excerpts, and with tools disabled. Main model usage verifies
claude-fable-5. Fable raised waiver authority, content provenance, independent
review evidence and transaction fencing/retry identity. Local source/tests
confirm existing hash integrity and commit-time claim checks; explicit waivers
preserve the Python policy and are now prominently displayed. Reviewer-owned
artifact attachments and execution lineage remain future extensions. This is a
generic design consultation, not a source-code audit. The earlier exact private
source packet remains unsent and awaiting its specific approval; browser sign-in
also remains pending. See docs/reviews/review-assessments-fable-design.md.

Next is generic workflow.assignment/workflow.begin inside the existing Workflows
and Tasks contracts, following docs/WORKFLOW_ASSIGNMENT_PLAN.md. That plan is not
implemented yet. Research programs, sessions, runner, shared auth and storage
provider parity remain open; the overall goal remains active.

## Workflow assignment and first activation — 14 September 2026

Extended existing Workflows/Tasks/Context Builder with per-state assignments,
full read-only context previews and atomic begin. Added two tools to the existing
adapter, preserved operator assistance and pre-claim review inspection, and kept
saved review context/checkpoints/verdicts claim-fenced. Guidance and task UI share
the durable start ledger. No new plugin/dependency; 28 domain tools (30 with UI).

Validation: 274/274 tests; 45 Python parity-audit tests; backend/UI typechecks and
builds; actual overlapping SQLite worker transactions. Three fresh live agents
made 42 calls across two restarts, with four successful begin calls producing
exactly two start events. Review evidence and all three permission probes passed.

Local review corrected omitted handoff bindings and a recipe-unavailable guidance
failure. Fable completed a generic design consultation without repository data;
its findings and dispositions are retained separately from the earlier private
source packet awaiting specific approval. No new browser sign-in attempted.

See [verification](verification/workflow-assignment.json), [live evidence](verification/workflow-assignment-live.json)
and [assignment contract](docs/WORKFLOW_ASSIGNMENT_PLAN.md). Full Python parity
remains active: session capabilities/leases, runner/outbox, living project context,
research programs, shared identity and storage providers still need work.

## Project-bound actor credentials — 14 September 2026

Scope now separates operational actors from their bearer credentials. An atomic
migration retains existing actor IDs, project scope and token authority while
moving digests out of actor rows. New credentials support explicit expiry,
metadata inspection, additional issuance, rotation and independent revocation.
The existing Scope adapter exposes four additional tools: 32 domain tools,
34 with UI. The network remains 28 plugins and 58 direct dependencies.

HTTP, MCP and CLI retain the resolved credential ID. Permission checks revalidate
it within domain transactions, immediately before queued tool dispatch and after
remote connection setup. The upstream Credentials adapter rejects every known
local token, including expired and revoked ones. Actor withdrawal still triggers
existing recovery; token replacement preserves attribution and claims.

Fable reviewed a separately approved generic design question without repository
files or project data. Its lost-response concern led to staged self-rotation:
issue, verify the replacement, then revoke the old token. The authenticating
credential cannot rotate/revoke itself, and self-issued replacements cannot
extend finite expiry. Operators remain administrators, not bounded session
principals. A separate local review found no actionable implementation bugs.

Validation: 293/293 tests with the prepared Nisa fixture; 137 Python identity and
session audit tests; backend/UI typechecks and builds. Concurrent SQLite workers
produce one rotation successor. Three fresh agents made 42 calls across two
restarts, with 39 successes and three expected role refusals. Two token rotations
preserved actor identity and expiry; old bearers failed and the replacement
reviewer bearer completed the review. Four begin calls retained two start events.

See [verification](verification/actor-credentials.json),
[live evidence](verification/actor-credentials-live.json) and
[Fable review dispositions](docs/reviews/actor-credentials-fable-design.md).
The earlier private-source export and browser sign-in remain unattempted pending
their specific approvals. The next integrated slice is verified shared users and
project membership, ahead of fixed workflow authority, leases and runner recovery;
see [the ordered parity plan](docs/IDENTITY_SESSION_PARITY_PLAN.md).
The overall parity goal remains active.

## Shared identity and project membership — 14 September 2026

Added an independent Identity provider with explicit Supabase JWKS or HS256
verification. Scope owns verified issuer/subject users, immutable membership
epochs, per-project roles and persistent member attribution. Human project
creation and membership management require verified account authority; existing
actor credentials retain their original fixed scope. HTTP/MCP catalogs and calls
require explicit human project selection and revalidate current membership.

The browser uses the Supabase SDK for PKCE login/refresh, with explicit project
selection, zero-project onboarding and a People view for membership administration.
Eleven synthetic client tests cover StrictMode initialization, concurrent expiry,
account/project switching, stale parsing, refresh ownership and membership loss.
Configured shared identity permits serving without a local credentials file.
Legacy project adoption and ownership repair are trusted local CLI operations;
repair requires a reason, records an audit event and does not expose that reason
to nonoperators through the feed.

Review permission loss commits with the membership change and durable recovery
event. Final review found a restore-before-recovery gap: a restored member could
otherwise reuse the old claim. Reviews now checks the committed event during
admission/submission; Tasks uses that guard for context, checkpoints and workflow
begin. Paused-consumer tests show no writes on rejected old claims, while fresh
claims survive historical recovery. Actual overlapping SQLite workers also prove
that concurrent self-demotions leave one verified human operator.

All 343 tests pass, with no failures, cancellations or skips, including the
prepared Nisa fixture. Backend/UI typechecks and production builds pass. Three
fresh agents used synthetic signed human identities across two server restarts:
42 calls, 39 successes, three expected role refusals and zero transport errors.
Eleven guidance calls, three assignment calls and four begin calls led to exactly
two first-start events. A second project gave the same user a different role and
refused cross-project evidence. The final recovery guard landed after that live
run and is covered by the final complete suite.

Fable completed a separately approved 2,525-byte generic design consultation,
with no source, credentials or project data and no tools. Feedback informed local
ownership repair, explicit issuer/algorithm policy, membership transaction checks
and browser bounds. Final independent local review found no actionable findings.
The current diagram is verified against 29 plugins, 17 service providers and 59
direct dependencies; the tool interface remains 32 domain tools, 34 with UI.

See [verification](verification/shared-identity.json),
[live evidence](verification/shared-identity-live.json),
[configuration](docs/SHARED_IDENTITY.md) and
[Fable dispositions](docs/reviews/shared-identity-fable-design.md).
No real shared Supabase/Nisa browser login is claimed. Earlier private-source
export and browser authentication approvals remain pending and were not retried.
Next: user-owned project/account machine keys, before fixed node authority,
sessions/leases and runner recovery. Full Python parity remains active.

## User-owned project/account keys — 14 September 2026

Scope now owns machine keys backed by verified issuer/subject users and live
memberships. Project grants stay fixed; explicitly selected account grants cover
current and later memberships with their current roles. Machine principals remain
distinct from human login and use the existing member actor for attribution.
Owner-only account HTTP routes and a reusable UI screen provide metadata,
creation, replacement and recursive revocation, including cleanup after the owner
leaves the issuance project. No new plugin or agent tools were added.

An immutable Scope migration stores digests, owner/grant/project/label and rotation
lineage. Atomic rotation retires the predecessor and permits one successor.
Recursive revoke covers later replacements through an already-retired ancestor.
Current key and membership epoch are rechecked before dispatch and inside writes;
legacy actor administration refuses user keys, closing independent-credential
escape. The upstream Credentials adapter recognizes active and dead local keys.

Fable reviewed a separately approved 3,134-byte generic design question without
source, credentials or project data and with tools disabled. Its feedback led to
account rotation using another current membership after issuance-project departure,
and source-key/membership attribution on every machine-authored domain event.
Review claim start events preserve the key used without treating token retirement
as actor death. Independent source review found no actionable authorization bugs;
an evidence review tightened grant, actor and membership assertions in the harness.

The Python audit passed 38 key/account tests and reproduced two reference behaviors:
membership rejoin restores a still-live key, and the public create(parent_key_id)
route can mint below a revoked parent. TypeScript preserves rejoin semantics and
avoids the lineage defect through its explicit atomic rotation route.

All 369 tests pass, with no failures/cancellations/skips, including the prepared
Nisa fixture. Twelve new core tests include three actual competing-worker races;
HTTP/MCP, domain provenance, upstream credential isolation and mounted connection
race tests pass. Fourteen browser-client tests cover human/key selection and
account-switch behavior. Backend/UI typechecks and builds pass.

Three fresh agents completed the task/review loop across two restarts: 40 calls,
37 successes, three expected role refusals and no transport errors. Two worker-key
rotations preserved attribution/grant/expiry. Supplemental HTTP checks verified
project confinement against another valid membership, future account membership,
owner management after departure, account rotation there, and a later successor
revoked through its original ancestor. Ten guidance, three assignment, four begin
and two context calls retained exactly two first-start events.

See [verification](verification/user-keys.json),
[live evidence](verification/user-keys-live.json), [key contract](docs/USER_KEYS.md)
and [Fable dispositions](docs/reviews/user-keys-fable-design.md).
The existing network remains 29 plugins and 59 direct dependencies, with 32 domain
tools or 34 including UI. Real shared-provider browser login is still unverified;
earlier private-source and sign-in approval requests were not retried. Next is
fixed execution authority declared by workflow nodes, followed by sessions,
recovery and runner controls. Research programs and storage parity remain open;
the overall goal remains active.

## Fixed workflow execution-policy foundation — 14 September 2026

Workflows now owns fixed per-state execution declarations separately from current
readiness and context rendering. A strict binding format supports literals,
target identity/revision, exact references, member choices and bounded subsets.
Complete alternatives cannot be combined; ambiguous default insertion is refused.
Canonical policy hashes include a format version and locale-independent ordering.
Immutable migration rows pin explicit policy absence as well as installed grants.
Changed authority requires a new workflow version. Registration generations
invalidate old checks after Cordis withdrawal, reinstallation and process restart.

Tasks declares producer and reviewer protocols using authoritative metadata.
Checkpoint attachments cannot expand direct artifact-read grants; the policy
also constrains new checkpoint attachments, closing a route through later context
rendering. Claim bindings remain current while declarations stay fixed. Interactive
workflow.begin is excluded from node authority; ordinary guidance and begin work
as before. The internal execution/admission path runs without artifact bytes or
context construction and can use the caller's writer transaction. It is a check,
not a credential or ownership reservation.

HTTP and MCP now consume the same Tools.describe projection. Native schemas are
captured with their descriptions at registration, while existing handler lifecycle
behavior remains intact. Remote metadata and strict input validation survive.
No new plugin, dependency or public agent tool was added.

Fable reviewed a separately approved generic design question, with no repository
source, credentials or project data and all tools disabled. Two independent local
reviews reproduced and verified fixes for omitted literal values, sparse arrays,
locale-sensitive hashes and checkpoint laundering. A separate Task probe checked
claim recovery, operator restrictions and admission with poisoned rendering paths.
Thirty-one focused Python tests verified the relevant reference behavior.

All 386 tests pass, with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI typechecks and production builds pass. The first full
suite caught six outdated test assumptions: five legacy fixtures removed an
already-pinned declaration, and one API test confused a declared review tool with
its available claim binding. Fixtures now retain the existing manifests with
refusal-only temporary callbacks; production pinning was not weakened.

Three fresh agents completed 40 calls across two restarts: 37 successes, three
expected permission refusals and no transport errors. Nine guidance calls, three
assignment calls and four begin calls retained exactly two first-start events.
Observed assignment packets carried fixed policies, stable before/after a review
claim. The live run preceded final exclusion of interactive begin from fixed
grants; its historical hashes are retained explicitly, and the final deterministic
suite checks the final declarations and unchanged ordinary begin behavior.

See [contract](docs/WORKFLOW_EXECUTION.md),
[verification](verification/workflow-execution.json),
[live evidence](verification/workflow-execution-live.json) and
[Fable dispositions](docs/reviews/workflow-execution-fable-design.md).
Next is real session credential enforcement through discovery, dispatch, native
transactions and delayed mounted calls, then lease ownership and recovery.
Composite context and execution-owned outputs need explicit session semantics.
Real shared-provider browser login, research programs and async/Postgres storage
remain open. The overall parity goal remains active.

## Assignment-scoped sessions and worker recovery — 14 September 2026

Sessions now issues durable MCP-only credentials through an optional HTTP adapter.
Every lease has a credentialless worker actor and separately pinned source human,
key or actor credential. Two worker sessions under the same source key can produce
and independently review. Source membership/credential loss never turns worker
retirement into source-account revocation.

Workflows supplies generic acquire/check/release hooks; Tasks and Reviews own the
actual worker and review handles. Offer reserves ownership and freezes context in
one transaction; first accepted authentication records activation using metadata.
Source and lease checks remain inside native writes. Per-invocation transaction
admission permits legitimate handoff hydration without accepting a later stale
revision. Remote calls repeat policy, grant and credential checks after connection.

Pre-offer checkpoint evidence becomes pinned input. Only that worker's own later
outputs enlarge its artifact authority. Late ordinary checkpoint attachments
cannot inject document bytes into running context. Closing a worker commits
retirement and events before domain cleanup; immediate successor offers drain that
cleanup. Old claims cannot overwrite replacement claims, and logical-owner reissue
preserves the actual producing worker and immutable input/output provenance.

All 410 tests pass including prepared Nisa integration, with no failures,
cancellations or skips. Backend/UI typechecks and builds pass. The initial full
suite had eight failures caused by an old fixture default capping Review migrations
at v4. The fixture now applies current migrations and still separately verifies
pre-v4 immutable rows and receipts, including the new provenance defaults.

Two fresh Codex agents using real session secrets completed 17 successful MCP calls
under one source key across two restarts. They left a done task, an independent
passing review and exactly two first-start records. The live process began before
final preparation cancellation/parser and pre-offer cleanup refinements; the final
suite covers the completed implementation.

The Python audit passed 21 focused tests. Separate probes confirmed same-source
session independence and exposed activation before a failed membership check in
the reference gateway. TypeScript validates membership before activation.

Independent local source reviews found no actionable final defect; five extra
consumer probes covered parser and held-connection races. Fable did not run:
automatic approval review rejected sending the 4,703-byte architecture prompt
without approval for that specific payload. The pending approval was not retried,
and no source or architecture payload was exported.

See [contract](docs/SESSION_LEASES.md), [verification](verification/sessions.json)
and [live evidence](verification/sessions-live.json). The graph is now 31 plugins,
18 service providers and 66 direct dependencies; the agent interface remains 32
domain tools, or 34 with UI. Next are production Runner/workspace/launch recovery
controls. Research programs, asynchronous/Postgres State, real shared-provider
login and real-service deployment remain open. Overall parity remains active.

## Automatic assignment and runner prerequisites — 2026-09-15

Workflows now supplies a metadata-only eligible-node query and strictly validated,
version-pinned workspace intent. Task recipes supply their queue label and
availability through existing program hooks. Existing Task manifest hashes and
versions remain unchanged when workspace declarations are absent.

Sessions owns source-bound runner registration, desired platform settings,
transactional capacity reservations and automatic lease receipts. Dispatch starts
off. Pausing admits no new automatic work and leaves existing leases usable.
Project halt disables dispatch and closes workers in one transaction; the source
account/key remains active. Separate sanitized project inspection and halt let a
human operator manage machine-key jobs without impersonating their source.

A new optional sessions-ui adapter adds the Sessions page. The API adapter adds
ordinary authenticated controls; neither adds agent tools. Browser verification
used a disposable synthetic project and checked enable, pause, halt, live counts
and the unfinished task returning to the queue. The preview server was stopped.
Vite now forwards the new control routes during UI development.

All 425 tests pass with no failures, cancellations or skips, including prepared
Nisa integration. Backend/UI builds and typechecks pass. Two fresh agents under
one source key completed 17 successful calls across two restarts through the
actual automatic HTTP lease route, leaving a done task, independent passing
review and exactly two start events. Default-off, exact retry, pause and human
project inspection were also checked. The live run preceded the final callback
fences and history-count refinement; deterministic final checks cover those.

Independent review found two corrected integration defects: an unsupported
operator assignment could block the automatic queue, and assignment callbacks
could change runner settings/capacity after initial admission. Operator nodes are
excluded, and one shared runner-admission check rereads controls before and after
acquisition. Eight extra probes verify rollback for changed platform enablement,
capacity, desired-settings version and stale presence at both callback boundaries.
The old Python runner audit passed 71 tests; three focused local-Git workspace
reference tests also passed. No new Fable payload was exported while the prepared
Sessions architecture prompt awaits its specific approval.

See [contract](docs/RUNNER_CONTROL_PLANE.md), [verification](verification/dispatch.json)
and [live evidence](verification/dispatch-live.json). The graph now has 32 plugins,
18 providers and 68 direct dependencies; default configuration has 30 entries and
API-only composition remains 23. The tool inventory remains 32 domain/34 with UI.
The next integrated slice is the machine-local actuator with durable launch intent,
birth-qualified process ownership, isolated session credentials, deadlines and
restart reconciliation for scratch assignments. Git workspace preparation/capture
and durable publication receipts follow. Pairing, model settings UI, trace delivery,
telemetry, research programs and alternative storage remain open. Scheduling does
not complete production Runner or overall parity.

## Machine runner checkpoint — 2026-09-15

Integrated an independent `@merv/runner` machine provider, with no server inject
dependencies or new agent tools. Its source-authenticated HTTP controller commits
request/launch intent before dispatch, attaches a stable launch identity, and
supplies only scoped session authority to workers. A private SQLite ledger,
authenticated guardian IPC and independent process deadlines support real
controller crashes without duplicate execution. Uncertain ownership retains
capacity instead of claiming that a remote lease closure killed a local process.

The CLI now supports runner-only configuration with literal argv, config-relative
paths and environment-name-only credentials. Native Codex profiles enforce fixed
MCP tools and bounded local shell policy; command profiles reject read-only work.
Explicit Git policies fail before attach, spawn or activation. Sessions get now
reconciles fresh workflow/expiry state without activating or rebuilding context.

All 464 tests pass with prepared Nisa integration, zero failures/cancellations/skips.
Backend/UI builds and typechecks, formatting and a plain-Node compiled supervisor
smoke pass. Real child tests cover lost lease/attach/release replies, actual MCP
attribution, controller SIGKILL/reconnect, duplicate-controller refusal, deadline
and process-tree cleanup, pause/halt/revocation, and single-session isolation.

Two fresh native Codex agents completed a synthetic arithmetic task and its
independent review: two local shell commands, nine successful MCP calls, two work
starts and both process groups confirmed stopped. This acceptance uses the real
MachineRunner and direct MCP, with no protocol proxy or manual phase spawner.
It preceded the last source-versus-session refusal refinement; the complete final
suite verifies that later change through real public HTTP and two worker slots.

Independent review found and fixed settings executable injection, uncorrelated
response identities, diagnostic redaction affecting intentional IPC, asynchronous
plugin readiness, and source-versus-session shutdown classification. No remaining
actionable finding was reported in the bounded final review. Fable did not run:
automatic approval review had rejected the prepared internal architecture payload,
and its specific approval remains pending. No replacement payload was exported.

The source-derived graph has 33 plugin entrypoints, 19 providers and 68 Cordis
dependencies, plus one separately drawn machine-to-server HTTP connection. Server
defaults remain 30 entries and tool counts remain 32 domain/34 with UI.
See [runner contract](docs/MACHINE_RUNNER.md), [verification](verification/runner.json)
and [native live evidence](verification/runner-live.json).

Next: Git base resolution, worktree preparation/capture and durable publication
receipts, then pairing, source rotation, operational settings and trace delivery.
Research programs, alternative State/Postgres and production shared-login/deployment
verification remain open. This checkpoint does not complete overall parity.

## Git workspace checkpoint — 2026-09-15

Integrated private Git preparation, persistent/ephemeral ownership, exact base
references, stopped-worker capture and acknowledged cleanup into the existing
Runner. Sessions stores immutable source-authenticated attachment and final
metadata separately from closed lease records. A final result may arrive after
closure without reviving the worker. Durable Domain Events carries the result
and frozen workflow identity to interested programs. The Sessions page shows the
declared mode before preparation and captured commit/statistics after completion.
No new plugin, Cordis dependency or agent tool was introduced.

The complete suite passes 490 tests with prepared Nisa integration and zero
failures, cancellations or skips. Backend/UI builds and typechecks pass. Twelve
local Git tests cover source isolation, safe references/configuration, retained
lineages, interrupted preparation, bounded capture and read-only refusal.
Actual Git/MCP recovery checks cover response loss, uncertain attachment closure,
controller restart and retaining capacity until a report is acknowledged. The
Python workspace/session/publication reference audit passed 24 selected tests.

Native profile auditing found that ignoring host skills did not disable repository
skill discovery in the installed CLI. The controller now collects exact repository
SKILL.md paths and explicitly disables them for launch; an actual outgoing-request
probe verified exclusion before generation. Native Git metadata remains protected:
workers edit files, and Runner makes the WIP commit after confirmed process stop.

Two fresh native Codex agents completed a synthetic managed work → capture → verify
→ done workflow on one machine: three shell commands, two successful MCP calls,
exact captured-commit verification, unchanged source and private central ref,
confirmed stopped workers and deleted ephemeral checkout. The first attempt failed
because the fixture had omitted managed ownership and required producer permission
for its review action. The corrected fixture has transactional write/review checks
and a trusted-source admin capture guard; production permissions were unchanged.

Independent evidence review also inspected Git objects, local ownership rows and
physical cleanup. HTTP plus actual React component rendering verified five session
workspace states and full-commit tooltips, including a correction for offered or
failed Git preparation being labeled scratch. Browser inventory was empty, so no
browser-interaction proof is claimed. The successful native run preceded that UI
projection correction; final deterministic verification includes it.

See [workspace contract](docs/WORKSPACES.md), [verification](verification/workspaces.json),
[native evidence](verification/workspaces-live.json) and [profile isolation](docs/RUNNER_PROFILE_ISOLATION.md).
Fable was not consulted: automatic approval review previously rejected the prepared
Sessions architecture prompt without specific payload/destination approval, which
remains pending. No replacement payload or private source was exported.

Next: independently reviewed immutable code proposals and durable central-publication
intent/receipt, including the supported native Git operation boundary. One private
object store does not establish cross-machine Git transport. Pairing, source
rotation, operational settings, trace delivery/telemetry, research programs,
asynchronous State/Postgres and production shared-login/deployment remain open.
Overall functional parity is still active.

## Live code checkpoints and independent review — 2026-09-15

Added one Code provider with tools, HTTP and UI adapters. It persists active-worker
commit requests, exact source/runner/host identity, immutable results and events
in State. Only a writable attached Git session with an explicit grant can request
a commit. Workers see their own operations; project readers can inspect history.
No shell arguments, executable, environment or filesystem path enter a command.

Existing Runner executes the fixed checkpoint through a durable local journal,
private per-operation indexes, deterministic tree/commit preparation and an atomic
expected-HEAD/owner/receipt ref transaction. Final capture moves ownership to a
permanent closed marker, fencing delayed Git children and delayed initial owner
claims. Unknown results retain capacity until receipt recovery or a closed fence
proves failure. A late result does not revive a closed session.

Independent reviews found two recovery edges: unproven pending commands needed
a fresh process inspection before mutation, and a lost dispatch response could
leave a server-only command after the worker closed. Both are fixed. The latter
regression failed first, then passed through completion outage, retained checkout,
controller restart and stopped-safe acknowledgement before cleanup. Core tests
also cover malicious object input, exact ownership, hash formats, transactional
rollback and immutable SQLite guards. Cordis unload/reload preserves queued and
completed commands while withdrawing tools/control/UI without closing the lease.

The final suite passes **526 tests**, no failures/cancellations/skips, including
prepared Nisa integration. Backend/UI builds and typechecks pass. One intermediate
suite found a remaining old Nisa catalog count; corrected expectations and the
final complete suite verify 43 → 37 → 43 in that scenario.

The first native acceptance succeeded: exactly two fresh Codex agents, six shell
commands, six successful MCP calls, zero failed calls, and `done` at revision 2.
The producer requested `code.commit`, received its immutable receipt while alive,
and sealed evidence under its own worker identity. The actual Reviews plugin
issued an independent claim; a read-only reviewer read the receipt, checked exact
committed bytes, HEAD/tree and clean status, then submitted a passing assessment
and transition in one transaction. The original source and private central stayed
unchanged. Both workers stopped, both workspaces closed, the reviewer checkout was
deleted, the producer checkout retained, the command acknowledged and no local
checkout slot remained owned. This is a generic synthetic program, not the full
research proposal/consolidation implementation.

Authenticated HTTP data and actual CodeView SSR verify four operation states,
full commit tooltips, accurate terminal labels and HTML escaping. Browser
interaction was not tested. The source-derived network and visually inspected
image now show 37 plugins, 20 providers (19 server + one machine), 77 dependencies,
34 default server entries, 26 API-only entries and 34 domain/36 UI tools.

See [Code contract](docs/CODE_OPERATIONS.md), [verification](verification/code-operations.json),
[native evidence](verification/code-operations-live.json) and [publication plan](docs/CODE_PUBLICATION_PLAN.md).
The Python publication audit passed 26 focused tests and separately reproduced a
stale publication attempt being rebound by a delayed receipt. The next TypeScript
slice must fence exact proposal/review/repository/attempt/owner generations and
keep stale attempts terminal. A checkpoint does not authorize central publication.

Fable was not consulted. Automatic approval review previously rejected the
prepared architecture payload without specific payload/destination approval;
that approval remains pending and no new export or retry occurred. Independent
local reviews completed. Overall functional parity remains active: production
proposals/publication, cross-machine Git, research programs, operational runner
controls, asynchronous State/Postgres and production deployment are still open.

## Immutable proposals and domain review routing — 2026-09-15

Code now seals successful live checkpoints and worker-authored evidence into an
immutable proposal manifest. It binds the original actor/session/source, exact
workflow and repository assignment, command/receipt and actual artifact bytes.
The manifest, proposal and event share the admitting domain's transaction. Strict
bounded inputs, locale-independent format-1 hashing, immutable database guards,
normalized request replay and post-artifact authority checks preserve those facts.
Code adds one dependency, Artifacts, and no new provider or agent tool.

Moved the existing `review.submit` tool to Reviews. A disposable owner registration
routes to exactly one domain's atomic verdict handler. Missing/ambiguous owners,
async callbacks and changed ownership are rejected. Tasks keeps its input/result,
deduplication and transitions, and withdraws the owner before Cordis drains its
dependent tools. Source review and focused tests found no concrete production bug.

All **553 tests pass**, with zero failures/cancellations/skips, including prepared
Nisa integration. Backend/UI builds and typechecks pass. The final full suite
includes a real MCP proposal seal followed by Code unload/reload, retained exact
manifest/UI data, refusal through the closed provider and no duplicate event.
Other checks cover corrupt evidence, binary artifacts, restart, revoked/expired
authority, current-invocation binding and rollback during artifact creation.

Two fresh native agents completed the first synthetic acceptance: five shell
commands, eight successful MCP calls, zero failed MCP calls, and `done` at revision 2. The producer created validation evidence and the production Code service sealed
it; a read-only independent reviewer read both pinned artifacts, checked the exact
commit/tree/bytes, and called production `review.submit`. A sandbox-blocked heredoc
was retried successfully before the producer requested its checkpoint. The audit
verified actual blob hashes, raw Git object hashes, preserved worker attribution,
unchanged source/private central, stopped workers, released ownership, acknowledged
command and deleted ephemeral checkout. The persistent checkout was retained clean.

Actual CodeView SSR with authenticated HTTP data verified four operation states
plus sealed-proposal producer/commit/manifest identities and escaping. Its server,
clients and disposable data were cleaned up; no browser-interaction proof is claimed.
The regenerated diagram was checked against all 78 direct dependencies and visually
inspected: 37 plugins, 20 providers, 48 arrows and 30 adapter dependencies, plus one
separate machine HTTP connection. Tool counts remain 34 domain/36 with UI.

See [proposal contract](docs/CODE_PROPOSALS.md),
[verification](verification/code-proposals.json) and
[native evidence](verification/code-proposals-live.json). Service replay requires
current assignment authority; it does not reopen a worker after handoff. The
synthetic verdict handler lacks post-transition replay, while production Tasks
replay is tested separately. Sealing does not independently fetch Git objects or
authorize central publication.

The Python reference audit passed 22 proposal checks and 41 experiment/research
checks. It established the next order: Claims → complete Experiments → authoritative
corpus/source references → actual Reflection → reflection-owned consolidation and
publication. Consolidation needs the approved reflection's frozen experiment corpus;
it must not be replaced by a standalone Code workflow. The new
[research plan](docs/RESEARCH_PROGRAM_PARITY_PLAN.md) records exact attempts,
submission rounds, metrics exhibits and explicit review return paths. Publication
keeps the existing requirement to reject delayed receipts from stale attempts.

Fable was not consulted: automatic approval review previously rejected the prepared
internal architecture export without specific payload/destination approval, which
remains pending. No new export or retry occurred. Independent local reviews and
native evidence inspection completed. Overall functional parity remains active;
research programs, reviewed publication, cross-machine objects, operational runner
controls, asynchronous State/Postgres and production deployment are still open.

## Project Claims — 2026-09-15

Added the independent Claims provider (State + Scope) and separate Tools/UI
adapters. Its three tools create, list and update project facts. Public statements
and scope remain fixed, status/confidence changes use an expected revision, and
normalized request replay returns the original receipt. Scope authority, record,
event and command receipt commit together; no workflow is manufactured for claims.

All 566 tests pass, including thirteen Claims domain/HTTP/MCP regressions and
prepared Nisa integration. Tests exercise two actual competing SQLite writers,
project/role/session boundaries, source revocation, restart/replay, immutable rows,
rollback and Cordis unload/reload with UI/tool withdrawal. Independent review found
and fixed scalar-ID schema inspection invoking a malicious getter before refusal.
Twelve Python reference tests pass; the comparison documents stronger TypeScript
revision/replay/input bounds and leaves reviewed reflection edits for that domain.

Two fresh native agents passed nine MCP calls with zero failures: create/retry,
update/retry and independent read. The audit confirmed original receipts, one
claim, two events, two command receipts, worker attribution and project isolation.
Both workers stopped with no owned slots, pending requests or matching processes.
This tests the actual Claims/Runner/Sessions integration in a synthetic managed
program, not scientific evidence or a Reviews assessment.

Corrected an older Code-proposal authority test whose nested transaction exception
could falsely satisfy its rejection assertion. The new same-transaction authority
fault requires the specific refusal and verifies rollback. A temporary mutant with
only the final authority checks removed fails the corrected test. Production Code
logic is unchanged; old verification records remain historical and this result
supersedes that specific weak proof.

Actual browser interaction now verifies high-confidence creation, literal HTML-like
text, retained request identity through a lost committed response and later 404,
normal edits, concurrent-edit conflicts, project draft isolation and read-only
controls. Independent request inspection confirms one claim after all three create
calls. The temporary proxy's initial Host/Origin mismatch caused the blank page;
fixing that fixture preserved the production origin guard. The final full suite
includes the UI retry fix. Backend/UI builds and typechecks pass. The browser used
locally signed synthetic identities, not a real shared-provider login.

Independent UI review also found an ambiguous-request retry being discarded after
a later definitive refusal. The component now retains uncertainty and the original
request ID until it receives a successful receipt, preventing an intervening 404
from reopening creation with a new ID. Scope changes still dispose the in-memory
pending command; this is not a durable browser outbox.

The architecture now has 40 plugins, 21 providers and 84 direct dependencies,
37 default entries and 37 domain/39 UI tools. The dependency map matches its source
sets and has been visually inspected. Browser interaction evidence and final build
checks are recorded in [Claims verification](verification/claims.json).

See [Claims](https://github.com/rapidreview-io/Merv/blob/1883f27ae6669fe255bb317011ae505bb4b04322/merv-typescript/docs/CLAIMS.md), [Python reference](https://github.com/rapidreview-io/Merv/blob/1883f27ae6669fe255bb317011ae505bb4b04322/merv-typescript/docs/CLAIMS_PARITY_REFERENCE.md) (both removed with the claims retirement) and
[native evidence](verification/claims-live.json). The next slice is the complete
Experiment lifecycle, followed by authoritative corpus references, Reflection,
and its consolidation/publication gate. History/linked-experiment UI and trusted
reviewed reflection writes are not implemented by this Claims slice.

Fable was not consulted: automatic approval review previously rejected the prepared
internal architecture export without specific payload/destination approval. That
approval remains pending; no new export or retry occurred. Independent local
reviews completed. Overall parity remains active.

## Explicit review return paths — 2026-09-15

Integrated optional `returnTo` through the existing Reviews contract, tool,
immutable assessment and UI. The registered domain owner validates the selected
route and applies its state transition in the same transaction. Tasks retains
its fixed pass/revise/fail routes and rejects supplied destinations in both
preflight and direct commands, before command replay. No plugin or tool was added.

Migration 6 adds nullable route storage without changing old snapshot hashes,
submitted rows or stored receipts. Absent and explicit-undefined input retain the
old shape; present routes participate in replay identity. Submitted routes are
immutable, and submitted reviews cannot be reissued. Owner changes/unload,
authorization loss, stale claims and failed domain transitions preserve the
existing refusal and rollback behavior. Independent review found two malformed
in-process input cases that could execute a Proxy-prototype trap or a Task
accessor; bounded guards and regressions now refuse both without executing them.

The full suite passed **574/574**, with **30/30** focused checks and **17/17**
independent checks. Full-suite log: `/private/tmp/merv-review-return-suite.log`;
independent log: `/private/tmp/merv-review-return-independent-approved.log`.
The independent run first encountered three sandbox loopback fixture failures;
the approved local rerun passed all seventeen tests.

Two fresh native leased reviewers completed **seven successful MCP calls, zero
failed calls**, and no shell calls. All three pinned artifacts were read in full
before verdict submission. One reviewer rejected the defective comparison with
`fail → planned`; the other identified a denominator error under a valid plan
and selected `needs_changes → running`. Both workers stopped; no owned slots,
pending requests or cleanup errors remained. The report is
`/private/tmp/merv-native-review-returns-live-20260915-01/report.json`.

That native run uses a synthetic registered owner, a seeded producer and a seeded
approved-plan document. The two destinations terminate only that fixture. It does
not prove production Experiment creation, independent design approval, attempt
records or subsequent execution repair. No production Experiment program was
introduced by this prerequisite.

The [exact Experiment reference](docs/EXPERIMENTS_PARITY_REFERENCE.md) now records
public inputs, artifact byte caps, graph schema, deterministic metrics provenance,
review return rules and deliberate TypeScript strengthening. Its 41 Python tests
passed in 3.663 seconds; `/private/tmp/merv-experiments-reference-20260915.log`
records the run. Both negative experiment verdicts must choose planning or
execution repair; only owner `mark_failed` means terminal failure.

Inventory is unchanged: **40 plugins, 21 providers, 84 Cordis dependencies,
37 default entries, 28 API-only entries and 37 domain tools (39 with UI)**.
See [return-path semantics](docs/REVIEW_RETURN_PATHS.md),
[the next integration order](docs/RESEARCH_PROGRAM_PARITY_PLAN.md) and
[verification records](VERIFICATION.md). Production Experiments is next; overall
parity remains active. No Fable export or approval retry was performed; the
earlier specific export approval is still pending.

## Production Experiments — 15 September 2026

Experiments now implements a real four-stage research lifecycle: planning,
independent design review, execution of the exact approved plan, and independent
results review. It owns attempts, retained evidence associations, immutable
submission rounds and deterministic metrics exhibits. Negative reviews carry
full findings and explicitly return work to planning or execution. Recovery
preserves exact prior evidence and figures while fencing retired workers.
Workflow guidance and submission use the same structural exit checks; assignment
and dispatch admission remain metadata-only.

The complete suite passes **610/610 tests**, including prepared Nisa integration,
with no failures, cancellations or skips. There are 36 new Experiment tests;
the independent combined group passes 34 tests. Backend/UI typechecks and builds,
architecture boundaries and formatting pass. Existing catalog expectations were
updated for the seven added tools; the first broad run's six failures were old
catalog counts, with no behavioral regression hidden by those changes.

Four fresh native workers completed the actual program through Sessions and
MachineRunner: **24 successful MCP calls, zero failed calls and five successful
shell calls**. The planner authored its plan; design review approved that exact
artifact. The executor ran training-only OLS against a training-mean baseline on
five fixed synthetic held-out examples, retaining actual code, stdout, result,
report and graph. The independent final reviewer read all five pinned artifacts,
recomputed all predictions/errors and MAEs (8 versus 0), and submitted a pass.
The workflow ended at revision 4 with one attempt and two sealed rounds. The
first execution clock belongs to executor activation, and the claim stayed
active with low confidence at revision 0.

The original report assembler used a raw launch ID to locate a hashed log folder
and failed after all four workers had finished. Corrected read-only verification
used the original transcripts/ledger and a disposable server copy; no agents
were rerun and original database hashes remained unchanged. Both script hashes
and the verifier hash are retained. Independent audit confirmed evidence bytes,
actual stdout, worker/source attribution and process/socket/listener cleanup.
Sandbox Python emitted retained macOS cache diagnostics while calculation commands
exited successfully; the report does not hide those diagnostics.

The built UI passed an actual browser check using a restored copy of the native
records and a synthetic reader credential: completion/guidance, exact plan and
evidence links, findings, attempts and the retained graph. Removing Experiments
withdrew its row and tools while Claims remained usable; restoration returned
the identical experiment (**46 → 39 → 46** tools). Long details now collapse so
guidance remains visible. Separate real-record SSR verifies successor attachment
attribution and the latest results review after owner closure. All temporary
browser servers and the verification tab were stopped.

The current composition has **43 plugin entrypoints, 22 providers, 95 direct
Cordis dependencies, 40 default server entries and 30 domain/API entries**.
There are 44 domain tools, or 46 with UI. Experiments has seven direct dependencies:
State, Scope, Claims, Artifacts, Workflows, Reviews and Context Builder.

This is a bounded synthetic calculation and a production lifecycle proof. It does
not establish general scientific performance or complete backend parity. Next:
authoritative corpus/capture references, actual Reflection, then reflection-owned
consolidation/publication. Storage, operational Runner, cross-machine Git and
real shared login/deployment gaps remain open.

[Implemented contract](docs/EXPERIMENTS.md) ·
[Verification](verification/experiments.json) ·
[Native evidence](verification/experiments-live.json).

Fable consultation remains pending: automatic approval review previously rejected
export of the specific private architecture payload without payload/destination
approval. No new export or retry occurred. Independent local source and execution
reviews completed separately.
# 2026-09-16 — Production storage and release preparation

Implemented native PostgreSQL/S3 storage and converted component transactions and lifecycle teardown to asynchronous contracts. The final frozen-source native regression passes 780 tests, with zero failures and one optional external Nisa checkout skip (781 total). Deployment tests pass 9/9; backend/UI builds and typechecks pass. The production dependency audit reports zero advisories. A private immutable Azure staging candidate passes real database/R2 storage, role isolation and restart checks; production Caddy/Vercel routing and the legacy services remain unchanged.

The user requires existing projects imported before switching. The isolated import and exact reconciliation now pass: 30 projects, 43 memberships, 200 claims, 3,224 readable artifact records and all 54,314 archived history records. All 2,961 retained objects passed source/destination hash verification. The exact historical allowlist preserves 1,551 preexisting metadata-only artifact rows without inventing files or hiding new omissions. Actual R2 downloads, same-image task/review/agent/reflection/restart smoke, shared-account login and imported-project/history browser acceptance pass. Old work is not silently converted into runnable assignments; native continuation versus historical preservation remains a user decision. Final HTTPS cutover needs a controlled legacy-writer pause and fresh import into a new final schema/prefix. Fable review is also pending exact packet approval; the earlier transfer was rejected before transmission, and no Fable verdict exists.

Current evidence: [storage](docs/PRODUCTION_STORAGE.md), [migration](docs/LEGACY_IMPORT.md), [accepted imported staging](deploy/REHEARSAL_2026-09-16.md), [review status](docs/reviews/production-readiness-fable-20260916.md).

## 2026-09-16 — Review completed and Research made optional by stage

After the user's approval, the exact final readiness packet was reviewed by Claude Fable (`claude-fable-5`), with no blocking defect found in its excerpts and explicit operational conditions. Separate dependency/UI discussion and a new optional-Research design consultation also completed. The earlier blocked transfer did not run; these later approved calls have recorded payload hashes, model provenance and findings in `docs/reviews/`.

The user then required Research to survive removal of domain plugins. Research now depends mandatorily on State, Scope and Workflows only; Paper, Reflections, Knowledge and Consolidation bind independently and block only operations using them. Existing workflow versions, committed replay, child records and promised gates are retained. Independent source review identified a provider replacement race between calls; binding checks and a regression now prevent using mixed provider lifetimes or leaving partial work. No new tools or plugins were introduced.

Integrated the small UI improvements from the review: project search with visible IDs and stable ordering, exact archive page/selection restoration on Back, and detail focus/Escape behavior. Browser checks covered search ambiguity, empty results, archive navigation and project isolation. The source-generated DAG now marks Research's optional edges and preserves the adapter toggle.

Backend/UI builds and typechecks pass. All 118 unique relevant checks have passing evidence across the targeted run and a rerun of the two PostgreSQL suites after correcting the disposable database's socket port; this does not claim another full regression run. Strict graph validation and 20 boundary tests pass. See `VERIFICATION.md` for logs and review scope.

The immutable private Azure image is refreshed, with all 54 configured plugins active and imported counts/metadata hashes unchanged. [Refresh and rollback evidence](deploy/STAGING_REFRESH_2026-09-16.md). Public Caddy/Vercel routes and the legacy writer remain unchanged. Old unfinished-work continuity is still a user decision; the final switch then requires a controlled writer pause and fresh export/import/reconciliation followed by public HTTPS acceptance.
