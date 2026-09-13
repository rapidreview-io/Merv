# Step 6 Claude Fable review

Completed 2026-09-13 after the user explicitly approved disclosure of the prepared
source-and-test packet. Review scope: mounts wave `3bf8caf7..43b1bc32`. Findings
below are Fable's review output; the parent agent must independently reproduce
and resolve material findings before closing the gate. No implementation changes
were made by this review.

| Metadata                    | Observation                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Requested reviewer          | `claude-fable-5`, pinned explicitly; no fallback configured                                        |
| Installed CLI               | Claude Code `2.1.261` at `/Users/guraltoo/.local/bin/claude`                                       |
| Outcome                     | Process exit `0`; result type `result`, subtype `success`, `is_error: false`                       |
| Duration / turns            | 436,389 ms / 1 turn                                                                                |
| Model usage observed        | `claude-fable-5` (canonical model also `claude-fable-5`)                                           |
| Additional CLI model usage  | `claude-haiku-4-5-20251001`, 44,252 input / 20 output tokens; purpose not identified in the result |
| Tool/MCP configuration      | Tools disabled; strict empty MCP; safe and restricted modes                                        |
| Reported server tools       | 0 web-search requests; 0 web-fetch requests                                                        |
| Permission denials / stderr | Empty permission-denial list / 0 stderr bytes                                                      |
| Session persistence         | Disabled                                                                                           |
| Private packet              | `/private/tmp/merv-step06-fable-jj470mir/review-packet.md`                                         |
| Packet size                 | 136,598 bytes; 19 focused source, test, and sanitized evidence files                               |

The review used the explicitly pinned Fable model. The CLI additionally reported
auxiliary Haiku usage; no fallback was requested, and that usage must not be
described as an independently requested reviewer or omitted from model provenance.
Its purpose cannot be established from this result alone.

Packet SHA-256, verified immediately before the approved invocation and afterward:
`5e300d1eb09de2ad6cace72c5818f4747932af6795b45dcacd1f7633967cc2db`.

The packet contains mounts runtime/client/catalog code and public types, the API
registry/schema boundary, access and credentials implementations, five focused
test files, and controlled verification records. It excludes saved credentials,
environment files, private runtime state, and raw agent transcripts. Synthetic
fixture credentials occur only as test data. The packet was not changed after
approval.

Invocation:

```sh
claude --print --model claude-fable-5 --safe-mode --restricted \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-step06-fable-jj470mir/review-packet.md \
  > /private/tmp/merv-step06-fable-jj470mir/response.json \
  2> /private/tmp/merv-step06-fable-jj470mir/stderr.log
```

## Timing and prior attempt

An earlier attempt was rejected before launch because automatic approval review
required explicit permission to disclose this specific private packet. No upload
occurred in that attempt. The user then replied “Proceed” to that concrete
disclosure request; the verified packet was submitted once, with no restart or
model substitution. No saved sandbox credential was accessed by this review.

While Fable was reviewing, the separate authenticated real-service acceptance
passed and was committed as `53677e1a`; see
[step-06-live-sandbox.json](../../verification/step-06-live-sandbox.json). It records
one upstream call through a fresh Codex process, matching selected identity and
completed cleanup. This happened after packet preparation and was not part of
Fable's input. Its statement below that the live gate was pending describes the
packet's earlier evidence state, not the current verification record.

## Fable's actual findings

# Claude Fable review — Merv Step 6 mounts wave (3bf8caf7..43b1bc32)

**Summary: no high-severity defect found. One supported medium defect (long-lived SSE notification stream is killed by the per-request timeout), one borderline-low contract wart in `reconnect()`, and two meaningful missing regression tests. Identity isolation, drain-before-close ordering, atomic catalog replacement, and credential rotation semantics all check out in the supplied code.**

## Finding 1 — Medium (introduced): per-request `AbortSignal.timeout` tears down the transport's long-lived SSE notification stream

- **File/lines:** `packages/mounts/src/runtime.ts:208-216` (introduced this wave); same pattern at `packages/mounts/src/credential-client.ts:176-183` (inherited via the move, but the pool does not depend on notifications, so impact there is only churn).
- **Trigger:** Any mount whose upstream accepts the StreamableHTTP standalone GET SSE stream, held connected longer than `timeoutMs` (default 5000 ms).
- **Mechanism:** The custom `fetch` wrapper attaches `AbortSignal.timeout(this.timeoutMs)` to _every_ request the transport issues. That is correct for the initialize POST and `tools/list` calls, but SDK 1.30.0 also opens a long-lived GET SSE stream on this same fetch for server-initiated messages — including `tools/list_changed`. That stream is aborted `timeoutMs` after it opens. In the SDK, a standalone-stream failure does not fire `onclose` (so `client.onclose` at `runtime.ts:199` never sees it), and reconnection is only scheduled when the server sent SSE event IDs; otherwise the error goes to the default `onerror` and the notification channel silently dies. From then on, catalog changes and missing-tool withdrawal are detected only by the `reconnectMs` poll (`schedule()` at `runtime.ts:279-287`). With the `reconnectMs: 60000` used throughout the docs and tests, a withdrawn upstream tool remains admitted locally for up to 60 s, and there is recurring aborted-GET churn against the real service. Existing tests mask this: the notification tests use `reconnectMs` of 25–50 ms and finish well under 5 s.
- **Regression test:** Extend `RemoteFixture` to serve the standalone GET SSE stream. Mount with `timeoutMs: 250, reconnectMs: 60000`; wait ~1 s (past the timeout); then `upstream.setTools([]); await upstream.notifyToolsChanged()`; assert `toolCount` drops to 0 within ~2 s. This fails today because the notification stream is already dead and the next poll is 60 s away.
- **Fix shape:** Only apply the timeout signal to non-streaming requests (e.g., skip it when `init.method === 'GET'` / the Accept header requests `text/event-stream`), keeping `controller.signal` so `stop()` still tears the stream down.

