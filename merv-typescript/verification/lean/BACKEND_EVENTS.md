# State + Domain Events durable composition

Scope: product storage and delivery mechanics in `packages/state` and `packages/domain-events`. No research/scientific policy is modeled. Library `BackendEvents`, executable `backend_events_model` (`BackendEventsMain`), namespace `Merv.BackendEvents`.

## Claims and their strength

**Proved model facts.** `BackendEvents.lean` proves safety by induction over arbitrary finite command traces. The state is an ordinary structure with independent fields and natural-number effect counts, including invalid combinations. It carries no proof fields and does not make effects unique by construction. The transition actually increments effect counts. `Safe` is a separate proposition shown to hold initially and to be preserved by each operation.

The model composes a publisher's application row and event log with a consumer's durable effect and cursor. It distinguishes nontransactional identity allocation from committed events, and local durable effects from externally observable handler attempts. One shared in-flight transaction represents State's schema writer lock. Tickets represent live transaction scopes. Crashes discard only pending transactions and registrations; committed rows, effects, cursor, retry state, and sequence allocation survive. A ticket cannot commit twice. Aborted publications leave identity gaps.

The complete-prefix invariant is:

```
effects(i) = 1  iff  baseline < i <= cursor AND committed(i) AND interested(i)
effects(i) = 0  otherwise
baseline <= cursor <= committed head <= allocated identity
publisher application row(i) = committed event(i)
```

`baseline` models a first subscription from `now`. Reinstalling a stable ID resumes its previous cursor, regardless of the new `from` input. A cursor may pass an aborted allocation, and need not itself identify an existing event; it cannot pass the committed head. The publish-order theorem is what prevents a lower-ID event appearing later behind that cursor.

| Theorem                                                                                           | Model fact                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `initial_safe`, `step_safe`, `trace_safe`                                                         | Safety initially, after every operation, and over arbitrary traces from any safe state                |
| `publisher_change_iff_event`                                                                      | Application change and event have the same durable outcome                                            |
| `publication_above_cursor`, `cursor_never_passes_committed_head`                                  | New committed IDs lie ahead of the consumer, whose cursor remains bounded by committed head           |
| `exactly_once_durable_prefix`                                                                     | Exact multiplicity for every event in the processed, subscribed prefix                                |
| `no_duplicate_effect`, `no_uncommitted_effect`, `no_lost_processed_effect`                        | At most one local effect; none for uncommitted events; all processed interested events have an effect |
| `step_effects_monotone`, `trace_effects_monotone`                                                 | Already durable effects cannot disappear under any suffix                                             |
| `crash_keeps_durable_data`, `crash_retires_scope`, `commit_replay_inert`, `stale_commit_is_inert` | Crash/reply-loss/replayed and stale scope boundaries                                                  |
| `stale_failure_is_inert`, `backoff_blocks_delivery`                                               | A stale failed worker cannot delay progressed work; early retries are blocked                         |
| `admitted_commit_survives_detach`                                                                 | Withdrawal stops future admissions but preserves the admitted atomic completion                       |
| `delivery_progress`                                                                               | An enabled successful delivery advances and clears retry metadata                                     |
| `recover_safe`, `recover_reaches_head`, `recovery_completes_backlog`                              | A sufficiently long successful suffix reaches the fixed head while preserving safety                  |
| `pump_safe`                                                                                       | The executable dispatcher pass is a composition of safe primitive transitions                         |

`recover` explicitly supplies successful commits; `delivery_progress` requires registration, an active subscription, an available transaction slot, expired backoff, and backlog. These are constructive recovery results, not an unconditional claim that a scheduler or permanently failing handler eventually succeeds.

**Finite implementation conformance.** `tests/backend-events-lean-conformance.test.ts` runs production `PostgresState`, `DurableEvents`, actual migrations, and SQL fixtures against PostgreSQL. Native Lean JSON output supplies expected snapshots. TypeScript invokes operations and observes SQL; it does not reimplement the model. Fixture effect rows deliberately have **no unique constraint**. A duplicate is observed as two rows instead of being prevented by a database key.

