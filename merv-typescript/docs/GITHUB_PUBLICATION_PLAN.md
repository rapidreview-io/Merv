# GitHub transport and consolidation pull requests

> 2026-09-22: The dedicated Consolidation plugin and its version-5 execution/publication path are retired. Historical design sections below describe that former implementation. Current research uses ordinary [consolidation tasks](CONSOLIDATION.md) and unit publication.

Extend the existing Code feature; do not add a plugin or a dependency from
Workflows/Reviews back to Code. Runner continues to execute Git. Consolidation
continues to decide whether an immutable proposal passed independent review.

Implement and verify these pieces in order:

1. **Repository and PR client.** Bounded, validated branches, exact commits, PRs,
   changed files, checks, statuses, reviews and exact-head merge requests. Keep
   tokens and upstream error bodies out of responses and diagnostics.
2. **Explicit project automation.** Human connection owner chooses a base branch
   and enables read/write automation. Recheck both the original owner's Merv
   membership and live GitHub repository permission. Persist stable authorization
   identity separately from rotating OAuth tokens. Relinking/disconnecting disables
   automation and invalidates outstanding writes.
3. **Runner transport.** Server-held App key mints a token for exactly the linked
   repository and required permission. The trusted controller uses it only for
   fixed fetch/push operations using a credential confined to the trusted Git child; never lend
   the user's OAuth token or put either token in worker context, logs, argv or
   durable records. GitHub supplies exact objects to independent runners. Preserve
   the existing local-source configuration and private worktree ownership rules.
4. **Durable publication records.** Freeze proposal/manifest, repository identity,
   authorization generation, source/base commit and deterministic branch. Retain
   one publication per proposal. Reconcile uncertain push/PR/merge outcomes against
   that exact target. Never force-update a different commit or follow a later
   proposal silently. Keep proposal branches for audit.
5. **Consolidation integration.** Transport checkpoint objects before review needs
   them. Open a draft PR for a sealed proposal. The domain records exact independent
   approval transactionally; Code uses that approval for publication. Reviewed
   completion and external PR/merge status remain distinct. Changed proposal heads
   require another review. Do not manufacture GitHub reviewer approvals.
6. **UI and explicit merge.** Show repo/base/automation, proposal PRs, diffs,
   commits, checks, reviews, conflicts and actual merge result. Human merge verifies
   the exact independently reviewed head and respects GitHub protection. Initial
   consolidation publication uses merge commits to retain reviewed ancestry;
   never silently substitute squash/rebase or bypass branch protection. GitHub's
   merge API does not provide an expected-base compare-and-swap, so do not claim
   such a guarantee; surface base drift and record the actual merged result.
7. **Verification and activation.** Cover tenant/source/session authority,
   revocation and relink races, token isolation, restart/uncertain replies,
   changed remote refs/PR heads and Code unload. Exercise real Git using separate
   runner repositories and a bare remote, PostgreSQL storage, and the UI. Consult
   Fable after integration. Upgrade App permissions only once the implementation
   is reviewable; verify actual GitHub operations in a private test repository.

App capabilities required beyond metadata: Contents write, Pull requests write,
Checks read, Commit statuses read, plus an App private key held by the server.
The existing connection stays usable when this optional transport configuration
is absent. No GitHub administration or Actions/workflow write permission is needed
for this scope.

Fable's architecture review completed on 2026-09-16 using the approved source-only
packet. Its proposed extra publication plugin was rejected to preserve the user's
ownership decision. Binding publication to token-version changes was also rejected:
routine OAuth refresh is not a change of repository authority. Review hypotheses
about existing code are not treated as proven failures.
