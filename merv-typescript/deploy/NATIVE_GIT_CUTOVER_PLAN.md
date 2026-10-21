# Native Git migration and production acceptance

**Implemented locally; production migration has not run.** The parent release chat coordinates the combined native Git, OAuth and plugin release. Do not deploy this worktree independently. The current step is migration/drain planning and local validation; no isolated production canary is being created. No customer approval, payment or review verdict may be invented to clear a gate.

## Preserve existing work

Read-only production inventory on 21 October 2026 found 39 unfinished workflows in 30 projects and one abandoned dispatched command in a 31st project. The migration plan preview found no active sessions, leases, writers, transfers, workflow allocations, live managed runners or missing definitions. Repeat the census at cutover.

| Existing cohort                            | Count | Treatment                                                                             |
| ------------------------------------------ | ----: | ------------------------------------------------------------------------------------- |
| Experiment40/41, planned                   |     7 | Same ID/state/data; version 45, revision+1                                            |
| Task43, in progress                        |     5 | Same ID/state/data; version 46, revision+1                                            |
| Customer1, planning                        |     2 | Version 6 retains structured intake, capability links, uploads and original retention |
| Customer3, planning/ready/awaiting payment |    24 | Version 5 retains document intake, contracts, approvals, checkout and payment replay  |
| Task2, in review                           |     1 | Keep exact version/revision/review and original artifact-only contract                |
| Abandoned dispatched command               |     1 | Audited retirement after forensic guards pass; execution outcome remains unknown      |

All 19 research dependency edges, earlier submissions/reviews, Code bases/heads, immutable declaration versions and customer records remain unchanged. Migration adds a retained source snapshot, a history revision and an audit event. The new graph and success states must match the old graph exactly. A successor planner retains access to recoverable unsubmitted output from the preceding revision. Repository refs are untouched by this command; native repository preparation separately validates old internal refs and refuses namespace collisions.

Task `wf_c7e253751027433bac7923ac71ddc631` retains review `review_033b07fd4e714a61bf668233a899bbff`, its brief and two deliveries. Eligibility verifies the exact historical definition/manifests, pending review snapshot, and absence of Git claims. A genuine `needs_changes` verdict performs the normal revision, then migrates that same task to 46. Its pinned task type and context remain immutable; only rendering uses a compatible successor. New task2 producers remain unavailable.

Command `codecmd_4bb21dbc0c594ad1aeca5748ca957e58` has no matching admitted store operation. Its original session expired and allocation ended; the unit completed later under another session with durable head `4c2692c5fa1f7435efb8ed35c3dc40640028c375`. The original runner ledger was not recovered. Retirement records **unknown original execution outcome**, preserves command/evidence in an immutable event, and marks the abandoned protocol request failed. It creates no success receipt and changes no Git head. Guards require the closed session, later terminal revision, released allocation, closed unblocked workspace and exact completed upload receipt for the later head. A matching original operation or contradictory receipt refuses retirement.

## Keep admission decisions through cutover

The first protocol migration implementation reset the effective scheduling revision. Independent review found an existing five-failure `host_failed` hold on experiment `wf_0fce8cfc71dc4d428181efc834695ea8` at revision 12 that would have become eligible at revision 13. This is a release blocker until the continuity fix and dispatch tests are integrated.

The corrected candidate retains original rows and interprets both sides of the immutable migration boundary as one scheduling revision, only while the workflow remains at that exact target version/revision. Holds and their counters, recent session failures, unanswered questions, unsettled compute waits, provider blocker ages, first work-start evidence and Fleet cooldown/retry windows remain effective. New failures append to the actual current revision's counter; reports combine the counters. The administrator releases a carried hold at the current revision, and replay of the migration cannot restore a released hold. Ordinary user revisions retain their existing behavior. Lease, action and credential authorization still requires the exact revision.

Tasks without an explicit compute epoch retain the predecessor epoch for Sandboxes attempt identity and request idempotency. Explicit experiment epochs remain unchanged. Unfinished compute still belongs in the independent ownership census; preserving its identity does not establish that it is safe to cut over a live job.

