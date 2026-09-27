# Identity

Identity owns authentication: Supabase JWT verification and the shared hash-only
credential ledger exposed by `@merv/identity/credentials`. Scope owns authorization;
Sessions and Pi own agent, execution and runtime lifecycles. Credential subjects
reference those existing records. Identity has no project membership or agent roster.

Lifecycle owners issue, renew and revoke credentials inside their existing State
transactions. Only trusted in-process code can renew a key; there is no bearer-based
renewal endpoint. Renewal cannot revive an expired or revoked key or exceed its
immutable hard deadline. Owners recheck both Identity validity and current domain
authority when a prepared call executes.

The additive migration adopts existing token hashes without changing client token
formats. Adoption never extends or revives a known credential. Legacy Scope keys
retain their existing expiry, including explicitly nonexpiring keys. Continuing
agent keys have a 30-day lifetime and a source-authorized rotation route. Execution,
managed-runner and Pi credentials are bounded by their owning lifecycle.

Services instantiate the same credential implementation against the shared State;
they do not maintain separate ledgers. Old credential columns remain for historical
references and migration compatibility. An older image that ignores Identity is
not a safe rollback after Identity-only rotation or revocation; follow the recovery
guidance in [Pi operations](../../deploy/PI_OPERATIONS.md).