## Finding 2 — Low (borderline; noting for completeness): `reconnect()` can resolve without having reconnected

`packages/mounts/src/runtime.ts:96-114`. If a refresh operation is already executing its second coalesced round (rounds capped at 2), `refresh(true)` sets `forceNext` and returns the in-flight, _unforced_ operation. The caller of `MountManager.reconnect()` sees success, while the actual transport reset is deferred to the backoff timer (up to `reconnectMs·2^failures`, capped at 60 s). Impact is limited because every round still revalidates the discovery credential identity (`runtime.ts:139-148`), so this cannot keep a rotated credential in use; it only defers replacing a stale-but-open transport. I would not block on it, but the `reconnect()` contract is misleading in this window.

## Meaningful missing regression tests

1. **Constructor partial failure releasing namespaces** — `packages/mounts/src/index.ts:63-70`. The only test of invalid configuration (`tests/mounts.test.ts:404-422`) exercises Zod-level failures, which throw _before_ any runtime is created. The catch path where a later mount's `createCatalog` throws (namespace already owned) — which must dispose earlier runtimes' catalogs via fire-and-forget `stop()` — is untested. Test: pre-create `registry.createCatalog('b')`, construct a `MountManager` with mounts `['a', 'b']`, assert it throws `invalid_mount_config` and that `registry.createCatalog('a')` and `createCatalog('b')` both succeed afterward.
2. **Notification liveness past `timeoutMs`** — the test in Finding 1; this is the regression guard the wave's acceptance ("lost connections withdraw catalog admission") actually needs at realistic `reconnectMs` values.

## Verification limits

- `scripts/live-sandbox-mount.ts` (650 lines) and `scripts/mount-unload-scenario.ts` (324 lines) are in the wave but **not in the packet**. I could not review the live script's credential handling, `--use-saved-sandbox-token` gating, or aggregate-only evidence redaction; the claims about them are unverified.
- Finding 1's SDK behavior (standalone GET stream lifecycle, no `onclose` on stream failure, reconnection gated on SSE event IDs) is from reading SDK 1.30.0 semantics, not from execution — no tests were rerun.
- The "existing public boundary diff" section is empty, so `registry.ts`, `access`, and `credentials` were reviewed only for interaction correctness with the new code; any defect there is inherited, and I found none material (namespace parsing at `registry.ts:128-129` is unambiguous because mount IDs cannot contain `_`; the no-await publish window in `replace` at `registry.ts:243-251` is genuinely atomic).
- Live authenticated real-service proof remains pending, as the packet states; the fixture evidence (`27 → 26 → 27` with a held call) is consistent with the code paths I traced (`stop()` withdraws synchronously via `catalog.dispose()` before its first await; `pool.close()` waits for admitted calls before closing clients) but is not a substitute for the live gate.

## Explicitly checked and sound

Connection keys include actor, project, _and_ `identityKey` (`credential-client.ts:130-136`), so a cached privileged connection cannot be borrowed across identities, including through rotation; per-invocation grant and credential rechecks occur both before dispatch (`credential-client.ts:209-216`) and at the registry (`registry.ts:300-304`); discovery handlers are discarded and replaced with pool-scoped calls (`runtime.ts:172-174`); catalog swap and withdrawal are synchronous before any await; mutations are never retried on failure; and all error paths I traced surface fixed messages plus `safeCodes` only, with no credential material.

## Independent reproduction and disposition

The medium finding was reproduced against the installed SDK and a real loopback
MCP fixture before changing the runtime: with a 250 ms request timeout and a
60-second poll interval, a catalog-change notification sent after 400 ms left
the old description published for the four-second observation window. The
runtime now bounds the GET opening handshake, clears that timer when response
headers arrive, and keeps the established body on the mount/SDK lifetime abort
signals. Ordinary POST deadlines are unchanged. The regression verifies both
notification delivery after the old deadline and stream cancellation on unload.

One SDK claim in Fable's explanation needed correction: installed SDK 1.30.0
reconnects standalone GET streams without requiring event IDs. The reproduced
failure is a notification lost in the artificial reconnection gap when no replay
store is present, rather than a guaranteed permanently dead channel. The fix
removes that unnecessary gap. The invocation-only client pool is unchanged; it
does not consume the catalog-notification channel.

The constructor test gap is also covered by `tests/mount-config.test.ts`. It
verifies that partial failure releases newly acquired namespace `a` and preserves
an existing owner's namespace `b`. Fable's suggested expectation that both should
be immediately acquirable was incorrect: releasing another owner's `b` would
itself violate catalog ownership.

The low reconnect timing finding was independently reproduced as well. It is now
fixed with a small serialization rule: an explicit forced attempt waits for the
active refresh, then performs its own reset/discovery. Its promise covers that
attempt. Regressions verify a request during the second coalesced round, recovery
after the preceding refresh fails, and rejection without another connection when
shutdown occurs while queued. Ordinary notification coalescing remains bounded.

After these changes, formatting, typecheck, build, and all **165 checks** pass
(155 top-level tests plus ten component-boot subtests). Fable did not rerun tests
or review the final patch; the fixes and corrected interpretations were verified
locally by the implementation/review agents. Both reported behavior issues and
the missing constructor regression are resolved. The authenticated live proof
remains the separately recorded successful one-call run against `43b1bc32`;
post-review changes affect discovery lifecycle and are covered by the new local
regressions, without repeating the approved real sandbox call.
