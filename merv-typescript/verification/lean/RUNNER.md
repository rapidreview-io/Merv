# Local Runner proofs

These modules verify the local Runner controller/guardian protocol. They accompany
the production implementation without changing it. `MachineRunner` is the production Runner
controller class exercised by the tests.

## Build integration

| Module             | Main                   | Executable                | Environment override                 |
| ------------------ | ---------------------- | ------------------------- | ------------------------------------ |
| `RunnerOwnership`  | `RunnerOwnershipMain`  | `runner_ownership_model`  | `MERV_RUNNER_OWNERSHIP_LEAN_BINARY`  |
| `RunnerSettlement` | `RunnerSettlementMain` | `runner_settlement_model` | `MERV_RUNNER_SETTLEMENT_LEAN_BINARY` |

The shared Lake workspace registers both executables and audits their model declarations.
The default executable directory is `verification/lean/.lake/build/bin`.

## Ownership claim and proof boundary

`RunnerOwnership.lean` models one retained reservation, arbitrary natural-number
identities for competing guardians, and arbitrary finite command traces. The claim is
per reservation, not a global limit of one worker across all Runner launches. SQLite
serializes the competing `reserved → starting` compare-and-swap and reserved cancellation.
The pinned hash abstracts the command together with its scoped session token.

`Durable` separates phase, historical claimed status and pinned command from volatile
guardian identity, group ownership, observed lifecycle, shutdown and kill witnesses.
The `claimed` field summarizes history; production has no extra claimed column.
`claims`, `ownerSpawns` and `workerStarts` are unbounded ghost natural numbers. The state
type does not require their bounds. The transition function increments them at claim,
group-owner creation and actual worker spawn respectively; induction proves the bounds.
Pinning and owner creation are one uninterrupted guardian callback in the model, while
worker start is a separate IPC delivery. The pinned-but-no-owner crash case is a safe
overapproximation of the owner-created state: it grants no extra launch permission.

Headline theorems in namespace `Merv.RunnerOwnership`:

- `arbitrary_trace_safe`, `at_most_one_claim_and_owner`,
  `at_most_one_worker_start`: at most one admitted guardian, one owner creation and one
  worker start for every trace from the initial reservation.
- `pin_precedes_owner_creation`, `pin_precedes_start`,
  `arbitrary_trace_pin_retained`: worker/owner effects require a durable pin, which
  remains unchanged through every continuation.
- `exact_launch_replay`, `conflicting_launch_replay`, `pinned_replay_no_effect`:
  exact replay acknowledges, conflicting replay refuses, and neither creates a worker.
- `cancellation_wins`, `claim_wins`: the first atomic operation determines which path
  remains available. A later cancellation of a claimed reservation has no effect.
- `terminal_preserved`: arbitrary continuations preserve a terminal row and its effects.
- `uncertain_cannot_claim`, `unproven_exit_is_uncertain`: uncertainty does not grant a
  replacement guardian; an owner exit without the group-kill witness stays uncertain.
- `guarded_no_pin_timeout`, `pinned_timeout_is_uncertain`,
  `no_pin_timeout_has_no_worker`, `known_different_boot_ends`: the timeout checks the
  durable pin at its write; a pinned row needs termination evidence, such as a known
  different boot, rather than mere elapsed time.

The model represents approved controller and guardian transitions. It does **not**
prove safety for arbitrary SQL writers or callers using unrestricted
`LocalLedger.end(..., 'open')`. Terminal stuttering abstracts controller early returns
and the SQLite immutable-terminal trigger. Deadline arithmetic, authentication,
validation, socket setup and synchronous spawn failures are outside the executable
trace alphabet. The effect bound safely overapproximates failures that create fewer
processes. There is no eventual-launch or eventual-termination claim.

Explicit assumptions, not Lean theorems:

- SQLite executes each statement atomically and preserves committed rows and triggers;
  the filesystem provides the requested private-directory and durability behavior.
- IPC is authenticated, command hashes distinguish different command/token inputs,
  and only the claimed guardian delivers lifecycle events for its own group owner.
- Node/OS child identity, IPC ordering and exit observation behave as required by the
  production supervisor. A successful kill of that live owned process group plus its
  observed SIGKILL exit establishes termination of the group. The VM supplies this
  witness; it does not prove those OS facts.
- A known, changed boot identifier proves old local processes gone. An unknown boot
  identifier is not evidence. The timeout observation means the required 60 seconds
  have elapsed, and the final SQL no-pin predicate still arbitrates the race.
- No outside writer resets a claimed row to reserved, removes a pin or rewrites terminal
  state. Multiple normal guardians/controllers remain in scope.

## Settlement claim and proof boundary

`RunnerSettlement.lean` models terminal release/report debt, an **abstract** durable
workspace driver, capture, one pre-existing receipt debt, workspace-result debt, close,
and the final settled marker. Driver absence blocks later stages after release. A
workspace-free launch can settle without workspace operations. An uncertain launch
cannot enter settlement without an explicit termination witness.

