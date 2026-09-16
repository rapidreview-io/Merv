# Step 7 Claude Fable review

> Historical review: references to the Merv-specific Nisa REST adapter describe
> the implementation at review time. That adapter was removed on 2026-09-14 after
> local MCP verification; see [current integration](../NISA_PLUGIN.md).

Completed on 2026-09-13 after the user explicitly approved sending the exact
prepared 24-file source-and-test packet to Claude Fable. The approved packet was
submitted once and remained unchanged. Fable found no supported high- or
medium-severity correctness, security, or lifecycle defect; it identified
meaningful regression-test gaps and lower-confidence observations. Its actual
feedback is retained below, separately from subsequent local reproduction or
implementation work. Fable did not run tests or edit code.

| Metadata                    | Observation                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requested reviewer          | `claude-fable-5`, explicitly pinned; no fallback configured                                                                                         |
| Installed CLI               | Claude Code `2.1.261` at `/Users/guraltoo/.local/bin/claude`                                                                                        |
| Outcome                     | Process exit `0`; result type `result`, subtype `success`, `is_error: false`, stop reason `end_turn`                                                |
| Duration / turns            | 439,824 ms / 1 turn                                                                                                                                 |
| Main model usage            | `claude-fable-5`, canonical model `claude-fable-5`; 2 ordinary input, 81,538 cache-creation input, 2,639 cache-read input, and 32,432 output tokens |
| Additional CLI model usage  | `claude-haiku-4-5-20251001`, canonical model `claude-haiku-4-5`; 67,027 input / 20 output tokens; purpose not identified by the result              |
| Restrictions                | Safe and restricted modes, all tools disabled, strict empty MCP, no session persistence                                                             |
| Reported server tools       | 0 web-search requests; 0 web-fetch requests                                                                                                         |
| Permission denials / stderr | Empty permission-denial list / 0 stderr bytes                                                                                                       |
| Baseline commit             | `7613264041ade8dddd650b9ceffba40270e427e5`                                                                                                          |
| Reviewed snapshot           | Uncommitted Step 7 Nisa integration at packet preparation; 24 files, 193,161 packet bytes                                                           |
| Private packet              | `/private/tmp/merv-step07-fable-toq4rly1/review-packet.md`                                                                                          |
| Private file manifest       | `/private/tmp/merv-step07-fable-toq4rly1/manifest.json`                                                                                             |

The review used the explicitly pinned Fable model. The CLI also reported
auxiliary Haiku usage. No fallback was requested; that additional usage is part
of the observed provenance, not a separately requested reviewer. Its purpose
cannot be established from the result alone.

Packet SHA-256, verified immediately before invocation and after completion:

`252a425f5c6a46e12003521b90ca568e3439866f94a8d4224dcd00f3f04487e7`

Each included file's SHA-256 was checked against the working source when the
snapshot was prepared. The approved retry checked the frozen packet itself,
without replacing it with later source or documentation. It includes the Nisa
package; its live and controlled unload harnesses; focused tests and synthetic
Nisa/sandbox fixtures; public API, Access, Credentials, and base contracts; the
existing registry and schema implementation; default composition; Nisa
documentation; and the sanitized controlled verification report. Existing
boundary implementations are labeled as unchanged context.

The packet excludes real credential files, environment files, saved profiles,
runtime databases, `live-runs`, raw agent transcripts, and sibling repository
source. Credential strings in fixtures are synthetic. This review did not access
saved Nisa or sandbox credentials and made no Nisa or sandbox service requests.

Invocation:

```sh
/Users/guraltoo/.local/bin/claude --print --model claude-fable-5 \
  --safe-mode --restricted --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-step07-fable-toq4rly1/review-packet.md \
  > /private/tmp/merv-step07-fable-toq4rly1/response.json \
  2> /private/tmp/merv-step07-fable-toq4rly1/stderr.log
```

## Initial rejection and explicit approval

Automatic approval review rejected the first attempt before process creation,
with this stated reason:

> This sends a 24-file packet of potentially sensitive internal source code to an external Claude service; the user authorized consulting Fable but did not specifically authorize exporting this payload to that destination.

No upload occurred in that attempt. The user subsequently replied “Approved” to
sending this exact packet. Its hash and byte count were reverified before the
single approved invocation. No workaround, indirect execution, packet change,
model substitution, or restart was used.

## Evidence boundary

At packet preparation, controlled fixture evidence recorded `29 → 27 → 29`
tools, admitted search draining after immediate withdrawal, native task/review/
feed continuity, and preserved independent sandbox connections. The packet
explicitly labeled this synthetic evidence. Actual Nisa service verification was
pending and is not established by this model review. The live harness in the
packet uses an actual SDK MCP client, not a fresh model agent. Later tests or
live results must be recorded separately rather than attributed to Fable.

## Fable's actual feedback

## Verdict

No high- or medium-severity correctness, security, or lifecycle defect is supported by this packet. The adapter's origin validation, per-dispatch access/credential resolution, redirect refusal, byte cap, deadline, sanitized error mapping, and catalog withdrawal/drain semantics all line up with the acceptance criteria, and the controlled evidence is internally consistent (report fields, checkpoint counts, and test assertions in `tests/nisa-unload.test.ts` match `scripts/nisa-unload-scenario.ts`). Everything reviewed in `packages/nisa`, `scripts`, and `tests` is introduced by this wave; the registry, access, and credentials files are inherited context and I found no defect introduced into their usage.

