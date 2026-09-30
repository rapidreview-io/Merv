# Backend authority composition

`BackendAuthority.lean` composes Identity, Scope, Sessions, API Tools and Mounts
at local admission and remote dispatch. The native oracle is
`backend_authority_model`, rooted at `BackendAuthorityMain`. This slice excludes
research/scientific policy. It reuses `IdentityCredentials` for credential
liveness and irreversible lifecycle, `ScopeAuthority` for current roles and
retired membership epochs, and `SessionOwnership` for leases, execution
registration, expiry, release and revision checks.

## Reproduced defects and fixes

Two deterministic regressions failed against the original API registry, using
real PostgreSQL, Scope, Identity credentials, Workflows and LeasedSessions:

1. During the final remote grant await, removing or reinstalling the session
   policy did not prevent the previously prepared invocation from entering the
   effect handler. A final synchronous registration fence now runs immediately
   before handler dispatch.
2. During an actual MCP caller connection's initialization, reinstalling the same
   Sessions object let `validateSession` adopt the new registration and send the
   old request upstream. The registry now retains its preparing registration in
   an `AsyncLocalStorage` handler context. Mounts' existing post-connect
   revalidation fences that original registration before and after validation.

The changes are in `packages/api/src/registry.ts`. They preserve completed
mutation results, allow fresh calls under a replacement registration, and retain
catalog draining semantics. No global transaction or writer lock is held while
an MCP connection initializes. Existing provider replacement and completed
mutation tests continue to pass.

## Proved model facts

All 36 theorem declarations are in `Merv.BackendAuthority`. The model stores raw
records, preparation snapshots and effect observations. None of these data types
contains a proof or an externally supplied authorization flag. The dispatch
predicate computes authority from the records; induction proves its effect-log
invariant over arbitrary command lists, including arbitrary starting worlds
with empty logs.

- `arbitrary_trace_dispatch_safety` / `empty_trace_dispatch_safety`: every recorded
  effect has the exact prepared request, live preparing provider and execution
  generations, and a binding selected by the dispatch-time holder and grant.
- `binding_requires_exact_holder_grant`: selection requires matching project,
  effective actor, mount and tool in an actual grant, and a matching binding in
  the admitted mount load's configuration. Discovery identity is never an
  authority fallback.
- `credential_requires_live_exact_record`: direct/source credential authority
  requires an exact project/actor/credential relation plus a live Identity row
  with the modeled Scope owner, subject and credential kind.
- `session_holder_requires_current_records`: a worker must match the current
  project, worker actor and session row, have a usable execution lease, a live
  execution credential and a currently authorized delegation source. Mixed
  direct-credential/session authority is refused. Member sources pin their
  actor's membership epoch; independent sources require their original live
  actor credential and write permission.
- `arbitrary_composed_trace_cannot_revive_credential` and
  `arbitrary_composed_trace_cannot_resurrect_source`: arbitrary interleavings of
  credential lifecycle, membership changes, session lifecycle, grant/config
  changes, preparations and dispatches cannot revive a revoked Scope credential
  or a retired membership source.
  `arbitrary_trace_execution_credential_revocation` gives the same irreversible
  result for a revoked session execution token. `source_live_requires_exact_source`
  unpacks the member or independent credential relation used by each source.
- `arbitrary_trace_retired_provider_cannot_recover`: once a provider generation
  has advanced beyond a prepared worker request, further changes cannot make
  that request current again.
- `arbitrary_trace_consumed_cannot_dispatch`: cancellation/consumption remains
  permanent across arbitrary traces. `wrong_identity_denied` rejects substituted
  prepared identities.
- `fresh_prepare_then_dispatch_progress` and `authorized_dispatch_progress`:
  under explicit fresh-ID, published-tool and current-record premises, a fresh
  preparation dispatches exactly one additional effect. This is a constructive
  finite progress result, not a scheduler-fairness or eventual-network-success
  claim. `reinstall_fresh_request_recovers` is an executable recovery witness.
- `catalog_replacement_preserves_admitted_authority` and
  `binding_replacement_preserves_admitted_selection`: replacing a catalog/load
  cannot reinterpret an already admitted handler's tool or credentials. Current
  grants and Scope authority still co-decide dispatch. New preparations capture
  the successor's bindings.
- `provider_mutant_counterexample`, `revoked_credential_counterexample` and
  `expiry_boundary_counterexample` give kernel-checked concrete witnesses,
  including a stale-provider algorithm that wrongly dispatches after reinstall.

The proof audit uses only Lean's standard `propext`, `Quot.sound`, and (where
reported) `Classical.choice`. There are no custom axioms, admitted proofs or
native-decision proof shortcuts. The JSON executable serializes the same
transition functions used by the theorems.

## Finite production conformance

`tests/backend-authority-lean-conformance.test.ts` drives actual production
services against a fresh PostgreSQL schema. The only workflow is a small
non-research lease fixture backed by SQL. Registry probes record real SQL effects;
mount probes use real HTTP and MCP SDK connections to `CredentialServer`, which
independently records accepted tool requests and upstream connection identities.

