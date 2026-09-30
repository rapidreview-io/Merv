# Identity credentials and Scope authority

These executable Lean 4 models accompany the real PostgreSQL-backed services. Their theorems
quantify over arbitrary finite command traces. The differential tests execute the same commands
against the compiled models and `CredentialStore` / `ProjectScope`, comparing results and stored
rows after every command. Finite conformance traces connect the model to the implementation;
they do not constitute a proof of the TypeScript runtime, PostgreSQL, or cryptography.

## Build integration

The shared Lake workspace registers both libraries and executable models. Run
`npm run verify:lean` to build and audit them, or `npm run test:lean` to include
implementation comparisons against the configured test PostgreSQL database.

Both mains accept one JSON document on stdin, with a `commands` array, and return an
`observations` array. Malformed documents fail with a nonzero exit code. The test files contain
the command schemas and complete example traces. Default executable locations are
`.lake/build/bin/identity_credentials_model` and `.lake/build/bin/scope_authority_model`.
`MERV_IDENTITY_LEAN_BINARY` and `MERV_SCOPE_LEAN_BINARY` can override those paths.
`MERV_REQUIRE_LEAN=1` turns missing binaries into failures rather than skips.

The fixtures create isolated temporary PostgreSQL schemas and clean them up.
No connected Merv service is mutated. Lean object files and native executables
are ignored build artifacts.

## Identity ledger

`IdentityCredentials.lean` models the hash-indexed partial map, with commands for issue, adopt,
renew, revoke, revokeSubject, authenticate and clock sampling. All validity decisions derive
from the stored revocation time, expiry, hard deadline, kind, and sampled clock. Adoption may
insert expired history, whereas issuance requires a future expiry if one is supplied. Unknown
revocation returns missing and does not insert a row. Adoption checks the submitted bound even
when a row already exists, then preserves that entire row on both successful reuse and conflict.
Renewal requires the owner, a live record and a hard deadline; it bounds the proposed expiry and
never decreases the existing expiry. Revocation retains its first timestamp.

Headline theorems in namespace `Merv.IdentityCredentials`:

- `trace_retains_identity_expiry_revocation`: an existing hash remains present across every
  trace, with immutable owner, subject, kind, creation time and hard deadline; expiry never
  decreases or switches between finite and unbounded; an already revoked row remains identical.
- `empty_trace_bounded` / `trace_bounded`: every reachable finite expiry respects its original
  hard deadline, and a hard deadline always has a finite expiry.
- `revoked_never_authenticates`: revocation remains effective through every later trace,
  including re-adoption, renewal, repeated revocation and backwards clock samples.
- `renewal_success_requires_owner_and_live_record`, `renewal_owner_only`,
  `revocation_owner_only`, `revoke_subject_other_authority_unchanged`: lifecycle operations
  cannot mutate another authority's record.
- `adopt_existing_unchanged`, `unknown_revoke_no_tombstone`, `expired_renewal_unchanged`,
  `authenticate_iff`: precise operation-level boundary properties.

Identifiers and token digests are abstract naturals. Canonical ISO timestamps are represented
by nonnegative millisecond offsets; clock monotonicity is **not** assumed. Hash uniqueness is
structural in the partial map; collision resistance, randomness, byte validation, generated
UUIDs and the SQL engine/trigger implementation are outside the proof. Owner arguments identify
trusted lifecycle services; this is not a bearer-authentication proof for arbitrary owner strings.
Commands represent completed serialized transactions, not concurrent interleavings or transaction
rollback behavior. The service's string/date validation is assumed before the modeled transition.

The differential tests compare all normalized identity fields, creation/expiry/deadline/revocation
timestamps and outcomes. They include a targeted lifecycle trace and three seeded traces of 90
commands each. Negative controls deliberately route a wrong-owner revocation through the correct
owner and make an expired renewal observe an earlier clock. Both still call the real store; both
must fail comparison with Lean. These are faulty test adapters, not production source mutations.

## Scope authority

`ScopeAuthority.lean` stores membership history, retired membership epochs, keys, independent
actors and their revocations. Membership rows represent the normalized consistent join of
`project_memberships`, `member_actors`, verified users and the actor's current role/activity.
Each role change or re-add allocates a fresh epoch; changing a role closes the previous epoch.
A delegation resolves its captured epoch and binds project and subject before reading its role.
A fresh account-key request instead resolves its owner's **current** membership in the selected
project. A project key remains confined to its issuance project.

Headline theorems in namespace `Merv.ScopeAuthority`:

- `removal_invalidates_arbitrary_future` / `role_change_invalidates_arbitrary_future`: removing
  or changing the actual current membership invalidates its captured source through every
  subsequent trace, including same-role re-addition and restoration of the original role.
- `arbitrary_trace_epoch_invalidation`, `trace_retired`, `trace_fresh_epochs`: retirement is
  permanent and allocation advances beyond every recorded membership epoch.
- `delegated_project_binding`, `key_authority_requires_current_membership`,
  `project_key_cannot_cross_project`: authority depends on matching current stored records.
- `worker_permission_subset`, `producer_reviewer_incomparable`, `worker_never_operator`:
  ordinary worker-role delegation uses the partial permission lattice. Producer and reviewer
  are incomparable, while reader is below both.
- `human_jwt_expiry_denied`: direct human calls require a live JWT. Durable human sources omit
  JWT expiry intentionally and continue while their captured membership remains active.
- `service_requires_same_project_and_writer`, `trusted_review_service_exception`: a trusted
  Fleet review service requires a same-project voucher that can write, but may review when
  that producer voucher cannot. There is intentionally **no universal permission-subset claim**.

Membership and independent-actor provisioning commands represent already authorized successful
administrative operations. They do not prove last-operator protection, identity verification,
operator authorization, SQL join consistency, or duplicate-id admission. Keys/actors use fresh
ids in conformance traces. The model's revoke commands preserve revocation identifiers; the
unknown-key/unknown-actor API error ordering is outside the model. Independent actor issuance
creates an authority with its own role; it is not a delegation chain and does not lapse when the
administrator's membership changes. Worker checks model Scope's creation-time role admission;
provider lifecycles, session execution, nested source/provider fencing, managed runners,
conversations, actor-credential lifetime capture/forgery, and arbitrary corrupted database rows
are excluded. The shared identity ledger model covers credential lifecycle independently.

Scope differential tests exercise actual membership APIs, current and captured key authority,
wrong-project requests, direct-human versus durable-human lifetime, all worker/source role
pairs, service vouchers, key revocation/expiry, and independently issued actor authorization.
The seeded trace repeats role changes, removal and re-addition across two projects and compares
the retained membership history after every command. Negative controls refresh a stale captured
epoch and widen a project key into an account key; both must be detected against real Scope.

Neither module uses `sorry`, `unsafe`, or custom axioms. Lean's kernel checks the proofs; the
standard logical axioms reported by `#print axioms` are distinct from implementation assumptions
listed above. Code and Code Research are outside this work and are untouched.
