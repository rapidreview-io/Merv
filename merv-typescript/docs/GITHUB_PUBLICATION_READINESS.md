# GitHub publication readiness — 2026-09-16

The GitHub implementation lives in Code and its existing API adapter. Runner handles Git transport; Consolidation supplies the independent review. No new Cordis plugin or dependency is added.

## Independent review

Claude Fable reviewed the design, the implementation, and the fixes using source-only packets. The final review returned **READY: no remaining blockers in the supplied source**, subject to production App permissions and signing-key provisioning.

Resolved findings: sealing no longer consults volatile GitHub credentials; uncertain PR creation is recovered before settling a rejection; merge intent requires the current lock; final capture reads the durable workspace policy; writes require Scope.write; closed PRs leave reconciliation; previously imported objects work offline; invalid-scope installation tokens are revoked. Regression tests exercise the failure sequences.

The suggested relaxation of the launch identity fence was rejected after verifying Sessions.attach and Runner's durable ledger. A controller restart reuses its launch; losing that ledger requires a new Session. Fable withdrew that finding. State's established ambient transaction convention remains unchanged and rollback tests pass.

## Verification

- Backend and UI typechecks passed.
- Code, Runner, Consolidation, and architecture tests: 178 total, 176 passed, two PostgreSQL cases skipped in the default run.
- Separate disposable PostgreSQL suite: 29 passed, zero skipped, including those two cases.
- Real Git test: two independent runner stores, exact reviewed commit transfer, lost push response recovery, refusal to replace another ref, offline object reuse, no credentials in persisted files.
- UI build passed. Actual local UI exercised against an isolated synthetic API: project selection, automation settings, proposal list/detail, checks/diff view, explicit merge confirmation, merged status and receipt.
- HTTP tests cover missing authentication, cross-project access, strict inputs and provider removal.

## Operational limits

Publication is asynchronous and separate from workflow completion. Reconciliation processes one intent per poll. Repository authority changes fence old intents; they cannot be silently republished under a different authorization. GitHub enforces branch protection; its merge API accepts an expected head but no expected-base CAS. Audit refs are retained.

## Production deployment

Deployed at 2026-09-17 00:13 UTC (2026-09-16 local): `20260917T001342Z-ea66c620-e39b3fb44c18`, source commit `ea66c620`, image `sha256:2c782113d2193d1bd68c06bac42dcac19ce3c37c0730e287701b389434e1f035`.

All 54 configured plugins are active. VM and public HTTPS health/UI checks return 200; both served UI assets return 200. Anonymous protected requests return 401 and an unapproved Origin returns 403. Previous image retained for rollback: `merv-typescript:20260916T235902Z-0f8b2bfc-193f875244ac`. The existing legacy service and database remain untouched.

The application is deployed. Following the user's approval, the official Merv Research App and installation `162326306` were upgraded to Contents/Pull requests read-write and Checks/Commit statuses read, with Metadata read retained. GitHub confirmed acceptance for rapidreview-io; repository access remains limited to the existing selected repository. No organization, administration or Actions permissions were added.

The App signing key was installed on 2026-09-17 at 05:00 UTC after the user generated and downloaded it. Its public key fingerprint is `lE5i6GCU4m1Xi7bUIL48wwLv3poZpYyira3ALmxDD9s=` (SHA-256, DER SPKI). GitHub verified the key against App `4971131`, slug `merv-research`. The key was transferred over SSH without appearing in command arguments or logs and stored in the root-only production environment as `MERV_GITHUB_PRIVATE_KEY_BASE64`. The previous environment is retained under `/var/backups/merv/github-key-activation/20260917T050001Z`.

Activation preserved the newer UI release already deployed by the parallel session: `merv-typescript:20260917T025401Z-50222607-320155bb6ea2`. All 54 plugins were active after restarting that same image. The actual compiled production GitHub client then minted a token restricted to `rapidreview-io/research-breast-cancer` with Contents read, read `main` at `f9b1c2a0e79ea64cebd4d844ffe8011f237cbaf0`, and successfully revoked the temporary token.

A separate private repository, `rapidreview-io/merv-github-smoke`, was created for live write verification. After the user completed GitHub verification, the installation settings already showed access to all repositories; the agent did not change that selection. Every token minted for the write test was restricted to the smoke repository. The requested Merv wordmark was uploaded, and GitHub confirmed the App avatar update. The existing OAuth connection remains available; per-project automation stays off until explicitly configured.

## Live GitHub acceptance — 2026-09-17

The first live run exposed a real compatibility defect: the client requested API version `2026-03-10`, which removes `merge_commit_sha`, while strict PR validation and durable merge recovery require it. Identical reads against both API versions confirmed the difference. The client now pins all REST requests, including revocation, to `2022-11-28`. [GitHub documents the removal](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes) and [supports the older version for at least 24 months from March 12, 2026](https://github.blog/changelog/2026-03-12-rest-api-version-2026-03-10-is-now-available/). Migrate merge-receipt retrieval before that version is retired; do not bump the header independently of the response contract. A regression test models the version-dependent merged-PR payload.

The corrected implementation passed the real GitHub lifecycle in [smoke PR #3](https://github.com/rapidreview-io/merv-github-smoke/pull/3):

- Read-only fetch into a producer runner store; checkpoint push with remote head/tree verification.
- A second independent runner store fetched and checked the exact proposed commit and file contents.
- Draft PR creation, rejection of merge before the independent verdict, and transition out of draft after the verdict.
- File/commit/check inspection, explicit merge of head `f22a990195ff36cf81b7d9c0acfa31a3db725281`, and merge receipt `fa7cb0fab084e6c44a6ae0ec1b027a4c6270d89c`.
- Idempotent merge replay and a scan confirming no GitHub tokens persisted in either runner store or the local test state. Temporary installation tokens were revoked.

This used the real GitHub App and the actual GitHub client, Runner workspace manager, and publication service. Scope/State and the domain proposal were isolated local fixtures; the publication authority fixture used a repository-scoped installation token. It therefore does not claim a full production OAuth-to-assignment-to-Consolidation run. The smoke repository had no CI checks configured. The two unmerged PRs left by earlier attempts were closed; research repositories received no test commits.

After the compatibility fix, backend typechecking passed. The GitHub client/automation/OAuth, publication, and architecture regression suite passed 50 tests with zero failures; its two opt-in PostgreSQL cases were skipped (the earlier separate PostgreSQL acceptance is recorded above).

Full release acceptance is recorded in `deploy/RELEASES.md`.

## Review provenance

- GitHub publication architecture review: `claude-fable-5`, completed 2026-09-16T23:15:50.864786+00:00; response SHA-256 `1d6cfa8f645a9e5aecf6398aff421376cd7da354977aa833ee040b6ce371b085`.
- GitHub publication implementation review: `claude-fable-5`, completed 2026-09-16T23:58:21.778022+00:00; response SHA-256 `4cb3edc8c99cedd00a0798881448716747906c00ec206df10c838a64cff1f1ac`.
- GitHub publication fixes verification: `claude-fable-5`, completed 2026-09-17T00:11:57.472355+00:00; response SHA-256 `424b0a2a6507b24f8db01c7c35b405adc999007901dd6aea7d8bbd5c2c99c49b`.
- Live API compatibility review: `claude-fable-5`, completed 2026-09-17T05:47:16.486306+00:00; response SHA-256 `31633024f2ce476abff5032f336000aa8f9b37d1d0febf1b0abc7cd8f04534e8`; **READY**. Its nonblocking recommendation to align the separate revocation request was applied through a shared version constant.