The test does not reproduce an authorization algorithm in TypeScript. It sends
commands and normalized identity symbols to the compiled Lean executable and
compares outcomes, effect counts and upstream identities. Larger oracle input
and output both use regular files, avoiding macOS pipe hangs. Schema-generated
IDs, credential hashes and membership actors are mapped to stable natural
symbols, not hashed or compared by a TypeScript oracle.

Representative cases include:

| Boundary                  | Exercised cases                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepared registry request | Stable progress; absent/reinstalled policy; current grant removal/restoration; source actor and credential revocation; Identity-only revocation; execution-token revocation; closed lease; workflow replacement; exact expiry and one millisecond before expiry             |
| Identity composition      | Wrong project, actor, credential or session; mixed credential/session caller; foreign invocation ID; caller mutation after preparation; consumption and cancellation                                                                                                        |
| Member delegation         | Role downgrade; downgrade then re-upgrade; remove then re-add; old worker remains denied while fresh current membership can write                                                                                                                                           |
| Real cold MCP connection  | Provider removal/reinstallation, grant removal/restoration, source/execution credential revocation, closed execution, workflow replacement and expiry during a held initialize request                                                                                      |
| Mount/catalog lifetime    | Dedicated discovery connection; caller uses source binding; admitted catalog drains after withdrawal; replacement cannot change captured handler; old cold load drains with old credentials while successor uses changed credentials; old cleanup cannot withdraw successor |
| Failure and recovery      | Deterministic upstream initialization failure; failed connection retirement; fresh invocation succeeds; exact missing bindings; revoked local Merv token refused as upstream bearer                                                                                         |

Barriers hold production preparation, the final real grant call, or the mock
server's actual MCP initialize/call endpoint. No sleep creates the race. Barrier
entry must occur before the pending invocation completes. Repeated calls and
fresh calls after recovery exercise successful behavior as well as denial.

Three always-on mutation controls each execute the real effect and then require
the comparator to detect a mismatch: remove the registry's provider fence,
revalidate a cold connection through the current provider, and select discovery
credentials for a caller. They alter one production seam while retaining the
real services, database and MCP transport.

## External assumptions and limits

These are model theorems plus finite implementation evidence, not a proof that
all TypeScript executions refine Lean.

- PostgreSQL isolation, SQL constraints, Node async-context propagation, the MCP
  SDK, JSON cloning/validation, token hashing, unique IDs and correct service
  implementations are external. The model uses atomic administrative changes
  and dispatch decisions. Deterministic barriers test representative await
  interleavings, not every microtask, cross-process race or transaction schedule.
- Dispatch means entering the local effect sink or sending an upstream tool
  request after local admission. It does not prove the upstream's authorization,
  idempotency, rollback, eventual response, or cancellation after a request was
  sent. A revocation after dispatch does not erase the historical effect.
- The fixture uses producer sessions and one permitted remote tool. General
  grant/identity predicates range over natural IDs, but the tests normalize a
  small set. Full role/subset properties remain in `ScopeAuthority`; arbitrary
  workflow policy correctness, research policy, managed/conversation callers,
  persistent-agent credential selection and authentication transport parsing
  are outside this composition. The execution credential is normalized by
  session ID; production resolves its stored token hash in the Identity ledger.
- Membership actor identity is its immutable epoch in the abstraction. Member
  delegation uses the pinned epoch, not a refreshed human login. Independent
  actor and execution credentials have distinct modeled owners/kinds.
- Mount binding configuration is immutable for a load. A preparation captures
  its catalog handler and that load's raw bindings; current Scope records and
  grants are still read at dispatch. A successor load does not retroactively
  change an admitted old connection. Catalog replacement and session-provider
  replacement intentionally have different lifetime rules.
- Local provider identities are modeled by unbounded increasing naturals;
  production uses registration-object identity. Distributed registry consensus
  is not asserted. Clock samples may move backwards; expiry is proved at the
  sampled decision time, while revocation/epoch/provider retirement remains
  irreversible across arbitrary traces.
- Session audit observations and terminal cleanup can write even when the
  modeled tool effect is denied. Model effect-count preservation does not mean
  zero database writes. Handler-internal transactional authorization remains
  necessary for native mutations.

## Reproduction

From `merv-typescript`, with the configured PostgreSQL service running:

```sh
# Install the pinned Lean toolchain as described in README.md.
export MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv
(cd verification/lean && lake build BackendAuthority backend_authority_model)
MERV_REQUIRE_LEAN=1 node --import tsx --test tests/backend-authority-lean-conformance.test.ts
npm run typecheck
```

The shared `test:lean` command builds and audits this target and includes its
conformance tests. The dated product verification report records the combined
checks and reproduced failures.

Validation on 2026-09-29: both Lake targets built; all 36 theorem axiom audits
passed; 40 new composition tests and the focused existing regression suites
passed (126 tests total, no failures or skips). TypeScript typechecking, Prettier
and the owned production diff whitespace check passed. The final suite also
includes `session-policy-generation`, `session-authority-generation`,
`remote-registry`, `mount-upstream`, `scope-ledger-drift`, `mount-unload` and
`remote-permissions`.