The executable's `publish` and `drain` inputs expand to Lean primitive transitions. SQL skips over gaps/uninterested runs are compared at completed operation boundaries with multiple Lean slot advances. Scalar serial numbers are abstract tickets, not PostgreSQL transaction IDs. Most trace tests disable only the dispatcher's timer-scheduling seam so each explicit drain has a stable observation boundary. The stale-context regression runs real timers and waits for the first actual background poll. Race tests use handler/rollback barriers and query PostgreSQL's real lock-wait graph; they do not infer ordering from sleeps. Retry tests control `Date.now` and compare the exact persisted deadlines to Lean's clock.

| Executed case                                                                          | Observed boundary                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Publisher rollback and identity gaps                                                   | Application row and event both absent; later event retains its higher ID                                          |
| Held publisher, second connection queued at writer lock, dispatcher read               | Uncommitted event invisible; cursor/effects unchanged; abort followed by publication and recovery succeeds        |
| Before effect, after effect, after cursor SQL, after successful commit with lost reply | Three abort cuts roll back effect and cursor; lost reply preserves both and does not create backoff               |
| Reopened State + dispatcher                                                            | Durable cursor resumes and previously committed effect is not repeated                                            |
| First install from now, unload, reinstall from now                                     | Historical baseline is respected and an existing ID resumes pending work                                          |
| Uninterested events and rollback holes                                                 | Cursor reaches committed head without producing unwanted effects                                                  |
| Backoff before/at deadline, ten failures, saturated delay, repair                      | Early attempts blocked; delay doubles to 25,600 ms and saturates; successful recovery clears metadata             |
| Detach and close during a held handler                                                 | Disposer/close join the atomic commit; replacement continues at the next event; old disposer cannot unregister it |
| Two successful dispatchers for the same ID                                             | Real lock contention yields one local row and one handler invocation                                              |
| Rolled-back failure delayed while another dispatcher succeeds                          | Stale failure recorder does not restore retry state                                                               |
| Retry-metadata SQL failure                                                             | Explicit drain rejects, local effects remain absent, reopen recovers work                                         |
| Publisher reply lost; synchronous and asynchronous postcommit callback failures        | Committed rows/events survive; callbacks cannot undo the transaction; later delivery succeeds                     |
| Retired transaction object outside and inside a new transaction                        | SQL methods and appendEvent reject stale scope use                                                                |
| Real `pg_terminate_backend` between handler queries                                    | Checked-out connection ends, SQL work rolls back, process stays alive, retry commits once                         |
| Drain inside a caller's plain State read                                               | First later safety poll is independent; a commit through another connection is delivered                          |

The lost-reply tests throw at the State API boundary **after an actual COMMIT has succeeded**. They test durable ambiguity handling; they are not a TCP proxy or exhaustive PostgreSQL wire-protocol fault injection. The connection-death regression really terminates a PostgreSQL backend and observes its socket's `end` event in a child Node process. Service restart tests actually close and reopen State pools and dispatchers; ordinary exception cuts are not described as a whole-machine power-loss test.

## Counterexamples and controls

Kernel-checked `by decide` counterexamples (no `native_decide`) demonstrate:

- `cursor_only_counterexample`: advancing the cursor without its local effect loses work.
- `effect_only_counterexample`: committing the effect without its cursor violates the prefix invariant.
- `commit_order_counterexample`: a lower identity committed after the cursor passes it loses delivery.
- `external_redelivery_counterexample`: rollback/retry produces **two external attempts and one durable local effect**.

Three implementation mutation controls always run with the Lean conformance suite. They omit a single effect INSERT, omit one cursor UPDATE, or replace State's writer-lock BEGIN with plain BEGIN. The real dispatcher then loses an effect, produces two unconstrained effect rows, or misses the late lower-ID event. Each result must differ from Lean's independently computed result. These are test-only SQL/scheduling seam mutations; production files are not temporarily overwritten.

## Reproduced fixes