Before applying, inspect the new admission snapshot alongside the workflow inventory. Do not use a dispatch toggle to drain: it resets retry counters. Use the boot maintenance/release hold sequence below, allow in-flight work to finish, and separately account for pending captures, Pi turns/commands, provider resources and Code ownership. A changed answer, hold, failure, wait or retry grant after planning invalidates the plan; regenerate it only after reviewing the change. The immutable batch receipt retains the reviewed admission snapshot. Historical evidence and snapshots remain available for comparison after reopening.

## Offline entry points

Run in the reviewed candidate image with the existing environment/database network. Planning is read-only and initializes no services or reconcilers:

```sh
node --import tsx deploy/git-cutover-migrate.mjs \
  --plan /private/native-git-plan.json \
  --retire-command codecmd_4bb21dbc0c594ad1aeca5748ca957e58
```

Inspect IDs, versions and blocker lists. Format 2 binds database/schema, candidate contracts, source workflow/command snapshots, dependencies, Code declarations and the admission snapshot. The latter includes original holds, failure/backoff records, pending questions and compute waits, conversation-upload gates, workflow blockers/first-start facts and round-limit grants/history, Fleet retry grants and rental history, and project/shared budget gates and accounting, including work outside the migration cohort. Private text and session credentials are not emitted; sensitive rows contribute digests. Earlier format-1 previews must be regenerated. A changed snapshot requires a fresh plan. A preview while Main runs is not the final offline plan.

After maintenance and a fresh verified backup:

```sh
node --import tsx deploy/git-cutover-migrate.mjs \
  --apply /private/native-git-plan.json --offline \
  --operator OPERATOR_ID --reason 'Preserve unfinished work during native Git migration' \
  --backup-id VERIFIED_SNAPSHOT_ID --backup-sha256 COMPLETE_MANIFEST_SHA256
```

Backup arguments record the operator's recovery evidence; this command does not fetch or verify the backup. `--offline` attests that Main and external writers are stopped. The command also refuses active sessions/leases/writers/transfers, unreleased workflow allocations and unexpired managed-runner grants. Pi, compute, Code checks/cleanup/publication ownership and other provider hosts require the separate recovery census below. A schema writer lock serializes target-contract pinning, all migrations, retirement and the receipt in one transaction. Any failure rolls back the batch. Identical replay returns the original receipt; changed operator/reason/backup evidence is refused.

## Coordinated release gates

