# Backend protocol verification

This workspace contains executable Lean specifications and machine-checked safety
proofs for independent backend protocols and selected cross-plugin product contracts.
TypeScript conformance tests compare the
models with real services and durable stores. These layers do not constitute a
verified translation of TypeScript, PostgreSQL, Git, an operating system, or an
external provider.

The deployed Sandboxes provider has a reproduced terminal-report race. Its repaired
candidate has a durable-admission proof and regression suite, with migration and
unknown-outcome limits in [the provider boundary](../provider-boundaries/README.md).
Physical capacity safety remains open for the currently deployed provider.
The [backend product contract map](PRODUCT.md) describes the new composition
models, real-service checks and remaining boundaries.

## Run

Install [elan](https://github.com/leanprover/elan) and put its binaries on `PATH`.
`lean-toolchain` pins Lean; the models use no external Lean library dependencies.
From `merv-typescript`:

```sh
npm run verify:lean
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv npm run test:lean
```

`verify:lean` builds the model executables and proofs, audits every declaration in
the `Merv` namespace, and checks that injected axioms and unfinished proofs fail.
It needs no database. `test:lean` rebuilds and requires the models, then runs the
`tests/*-lean-*.test.ts` comparisons, regressions, concurrency checks and negative
controls. The database role must be able to create schemas; fixtures remove their
own schemas. Use a local test database, not production.

The earlier `test:workflow-lean` command still selects the original workflow and
review suites. Ordinary `npm test` may explicitly skip a comparison whose model
has not been built. The dedicated command and CI set `MERV_REQUIRE_LEAN=1`, so
missing models are failures. `MERV_LEAN_MUTATIONS=1` enables the original model
mutation control; the new suites also exercise deliberately faulty adapters or
implementation mutations as documented for their area.

CI has a dedicated Lean job: it installs the pinned compiler, builds and audits
the proofs, and runs conformance against PostgreSQL in that same job. Ordinary
server shards exclude `*-lean-*` tests. No job assumes another job's local build
output is present.

## Independent proof areas

| Area                                   | Models and documentation                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Workflow transitions and review claims | `Workflow.lean`, `Invariants.lean`, `Admission.lean`, `ReviewClaims.lean`; [original coverage](COVERAGE.md)      |
| Sessions and workflow dependencies     | `SessionOwnership.lean`, `WorkflowDependencies.lean`; [scope and correspondence](SESSIONS.md)                    |
| Identity and Scope                     | `IdentityCredentials.lean`, `ScopeAuthority.lean`; [scope and correspondence](IDENTITY_SCOPE.md)                 |
| Fleet and Fleet Workflow               | `Fleet.lean`, `FleetWorkflow.lean`, `FleetLease.lean`, `FleetRelease.lean`; [scope and correspondence](FLEET.md) |
| Runner                                 | `RunnerOwnership.lean`, `RunnerSettlement.lean`; [scope and correspondence](RUNNER.md)                           |

Each independent area owns a local model and states the assumptions it makes about
other services. The [product models](PRODUCT.md) compose selected boundaries;
sharing a toolchain alone does not discharge all cross-plugin assumptions.
This integration contains infrastructure protocols. The earlier independent Code
and Code Research work remains in its separate verification checkout.

## Edge cases retained

| Area         | Cases that must remain visible                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions     | An old exact release cannot free a successor; expiry equality denies admission; replacement registration invalidates a prepared invocation; a consumed invocation cannot act twice.                                                                                                                                            |
| Dependencies | Concurrent reverse-edge additions cannot both commit; failed declared prerequisites differ from pending system prerequisites; a no-op addition may record a receipt without advancing revision.                                                                                                                                |
| Identity     | Wrong-service renewal/revocation cannot mutate the row; re-adoption cannot undo revocation; renewal cannot cross the original hard deadline.                                                                                                                                                                                   |
| Scope        | Remove/re-add and role restoration do not revive a captured membership epoch; project keys cannot cross projects; trusted review-service vouchers are an explicit exception to ordinary permission-subset delegation.                                                                                                          |
| Fleet        | Lost replies and arbitrarily late creates or renewals still consume capacity; elapsed time never releases an attempted allocation; terminal provider evidence permits cleanup; retries retain the original identity; one create refusal cannot cancel a concurrent create; idle observations require a final retirement check. |
| Runner       | A claimed or pinned uncertain launch cannot authorize a replacement; cancellation races the guardian claim; successful group termination needs evidence; a network effect followed by a crash can require a retry before the local completion marker.                                                                          |

These cases are examples and regression obligations, not an exhaustive list of
all implementation behaviors. The proofs cover arbitrary traces of the stated
models; correspondence tests and reviews check where those models fit the code.

The transition model still accepts `initialReceipts` so its comparisons can
include the workflow's already-persisted start receipt. Its history/receipt
count equality concerns that transition protocol, not every workflow command:
for example, a no-op dependency addition can record a receipt without a new
history entry.

## What the checks establish

Lean proofs quantify over the model's stated states, parameters and execution
traces. The executable tests use bounded, reproducible scenarios to check the
connection to the implementation; passing them does not prove every TypeScript
execution. Counterexample tests retain concrete failure sequences, including
lost replies and changes between asynchronous checks. Successful and recovery
traces also matter: refusing all work would not satisfy the intended contract.

Models should retain the distinctions needed to falsify a property: competing
rows for ownership, historical credential versions, and remote operations in
flight. They should derive local authority from records rather than accept the
very property under test as an unexplained Boolean. Model parameters express
contract choices; tests normalize generated identities and inspect meaningful
effects rather than freezing whole response snapshots or SQL statement counts.

[`Audit.lean`](Audit.lean) requires the headline results to remain theorems and
checks all `Merv` declarations, including helpers. Only Lean's standard `propext`,
`Classical.choice`, and `Quot.sound` axioms are allowed. `sorryAx` and custom axioms
are rejected, and compilation treats warnings as errors. The axiom audit does
not replace review of theorem statements and external assumptions.

Database serialization and rollback, faithful time and identity representations,
cryptographic primitives, truthful terminal provider evidence and OS process semantics
remain explicitly bounded assumptions in the corresponding models. Scientific
judgment, full research orchestration and unconditional liveness are outside
this work.