1. **Background polls inherited a retired State scope.** A fresh drain inside `State.read` scheduled its next safety poll inside that read's async context. Once the read ended, the first poll returned `transaction_closed`; each retry inherited the same dead scope. Commits through another State connection could stay undelivered. `DurableEvents.prepare` now binds timer scheduling to its independent initialization context. The first-poll barrier regression failed with `transaction_closed` before the fix and passed afterward.
2. **A checked-out pg connection could crash the process between queries.** `pg-pool` removes its idle error listener when lending a client. Terminating the backend while a handler awaited between queries emitted an unhandled Client `error`, exiting Node before recovery could run. State now listens throughout the checked-out lifetime, marks disconnected clients for disposal, and removes its listener after release reinstalls pool ownership. The subprocess regression failed with an uncaught error and exit 1 before the fix; afterward it proves rollback and a successful retry against real PostgreSQL.

## External assumptions and exclusions

PostgreSQL's transaction atomicity/durability, isolation, advisory-lock mutual exclusion, rollback on disconnected transactions, identity generation, and the Node/pg transport/runtime are external assumptions, not Lean theorems about their implementations. The runtime regressions probe representative instances of these assumptions.

All publishers use State's schema writer transaction and `appendEvent`; event identities are not allocated or inserted through a bypass, sequence order is not administratively changed, and retained events/consumer progress are not tampered with. The executable models one append per publisher transaction and one stable consumer definition; other consumers can be projected as independent uses of the same lock. The tests exercise two State connections/dispatchers contending for that same consumer, and run the connection-termination probe in a separate Node process, but there is no formal source-level refinement proof of arbitrary TypeScript, SQL, multi-event batches, or arbitrary application handlers that also publish derived events. The selected handler's effect is the unconstrained fixture INSERT. It must await its local operations, obey its supplied transaction, and implement the intended effect once per successful invocation.

Restart must preserve the database and re-register the same consumer ID/types. Recovery needs eventual successful database access, repaired/terminating handlers, sufficient polling, and an eventually expired retry deadline. Permanently failing handlers, loss of the database, administrative log deletion, arbitrary SQL that commits independently, unsafe integer overflow, a clock that never reaches the deadline, and external side-effect idempotency are outside this claim. External attempts can repeat after rollback or an uncertain remote reply; exactly-once here concerns local durable effects per committed event and consumer.

No earlier Lean definitions were imported beyond Std: existing models describe other service state machines rather than the shared event-log/consumer transaction. Reusing those fields would introduce unrelated assumptions. This model follows their established native JSON oracle interface.

## Reproduction

Run from `merv-typescript`:

```sh
# Install the pinned Lean toolchain as described in README.md.
export MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv
lake -d verification/lean build BackendEvents backend_events_model
MERV_REQUIRE_LEAN=1 node --import tsx --test tests/backend-events-lean-conformance.test.ts
node --import tsx --test tests/state-postgres.test.ts tests/domain-events.test.ts tests/storage-state.test.ts
npm run typecheck
```

The oracle uses regular files for both stdin and stdout, avoiding macOS synchronous pipe stalls. It fails closed when `MERV_REQUIRE_LEAN=1` and the binary is absent. The shared `test:lean` command and CI include this model and test file.

## Recorded verification

On 2026-09-29, with Lean 4.34.0 and PostgreSQL at the configured local test URL:

- `lake -d verification/lean build BackendEvents backend_events_model`: passed.
- New conformance/regression suite: 19 tests passed, including all three implementation mutation controls.
- Combined new suite plus `state-postgres`, `domain-events`, and `storage-state`: 80 tests passed, zero failed or skipped (19 new + 61 existing).
- `npm run typecheck`: passed.
- `#print axioms` for all 31 theorem declarations: only standard Lean `propext`, `Classical.choice`, and `Quot.sound` where used; the four finite counterexample theorems use no axioms. No `sorry`, custom axiom, or `native_decide` appears in either new Lean source.
- Production diff whitespace check: passed.

The dated product verification report records the combined checks.
