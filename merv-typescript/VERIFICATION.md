# Verification — 13 September 2026

The TypeScript build passes. After lifecycle, loader, remote transport, and credential/grant integration, the automated suite passes **160 checks** (150 top-level tests and ten component-boot subtests), with zero failures or skips. It uses upstream `cordis@4.0.0-rc.10`, native SQLite, real loopback HTTP, and the official MCP SDK client. [Execution evidence](EXECUTION_LOG.md) records clean-checkout verification and the added regressions; historical runs below retain their original results.

```sh
npm run build
npm test
```

## Mounts controlled integration — live gate pending

`npm run test:mounts` passes the mounts runtime regressions and the complete configured removal scenario. The application exposes 27 → 26 → 27 tools. An admitted authenticated upstream call drains while new mounted calls are refused; a native task, independent review, and feed posts complete with the mount absent. Restoration uses a new upstream connection and retains the same native providers and durable work. [Controlled mount report](verification/step-06-controlled-mount-unload.json).

Additional fixtures verify unavailable optional mounts, selected schemas, notifications, bounded discovery timeout, physical TCP loss, automatic recovery, explicit reconnection, separate discovery/caller authority, revocation, dependent-consumer draining, and cleanup failure reporting. The [feed removal regression](verification/step-06-feed-unload.json) also passes. All fixture credentials are synthetic.

Public sandbox discovery and source inspection select only `usage_report`. No authenticated live call has been made: automatic approval review rejected the saved credential's proposed use. Step 6 remains in progress until the prepared read-only live command is authorized and successfully verified; this fixture evidence does not complete it. See [sandbox preparation](docs/READ_ONLY_SANDBOX_MOUNT.md).

## Credential and permission integration

The credential suite includes two-project authenticated HTTP/MCP scenarios with separate upstream identities and connections. Hidden tool names remain denied on direct invocation, and actor/grant/binding revocation and credential rotation take effect without restarting Merv. Focused tests cover changes during connection setup, admitted-call draining, timeout/failure cleanup, secret exclusion, and unchanged native role checks. Run `npm run test:credentials`. The default composition grants no remote access and mounts no live service yet.

At the step-5 gate, the full 141-check suite, typecheck, build, formatting, and independent reviews passed. The [step-5 feed-removal report](verification/step-05-feed-unload.json) also passed against the new dependency graph. The earlier live-agent run below remains the last model-driven acceptance; this credential gate uses controlled authenticated MCP fixtures.

## Remote transport and fresh-agent acceptance

Step 4 preserves native tools and adds validated remote catalogs, complete MCP result forwarding, independent project selection, pagination, refresh notifications, and generation draining. The full suite and independent reviews pass. [Compatibility matrix](docs/TRANSPORT_COMPATIBILITY.md) records the actual sandbox endpoint and installed agent versions, including the deliberately unsupported schema/protocol cases.

Three fresh Codex instances completed the native producer/reviewer/reader scenario across two restarts: **28 calls, 25 successes and three expected permission denials**. Each negotiated `2025-06-18`; the reviewer read the pinned evidence before submitting pass, and the final task reached `done` at revision 2. [Sanitized current report](verification/step-04-live-agents.json). This new run is separate from the historical agent acceptance below.

The final feed-removal repeat also passed after the transport changes. [Current feed report](verification/step-04-feed-unload.json).

## Feed removal through the loader

The current `npm run test:feed-unload` uses `app.setEnabled('feed', false/true)` and the pinned upstream loader. It again verifies 26 → 22 → 26 tools, draining of an admitted post, a completed task/review while feed is absent, retained posts/activity, and a refreshed provider handle. [Committed report](verification/step-03-feed-unload.json).

## Earlier feed removal during an active run

The original `npm run test:feed-unload` passed using the official MCP SDK client against the running application. The only removal action was the feed provider's Cordis `Fiber.dispose()`. No tools or dependent plugins were manually removed.

| Phase         | Observed result                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feed active   | 26 tools; initial post and task created through MCP                                                                                                                  |
| Feed draining | Four feed tools disappeared; new feed calls returned `unknown_tool`; disposal waited for an admitted `feed.post`                                                     |
| Feed absent   | The admitted post committed; the original feed adapter became `PENDING`; task delivery and independent reviewer routing reached `done` at revision 2                 |
| Feed restored | Installing only the provider reactivated the original adapter; 26 unique tools returned; all three posts were readable; activity recorded during absence was visible |

The process stayed at PID `64235` and used the same loopback listener and MCP clients throughout. Assertions verify unchanged state, scope, artifact, workflow, review, task, registry, and API service instances. A test barrier makes the normally synchronous feed post overlap removal; real Cordis disposal, SQLite writes, and HTTP/MCP calls perform the actual work. This scenario is an MCP integration test; the separate Codex acceptance below records the earlier agent run.

[Structured removal report](live-runs/feed-unload-2026-09-13T12-55-42.878Z/report.json). The associated synthetic database is retained in that directory. The report is written only after clean shutdown.

## Earlier Codex task-loop acceptance

Three fresh, authenticated Codex CLI instances completed the synthetic task through MCP. Each had a separate Merv actor and an empty agent workspace. The application restarted between phases.

| Instance | MCP calls | Observed result                                                                                                                                                          |
| -------- | --------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Producer |        10 | Created immutable brief and delivery; task entered `in_review` at revision 1; `review.start` was refused by Merv                                                         |
| Reviewer |        10 | Read both pinned artifacts after restart; independently recomputed sum 20 and mean 5; submitted `pass`; task reached `done` at revision 2; artifact creation was refused |
| Reader   |         6 | Read the retained verdict, delivery, and workflow history after a second restart; creating an operator was refused                                                       |

The **26 calls comprise 23 successes and three expected permission denials**. All three CLI processes exited successfully. Saved transcripts prove the reviewer read the exact pinned brief and delivery before submitting its verdict. An additional database reopen verified the task, review, history, artifact hashes, and clean shutdown against the report.

The live result covers one small arithmetic task. More complex research quality, distributed execution, and production deployment are outside this acceptance test.

## Retained evidence

Run directory: `live-runs/2026-09-13T09-17-06.969Z/`.

- [Structured run report](live-runs/2026-09-13T09-17-06.969Z/report.json)
- [Exact-evidence and persistence audit](live-runs/2026-09-13T09-17-06.969Z/evidence-audit.json)
- [Producer transcript](live-runs/2026-09-13T09-17-06.969Z/producer.jsonl)
- [Reviewer transcript](live-runs/2026-09-13T09-17-06.969Z/reviewer.jsonl)
- [Reader transcript](live-runs/2026-09-13T09-17-06.969Z/observer.jsonl)

The saved run was rechecked with the final, stricter evidence verifier. Final shutdown-failure handling and rejection of incomplete transcript evidence also have automated regression tests. Live data and synthetic credentials remain local and are excluded from Git; this document does not contain bearer tokens.

Task: `wf_d30bd4b958e64b8e9e26bb9da37fc697`  
Review: `review_541fa6ce089e43639e4d9bbf3e6d0afd`
