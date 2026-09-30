# Backend product contracts

This pass moves from independent plugin models to selected contracts between
backend services. It deliberately excludes research decisions, scientific review
quality and research-program policy. It does not claim every product execution
has been verified.

| Boundary                                   | Model and real-service checks                                                                                                                                                                                                   | Failure schedules and positive cases                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity → Scope → Sessions → Tools/Mounts | [BackendAuthority](BACKEND_AUTHORITY.md) composes existing credential, scope and session models; PostgreSQL services and local MCP transport exercise dispatch.                                                                 | Revocation, expiration equality, changed project/actor/session, captured membership epoch, policy replacement while awaiting permission, connection setup, caller connection isolation, fresh admission after replacement.                       |
| State → Domain Events → consumer writes    | [BackendEvents](BACKEND_EVENTS.md) models publisher/event atomicity and consumer/effect/cursor atomicity; real independent State connections and dispatcher execute the schedules.                                              | Publisher and handler rollback, sequence gaps, skipped event types, retry deadlines, stale failure reports, loss of response after commit, detach during delivery, restart, cross-connection polling and recovery.                               |
| Scope → Artifacts → Blobs                  | [BackendStorage](BACKEND_STORAGE.md) reuses Scope authority and relates tickets, objects and attachments; production storage services run against PostgreSQL and an S3 protocol fixture.                                        | Wrong owner/project/content, request-ID conflicts, concurrent finalization, revoke/expire during blob reads, orphan bytes after failed attachment, object/SQL lost replies, outage, retries and restart.                                         |
| Shared relay → Fleet and Pi token ledgers  | [BackendRelay](BACKEND_RELAY.md) separates reservation, external dispatch, terminal usage and callback commit; real HTTP relay and PostgreSQL ledgers are compared with Lean.                                                   | Malformed/overflowing totals, valid zero, duplicate terminals, partial/error streams, definite refusal, ambiguous failure, crash before callback and original-day retention.                                                                     |
| Fleet → Sandboxes registry → cloud         | `BackendProviderBoundary.lean` reuses the Fleet theorem through an explicit correspondence premise retains a counterexample when that premise fails; its `Durable` namespace proves the repaired admission/settlement protocol. | A provision call pauses, deletion sees no machine, the registry reports terminal, capacity is released, then the machine appears. The deployed provider regression remains red; the repaired candidate has separate checks and migration limits. |

The retained independent Sessions, WorkflowDependencies, Identity, Scope, Fleet,
Runner utility proofs continue to run in the same suite. This pass does
not extend the earlier Code Research models or formalize new research logic.

## What is proved, and what is checked

The model theorems quantify over arbitrary finite traces and their stated
parameters. Records carry ordinary data; critical relationships are invariants
to prove rather than fields supplied as proof objects. Independent model
definitions are reused where their contracts fit the combined protocol.

Conformance tests run the native Lean executables and the actual TypeScript
services, then compare durable state or observable effects. Controlled pauses
expose interleavings at asynchronous boundaries. They include successful work
and recovery, so rejecting every request is not sufficient to pass. Deliberately
broken guards, effect/cursor behavior and stale authority are negative controls.
These bounded comparisons are evidence of correspondence, not a verified
TypeScript-to-Lean compiler or exhaustive exploration of the production program.

`npm run test:lean` builds and audits all models before running these checks. The
dedicated CI job requires the binaries and PostgreSQL; an unavailable oracle is
a failure. The separate source files under `verification/lean` express contracts;
the test suite checks the implementation against them. Scenario IDs and generated
database identities are fixture details, not product invariants frozen into the
proofs. A legitimate contract change should update both specification and tests.

## Remaining boundaries

- **Physical capacity is still open for the current Sandboxes provider.** See the
  [reproduced failure](../provider-boundaries/README.md). The passing local suite
  must never be reported as an end-to-end machine-capacity guarantee.
- Token reservation estimates are not proven bounds on external model billing.
  A valid report larger than its estimate is charged in full; receive-to-persist crashes can retain excess reservations. This is documented in the relay contract.
- PostgreSQL serialization/durability, cryptographic hashing and signatures,
  S3 conditional persistence, transport truthfulness, and OS process semantics
  remain explicit assumptions rather than Lean implementations.
- Authorization has a defined admission point. Revocation does not erase an
  effect already admitted, and already issued signed storage capabilities follow
  their own expiry contract. Local rollback cannot undo a remote side effect.
- Full Pi conversation/host movement, Context Builder assembly, Web/Nisa response
  semantics, deployment orchestration, migrations across mixed-version services,
  and all HTTP/UI routes are not newly formalized by this pass. Existing ordinary
  tests remain useful evidence for those areas. No unconditional availability or
  eventual-completion theorem is claimed under arbitrary crashes or outages.

The dated product verification report records the exact local checks and fixes.
Keep this contract map current rather than interpreting historical test counts
as a complete inventory.

The [interruption-hardening record](../infra-hardening-2026-09-30.md) adds real
process-kill checks and production-canary evidence. Its release scope excludes
Code and Code Research runtime changes.