Details I explicitly verified rather than assumed: the `Promise.race` deadline in `packages/nisa/src/index.ts:242-343` cannot leak an unhandled rejection or a stale timer firing after success; `allowedOrigin` (index.ts:37-52) is safe against WHATWG URL host normalization tricks (`http://0177.0.0.1`, `http://127.1`) because of the strict `url.origin !== value` equality; the underscore→slash rewrite at index.ts:233 replaces only the first underscore, but `citedId` (index.ts:13-14) admits at most one separator, so it is correct; `paperInput`'s regex confines the path segment at index.ts:215 (no traversal); and the mutated-after-return `checks.resourcesClosed` in the scenario (set in the `finally` at scripts/nisa-unload-scenario.ts:416) works because the returned report holds a reference to the same object.

## Significant missing regression tests

1. **Mid-stream byte cap (highest value).** The only oversize case, `tests/nisa.test.ts:191`, is served by the fixture in a single `res.end(...)`, which Node sends with a Content-Length header, so it exercises the pre-flight header check at index.ts:283-290. No test pins the streaming cap at index.ts:300-306 for a chunked response without Content-Length; a regression there would allow unbounded buffering while all current tests pass. Smallest fix: extend `NisaReply` in `tests/fixtures/nisa-server.ts` with a chunked-write option (multiple `res.write` calls exceeding `maxResponseBytes`, no explicit length) and assert a sanitized ≥400 result with exactly one upstream request.
2. **Paper identity mismatch.** The guard at index.ts:218 (`valid.data.arxiv_id === input.arxiv_id`) is untested. Smallest test: `s.upstream.setPaper('1706.03762', { body: { ...paper, arxiv_id: '2101.00001' } })` and assert the call fails with a sanitized error.
3. **Non-JSON content-type rejection.** index.ts:278-281 is untested; none of the sanitized-error cases sets `contentType`. Smallest test: `setSearch({ body: '<html>secret</html>', contentType: 'text/html' })` → ≥400, body text absent from the error.
4. Lower value: invalid UTF-8 bytes (the `fatal: true` decode at index.ts:316-318) and a top-level array or `isError`-keyed response (index.ts:322-331; only the `error` key is covered).

## Uncertain observations (not defects on this evidence)

- **Strict `papers.max(input.max_results)`** (index.ts:207): if the real Nisa service ever returns more rows than requested, every search becomes a 502. Live proof is pending, so this is a live-run risk to watch, not a confirmed bug.
- **Live harness strictness beyond the adapter contract:** `scripts/live-nisa.ts:201` requires every returned search paper to carry a nonempty `url`, which the adapter's own `citation` schema does not require. A single live record without `url` fails the run with only the generic failure code.
- **Diagnostic codes unreachable at the CLI:** the sanitization filter at scripts/live-nisa.ts:297-300 only passes `nisa_`-prefixed codes, so `choose_one_nisa_mode`, `explicit_nisa_mode_required`, and the three `sandbox_*`/`unexpected_live_origin` codes always collapse to `nisa_live_failed`. Deliberate sanitization or not, the specific codes defined for these failures can never surface.
- **Evidence fields are literals, not measurements:** `cordisVersion` and `loaderVersion` in the report (scripts/nisa-unload-scenario.ts:394-395) are hardcoded strings; if either dependency moves, the verification JSON would silently misstate the tested versions. Deriving them from package metadata would make the evidence self-consistent.
- **Minor lifecycle nits:** the scenario sets its two env vars before its `try` (scripts/nisa-unload-scenario.ts:45-46), so a constructor throw would leak them; the cleanup assertions inside the scenario's `finally` (lines 410-415) can replace the primary failure with a cleanup failure; and in `start()` (index.ts:132-134), a rejecting `close()` inside the catch would replace `nisa_initialization_failed` with the dispose error. All are low severity.

Nothing in the packet contradicts the stated evidence posture: the controlled report correctly declares `realNisaServiceVerified: false`, all fixture credentials are synthetic, and the report-leak checks (`tests/nisa-unload.test.ts:24-27`) hold against what the scenario actually emits.

## Independent disposition after the review

The three highest-value test gaps now have regressions against real local HTTP
fixtures. The streaming test observes an actual chunked response with no
Content-Length, forwards each received chunk unchanged, and proves that several
chunks individually below the limit are rejected when their cumulative bytes
exceed it. Separate tests verify that a different valid paper ID cannot escape
the lookup boundary and that an HTTP 200 response with valid JSON but a non-JSON
media type is rejected. Each failure is sanitized and makes one upstream call.
These tests cover existing adapter guards; they do not establish a newly fixed
production adapter defect.

A separate local audit reproduced a bypass in the frozen live harness's fetch
guard: Request-wrapped and non-string sandbox POST bodies could avoid RPC
inspection. The installed SDK's current URL-plus-string request path did not
exercise that bypass. The corrected harness normalizes and inspects the effective
request before forwarding, enforces the public sandbox route and RPC allowlist,
and refuses automatic redirects at every allowed origin. Seven offline tests
cover these boundaries, effective init overrides, concurrent admission, and
consumption of the one-call allowance after dispatch failure. Another local
implementation agent reviewed the corrected guard. Fable reviewed the approved
frozen packet, not this subsequent correction; no second model submission was
made.

The remaining uncertain observations do not establish defects under the current
contract and pinned versions. The real Nisa search/paper and unload proof remains
pending a renewed login or explicitly supplied API key. No authenticated Nisa or sandbox operation was performed
during this review checkpoint.

Final verification: typecheck, build, formatting, and all 187 checks pass (177
top-level tests plus ten component-boot subtests), with no failures or skips. The
complete controlled Nisa-removal scenario is included in that suite. The
[post-review checkpoint](../../verification/step-07-post-review.json) records the
sanitized outcome and the remaining real-service gate.
