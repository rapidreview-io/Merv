# Nisa plugin implementation: Claude Fable review and disposition

The actual Claude Fable review completed on 2026-09-13 after the user approved
exporting the exact frozen backend packet. Fable identified supported defects in
polling, storage-error handling, settlement, result size, provenance, and input
validation. The changes and tests described below were performed locally after
that review; they are not a second Fable review or a Fable approval of the final
implementation.

## Review provenance

| Item                | Recorded value                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Main reviewer       | `claude-fable-5`, explicitly selected; no fallback configured                                                          |
| Result              | `type: result`, `subtype: success`, `is_error: false`, `terminal_reason: completed`, `stop_reason: end_turn`           |
| Duration / turns    | `duration_ms: 438191`; `num_turns: 1`                                                                                  |
| Approved packet     | Five backend source files; **74,648 bytes**                                                                            |
| Packet SHA-256      | `78285b23050ca3fec77117e70969761e2988ed167a75f41cd61b67b6606e2569`                                                     |
| Main model usage    | 2 ordinary input tokens, 29,069 cache-creation input tokens, 31,001 output tokens, including 26,517 thinking tokens    |
| Auxiliary CLI usage | `claude-haiku-4-5-20251001`: 20,773 input / 17 output tokens; purpose not identified by the result                     |
| External tools      | Disabled for this source-only invocation; reported web-search and web-fetch requests both zero, subagents spawned zero |
| Permission denials  | Empty list in the completed response                                                                                   |

The auxiliary Haiku usage is recorded for transparency. It was not a replacement
reviewer or a fallback for the requested Fable review. Fable did not run tests,
edit files, inspect the repository independently, or contact Nisa services.

Private original records: [approved packet](/private/tmp/nisa-plugin-wave-review/packet.md),
[file manifest](/private/tmp/nisa-plugin-wave-review/manifest.json),
[complete Fable answer](/private/tmp/nisa-plugin-wave-review/answer.md), and
[machine-readable response](/private/tmp/nisa-plugin-wave-review/response.json).
These links identify local review artifacts, not deployed endpoints.

The packet contained `project/backend/plugin_api/{retrieval,operations,runtime,routes,host}.py`.
It already included the PID guard and accepted-principal snapshot policy. It did
not include the later partial-result corrections, the new MCP forwarding
transport, or the later connection-deadline and calendar-validation changes.
The file manifest and packet hash identify the reviewed version; current source
must not be substituted when attributing Fable's findings.

## Findings and local disposition

Fable considered the core admission and recovery composition largely sound and
did not identify a double-dispatch or lost-update interleaving. The table retains
its original finding IDs and separates fixes from intentional behavior and
deployment conditions.

| Finding                                                                  | Disposition in the final local implementation                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **H1: status polling takes full recovery writer locks**                  | **Fixed.** Healthy polls read the requested operation without acquiring the admission mutex or a SQLite writer transaction. Recovery opens a writer only after observing and rechecking abandoned work. Startup/admission can inspect all active rows.                                                                                                        |
| **H2: transient monitor storage failure cancels healthy work**           | **Fixed.** Failed observations retry with capped backoff. Unknown storage state is not converted into user cancellation; subsequent cross-process cancellation remains observable.                                                                                                                                                                            |
| **M1: completed execution becomes failed after a settlement error**      | **Fixed.** Execution and settlement are separate. Up to three settlement attempts retain the same outcome and result. Exhausted persistence attempts leave an orphan that recovery marks uncertain; neither settlement nor recovery reruns the model.                                                                                                         |
| **M2: unbounded durable results can make `qa.get` unreadable**           | **Fixed with explicit limits.** Runtime reserves evidence capacity before reads, preserves complete normal records, stops new reads on exhaustion, and drains entered reads. Oversized records or answers receive byte counts, SHA-256 omission records, completeness flags, and a result-bearing failure. No blanket field or string truncation was adopted. |
| **M3: malformed index output becomes an internal error or caller error** | **Fixed.** The plugin validates response containers, rows, numeric fields, and required values. Malformed upstream output produces a sanitized 502.                                                                                                                                                                                                           |
| **M4: arbitrary nested dictionaries become source provenance**           | **Fixed.** Only documented per-tool result slots promote papers and URLs. Nested content and metadata remain in retained raw evidence but do not become additional verified sources. The regression uses planted nested JSON; the old code did not parse JSON embedded inside plain strings.                                                                  |
| **M5: incomplete paper metadata raises an unclassified error**           | **Fixed.** Missing or invalid required metadata produces a sanitized upstream 502. The implementation does not invent missing paper facts.                                                                                                                                                                                                                    |
| **L1: cancelled operations can retain a result**                         | **Intentional and documented.** Available answers, evidence, and usage remain inspectable after cancellation, including a completion/cancellation race. Cancelled and failed operations are excluded from future completed-conversation history.                                                                                                              |
| **L2: invalid pagination values are silently coerced**                   | **Fixed at the new plugin boundary.** Invalid types and out-of-range values are rejected before dispatch. Existing legacy SDK/tool normalization remains unchanged.                                                                                                                                                                                           |
| **L3: malformed owner IDs cause recovery to fail closed**                | **Retained.** A corrupted ledger requires operator repair. The service does not infer ownership or automatically rewrite ambiguous records.                                                                                                                                                                                                                   |
| **L4: lease acquisition and marker hygiene**                             | **Partially fixed; remaining conditions explicit.** An initial `flock` failure now closes the acquired file. Lease markers remain retained; existing directory permissions and filesystem maintenance are operational responsibilities. No automatic permission repair or marker pruning is claimed.                                                          |
| **L5: legitimate answer prefixes resemble core sentinels**               | **Fixed.** Completion uses the observed final provider response and run state. Literal cancellation/iteration-limit strings are valid final answers, while actual iteration exhaustion remains incomplete.                                                                                                                                                    |
| **L6: invalid query-list members are silently removed**                  | **Fixed at the new plugin boundary.** Mixed or blank lists are rejected before dispatch. Shared legacy filtering/coercion is preserved. The shared helper's `requests` handlers still serve its legacy fetch path; this wave does not claim to have rewritten legacy error handling.                                                                          |
| **L7: `/identity` appears to add a seventh capability**                  | **Scope clarified.** Identity is an internal authenticated HTTP endpoint used by the forwarding boundary. It is not an MCP tool. The published catalog has exactly six tools: `search`, `paper`, `excerpts`, `qa.ask`, `qa.get`, and `qa.cancel`.                                                                                                             |
| **L8: 551-row lookahead exceeds the index request limit**                | **Verified and fixed.** Actual Tantivy source limits a request to 500 rows. The plugin fetches its largest lookahead as **500 + 51**, preserving ranking, the requested page, and the additional-row truncation signal.                                                                                                                                       |

