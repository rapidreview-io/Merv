# Actor credentials

Scope now stores actor identity and bearer credentials separately. Rotating or
revoking a token does not rewrite task ownership, checkpoints or review history.
This is the project-bound credential foundation. Shared human access is described
in [Shared identity](SHARED_IDENTITY.md), and owner-backed project/account keys
in [User keys](USER_KEYS.md). Worker leases remain separate work. User-key callers
cannot administer these independent actor credentials.

## Public tools

| Tool                 | Purpose                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `actor.create`       | Create an actor and its first token. Operators may set a future `expiresAt`; null or omission leaves it unbounded.         |
| `actor.credentials`  | Read your credential metadata, or as an operator inspect another actor in this project. No tokens or digests are returned. |
| `actor.issue_token`  | Operator: issue an additional credential for an existing active actor. Existing tokens remain valid.                       |
| `actor.rotate_token` | Operator: atomically revoke a credential and return a successor for the same actor/project. Supply the old credential ID.  |
| `actor.revoke_token` | Operator: revoke one credential. A different active credential can revoke your old token.                                  |
| `actor.revoke`       | Withdraw the actor itself. All its credentials lose access and existing actor-revocation recovery runs.                    |

The four credential tools use the existing Scope adapter. The later Identity
provider brings the current network to 29 plugin entrypoints and 59 direct Cordis
dependencies, with 32 domain tools (34 with UI).

## Safe rotation

To replace the token authenticating your own request:

1. Call `actor.issue_token` for your actor and retain the returned secret securely.
2. Verify `actor.whoami` using that new bearer.
3. Use the new bearer to call `actor.revoke_token` for the old credential ID.

Atomic rotation of the authenticating credential is refused. If an issuance
response is lost, the original token still works; inspect metadata, revoke the
unreceived candidate if needed, and issue another. Raw tokens are returned once
and are never saved in command receipts.

An operator rotating another actor’s token can use `actor.rotate_token`. Only one
successor may point to an old credential; competing attempts cannot mint two.
If that response is lost, the operator can find the successor through
`actor.credentials` and rotate it again. Plain revocation does not prevent an
operator issuing a fresh credential for the same still-active actor.

Omitted rotation expiry preserves the old deadline. Self-issued credentials
cannot outlive the authenticating credential; rotating another credential of
one’s own cannot extend its finite deadline. A different operator may explicitly
change another actor’s expiry. These are operator-administered actor keys, not
hard-bounded delegation leases. Shared human authorization uses project membership;
session deadlines remain separate work.

## Request and transaction boundary

`Scope.authenticate` resolves a token to its actor and immutable credential
metadata. HTTP, MCP and CLI construct a caller containing the trusted
`credentialId`; feature arguments cannot replace it. Scope rechecks that record’s
actor, fixed project, expiry and revocation whenever domain code requires a
permission, including inside the operation’s transaction.

The tool registry rechecks immediately before dispatching a queued handler.
Mounts preserves the original caller and rechecks after connecting upstream.
Previously dispatched upstream work may finish; that does not authorize another
Merv mutation. Trusted local configuration and committed domain-event consumers
remain explicitly independent of an HTTP bearer.

The remote Credentials plugin recognizes every stored local token digest,
including expired, rotated and revoked credentials, and refuses to send those
secrets upstream. Lookup failures are sanitized and fail closed.

## Data and compatibility

The Scope v2 migration moves digests into `actor_credentials` and removes
`actors.token_hash` within one database transaction. It preserves actor IDs,
roles, active flags and original token/project associations. Existing tokens had
no expiry; their migrated expiry remains null. There is no fallback authentication
against actor-row digests and no implicit account-wide upgrade.

Credential metadata includes ID, actor, project, kind (`actor`), creation time,
expiry, revocation and optional rotation predecessor. Provenance and digests are
immutable, revocation is one-way, and history cannot be deleted. Rotation and its
audit event commit together. Creation time uses the original issuance event when
available, otherwise the migration time; no historical events are fabricated.

Credential issuance, rotation and revocation create `actor.credential_*` audit
events visible to operators. They do not create an `actor.revoked` event. An
expired token blocks requests but does not declare its actor dead or reopen its
review claim. Assignment ownership, lease expiry and successor recovery must be
implemented together in the upcoming session layer.

See [identity/session implementation order](IDENTITY_SESSION_PARITY_PLAN.md),
[verification](../verification/actor-credentials.json) and
[Fable review dispositions](reviews/actor-credentials-fable-design.md).
