# Managed Git for every work item

Every new task and experiment uses the project's managed Git repository. GitHub
is an optional mirror and publication destination, not the repository's identity
or a prerequisite for source retention. Existing workflow versions and accepted
evidence remain immutable.

Implementation contract:

- Initialize an empty, durable repository for each project without external
  credentials. Journal initialization and recover it after interruption. A work
  item can wait for initialization, but must never fall back to scratch mode.
- Remove workspace selection from new work and reflection plans. Producers use
  managed branches; reviewers inspect the submitted commit. A delivery without
  source changes may retain the existing commit. Large data stays in artifacts.
- Retired workflow records remain read-only history; do not keep their runtime protocols or upgrade them into current contracts.
  New work uses one managed protocol, including before GitHub is connected.
- Import a connected remote's history into the existing managed repository.
  Preserve both main heads. Reconcile diverged or unrelated histories through a
  reviewed integration task; never reset a project's main to a remote head or
  force-push away either history. Publication still uses the existing reviewed
  GitHub protocol and its concurrency checks.
- Keep repository storage/recovery in Code and research-specific acceptance in
  Code Work. Simplify the creation paths and contracts rather than moving
  research policy into the storage plugin. GitHub setup no longer owns creation
  of the local repository.

Validation must exercise disconnected project creation, concurrent initialization
and crash recovery, unchanged-file delivery, dependency lineage, immutable old
work, remote ancestry cases (equal/ahead/behind/diverged/unrelated), conflicts and
remote movement during reviewed publication.

Initialization is declared by the project-created event and recovered by Code's
maintenance loop. A pre-existing unbound project is initialized when it next
creates work. Existing bindings are retained; a legacy local repository must be
imported before creating new managed work.

A local publication retains its destination when the independent review is
sealed. With no linked remote it advances Merv main only when that main still
matches the reviewed base. Connecting GitHub later does not retarget old receipts.

Repository preparation imports the exact selected remote head, rejecting a ref
that moves during transfer. If Merv already contains it, preparation is complete.
Otherwise preparation creates one ordinary integration task with both parents
pinned. Repeating the request after its independent review verifies the retained
merge and compares both heads before advancing Merv main. This operation does not
push remote main: the existing App publication and pull-request gates remain in
force. A remote without a base branch must first be initialized before this
reconciliation path can be used.

Rollout requires the updated Code workspace driver on execution workers because
integrating independently initialized repositories uses Git's explicit
unrelated-history merge support. Published workflow definitions are unchanged;
reflection instructions use new recipe versions and change-spec version 3.

Deploy the updated workers before enabling the new server behavior. Existing
`code.v2` workers must all support merging unrelated histories; the capability
name alone does not distinguish older implementations. Verify disconnected
creation and a reviewed remote integration before allowing new work. No stored
workflow or approval is rewritten during rollout.

## Verification

Local verification on 2026-10-03:

- Full PostgreSQL regression suite: 2,966 passed, one skipped, zero failures.
- After correcting local consolidation to compare the pinned main rather than
  its derived dependency base, all 62 affected publication, reconciliation,
  automatic-research and real worker tests passed. The new regression reproduced
  the failure before the correction for both contained and diverged dependencies.
- Backend and UI typechecks/builds, changed-file formatting and diff checks passed.
- Both the historical UI demo and the managed Git demo started and stopped cleanly.
- Existing migration, workflow, policy and recipe fixture rows remained unchanged.

Production rollout on 2026-10-03:

- PR #30 merged after all four CI test shards and verification passed (run
  `37114114425`). Read-only assignment/checkpoint fixtures now wait for asynchronous
  repository initialization; process-cleanup assertions tolerate observation after
  the automatic timeout while still verifying rejection and descendant cleanup.
- Hosted release `20261003T095754Z-06f9746e` passed Linux Pi, workflow and isolation
  gates, then a real hosted Pi canary in 30 seconds. Both Cloudflare applications
  use image digest `9932886440b4750e94a0b10a087f787c2defd06889e5954e54fd78bf40993027`.
- The first worker candidate was refused before production changes because its
  companion checkout lacked the already-deployed assignment-reset implementation.
  Sandboxes merge `5157f1ed` preserves that implementation and managed ML support.
- Main release `20261003T101141Z-7bd8dfee-19265b945bb2` is healthy; authentication,
  origin checks and public UI assets passed.
- The exact deployed Main image passed isolated PostgreSQL/S3 acceptance: automatic
  Git initialization without GitHub, new managed-task admission, historical delivery
  and independent review, continuing-agent identity, private signed downloads,
  reflection and restart persistence. The synthetic schema is
  `merv_ts_smoke_git_20261003_9e55ed0748`; production research records were not used
  for this smoke test. This smoke does not claim a live GitHub reconciliation.
- Recovery snapshot `20261003T092414Z-87ed16613318403d8ad9aacc1dea6a48` was retained
  before rollout. Research supervision remained paused.

The worker-first rollout requirement above also applies to future releases.
