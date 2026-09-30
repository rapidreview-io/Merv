# Fleet protocol proofs and service conformance

**Open provider boundary:** a read-only audit and real PostgreSQL/worker probe
reproduced Sandboxes reporting stopped before an older create materializes.
The [provider regression](../provider-boundaries/README.md) is deliberately red.
The local results below do not establish physical capacity safety against that
provider until its terminal-report contract is repaired.

Four Lean models cover Fleet reservation and admission decisions, diagnostic lease evidence,
the owner-completion handshake, and provider/controller release interleavings. Attempted
allocations retain their reservations until terminal evidence, except for a provably sole
first create refusal with no effect. Time passing never proves that a machine is gone.
The models establish their stated invariants; finite real-service comparisons do not establish
full TypeScript refinement or prove an external provider's behavior.

## Models and theorems

All four models use Lean's kernel, `Std`, ordinary inductive data, and executable transitions.
There are no `sorry`, custom axioms, `unsafe`, or `native_decide` declarations.

| Module          | Headline theorem                                                                                                                                                                           | Meaning                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Fleet`         | `trace_reservation_bounds`                                                                                                                                                                 | Held reservations stay within global and project-indexed bounds covering initial occupancy and every configured limit in an arbitrary trace. Counts come from the ledger. |
| `Fleet`         | `step_accounting`                                                                                                                                                                          | Admission can grow usage only up to the currently configured limit; reducing limits preserves existing holds.                                                             |
| `Fleet`         | `trace_allocation_identity`, `trace_create_launch_identity`, `trace_receipt_identity`                                                                                                      | Allocation, profile, epoch, create/launch keys, and recorded machine/launch identity remain pinned.                                                                       |
| `Fleet`         | `trace_stop_released_monotone`, `admission_fences`                                                                                                                                         | Stop/release persist through delayed replies; admission requires the stored epoch/profile, delivered launch, run intent, and admissible phase.                            |
| `Fleet`         | `ambiguous_keeps_capacity`, `concurrent_refusal_keeps_capacity`                                                                                                                            | Ambiguous outcomes and a refusal with multiple recorded create attempts cannot free capacity.                                                                             |
| `FleetLease`    | `trace_release_iff_terminal`, `attempted_retained_without_terminal`                                                                                                                        | In this attempted-allocation projection, only terminal evidence newly releases a reservation.                                                                             |
| `FleetLease`    | `arbitrary_time_never_releases`, `step_clears_legacy_deadline`, `stale_deadline_cannot_release`                                                                                            | Clock jumps and old persisted deadlines cannot release capacity.                                                                                                          |
| `FleetLease`    | `trace_original_lease`, `observed_highwater`                                                                                                                                               | Original lease and greatest observed expiry remain diagnostic evidence across restart/profile changes.                                                                    |
| `FleetWorkflow` | `trace_retirement_safe`, `retirement_checks_capture`                                                                                                                                       | Conditional owner-completion retirement cannot stop active assignments or ignore pending capture.                                                                         |
| `FleetWorkflow` | `idle_read_stop_counterexample`, `idle_read_conditional_retirement`                                                                                                                        | The historical unconditional stop loses a claim race; rechecking in the stop writer prevents it.                                                                          |
| `FleetRelease`  | `arbitrary_trace_live_requires_reservation`, `trace_safe`                                                                                                                                  | Under the explicit provider contracts, a live machine retains its reservation through arbitrary command, effect, reply, cancellation, restart, and clock interleavings.   |
| `FleetRelease`  | `materialized_release_requires_terminal`, `released_pending_requires_tombstone`                                                                                                            | Releasing a materialized machine requires observed terminal evidence; outstanding commands after release can only target a permanent terminal tombstone.                  |
| `FleetRelease`  | `sole_no_effect_refusal_releases`, `concurrent_refusal_keeps_capacity`                                                                                                                     | A sole first no-effect refusal can release; refusal of one concurrent invocation cannot.                                                                                  |
| `FleetRelease`  | `trace_original_identity`, `trace_tombstone_absorbing`, `trace_release_retained`                                                                                                           | Original key/profile/lease, provider tombstones, and released state survive arbitrary later commands.                                                                     |
| `FleetRelease`  | `old_timeout_late_create_counterexample`                                                                                                                                                   | The historical timeout rule permits a live machine without a reservation. This is a kernel-checked negative control, not the current rule.                                |
| `FleetRelease`  | `fixed_rule_allows_late_effect_but_holds_reservation`, `delayed_renew_keeps_live_reservation`, `delayed_create_after_terminal_is_tombstoned`, `delayed_renew_after_terminal_cannot_revive` | Arbitrarily delayed effects retain capacity while live and cannot revive a terminal key.                                                                                  |

The theorem names above are qualified by `Merv.<Module>`. Limits are parameters, including a
different limit for every project. Reducing a limit below existing occupancy cannot establish
`occupied <= newLimit` retroactively. The reservation bound covers historical limits; service
tests lower caps and verify that new reservations stop while old ones remain counted. Queued
requests are not reservations; `free()` additionally subtracts queued work.

## Await boundaries and implementation mapping

`Fleet.Command.dispatch` and `reply` are separate transitions. `FleetRelease` separates
`queueCreate` (durably recorded intent), `sendCreate`, provider `createEffect`/`refuseEffect`,
and receipt of the handle/refusal. It also separates stop requests, physical termination,
terminal observation, and release; renewal requests and effects are independent. Cancellation
cannot retract queued or in-flight work. Clocks may jump forwards or backwards and any step
may be delayed indefinitely. There is no bounded-delay or fairness premise.

Production persists `createAttempted` and `createAttempts` before calling the provider. A
crash before send can overcount attempts, which conservatively prevents a later refusal from
proving global absence. The models' operation histories/counters are proof instrumentation,
not a production dispatch journal. In the controlled failed-recovery traces, the adapter call
is sent but fails before any machine effect: `refuseEffect` settles that in-flight operation,
then `lostReply` represents the ambiguous 503 visible to Fleet. It is not `receiveRefusal` and
cannot authorize release. A successful DELETE returning `deleting` remains a pending stop;
it maps to physical stop only when the fake provider actually becomes terminal.

A real `tick()` spans multiple model commands and PostgreSQL writer transactions. The tests
compare ledger and provider checkpoints before send, before effect, before reply, after
persisting replies, before terminal observation, and after release. They compare pinned
identity, attempts, occupancy, stop intent, handle/terminal knowledge, provider state, original
lease, observed expiry, and actual provider expiry; create traces also compare instrumented
queued/in-flight/completed operation counts. Finite conformance does not prove all production
schedules. The per-allocation release theorem complements the global/project ledger theorem;
composition into whole-system physical capacity still requires a refinement argument and
unique allocation keys across ledger rows. Backoff, price policy, remote revision precedence,
full source authorization, profile availability, and all UI phases are not fully modeled.

`FleetWorkflowAdapter.observe()` is advisory. The optional owner `canRetire(allocation, tx)`
rechecks completion in the writer that sets stop. Workflow re-reads
`Sessions.inspectManaged(id, epoch, tx)` for active work, capture, acknowledgement, and its
existing acknowledgement grace. Claims must use that same State writer and Fleet admission.
A vetoed retirement continues through fenced renewal so the new claim does not lose its
machine before the next poll. Explicit cancellation, revocation, deadlines, and shutdown are
outside the owner-completion theorem. Other owners with claimable work need an equivalent
completion contract.

## Provider contracts and safety versus liveness

The provider assumptions remain external obligations:

1. A stable allocation create key and pinned profile identify at most one machine, including
   across concurrent controllers and restarts. Stopped/deleted keys retain permanent dedup
   tombstones. Neither a delayed create nor a delayed renew can revive them. Launch keys and
   bootstrap bytes are stable; a replay cannot execute a different launch. Fleet validates
   identities but does not prove provider execution or stable bootstrap bytes.
2. Terminal observations truthfully describe that pinned machine and are final. A deleting
   state or accepted DELETE alone is not terminal evidence.
3. Definitive no-effect refusals are truthful about the individual invocation. Only a
   provably sole first refusal permits attempted-allocation release without a terminal
   observation. Concurrent invocations, timeouts, conflicts, rate limits, malformed success
   responses, 5xx, and transport failures retain capacity.
4. Controllers share State's serialized writer and policy configuration. Changed limits
   govern new admission; namespace/credential bindings must continue to name the same rental
   scope. Every concurrent controller must implement the durable create-attempt count; an
   old controller that dispatches without it is outside the refusal proof.

There is no 60-second completion allowance, lease-expiry release premise, bounded clock skew,
or eventual-connectivity assumption. `leaseSeconds` and the high-water `leaseExpiresAt` remain
persisted diagnostics; neither authorizes release. `releaseBy` from an older controller is
ignored and cleared during cleanup. This also applies to legacy attempted rows missing lease
evidence. A durable `createAttempted === false` still permits immediate cleanup without
renting a machine.

A lost connection, removed profile, or permanently unavailable provider can therefore hold
capacity indefinitely. This chooses safety over automatic reclamation: repeated same-key
recovery uses the original profile, and terminal evidence eventually permits release if it
becomes available. The proofs do not guarantee that it will. Daily compute accounting includes
all open rentals regardless of creation age and rentals released during the current UTC day;
long-held cleanup does not disappear from the budget. Migration V3 adds the partial released
person/updated-time index, leaving published migrations unchanged. Billing still uses recorded
runtime/price evidence and does not infer an unobserved machine's actual cost.

The historical timeout trace records a create, cancels, passes the old deadline, releases,
and then executes the delayed create. `old_timeout_late_create_counterexample` checks the
result in Lean's kernel. `fleet_release_model` exposes it only through `oldTimeout: true`.
Service tests replay their commands with that option, verify the live-plus-unheld divergence,
and require the normal comparator to reject it. Current production instead retains the slot
and keeps the successor queued until terminal evidence.

## Conformance and regressions

`tests/fleet-lean-regressions.test.ts` runs actual Fleet services against PostgreSQL and a
controlled fake provider, comparing checkpoints with all four JSON CLIs: `fleet_model`,
`fleet_workflow_model`, `fleet_lease_model`, and `fleet_release_model`. Coverage includes:

- global/project caps, multiple projects, per-project overrides, admission epochs, concurrent
  controllers, in-flight reservations, launch identity, restart, and lower limits;
- delayed creates through cancellation, multiple failed recoveries, expired legacy deadlines,
  restart, queued replacement, terminal release, and replacement progress, with delays through
  90 days; a create queued before release later returns the same key's terminal tombstone;
- a due renewal paused before effect, concurrent cancellation and uncertain stop, a clock jump
  30 days past its original expiry, a held slot and queued successor, actual delayed lease
  extension, and eventual terminal release;
- known and lost-create replies across profile replacement, offset expiry timestamps,
  high-water retention, missing legacy evidence, and terminal reconciliation;
- malformed HTTP 408/409/429 error envelopes through the actual Sandboxes adapter into Fleet;
- sole versus concurrent first refusal, workflow claim/retirement races with renewal due,
  completion versus active work/capture/acknowledgement, and launch identity conflicts.

Negative controls also enlarge a real Fleet cap, drop an in-flight hold, replace the original
lease diagnostic, and replay unconditional retirement. Each comparison must reject the
mutation. `tests/fleet.test.ts` additionally checks long-held/recently released daily spend and
the production query's index plans. These tests assume the fake provider contracts, rather
than proving a remote service implements them.

From `merv-typescript`, after `npm run verify:lean`:

```sh
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv MERV_REQUIRE_LEAN=1 \
  node --import tsx --test tests/fleet.test.ts tests/fleet-lean-regressions.test.ts
```

Every CLI emits an observation after each command. Tests require a built executable or Lean
on PATH; `MERV_REQUIRE_LEAN=1` makes missing models fail instead of skipping.
