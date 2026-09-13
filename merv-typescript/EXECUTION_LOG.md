# Execution evidence

The acceptance criteria and ordering are in [EXECUTION_PLAN.md](EXECUTION_PLAN.md). A step is complete only when its gate is verified. The existing Python application is separate from this implementation.

## Current position

- Step 1: complete; clean-checkout installation, tests, CLI, authentication, restart, and cleanup verified.
- Step 2: complete; lifecycle fixes pass the full 60-check suite, feed-removal scenario, and independent review.
- Step 3: complete; upstream loader configuration, replacement, diagnostics, and public plugin contracts verified.
- Step 4: complete; remote catalogs/results, protocol compatibility, full integration checks, and fresh agents verified.
- Step 5: next — credentials and tool grants.
- Steps 6–15: not started.
- Subsequent experiment, reflection, hosted access, and migration work: not started.

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
