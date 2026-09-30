# Sessions and workflow dependency proof boundary

These local models prove protocol safety, not a translation of TypeScript or a
proof of the identity providers, PostgreSQL, arbitrary plugins, or external tools.
They are deliberately separate from the shared/compositional verification work.

## Ownership and invocation generation

`SessionOwnership.lean` stores a list of retained assignments and separate terminal,
activation, and release sets. Competing records are representable: exclusive
ownership is an invariant proved from admission, not imposed by a one-owner data
type. The key is `(target, revision)`, plus a separate actor uniqueness condition.
Targets stand for already validated tenant-local workflow IDs.

Theorems preserve exclusivity over arbitrary command traces, preserve terminal
session membership, isolate exact releases from other lease IDs, reject mismatched
receipts, require current registration generations for successful invocation,
refuse sampled expiry, and consume successful invocations. The executable model
covers offered/active/closed records, expiry, revision movement, workflow reload,
preparation, single-use execution, cancellation and restart.

Implementation correspondence:

- `packages/sessions/src/index.ts`: offer admission at 1010–1055, current lease and
  deadline checks at 651–697, preparation/generation revalidation at 2203–2334.
- `packages/sessions/src/index.postgres.ts`: partial unique indexes at 23 and 84;
  immutable authority and irreversible terminal rows at 35–46.
- `packages/contracts/src/index.ts`: `releasedLease` matches exact identity columns
  and receipt at 866–888; `releaseLeaseRow` changes only that retained row at 895–918.
- `packages/workflows/src/leases.ts`: current state, policy and provider lease checks
  at 356–385; a matching-policy reload can retain the offered lease but returns the
  new registration generation at 309–347.

The session differential fixture uses real Scope, Workflows, Sessions, credentials,
PostgreSQL migrations, and the production exact-release helper. Its minimal domain
lease callback stores opaque receipts; it does not use Code or Code Research. The
fixture has no review claims: the existing review model separately covers exact
claim release. The mutation control intentionally adds an incorrect release by
instance after the real helper; the comparator must detect the successor damage.

### Deliberate exclusions and assumptions

- Scope/delegation/credential predicates, policy hashing, JSON copying and generated
  ID freshness remain external. Row IDs and receipts are opaque symbols, not crypto.
- Offers are fresh requests. Offer request replay and persistent-agent enrollment
  replay are not modeled. Existing workflow replay proofs remain separate.
- A `run` is one admission/effect boundary, not the asynchronous tool registry.
  The real invocation is claimed before yielding, validated again after its audit
  observation, and guarded again by transactional handlers. A running invocation
  can finish its own handoff transaction after moving the workflow revision;
  transaction-local memoization at `sessions/src/index.ts:763–775` is not modeled.
- The model refuses authority sampled at/after expiry. It does not revoke an already
  committed effect or promise preemption of an external process. Monotone modeled
  time is an assumption for whole-trace expiry reasoning.
- Activation/heartbeat lease sliding is excluded. Conformance fixes the hard
  deadline to the initial five-minute offer deadline, so activation does not extend
  it. Source revocation and workspace/usage reporting have their ordinary tests.
- A close in this model includes successful domain cleanup. In production, an
  unavailable provider can leave a closed session's reservation for the durable
  close consumer. The proof does not assert eventual delivery or cleanup.
- The API tool registry’s separate session-policy provider generation is excluded;
  the modeled generation is Workflows’ execution registration only.
- Reload increments a fresh local generation. Restart forgets prepared capabilities
  while retaining session rows. Cross-process global registry synchronization is
  not asserted.
- Refusal preserves the modeled domain effect count; Sessions may still commit
  failed invocation observations or cleanup. No global 'zero database effects'
  claim is made.

## Dependencies

`WorkflowDependencies.lean` uses labeled edges: owner zero is declared, positive
owners identify system prerequisite providers. Its independent admission oracle
searches finite rank assignments. Every accepted certificate puts each edge on a
strictly increasing natural-number rank. `ordered_path` lifts this to paths of
arbitrary length; `certified_acyclic` excludes cycles; step and trace theorems
preserve that property. Edge removal preserves acyclicity by path inclusion.

This is intentionally a different algorithm from the implementation's recursive
SQL reachability check. The theorem is parameterized by the node count and arbitrary
finite traces. Only the JSON executable is capped at five nodes to bound the
exponential oracle; conformance uses four. Completeness of rank enumeration for
all finite DAGs is not claimed. Comparisons include successful additions, not just
refusals, to catch an oracle that rejects everything.

Prerequisite admission is derived from the actual edges and terminal-success set,
not an externally supplied 'dependencies ready' boolean. `gated_requires_all_settled`
and `finish_requires_all_settled` prove the gate. A system edge to a failed target
blocks as pending; a declared failed edge produces failure, even when a system
edge also references the target. The model separately preserves terminal state and
shows no-op additions keep revision.

Implementation correspondence:

- `workflows/src/dependencies.ts:281–355`: tenant-local targets, pinned success
  contracts, exact owner edges, cycle reachability and batch insertion.
- `workflows/src/commands.ts:388–455`: declared additions/removals and revision
  advancement only for actual changes. A no-op writes a receipt without history;
  do not extend receipt/history equality to this command class.
- `workflows/src/service.ts:260–297`: replacement of only one system provider's
  edges, with no source revision change.
- `workflows/src/evaluation.ts:265,306` and `leases.ts:49–51`: explicit opt-in gates.

The fixed universe consists of pre-existing nodes with pinned `done` success and
`failed` terminal states. New instance minting, tenant authorization, changing
workflow versions, request replay, provider unload, and pinned-contract migrations
are left to existing tests. The real-service comparator drives owner handles,
system prerequisite handles and normal transitions; it reads edge rows and public
snapshots after every operation, normalizing opaque IDs and sorting only edges.
A negative control removes the production recursive cycle query in an isolated
fixture; it must actually commit a cycle that the comparator rejects. A separate
two-connection race checks that reverse additions cannot jointly commit.

Gates are relative to the captured prerequisite snapshot. Policy callbacks receive
the real transaction and can mutate other rows; the closing workflow recheck only
checks source instance fields. Commit-time prerequisite stability therefore assumes
noninterference by those callbacks. This model does not silently prove that stronger
property. All relevant writers must participate in the PostgreSQL schema-wide lock;
uncaught failure must roll back the transaction. A supplied transaction whose owner
catches an error and commits partial effects is outside that contract.

## Validation

The shared build registers both models and CLI targets and includes their headline
theorems in the existing axiom audit. Run `npm run verify:lean`, then with a local
schema-capable test database run these two `*-lean-conformance.test.ts` files with
`MERV_REQUIRE_LEAN=1 MERV_LEAN_MUTATIONS=1`. The executable models are required in CI;
ordinary local tests explicitly skip when they have not been built. Conformance,
real concurrency and fault/mutation tests support the model correspondence; they
do not turn it into full application verification. No liveness claim is made.
