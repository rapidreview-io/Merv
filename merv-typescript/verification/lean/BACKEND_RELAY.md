# Shared model relay and durable usage

`BackendRelay.lean` models one ModelRelay request from its committed reservation
through external dispatch, the first terminal frame, accounting commit and
terminal forwarding. Fleet and Pi own their separate reservation records and
daily totals. The transport only awaits the accounting callback; it has no SQL,
recovery queue, or knowledge of either owner's schema.

The arbitrary-trace proofs establish at most one initial usage callback and at
most one accounting commit for a request, retention of an unsettled reservation,
preservation of the charged day, stability of the committed amount across
arbitrary retries/crashes, and a committed settlement before forwarding the
authoritative terminal with usable usage. Request identity is a parameter;
settlement for a different identity has no effect. A conflicting retry leaves
the committed amount unchanged (the implementation also rejects it).

Named traces distinguish crashes before and after commit. The native codec
independently decodes usage as nonnegative integers with a total within
JavaScript's exact integer range. SQL transaction atomicity and durability are
premises, not a Lean implementation of PostgreSQL.

## Durable settlement

Reservation now inserts a fresh server-generated request ID, person, original
day and estimated tokens in the same transaction that increments the daily
total. Each owner has one additional table (`fleet_model_requests` or
`pi_model_requests`), with nullable `settled_tokens`. No new background service
or generic accounting framework is introduced.

Settlement locks that record, validates usable totals, and atomically updates
the daily total and settlement receipt. It reads the original day and estimate
from the database. Repeating the same total is a no-op, including across
independent connections and restarts after a lost commit reply. A different
total or unknown request/person is rejected. The receipt identifies this local
reservation, not a provider call or a client retry of the HTTP request. Each new
HTTP request reserves independently and may execute upstream again.

For reserved calls, the relay awaits `onUsage` before forwarding the first
terminal frame containing usable usage. Callback rejection withholds that
terminal and returns `503 relay_unavailable` if no streaming response has begun,
or a `relay_interrupted` SSE error otherwise. Definite refusals also await their
refund. Client disconnect and relay shutdown do not cancel an accounting write
already started. Diagnostics callbacks, including usage reporting when no
reservation exists, retain their nonblocking behavior.

The first terminal remains authoritative. Missing or malformed usage keeps the
reservation and may still be forwarded; subsequent terminal frames cannot
change the accounting result. This is not a promise that every completed-looking
stream has a usable provider report.

`backend-relay-lean-conformance.test.ts` drives the production relay over local
HTTP, its production Codex accounting hooks, and real PostgreSQL. It compares
the resulting durable ledger delta and callback count with the native Lean
oracle for missing, null, array, incomplete, negative, fractional, string and
overflowing totals; valid zero and positive totals; duplicate terminal frames;
failed streams with usage; definite HTTP refusal; and lost upstream replies.
The mutation control imports a transient compiled copy of the actual relay with
the old permissive guard and requires the same comparison to fail. It does not
modify source files used by parallel tests.

`backend-relay-settlement-lean-conformance.test.ts` adds both owners' real
accounting methods and PostgreSQL migrations, local upstream/relay HTTP servers,
and independent database connections. It checks:

- No authoritative usage terminal or definite-refusal response passes a paused
  accounting callback before commit.
- Reservation-record failure rolls back the initial daily charge; receipt-write
  failure rolls back the settlement delta.
- Concurrent repeated settlement, conflicting totals, wrong people, stale copied
  day/estimate fields, and separate requests on one grant preserve the ledger.
- Lost commit replies withhold the terminal while retaining the committed amount;
  a restarted owner safely repeats the settlement.
- Client disconnect/shutdown does not cancel an observed usage write.
- A child process is killed with `SIGKILL` after both settlement SQL statements
  but before commit, and again after commit but before callback return, for both
  owners. PostgreSQL retains exactly the committed side of each boundary. The
  test explicitly supplies usage on retry; production does not reconstruct it.

Two further transient production-code mutations must fail the same oracle
comparisons: removing the terminal wait, and removing Fleet's receipt guard so
a replay applies its delta twice. The source files and shared harness are never
mutated in place.

## Reproduced and repaired

A terminal `usage: {}` previously became input=0/output=0. The real ledger
returned all 65,558 reserved tokens in the reproducer even though there was no
usable usage evidence. The shared relay now emits settlement only when both
totals are nonnegative safe integers and their sum is safe. Missing or malformed
terminal usage retains the reservation. Valid zero usage still settles to zero;
definite no-take refusals still refund. The first terminal remains authoritative,
so a later conflicting terminal cannot rewrite an earlier result.

## Limits and open boundary

This is a per-request callback and accounting proof, not a proof of external
billing. The reservation uses an input estimate (`JSON.stringify(body).length / 4`)
plus an output allowance. That estimate is **not a demonstrated upper bound on
provider token use**. The comparison deliberately includes valid usage above the
reservation; it must charge that usage rather than silently cap the ledger.
The daily limit therefore gates estimated reservations and subsequent admission,
not an unconditional hard bound on physical provider consumption.

Provider token reports and the assumption that an error HTTP status has no billed
effect remain external contracts. A process can die after receiving usage and
before persisting it, or after reservation commit before dispatch (including a
lost reservation-commit reply). Those outcomes retain the reservation. Unknown
upstream outcomes also remain charged; no automatic refund, remote retry, or
invented usage resolves them. A client may miss a terminal even though accounting
committed. No exactly-once remote-effect or eventual-settlement claim is made.

The narrow improvement closes **forwarded authoritative usable terminal →
uncommitted accounting** and makes known settlement retries safe. It cannot
eliminate the receive-to-durable-write crash window without a durable source of
provider outcomes. Retrying safely still requires the original reservation ID
and trustworthy usage evidence. Callback writers must resolve only after commit;
database operations must eventually return to release relay admission.

The additive migrations do not infer per-request identities for historical daily
totals. Old in-flight processes retain their old behavior until drained/restarted;
mixed-version rollout is outside this slice. New request rows are retained; no
retention policy or operator reconciliation interface is added. Product judgment
would be needed for how to reconcile unknown outcomes and how long to retain
their evidence. Existing Codex/Pi regressions also cover revocation, streaming
cancellation, late reservation, midnight accounting and shutdown; not all are
represented by this small model.

HTTP cancellation and total deadlines bound the wait for accounting. The already
started accounting Promise retains a rejection handler and may commit after the
HTTP request ends. Three additional regressions cover timeout, shutdown and
client disconnect while settlement is stalled; successor admission remains usable.
