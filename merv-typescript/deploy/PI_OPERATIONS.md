# Read-only Pi operations

Pi is an optional Fleet client. The Agent sidebar opens conversations, not tasks.
The production configuration keeps workflow dispatch disabled and uses the
authenticated, model-restricted relay with `gpt-6-luna`. Provider credentials stay
on the main server; workers receive only bounded per-command relay authority.

As of2026-09-24 18:17UTC, Pi is enabled for all34 existing human-accessible
projects, with35 connections including the service pilot. The33 new connections
use distinct namespaces and finite30-day consumers; renew by October17.
New projects require the same scoped connection onboarding, not just membership.
Owner-authorized enablement does not certify unfinished security or full UI
acceptance; see `docs/PI_IMPLEMENTATION_STATUS.md` for current limitations.

## Credentials and access

- Browser callers use normal authenticated human project membership. The old
  acceptance actor credential is not the browser credential or a production
  identity fallback. A project without an active human membership is not made
  accessible by enabling Pi.
- Each configured project requires a Sandboxes connection with a consumer grant
  restricted to its approved account, application, namespace and member. Its
  immutable grant ID must also occur in the runtime-launch allowlist of both
  Sandboxes control and the pipelines worker. Never substitute an administrator
  token in the application.
- Production consumer rotation uses a finite 30-day lifetime. Rotate at least
  seven days before expiry. There is no automatic renewal: operators must record
  the actual issuance, expiry and renewal deadline in the protected deployment
  receipt. A running process or HTTP health check does not establish valid grants.
- Human project onboarding uses the normal verified-login/membership path. Do not
  fabricate a human JWT, mutate membership tables directly, or convert a canary
  service actor into the user's identity.

## Consumer rotation

1. Verify current images, configuration, human access and provider identity;
   confirm no active allocations or pending infrastructure work. Preserve the
   account's **USD 100 all-time cap**, accrued spend and accounting, Fleet limits
   **1/1/1**, and the native maximum of **3**. Save private rollback configuration.
2. Through the existing account-admin grant API or trusted operator control
   service, issue a consumer with the exact previous scope and a 30-day TTL.
   Store the returned secret once in protected server configuration, never in
   Git, command arguments, transcripts or worker context. An ambiguous issuance
   must be reconciled by its recorded attempt and grant ID, not retried blindly.
3. Add the new grant ID to both runtime-launch allowlists without altering the
   release catalog. Verify identity and expiry, then install the project's new
   consumer credential and recreate the affected services from immutable images.
4. Verify authenticated readiness, a bounded Pi turn, streaming and release;
   retain the accepted isolation evidence for unchanged runtime/security code.
   Remove the superseded grant ID from both allowlists and revoke that grant
   after confirming no active launch depends on it.
5. Record exact Git revision, image, configuration hashes, grant ID, expiry,
   renewal deadline, budget and cleanup. Never record the secret. If no valid
   scoped consumer can be activated, fence new Pi work; an expired grant is not
   a usable rollback credential.

## Release and evidence

Publish the reviewed main-server source before building an immutable release.
Reconcile concurrent changes rather than deploying an old checkout. Do not change
published migration SQL or remove production migration-ledger rows for rollback.
The hosted runtime remains digest-pinned; rebuilding it requires its coordinated
release/catalog and isolation gates, not just a main-server rollout.

Complete Merv-controlled capture and secret scanning remain the security boundary.
Scan all available provider logs with source/time/pagination checks and explicitly
retain the provider-internal visibility limitation. Previously accepted evidence
is not proof of a new run's complete logs. Ordinary release regression checks must
not be relabeled as a fresh full security acceptance. Keep diagnostic SSH disabled
and temporary administrator keys absent after maintenance.
