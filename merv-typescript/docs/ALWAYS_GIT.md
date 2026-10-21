# Managed Git for every work item

Every new task and experiment uses the project's managed Git repository through
ordinary Git clone, fetch, commit and push. Merv owns the remote and the reserved
research baseline; the user or their agent owns synchronization with external
services. Merv no longer connects to GitHub or opens external pull requests.

Each work item starts at its pinned baseline. Submitted source is frozen as an
immutable parent commit and tree for independent review; ordinary session closure
does not create a commit. Accepted work integrates into the local research
baseline. Planned machine teardown captures and verifies remaining writer work
before release. Historical workflow definitions, receipts and publication evidence
remain unchanged.

A user may push source history onto a user branch and select its exact head with
`code.write repository_prepare`. Diverged or unrelated source opens an independent
integration task with both parents pinned. Repeating the same request after
acceptance advances main only if the selected source and expected baseline still
match. Existing work retains its original pins.

Before rollout, finish all legacy work and transfer operations on the previous
runtime, then run the read-only Git cutover preflight. New runtime producer leases
refuse unfinished legacy protocols; they do not reinterpret saved workflow versions.
See [GitHub integration retirement](GITHUB_REPOSITORIES.md) and
[Code operations](CODE_OPERATIONS.md) for migration and operation details.

The following notes record the earlier release and are historical evidence, not
instructions for this runtime.

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
