# Immutable code proposals

Code can now seal a successful worker checkpoint together with its evidence into
an immutable proposal. An admitting domain command calls this service in its own
transaction. The domain owns the current proposal, review, gate and eventual
publication; Code owns the retained facts. There is no standalone Code workflow
or new agent-facing seal tool.

## What is frozen

A proposal records its project and workflow instance, monotonically increasing
proposal revision, original worker actor/session and delegation source, workflow
name/version/state/revision/policy hash, successful command and receipt, summary,
evidence metadata, trusted input IDs and domain provenance. It also records the
actual admitting tool and input, and a manifest artifact with a SHA-256 hash.

The workflow registration ID is the worker lease's frozen registration generation.
It is historical provenance. Current invocation authority is validated separately,
including after a compatible program reload.

The manifest is format 1 JSON: arrays preserve order, object keys sort by UTF-16
code unit independently of locale, and finite JSON values use JSON serialization.
The manifest omits its own artifact and hash to avoid a self-reference. Its hash
is the SHA-256 of the actual UTF-8 artifact bytes. This format does not change
older command, review or workflow hashing.

## Domain integration

The public Code service accepts:

```ts
code.seal(
  caller,
  {
    commandId,
    summary,
    artifactIds,
    pinnedInputIds, // optional: trusted program-selected inputs
    provenance, // optional: program-derived provenance
    requestId,
  },
  { tool: admittingTool, input: actualInput },
  tx,
);
```

`tx` must be the active State writer. `caller` must already carry the genuine
session invocation admitted by the tool registry. Code does not create an
invocation on behalf of a domain or allow an ordinary project operator to stand
in for a worker. The session must remain active, writable and attached to its
original workspace, before final capture.

Code checks that the successful command belongs to that exact worker, project,
session, workflow revision, runner, host and workspace attachment. Its receipt
must bind the same repository/workspace, original base and expected parent.

At least one evidence output must be authored by that worker. A domain may include
existing inputs from other authors by explicitly pinning them. `pinnedInputIds`
and `provenance` are trusted program inputs; domain tools must derive them from
their authorized snapshot, rather than forwarding arbitrary worker nominations.
Every evidence ID must belong to the same project and its actual bytes must match
the immutable stored size and hash. This supports text and binary artifacts.

The manifest artifact, proposal row and event commit in the caller's transaction,
along with the domain's review request and transition. Code rechecks authority
after artifact creation. A failure or revocation rolls the database changes back;
the content-addressed blob store may retain an unreferenced blob, as with other
rolled-back artifact writes.

Request IDs are scoped to project and worker session. The same normalized input
and admission return the original proposal while that worker still has current
authority; changed input conflicts. A successful handoff can close that authority,
so the old worker cannot replay across a completed transition just because a
proposal exists. An authorized source can inspect the retained record to reconcile
a lost response. A new request ID creates a new immutable revision. This service does not supersede a review or
select a new current proposal automatically. The domain must atomically update
those bindings and prevent replacement once publication is authorized.

## Reading and unloading

`code.proposal(caller, id, tx?)` reads one project-scoped record;
`code.proposals(caller, instanceId?, tx?)` reads the latest 100. Reads require Scope
read permission and do not rebuild assignment context or recursively inspect a
lease. They remain useful after the worker closes. The Code UI displays sealed
proposals with the original producer, exact commit and manifest identity.

Code now injects State, Scope, Sessions and Artifacts. Its existing tool/API/UI
adapters depend on Code. Removing Code withdraws those adapters and retains the
immutable database records. It adds no dependency from Workflows or Reviews back
to Code. A future research domain will explicitly inject the services it uses.

## Shared review dispatch

The Reviews tool adapter now owns `review.submit`. It calls
`reviews.apply(caller, input, tx?)`, which locates exactly one registered domain
owner for the immutable project/subject identity. The owner applies the verdict
and domain transition in the same transaction. Zero owners yields
`review_owner_unavailable`; competing owners are rejected without choosing one.

Owners register `{ id, owns(review, tx), submit(caller, input, tx) }`. Predicates
must be synchronous, read-only and recognize retained domain records even after
a review is submitted, so domain command replay can return its original receipt.
The dispatcher freezes the review snapshot, rejects asynchronous callbacks and
checks registration and authority before committing. The callbacks and transaction
port are trusted plugin code, not a sandbox for hostile plugins.

Tasks registers the existing task verdict command as its owner. Task request
format, result, deduplication and atomic transitions remain intact. Tasks withdraws
its owner before Cordis waits for dependent tools to drain; a new `review.submit`
cannot enter an unloading domain. Other domains' review dispatch remains available.
The lower-level `reviews.submit` still writes an assessment; only the owning
domain may compose it with its transition and request replay semantics.

## Validation and remaining research work

`tests/code-proposals.test.ts` uses actual State, Scope, Sessions, Code commands and
Artifacts. It covers identity and assignment bindings, corrupt bytes, binary
evidence, normalized replay and restart, transaction failures, source revocation,
immutable storage and bounded hostile input. `tests/review-routing.test.ts` covers
owner selection, rollback, replay, tenant isolation and unload while calls drain.

`scripts/live-code-proposals.ts` runs two fresh native agents through a synthetic
domain with actual Code sealing and shared review dispatch. The reviewer receives
the exact checkpoint, reads every pinned artifact and checks the actual Git tree
and files. The fixture uses one machine and explicitly verifies repository/runner
identity before verdict. Its small verdict handler does not implement command
replay after the transition; production Tasks replay is verified separately.

Hosted consolidation@5 now binds frozen candidates, decisions, reviewed evidence and the exact Code commit to its proposal. Passing review seals publication authorization; completion follows only after Code imports and verifies a human-requested PR merge. A stale main returns the same consolidation for another reviewed merge round without changing its approved snapshot. Published older workflow versions retain their original proposal behavior. See [GIT_MODEL.md](GIT_MODEL.md) and the mandatory real-GitHub release matrix in [CODE_OPERATIONS.md](CODE_OPERATIONS.md). Historical execution evidence is recorded in [VERIFICATION.md](../VERIFICATION.md); the live script alone is not a passing run.
