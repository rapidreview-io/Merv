# Code cleanup v3 rollout and recovery

`code_bases` migration 3 gives pending check cleanup its own durable owner,
`code_base_cleanup`. It retains resources across operator actions and later executions.
Migration versions 1 and 2, base plans, results and check receipts remain unchanged.

## Before rollout

1. Require exact-head CI and independent review. Confirm all work is idle, including
   sessions, Fleet allocations, Code writers/checks and pending cleanup. Inspect legacy
   `code_check_unreclaimed:` warnings too: an unknown resource identity is unresolved
   ownership, not evidence of idleness.
2. Install this release's recovery-snapshot census update before capturing recovery data.
   It refuses a snapshot when the optional `code_base_cleanup` table contains ownership.
   Keep that updated recovery program installed after rollout.
3. Take a fresh verified recovery snapshot using the existing offline recovery process.
   Retain the database dump, matching Code files, manifest/checksums and restore-verification
   evidence, together with the current image and private deployment configuration. Confirm
   snapshot restart completed; a pending recovery restart must be resolved before release.

## Deploy and verify

Run the release with **`--no-rollback`**. Migration and ledger insertion are transactional,
but after v3 commits the previous image cannot boot: it knows only v1–v2 and State rejects
it with `migration_ahead`. Ordinary automatic image rollback is therefore inappropriate.

Verify readiness and normal authenticated UI/API behavior, the v3 migration ledger/hash,
and cleanup ownership after startup. The migration preserves each legacy warning as
evidence; it schedules only a well-formed known machine ID. Unknown identities remain
visible and are never treated as successful empty releases. Older discarded job/source
IDs are not invented. Existing check handles transfer their known IDs on the next drain.

## Recovery

Prefer a forward fix that retains the exact published v3 migration text, its ledger entry,
and the cleanup queue's ownership and retry behavior. A rollback build may revert unrelated
features, but merely teaching old code the migration number would abandon resources now
owned by the queue. Never delete the ledger entry or drop cleanup rows to make an old image
start. Keep an unhealthy new service stopped while preparing a compatible recovery image.

A full snapshot restore is a separate, explicit recovery operation. First restore the
complete matching database and Code snapshot to an isolated destination and verify it.
Preserve post-release state and account for intervening writes and external resource
actions before any cutover; recovery must not lose accepted writes. Do not restore an old
database over live new writes or pair an old image with the migrated production database.