1. Commit and independently review the integrated candidate. Packaging uses committed HEAD. Build backend/UI and verify native Git, lifecycle, migration, recovery and exact-image Linux isolation tests. Preserve the parent's OAuth/plugin changes and exact Sandboxes/hosted pins.
2. Establish maintenance for the experiments origin. Allow only public GET /health, /ui/ and /ui/assets/* so release health/static checks can reach the hosted rollout; return 503 for other ingress, including both Stripe webhook paths. Keep normal authenticated loopback operator access and 401/403 auth checks intact. Fence background admission, Pi turns, customer reconciliation/file sweep and domain-event delivery until compatible Main/hosted images are accepted. **Caddy alone cannot fence these. Use the boot-only `MERV_BOOT_MAINTENANCE=1` transition fence and the activation/removal sequence in [BOOT_MAINTENANCE.md](BOOT_MAINTENANCE.md).** Session dispatch toggles clear retry holds, and disabling Fleet composition is invalid while customer experiments remain enabled.
3. Drain ownership using recovery/hosted-release censuses: sessions, leases, writers, compute, Code operations/checks/cleanup/publications and provider hosts. Session expiry is insufficient. Do not terminate unrelated work merely to clear the migration.
4. Stop Main; capture a fresh matched DB/Code snapshot and leave Main stopped. Preserve external blobs/buckets and runner-only bytes separately. Require COMPLETE, checksums and an isolated restore checking every repository/database promise; retain configuration, keys and exact image pins. Recovery acquires its own maintenance lock: do not hold the same flock externally while calling it. An already-stopped Main stays stopped.
5. Generate and apply the final offline plan with the fresh verified snapshot ID and COMPLETE hash. Record the receipt. The migration receipt must record 38 migrated workflows and one retired command. `git-cutover-preflight.mjs` must report ready with one retained artifact review and no unresolved command.
6. Treat workflow migration as the rollback boundary, even before native Code schema migration. Use `release.mjs --no-rollback`. Failure preserves maintenance; use forward recovery or a tested compatible image. The release checks the exact previous image’s native-protocol label; the database’s alreadyNative flag alone cannot prove image compatibility. An unlabeled image stays stopped if either snapshot shows migration or cannot be verified. Never overwrite newer data with a stale DB or mismatch DB/Code snapshots.
7. Use the supported preparation sequence in [BOOT_MAINTENANCE.md](BOOT_MAINTENANCE.md): with `MERV_BOOT_MAINTENANCE=1`, run `node deploy/release.mjs --host ResearchSuite_Control --no-rollback --skip-hosted`, then `node deploy/hosted-release.mjs --host ResearchSuite_Control --prepare-cutover` from the same reviewed committed checkout. Require **exit 5 / PREPARED**, the durable exact-image/pin checkpoint before any live canary. The normal automatic hosted path is not valid under the boot fence. Preparation uses a read-only empty-ownership census and defers ordinary HTTP canary credential verification; it does not drain paused workers. Errors remain open for forward recovery and never roll back to the incompatible runner. Main health alone does not establish runner acceptance. The public origin reaches Caddy/Azure; no Cloudflare HTTP-edge path has been verified.
8. Authorize controlled reopening for **all** background demand while customer ingress remains closed. Follow the runbook's locked same-image Compose recreation after restoring the maintenance env variables; do not start another Main release while the hosted run is open. Permit the required ordinary authenticated worker/Git/callback routes. Run `node deploy/hosted-release.mjs --host ResearchSuite_Control --resume --accept-cutover` from the original pipeline commit. It verifies maintenance removal and the unchanged prepared pair, then runs the real Pi canary; plain `--resume` never accepts. The operator capability does not propagate to workers or events. After it passes, complete the authorized disposable-project public Git probe, actual Pi/Fleet dirty producer → frozen independent review → approval commit → resumed execution → results review → approval → retained shutdown receipt. Verify read-only mounts/credentials, lost-response replay, provider deletion after retention acknowledgement, normal terminal Claude/Codex onboarding and existing links/history/promised objects. **These production gates remain outstanding.**
9. Restore intended customer ingress without clearing retry decisions; observe payments, event replay and cleanup. The cutover run deliberately skips staging: keep staging's old apps/pins until its own compatible Main and data migration are separately accepted, then perform its reviewed coordinated rollout. Production success is not staging compatibility. Keep recovery points, original settings, exact image pins and open-run failure evidence; failed canaries never justify old-protocol rollback.

## Recovery evidence

Snapshot `20261020T040557Z-3f4618afb38e45539e09c0891c048652` passed an isolated network-disabled restore on 21 October at 10:23–10:27UTC: 61 repositories and database promises matched. Main stayed healthy and unchanged; scratch resources were removed. This snapshot is stale and cannot satisfy the final backup gate. The 21 October backup failure coincided with host disk exhaustion and a Docker build. Candidate recovery tooling holds resource exclusion through capture, verification, upload and prune, budgets scratch DB/WAL and Code space, and emits safe stage/tool/exit diagnostics.

The [inventory ledger](../verification/native-git-drain-inventory-2026-10-21.csv) records proposed paths; [original production readiness evidence](../verification/native-git-production-readiness-2026-10-21.json) remains historical. Neither is a backup. See [recovery scope](../docs/RECOVERY_SNAPSHOTS.md) and [hosted acceptance](../scripts/hosted-runner/NATIVE_GIT_ACCEPTANCE.md).
