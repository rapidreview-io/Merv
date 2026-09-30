# Artifacts + Blobs + Scope product verification

`BackendStorage.lean` and `BackendStorageMain.lean` define the model and its native
executable, `backend_storage_model`. The comparisons live in
`tests/backend-storage-lean-conformance.test.ts`. Proof declarations are in
`Merv.BackendStorage`; no research or scientific policy is modeled.

## What is proved

The model uses ordinary records and independent maps for upload tickets,
content-addressed objects, admitted operations, and durable artifact bindings.
Those types admit invalid combinations. `Safe` relates these records, and
`step_safe` proves preservation by the executable transition function; validity
is not embedded in a proof-bearing constructor.

`ScopeAuthority.actorAuthority`, its role rules, revocation set, and `before`
expiry predicate are reused. The formal authority slice covers independent
actors and an optional credential deadline. Membership/key/provider/session
policy is not silently reduced to that slice: production Scope handles it in
conformance checks, and its wider models belong to the authority slice.

| Declaration (prefix `Merv.BackendStorage.`)                    | Kernel-checked claim                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arbitrary_trace_content_and_project_binding`                  | From the empty store, every attached artifact agrees with its immutable upload ticket, owns a stored object in the ticket's project/hash namespace, and retains the declared content token and size, after any finite command trace.                |
| `arbitrary_trace_immutable_binding`                            | Any existing artifact binding, including its allocated serial and all ticket metadata, is unchanged by any future finite trace.                                                                                                                     |
| `arbitrary_trace_immutable_object`                             | A stored object at one project/hash address is unchanged by any admitted command trace, including duplicate conditional PUTs.                                                                                                                       |
| `arbitrary_trace_immutable_ticket`                             | Existing upload facts cannot change through any finite trace.                                                                                                                                                                                       |
| `arbitrary_trace_no_unauthorized_attachment`                   | At every transition after any finite prefix from the initial store, a changed durable attachment has an admitted operation for that exact upload, a matching immutable ticket/caller, and current write authority at the write linearization point. |
| `existing_commit_exact_replay`, `start_completed_exact_replay` | Authorized retry returns completion and the entire store is unchanged. A completed start needs no blob operation.                                                                                                                                   |
| `positive_recovery`                                            | A pending operation with matching stored size, live authority, and no prior binding can commit the exact ticket with one new artifact serial. This is conditional progress, not a fairness/eventual-network theorem.                                |
| `outage_retry_retains_state`, `lost_commit_keeps_persistence`  | Blob outage leaves the store unchanged; losing a successful finalization response does not undo persistence.                                                                                                                                        |
| `stale_authorization_counterexample`                           | A transition which trusts stale admission attaches after revocation; the actual model refuses it.                                                                                                                                                   |
| `revocation_does_not_revoke_capability`, `capability_expiry`   | Capability lifetime is distinct from Scope authority. These are abstract time facts, not a cryptographic or provider-expiry proof.                                                                                                                  |

Supporting theorems cover each preservation step, target-specific modification,
current authorization, and denied commits. There are no `sorry`, custom axioms,
or `native_decide` declarations. Ordinary Lean `decide` checks the concrete
counterexamples. The main executable calls the same `step` function the proofs
cover; TypeScript contains no duplicate expected-state oracle.

## Implementation ordering represented by the model

1. `Uploads.begin` writes an actor/project/request-ID ticket under Scope write
   authority, commits it, then HEADs/signs the plan. A failed HEAD or lost plan
   response can leave a recoverable ticket.
2. A signed conditional PUT persists the exact checksum/size in the project's
   namespace. Persistence may succeed even when the client loses its response.
   Duplicate object writes do not allocate artifact rows.
3. `Uploads.complete` copies the caller, checks write authority and ticket
   ownership in a short read snapshot, and returns immediately if already
   complete. Otherwise it does HEAD and, for inline-sized files, verified GET
   outside that snapshot.
4. A State transaction rechecks write authority, locks the upload row with
   `FOR UPDATE`, observes an existing binding or inserts one artifact and its
   `artifact.created` event, then updates the completion binding atomically.
   The fresh in-transaction authority decision is the modeled write
   linearization point. This does **not** assert credentials remain unexpired
   at every later instruction or at the physical COMMIT timestamp.
5. A lost reply is separated from the committed state. A service restart drops
   pending operations but retains tickets/objects/bindings; retry recovers from
   the persistent database.

Model `start`/`finish` are the two sides of blob I/O, so revocation, time changes,
and another finalizer may occur between them. Provider outage is explicit.
The formal model assumes correct immutable storage, so corruption/deletion
faults are exercised separately as external-contract tests. Model `restart`
is a process-state abstraction; the test closes and reopens the real PostgreSQL
state connection and recreates Scope/Artifacts, not an OS process or database
server crash.

Tickets use numeric logical identities for the actual derived upload IDs;
artifact serials normalize nondeterministic generated IDs while retaining their
first observed identity across retries. Actual artifact metadata, raw bytes,
SHA-256, event counts, and retained IDs are independently checked against SQL
and service reads.

## Finite conformance evidence

The new test file contains 38 tests. Fifteen trace scenarios compare every
observable outcome, ticket, artifact binding, and row count with the native
Lean JSON oracle. The driver calls production `ArtifactStore`, `ProjectScope`,
`PostgresState`, and `S3Blobs`; the S3 protocol fixture uses the real AWS SDK and
checks SigV4 signed project/key/headers, payload checksum, conditional writes,
and expiration. The protocol fixture's object map is an external service test
double, not an artifact-state oracle. Native stdin and stdout use regular files
rather than bidirectional pipes on macOS.

The matrix includes:

- Successful upload and exact retry; repeat begin/resume; conflicting title,
  media type, size and hash; dedup into distinct artifact rows; request-ID
  isolation by actor and project; another actor/project's ticket rejected.
- Missing object followed by recovery; HEAD outage; corruption between HEAD
  and GET; object disappearance; one tick before and at credential expiry;
  revoked actors during pending I/O; a session provider using real Scope
  delegation validation while its source is revoked.
- Two finalizers admitted before either completes, completed in reverse order;
  real HEAD/GET HTTP barriers; copied caller resisting mutation during I/O;
  lost object response; lost DB response; an actual exception after DB commit
  followed by PostgreSQL reconnect; rollback after artifact/event insertion but
  before completion binding, followed by successful retry.
- Completed retry/begin/resume during a provider outage without external I/O;
  PostgreSQL immutable-row triggers and the inline bytes/hash/size CHECK;
  large objects completing with HEAD and no inline GET.
- Read-only snapshot continuation across revocation, direct download admission
  semantics, signed PUT/GET capability persistence and expiry, refreshed
  capability recovery, and namespace tamper rejection.
- Production DiskBlobs input copying, 13 admitted racing writes to one address,
  close draining them while refusing new operations, reopening real local
  files, namespace isolation, corruption detection without overwrite, and
  temporary-file cleanup on successful and failing duplicate writes.
- S3 close draining an admitted HEAD and refusing subsequent operations.

Two service-level mutation controls must produce a counterexample: replacing
fresh Scope write authorization with cached authority produces one unauthorized
artifact; suppressing the locked completed-row observation produces two
artifacts for one upload. Both are local fixture mutations; production code is
never patched by the tests. The immutable database constraint test also checks
actual SQL rejection, not only API absence of mutation methods.

The session-provider test supplies a minimal provider which calls real
`requireDelegation`; it does not instantiate the complete Sessions lifecycle.
Existing artifact-download tool tests separately exercise ToolRegistry's
post-handler authority recheck. Neither test is a proof of every provider.

## External assumptions and limits

- **Content addressing:** the model abstracts bytes by collision-free content
  tokens. It validates tokens at PUT, but does not prove SHA-256 collision
  resistance, SigV4 security, AWS SDK correctness, or content length of an
  abstract token. Production inline GETs verify bytes; PostgreSQL checks inline
  bytes against SHA-256 and size. Tests hash the real buffers independently.
- **Large object trust:** HEAD proves existence/size only. A deliberate fixture
  counterexample replaces a large object out of band with different bytes of
  the same size; finalization still succeeds. The content theorem therefore
  assumes checksum-enforced conditional writes, no privileged/out-of-band
  mutation or deletion, and correct provider HEAD results. This limitation is
  exposed, not strengthened into an invented guarantee.
- **Database boundary:** transaction serialization, rollback/commit atomicity,
  row locks, constraints, durable writes, and Scope's in-transaction authority
  decision are relied upon. They are exercised against real PostgreSQL, not
  formally verified SQL, driver, filesystem, or hardware implementations.
- **Read/download TOCTOU:** Artifacts documents authorization once at admission.
  An existing read snapshot may finish after revocation. A direct service
  download may issue a URL when revocation lands during HEAD; ToolRegistry
  reauthorizes open-world read tools after the handler and can suppress that
  response. This cannot revoke an already delivered bearer URL. A signed PUT
  can still create orphan bytes after actor revocation, while finalization is
  refused. The fresh write check guards durable artifact attachment, not all
  external object creation.
- **Capability expiry:** upload URLs last one hour and download URLs 60 seconds;
  the provider enforces request admission. There is no per-chunk Scope check
  or proven revocation of a transfer already admitted. The abstract strict
  deadline and local SigV4 fixture tests are not a proof of a remote provider's
  exact equality boundary, clock skew, network, or streamed-transfer behavior.
- **Cleanup:** ordinary disk-operation temporary files are cleaned and close
  drains admitted operations. There is no artifact/upload/object garbage
  collection here. Failed finalization intentionally retains tickets and
  orphan objects; power loss, crash-time temporary files, malicious local
  filesystem changes, and live remote S3 durability are outside these proofs.
- **Scope breadth:** the storage theorem's independent-actor abstraction does
  not itself prove memberships, user keys, sessions, provider replacement, or
  administrative admission. Separate Scope models and the authority slice own
  those policies. Real Scope is still used for every production authorization
  in this file except the explicitly labeled mutation control.

No concrete production defect in Artifacts or Blobs was reproduced within
these contracts, so this slice makes no production code change. The direct
snapshot and large-object trust counterexamples are documented intentional
limits, not mislabeled security fixes.

## Reproduction

From `merv-typescript/verification/lean`:

```sh
# Install the pinned Lean toolchain as described in README.md.
lake build BackendStorage backend_storage_model
```

From `merv-typescript`:

```sh
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv \
MERV_REQUIRE_LEAN=1 node --import tsx --test --test-concurrency=2 \
  tests/backend-storage-lean-conformance.test.ts \
  tests/artifact*.test.ts tests/blobs-s3.test.ts
```

Verified in this worktree: `lake build BackendStorage backend_storage_model`
passed; the combined command above passed **97/97** tests (38 new storage
checks), with no skips; `npm run typecheck` passed; `git diff --check` passed.
A separate `#print axioms` check of the 13 headline declarations reported only
Lean's standard `propext`, `Quot.sound`, and (for `positive_recovery`)
`Classical.choice`.

The dated product verification report records the bounded run results.
