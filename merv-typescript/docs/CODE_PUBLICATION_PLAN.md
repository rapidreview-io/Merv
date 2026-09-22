# Reviewed code publication

> 2026-09-22: The dedicated Consolidation plugin and its version-5 execution/publication path are retired. Historical design sections below describe that former implementation. Current research uses ordinary [consolidation tasks](CONSOLIDATION.md) and unit publication.

The accepted design is [GIT_MODEL.md](GIT_MODEL.md), sections 8 and 9. S4-3 implements its PR path on unreleased `consolidation@5`; published versions 1–4 keep their original behavior. There is no direct-push or local central-publication path.

A passing independent review seals the exact proposal head/tree, candidate-set and decision-manifest hashes, integration base and certificate. Code materializes a create-only snapshot ref and opens its PR through the existing enqueue/sync journal. Only a signed-in human administrator may request the synchronous merge at that reviewed head. Code verifies current main ancestry, exact-head App approval, required checks and available rules, then rechecks authority, binding, review and intent transactionally. Completion waits for import and verification of the two-parent merge and reviewed tree.

A changed main returns the same consolidation through `stale_base` to producing. Code freezes another merge round on the same work branch. The new approval seals a successor proposal; the server comments on and closes its predecessor PR without mutating either approved snapshot. A delayed or mismatched result cannot revive the old authorization. Publication incidents remain recorded and require investigation.

The real-GitHub race behavior is a release condition, not established by fake-App tests. Follow the manual enforcement matrix and canary recording procedure in [CODE_OPERATIONS.md](CODE_OPERATIONS.md) before enabling production publication. Incomplete rules visibility is visible and owner-acknowledgeable; a canary proving stale merges are allowed disables this path. Local work and mirroring continue.
