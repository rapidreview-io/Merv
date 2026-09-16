# User-owned keys — Fable design review

Claude Fable reviewed a separately approved generic credential-design question.
No repository source, credentials or project data were sent. Tools and MCP were
disabled; the invocation used safe/restricted mode and no session persistence.
The prompt and response remain at `/private/tmp/user-key-fable-20260915/`; their
hashes and usage are recorded in the verification file. This does not claim the
earlier private-source audit, which remains pending its specific approval.

| Finding                                                                   | Disposition                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rotation/revocation can race or create multiple successors.               | Parent validation, retirement and successor insertion share a writer transaction. The predecessor is unique; recursive revoke covers descendants. Three actual overlapping-worker races test both orderings.                      |
| Rotation must retire the predecessor.                                     | Already specified and implemented atomically. Fable misread this part of the prompt as potentially retaining the predecessor.                                                                                                     |
| Reject expired predecessors.                                              | Bearer authentication rejects expiry. A verified human may explicitly reauthorize a replacement with valid expiry, while preserving the grant and requiring current membership. Revoked predecessors always fail.                 |
| Losing a one-time secret response can interrupt a machine.                | Document owner metadata lookup, revocation and fresh issuance. Human login is independent. No secret enters storage or audit. Atomic rotation is explicit in the UI; automatic retries do not recover a secret.                   |
| Account rotation should not depend on membership in the issuance project. | Accepted. Account rotation requires any current membership and retains the original issuance project as provenance. Project rotation remains confined to its project.                                                             |
| Post-removal metadata must not disclose current project state.            | Owner listing returns only key-owned fields, including the immutable issuance ID. It does not load project contents, roles or other members. Project discovery separately reflects the authenticated owner's current memberships. |
| Machine writes need source-key attribution for later session recovery.    | Accepted. Existing domain events now include key ID and membership epoch. The review claim's start event retains the source key; immutable membership history preserves role-at-use. No new schema or plugin was needed.          |
| Current/future memberships increase the scope of an account key.          | Explicit intended account-grant semantics, matching Python. Default issuance remains project-scoped and the UI makes account scope explicit. Calls always recheck current membership.                                             |
| Freeze legacy actor issuance to prevent escape.                           | Machine keys cannot use actor credential administration. Trusted human/local operator issuance remains an explicit compatibility capability, not an authority available to the machine key.                                       |
| Record denied authentication and first use in each project.               | Deferred operational telemetry. Membership/role changes and machine writes are already attributable; adding a write for every denied authentication is not required for the authorization boundary or this parity slice.          |
| Retain key rows, including revoked ones.                                  | Implemented immutable history; upstream credential validation recognizes every issued local digest.                                                                                                                               |
| Rotation must not transfer future leases automatically.                   | Agreed. This wave preserves actor work, not sessions. Future leases will retain their exact source key and close when it ceases to authorize them.                                                                                |

Independent local review found no actionable authorization or transaction bugs.
A separate validation review tightened the live harness: it now compares requested
and returned grants, probes project-key confinement against another valid owner
membership, and verifies both key ID and membership epoch in domain events.

Final integration verification also reproduced and fixed a legacy prefix collision:
old random actor tokens beginning with `mk_` are classified by their complete
format, preserving access without retrying dead user keys through actor or JWT auth.
