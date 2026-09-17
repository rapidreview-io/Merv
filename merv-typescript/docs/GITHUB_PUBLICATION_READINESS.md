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

The application is deployed. Live GitHub transport/PR/merge verification remains pending the App signing key and permission upgrade: at preflight `MERV_GITHUB_PRIVATE_KEY_BASE64` was absent and the official App still granted only Metadata read. Both setup requests were handed to the user as required by the browser's credential/access-change policy. No production GitHub writes are claimed. The existing OAuth connection remains available; automation stays off until explicitly configured.

Full release acceptance is recorded in `deploy/RELEASES.md`.

## Review provenance

- GitHub publication architecture review: `claude-fable-5`, completed 2026-09-16T23:15:50.864786+00:00; response SHA-256 `1d6cfa8f645a9e5aecf6398aff421376cd7da354977aa833ee040b6ce371b085`.
- GitHub publication implementation review: `claude-fable-5`, completed 2026-09-16T23:58:21.778022+00:00; response SHA-256 `4cb3edc8c99cedd00a0798881448716747906c00ec206df10c838a64cff1f1ac`.
- GitHub publication fixes verification: `claude-fable-5`, completed 2026-09-17T00:11:57.472355+00:00; response SHA-256 `424b0a2a6507b24f8db01c7c35b405adc999007901dd6aea7d8bbd5c2c99c49b`.
