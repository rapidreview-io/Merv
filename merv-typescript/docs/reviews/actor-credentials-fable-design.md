# Actor credentials — Fable design review

Fable reviewed a standalone generic credential design question, with no source
files, repository excerpts, credentials or project data. Tools and MCP were
disabled, safe/restricted mode was enabled, and session persistence was disabled.
This is a design consultation, not the separately blocked private-source audit.

The main model was `claude-fable-5`; the CLI also reported its Haiku helper.
Reported duration: 101.573 seconds; total cost: $0.372781. The exact question and
response are retained in `/private/tmp/credential-boundary-fable-20260915/`.

| Finding                                                                    | Disposition                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost atomic-rotation response can strand the authenticating operator.      | Fixed with additional credential issuance and staged self-rotation. The authenticating credential cannot rotate/revoke itself. The original stays usable until a verified replacement revokes it. Operators recover another actor’s lost successor via existing metadata and another rotation.                                  |
| Plain token revocation lacked a way to restore access without a new actor. | `actor.issue_token` issues an independent credential for the same active actor. It changes neither actor identity nor existing token state.                                                                                                                                                                                     |
| Self-rotation could extend a finite credential deadline.                   | Self-issuance inherits/caps against the current credential; rotation of another own credential cannot extend its finite prior expiry. Operator authority remains the current administrative model, not a bounded delegation lease.                                                                                              |
| Request identity might be lost across queues or async calls.               | Audited HTTP, MCP, CLI, registry, domain callbacks and mounts. Credential IDs are retained and rechecked before queued dispatch, after remote connection setup and within domain transactions. Race regressions verify no handler/upstream dispatch after invalidation. Trusted durable-event handling remains a distinct path. |
| Migration might retain a legacy authentication bypass.                     | One atomic migration removes actor-row digests; authentication reads only credential records afterward. Migration/restart regressions preserve original authority and test table integrity.                                                                                                                                     |
| Migrated tokens should receive mandatory expiry.                           | Not adopted: existing credentials were unbounded. Inventing a deadline would change existing authorized access. Expiry can be introduced explicitly by an operator. No credential becomes account-wide.                                                                                                                         |
| Human accounts and session principals must remain distinct.                | Recorded as the next identity boundary. `kind=actor` and fixed-project constraints describe only this store; future verified-human and lease principals must be explicit alternatives, not inferred from an operator role. Shared-user and session parity are still open.                                                       |

Local review also replaced the upstream adapter’s active-token-only test with a
lookup that rejects all known local credential digests, including revoked or
expired tokens. It found no remaining authenticated caller reconstruction that
drops the credential ID.
