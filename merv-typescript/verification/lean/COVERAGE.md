# Workflow and review verification scope

This is a set of executable specifications with machine-checked safety proofs
and implementation comparisons. It is not a verified translation of TypeScript.
Each model has a deliberately stated boundary; passing samples do not close the
gap between the model and every production execution.

This document describes the original workflow-transition, admission and review
models. See [Sessions and dependencies](SESSIONS.md), [Identity and Scope](IDENTITY_SCOPE.md),
[Fleet](FLEET.md), and the [workspace index](README.md) for the independent additions.

| Model               | Proved properties                                                                                                                                                                                                                                                                                                                                    | Implementation checks                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workflow.lean`     | Allowed edges; terminal preservation; fresh stale-revision refusal; receipt recording, preservation, and no second commit after arbitrary intervening commands.                                                                                                                                                                                      | Generated traces through the real workflow service, including successful retries and request conflicts.                                                                                |
| `Invariants.lean`   | Every step preserves the store or increments revision, history, and receipt count together; revision monotonicity; history/revision and receipt/history consistency over arbitrary traces; chosen edges belong to the graph; states remain declared.                                                                                                 | Compare durable snapshot, returned snapshot, history count, request count, and transition-event count after every command.                                                             |
| `Admission.lean`    | Preflight refusal precedes replay; guard failure preserves the store; late registration withdrawal rolls back the modeled effect; a committed effect requires preflight and later checks and agrees with the core transition.                                                                                                                        | Handle-only API, revoked caller refusal, wrong handle, revoked actor replay, policy refusal, withdrawal during an awaited guard and after event insertion, and retry after rollback.   |
| `ReviewClaims.lean` | Pinned evidence preservation and submitted verdict terminality across arbitrary traces; successful submission requires current permission, independence, live ownership, and the matching claim; nondecreasing claim generations; stale claims cannot submit; old revocation events and mismatched release requests cannot release the active claim. | Real review service with retained evidence, fresh/repeated claims, current independence changes, release/reclaim, stale submission, delayed revocation, and immutable submitted state. |

## Trace coverage

The implementation boundaries are [`transitionInternal`, `replay`, and `record`](../../packages/workflows/src/commands.ts),
the [graph validator](../../packages/workflows/src/definition.ts),
[`checkStart`, `checkSubmit`, `releaseClaim`, and `releaseClaims`](../../packages/reviews/src/index.ts),
and [PostgreSQL transaction serialization](../../packages/state/src/postgres.ts).
Recheck these mappings whenever those functions change; a proof that compiles
against an outdated model does not establish the changed implementation's behavior.

Workflow differential tests use five valid graphs: a review cycle, a self-loop,
a branching graph, a terminal initial state, and a reachable nonterminal dead end.
Three deterministic seeds per graph cover every declared state and all five core
outcome classes. A start receipt is seeded explicitly, so reuse of the start
request ID by a transition must conflict. The model still treats fingerprints as
opaque tokens; tests construct tokens from the concrete payload being compared.

The review comparison drives the real claim service and manually delivers retained
revocation events. Its dynamic directing-authority provider is controlled by the
fixture to test changes in independence at submission. This exercises the service's
admission and recovery handlers, not the entire event delivery infrastructure or
the scope provider's own identity derivation.

## Atomicity and concurrency

The TypeScript atomicity suite uses two independent database connections to race
commands against the same revision. It checks exactly one advances, the failed
request has no receipt, and the loser can retry at the new revision. It also injects
failures at receipt, history, and event insertion, and after a transition inside an
outer transaction. Every injection must fire; each refusal must preserve durable
state and permit the same request to be retried successfully.

Lean reasons over serialized atomic steps. PostgreSQL's schema-wide advisory lock
and transaction rollback remain assumptions of that abstraction, supported by these
implementation tests. This is not a proof of PostgreSQL, crash recovery, or every
asynchronous interleaving. A caller that catches a failure and commits a supplied
transaction without rollback is outside the rollback contract.

## Checks that verification can fail

The axiom gate enumerates every declaration under `Merv`, including helper
definitions. Required headline results must remain theorems, and all dependencies
must belong to Lean's standard three-axiom allowlist. The verification command
also compiles disposable copies containing a custom axiom and an unfinished proof;
both must fail for the expected reason.

With `MERV_LEAN_MUTATIONS=1`, the conformance test creates a disposable executable
model that incorrectly returns current state on replay. The same comparator must
reject it against the real service. The checked-in model is never modified. This
negative control checks the test harness; it does not replace the model proofs.

## Remaining boundaries

- Input syntax, canonical hashing and collision resistance, cryptographic identity,
  and tenant discovery are outside the proofs. Scope policy has its own model;
  this workflow model does not prove composition with it.
- Admission models the ordering and consequences of externally supplied permission,
  ownership, and registration checks. It does not derive those predicates from
  the complete identity/session database.
- Review commands use fresh submission request IDs and valid assessment payloads.
  The review receipt/replay protocol, supersession, verdict routing, and scientific
  assessment quality are excluded. Generated claim IDs are assumed fresh and
  event IDs correspond to committed log order.
- Counts abstract full workflow history/event rows; timestamp values, arbitrary
  payload merging, additional escalation events, blocker cleanup, migrations,
  numerical overflow, and process crashes are excluded.
- Workflow receipt/history equality is conditional on an initially consistent
  store, such as the single-instance fixture seeded with its start receipt. A
  project's unrelated instance receipts must not be counted as that instance's
  history. No-op dependency additions also record receipts without new history,
  so the equality does not extend to every command on an instance. State-closure
  proofs assume registered graph destinations are declared.
- Session ownership, sampled expiry, and dependency DAGs now have separate
  models. Their composition with these workflow and review models, loop budgets,
  and research or reflection orchestration remain future verification work.

No liveness claim is made. Valid workflows may loop, have nonterminal dead ends,
or wait indefinitely on external agents.