The ledger fixes passed **20 focused tests**. Runtime fixes passed **21 focused
tests**. Retrieval boundary and pagination fixes passed **48 focused tests**.
These groups are part of the combined checks below, not additional totals.

Runtime accounting uses `ensure_ascii=True` JSON sizes so Unicode escaping is
included. Limits are 48 admitted reads, 256 KiB per-record reservations including
derived provenance, 768 KiB aggregate evidence, 2 MiB for an answer's escaped
JSON, and 3 MiB for the final result. The final limit leaves room for the operation
envelope under the MCP host's default 4 MiB backend-response limit. Normal large
Unicode answers and unknown source fields are retained exactly. A durable-ledger
and Flask `qa.get` regression verifies that an oversized failed result remains
readable with explicit omissions and available usage.

`evidenceComplete` means no tool record was lost to the runtime evidence budget;
PDF bytes still use the explicitly documented byte fingerprint representation.
MCP text and structured-content copies can make the subsequent MCP wire message
larger than the backend response. The 4 MiB claim concerns that backend-response
boundary, not a universal transport or process-memory limit.

## Claims and review coverage

- **Local filesystem:** SQLite/WAL and POSIX lease ownership require the documented
  persistent local-host deployment. There is no network-filesystem detector or
  claim that the code enforces the storage mount type.
- **Authentication:** A real signed-JWT local test exercises the minimal host's
  default verifier without importing the full server or replacing authentication
  with a fake callback. The small host still uses Nisa's auth module and configured
  identity infrastructure; it is not a separate identity system. Each HTTP request
  is authenticated, while already accepted work retains its verified principal
  snapshot and may outlive that token.
- **Forking:** The PID guard was in the reviewed packet. Actual-fork tests verify
  `qa_wrong_process` 503 failures without disturbing the parent's lease or work.
  This fails closed on inherited services; it does not prevent an operator from
  selecting an unsupported preload configuration.
- **Event bus:** The real constructor, tool execution, final answer, and close
  produced zero global operation events in a focused test. That test also passed
  before the runtime corrections. Fable raised an unproven constructor-window
  concern; no event leak was reproduced.
- **Legacy delegation:** The existing `agents/tools/string_search.py` call site
  delegates to the shared implementation and was inspected locally. It was absent
  from the five-file packet, so Fable correctly could not verify that claim from
  its supplied source alone. Legacy parity tests remain in the local checks.
- **Deadline and calendar corrections:** These were independent local follow-ups
  outside the frozen review. Plugin dates validate actual calendar days while
  shared legacy month normalization remains unchanged. Connection behavior must
  be assessed against the later implementation and its tests, not attributed to
  Fable's frozen-packet review. The later provider resolves hostnames in a bounded
  subprocess that is killed and reaped on timeout, then uses a numeric address
  snapshot with the original HTTP Host/TLS name. Local tests cover stalled DNS,
  stalled TLS, body deadlines and socket cleanup.

## Final local verification

After the fixes and independent local review, the final combined checks passed
**174 Python tests, 13 Nisa MCP tests, and 193 Merv tests, with zero skips**.
Runtime tests use the real pinned agent-core loop with fake providers and blocked
model networking. HTTP and protocol tests use local fixtures, including the real
JWT verification path. These results are not evidence of a new live model run,
production deployment, or a second Fable review.
