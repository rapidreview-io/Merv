# Verification — 13 September 2026

The TypeScript build passes. After lifecycle, loader, and remote-transport integration, the automated suite passes **111 checks** (103 top-level tests and eight component-boot subtests), with zero failures or skips. It uses upstream `cordis@4.0.0-rc.10`, native SQLite, real loopback HTTP, and the official MCP SDK client. [Execution evidence](EXECUTION_LOG.md) records clean-checkout verification and the added regressions; historical runs below retain their original results.

```sh
npm run build
npm test
```

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
