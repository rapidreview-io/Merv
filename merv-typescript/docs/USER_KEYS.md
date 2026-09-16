# User-owned machine keys

Scope now issues machine keys on behalf of a verified user. Identity continues
verifying shared-account JWTs; Scope owns key records, project grants and current
membership checks. This adds no plugin or agent tools. The network remains 29
plugins and 59 direct dependencies, with 32 domain tools or 34 including UI.

## Scope and attribution

| Grant                | Reachable projects                                              | Selection                           |
| -------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `project` (default)  | The issuance project, while the owner remains a member          | May default to that fixed project   |
| `account` (explicit) | Every current owner membership, including projects joined later | Always requires an explicit project |

A key uses the owner's current role in the selected project. There is no separate
role cap in this slice. Membership removal blocks that project's operations;
role changes take effect immediately. Rejoining permits new calls under the new
membership epoch, while Callers captured before the change remain invalid.

Machine principals are explicitly `kind: "key"`. They resolve to the owner's
existing attribution actor in the selected project, carrying the key ID and
membership epoch. They never become a human login. Reusing attribution prevents
minting a second key from bypassing existing producer/reviewer independence.
Separate agent-context identities and assignment leases remain future work.

The registry rechecks authority before dispatch. Scope rechecks the stored key,
expiry, grant, owner and exact active membership inside domain transactions, and
Mounts rechecks after asynchronous connection setup. A project key cannot escape
its grant by selecting another valid owner membership.

## Human administration

Only a verified human owner may manage keys. Other project operators cannot
inspect or revoke that person's keys through these account routes. Project
operators still control the person's project membership. Key callers cannot
create projects, administer memberships, manage user keys, or use legacy actor
credential administration to mint independent authority.

| Route                            | Input / result                                                      |
| -------------------------------- | ------------------------------------------------------------------- |
| `GET /account/keys`              | `{ keys }`, metadata for the authenticated owner                    |
| `GET /account/keys?projectId=ID` | Owner metadata filtered by issuance project                         |
| `POST /account/keys`             | `{ projectId, grantScope?, label?, expiresAt? }` → `{ key, token }` |
| `POST /account/keys/:id/rotate`  | `{ expiresAt? }` → `{ key, token }`                                 |
| `DELETE /account/keys/:id`       | Revoke that key and its rotation descendants → `{ revoked: true }`  |

Successful requests return HTTP 200. Creation requires current membership in the
issuance project. Labels are optional, at most 120 characters. Expiry is a future
canonical UTC timestamp, or null for no expiry; omission on creation means null.
Ownership always comes from authentication, never request fields. Unsupported
fields, including caller-supplied lineage, owner and audience, are refused.

Owners may list and revoke their keys after leaving all projects. Responses
contain key-owned metadata: IDs, owner identity, issuance project, label, grant,
timestamps and predecessor. They do not expose project contents, other members,
digests or secrets. Key lifecycle events remain in the issuance project's audit
history and are visible only to operators through Feed activity.

## Rotation and revocation

Rotation preserves owner, issuance project, grant and label. Omitted expiry
preserves the previous deadline; a human may explicitly change or remove it.
An expired but unrevoked key can be replaced with an explicit valid expiry.
A revoked key can never be rotated. The old key stops working atomically with
creation of its replacement; a unique predecessor constraint permits one successor.

A project-key rotation requires membership in that project. An account-key
rotation requires any current membership, so leaving its issuance project does
not strand a key that still reaches other projects. Its issuance project remains
unchanged audit provenance. With zero memberships, listing and revocation still
work; creation and rotation are refused.

Revoking an ancestor also revokes every replacement descended from it, even if
the ancestor was already retired by rotation. The recursive update shares the
same writer transaction as the check. Tests run actual overlapping SQLite workers
in both rotate/revoke orders and verify that no live descendant escapes.
Independent keys remain usable.

The server generates a high-entropy `mk_` token and stores only its digest. The
secret is returned once, never retained in events or context. Creation and
rotation are not secret-replay endpoints: if a response is lost, inspect the
owner's metadata list, revoke the unavailable key or lineage, and issue a new key.
Human login remains available throughout. Legacy 43-character actor tokens retain their format even when their random prefix
happens to be `mk_`; user keys have the prefix plus a complete 43-character secret.
Historical key rows are retained so
even dead local tokens cannot be configured as upstream credentials.

## Work, recovery and audit

Key retirement does not deactivate the owner actor or release its review claims.
Another valid key or the human owner may continue the same actor's work. Membership
loss and loss of review permission still invalidate prior claims immediately,
including when access returns before recovery delivery. Current task/review
independence remains actor-based until separate agent sessions are implemented.

Machine-authored domain events record
`data.source = { kind: "user-key", keyId, membershipId }`. This covers artifacts,
tasks, checkpoints, context builds, feed posts, workflow transitions/starts and
review claims/verdicts. The immutable membership record retains role-at-use;
the event retains the credential used. Human and trusted recovery events do not
pretend to originate from a key. These fields are audit provenance, not a lease
or additional permission grant.

Revocation blocks new calls and domain writes; already-dispatched upstream work
may finish. Shared keys create no automatic mounted-tool grants, upstream
credential bindings or permission to forward the local key. Sessions will bind
their source key and assignment separately; rotation must not silently migrate
those future leases to a replacement.

## Browser

Human users can open **Manage machine keys** from the project chooser or account
menu, including when they have no selected project or have lost membership.
Project scope is the default; account scope explicitly describes current and
future memberships. A newly issued secret stays in component memory, with explicit
copy and hide controls; closing the screen or changing accounts clears it. It is
never automatically substituted for the current login.

Pasted project keys select their fixed project. Pasted account keys use the project
chooser. Machines do not see key-management controls. Synthetic browser tests
cover selection and account-switch races; this wave does not claim real shared
Supabase/Nisa browser sign-in.

## Python comparison and next work

The Python reference's 38 key/account tests pass. Its account keys likewise follow
current membership and regain access after rejoining. The TypeScript design
preserves that behavior and adds explicit current project roles.

Two reference behaviors were deliberately improved. Python's public create route
can mint a child of an already-revoked parent; TypeScript accepts lineage only
through atomic rotation. Account-key rotation can use another membership after
leaving the issuance project. Human reauthorization may also replace an expired
key explicitly, without accepting the expired bearer itself.

Next: fixed workflow execution authority, sessions/leases, session-aware recovery
and runner operation. OAuth-issued MCP audiences and refresh families are still
separate work. See [the ordered plan](IDENTITY_SESSION_PARITY_PLAN.md),
[Fable review](reviews/user-keys-fable-design.md) and
[verification](../verification/user-keys.json).