`Debt.done` is a persisted completion marker; `Debt.calls` is an unbounded ghost count.
A retry or crash increments the count without setting the marker. Capture may be called
again while later debt remains; neither capture nor close is claimed to have exactly
one invocation. Receipt acknowledgement and driver capture/closed status belong to the
abstract driver's journal, not the Runner ledger.

Headline theorems in namespace `Merv.RunnerSettlement`:

- `arbitrary_trace_completed_debts`: after a release, receipt or result marker is set,
  every continuation preserves both that marker and its call count, including restarts
  and driver disappearance/reappearance.
- `arbitrary_trace_settlement_safe`: a closed workspace has capture, release, receipt
  and result completion; settled state requires terminality, release completion and a
  closed workspace when present.
- `completion_marker_blocks_attempt`, `uncertain_cannot_settle`.
- `crash_window_repeats_call`: two invocations occur when the first remote effect is
  followed by a crash before the local marker. There is **no exactly-once-invocation
  theorem**. Remote idempotence is an external API obligation.

Successful answers and final refusals both discharge debt; retryable refusals do not.
The abstract driver must truthfully persist its journal and implement the driver
contract. These proofs say nothing about Code checkout, Git, commit correctness,
transport publication, or remote receipt idempotence. Fresh receipt discovery and
multiple debts can require additional protocol reasoning; this slice follows one
already journalled receipt through settlement.

## Conformance and negative controls

`tests/runner-lean-ownership.test.ts` uses real `LocalLedger` and Node SQLite. It evaluates
the production `supervisor.mjs` source in a deterministic VM, removing only import
syntax and binding imports to real crypto/filesystem/SQLite or explicit process/socket/
timer event doubles. Guardian and group-owner function bodies are unchanged in the
positive runs. It compares phase, pinned command identity, launch reply and actual
admission/owner/worker counts with the compiled Lean executable after each command.
It also reads the actual ledger inside the owner and worker spawn doubles, requiring
the command pin to be committed before either creation effect.

Coverage includes competing guardians, both cancellation orderings, exact/conflicting
replay, repeated group start messages, natural exit and stop, successful/absent kill
witnesses, uncertain recovery by the original guardian, controller timeout, lost guardian,
no-pin expiry, boot change and missing boot evidence. A stale no-pin read races an actual
guardian pin before the real `LocalLedger.end` predicate executes. A bounded real-process
case drives six concurrent `ProcessHost.launch` calls against a synthetic worker and
checks one append-only start effect, conflicting replay and terminal preservation.
Cleanup uses the production host stop protocol, a short worker deadline and scratch
paths; it never signals a saved PID.

Negative controls alter only VM source or disposable test databases: remove the claim
predicate, remove the command-pin replay guard, admit a replacement from uncertain,
and drop the actual terminal trigger. The same comparator rejects their observable
admission, spawn or terminal effects. The late terminal-write test additionally verifies
that the real trigger rejects a delayed production callback.

`tests/runner-lean-settlement.test.ts` drives real `MachineRunner.start()` / `tick()` with
real `LocalLedger`, `ProcessHost`, `RunnerClient`, a stand-in HTTP server and a scratch
abstract driver. No checkout is prepared and the disabled profile cannot launch work.
The driver stores capture/closed/receipt-ack markers in a scratch JSON journal. A
simulated process crash closes local resources without graceful settlement, then builds
a new controller and reopens persisted state. Production metadata writes and the abstract
acknowledgement method inject crashes immediately before local completion markers.

The release/report crash test seeds a remotely closed managed assignment, so its pending
usage/release acknowledgement remains a network debt even after remote closure. It
observes two successful remote effects for release, receipt and result when each local
marker write is interrupted; after completion all three counts remain fixed. Final
refusals, retryable refusals, capture/close interruption, missing/reintroduced driver,
workspace-free settlement and uncertainty are compared at each checkpoint. Negative
controls suppress release/receipt/result markers or supply unearned termination evidence;
the comparator detects all four.

These are finite production conformance tests plus unbounded Lean induction proofs,
not a formal refinement proof of the TypeScript/JavaScript runtime. Mutation controls
run unconditionally. `MERV_REQUIRE_LEAN=1` makes missing executables fail instead of skip.

## Focused commands

From `merv-typescript` with the pinned Lean compiler on `PATH`:

```sh
npm run verify:lean
MERV_REQUIRE_LEAN=1 node --import tsx --test tests/runner-lean-ownership.test.ts tests/runner-lean-settlement.test.ts
node --import tsx --test tests/runner-process.test.ts tests/runner-settle.test.ts
```

No database service is required. Generated C, Lean object files and executables stay in
`.lake/build`. The axiom gate rejects proof holes and custom axioms.

## Explicit exclusions

Code and Code Research implementations, Git correctness and checkout behavior are
outside this proof. No Code implementation class is imported by the new tests.
Abstract receipt descriptors and Runner's existing transport contract are the only
receipt boundary used here. Composition with Sessions/Workflows, Scope/Identity and
Fleet remains separate work.
