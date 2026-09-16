# Shared identity — Fable design review

Claude Fable reviewed a separately approved standalone generic architecture
question. No repository files, source excerpts, credentials or project data were
sent. Tools and MCP were disabled; safe/restricted mode and no session persistence
were enabled. This is a design consultation, not the earlier private-source audit
that remains awaiting its specific approval.

The exact prompt and response remain in
`/private/tmp/shared-identity-fable-20260915/`. The verification record stores their
hashes and reported usage.

| Finding                                                                                  | Disposition                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Membership epochs need explicit rejection semantics.                                     | Current immutable epoch IDs are compared inside permission transactions. Role change/removal/rejoin invalidates old callers. IDs need uniqueness/equality, not an arithmetic counter.                                                                                                   |
| Recovery and deactivation must survive a crash together.                                 | Membership, actor state and durable audit/recovery events commit in one State transaction. Recovery distinguishes old claims from claims started after the loss event.                                                                                                                  |
| Last-operator checks can race.                                                           | Serialized SQLite writer transactions protect the check and mutation. An actual overlapping-worker test leaves one verified operator. Unverified invitations do not satisfy the last-operator guard.                                                                                    |
| Never-owned-only adoption leaves a project locked if its sole human loses their account. | Added explicit local repair with a required reason and a durable `membership.repaired` event. No HTTP/MCP equivalent; machine bearer roles confer no repair authority.                                                                                                                  |
| JWKS and HS256 can allow algorithm confusion.                                            | Configuration selects one exclusive mode and accepted algorithms; no runtime fallback and no token-supplied key URL.                                                                                                                                                                    |
| Invitations may accidentally bind by email across issuers.                               | This slice uses exact issuer+subject invitations, including before first login. It performs no email matching and never creates a verified user from an invitation.                                                                                                                     |
| Client project selection alone cannot enforce isolation.                                 | The server resolves every catalog/call against selected membership, checks resource project IDs and rejects conflicting selectors. Browser cache/request fencing is additional protection.                                                                                              |
| JWKS lifetime and browser session behavior need explicit bounds.                         | Five-minute key cache, 30-second refresh/failure cooldown and five-second request/body limits; required expiry and zero clock skew. Browser auth uses the Supabase SDK with PKCE, scoped session storage and guarded refresh.                                                           |
| Add an application maximum JWT lifetime.                                                 | Not added implicitly. This verifier follows the trusted issuer's required expiry; an independent maximum issued lifetime would require an explicit policy and required `iat`. Configure short user-token lifetime at the shared issuer. No claim of immediate offline logout detection. |
| Account-wide keys and session principals should stay distinct.                           | They remain explicit next steps. Member attribution actors cannot receive ordinary actor tokens.                                                                                                                                                                                        |

Local implementation review additionally found and fixed project catalog scope,
absent-member deletion parity, unnecessary writer transactions on repeated user
recognition, membership-repair activity privacy, and browser refresh/switch races.

A final adversarial case exposed a claim gap when membership was removed and
restored before recovery delivery. Reviews now checks committed loss events during
claim admission/submission, and Tasks delegates assignment/context/checkpoint
checks to that same guard. Tests pause both recovery consumers, verify that old
claims cannot write even after access returns, and preserve valid later claims.
Final independent local review found no actionable findings.
