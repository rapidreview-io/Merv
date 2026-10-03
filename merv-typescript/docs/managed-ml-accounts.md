# Managed ML account allowance

Merv-managed ML uses one infrastructure member per Merv account. The subject is
`merv_account_` plus the SHA-256 digest of the project's immutable creator issuer
and subject. Every project created by that account uses the same subject; a
collaborator or agent cannot choose the payer. Projects without creator provenance
are refused managed enrollment until ownership is resolved explicitly.

Sandboxes remains the authority for reservations and spending. Provision the
`merv-ml` account's unfiltered USD/month `member_default` policy with cap **500**.
Do not set a $500 platform account or namespace cap: those aggregate all users.
Existing higher platform ceilings and resource limits remain operational controls.
The member cap covers every project/work namespace, including concurrent launches.
The integration refuses managed issuance without a finite aggregate member cap.

## Deployment order

1. Apply the [companion Sandboxes patch](../deploy/patches/sandboxes-managed-ml.patch)
   to live-source base `10a0d5fd75f812d37b2698904063cd4e2f340c40` (reviewed companion
   commit `95a8d1d`). Deploy the change adding `POST /v1/delegations/connections`
   and `GET /v1/delegations/allowance`. Set `SANDBOXES_MANAGED_DELEGATION_GRANTS`
   to a JSON array containing the **existing ML consumption grant ID**. This is
   neither its secret nor an application name. Do not opt in Fleet or Code grants.
2. Verify `merv-ml` has the $500 monthly member default and the existing aggregate
   infrastructure ceilings. Review each live account's current-month historical
   usage before binding a new subject. Reuse an existing billing member via
   `AccountService.bind_subject` when that preserves all applicable usage. Never
   fabricate a debit transfer: import adjustments are nonnegative and would also
   increase platform-wide usage. Accounts with usage split across historical
   members need a separate reviewed accounting migration before cutover.
3. Deploy Merv with `sandboxes.native.managed` set to `{ "namespace": "merv-ml",
"tokenEnv": "<the existing ML consumption token environment variable>" }`.
   Keep the existing native credential-encryption key and application configuration.
   No administrator token or new browser consent credential is needed.
4. In each eligible project's Integrations, enable Merv-managed ML. The connection
   uses the creator's allowance and reports actual member usage and reservations.
   New legacy ML submissions/rentals are disabled in this mode. Existing legacy
   records, downloads, cancellations and releases remain available. CPU-only
   legacy work remains available in projects that have not enabled native compute.
5. For an existing native pilot, finish/revoke active assignments first. Enrollment
   fences new credentials, verifies the open work has no remote resources, revokes
   its old work grant, and checks resources again before changing the local binding.
   Work with jobs, machines or workflows cannot be silently migrated. Completed
   work retains its original connection, namespace and evidence provenance.
6. Verify allowance, two-project shared payer, and independent-account isolation
   with reads before resuming dispatch. A missing allowance or an authentication
   failure is not evidence that compute is funded or available.

## Pocket Composer audit, 2026-10-02 UTC

One verified account owns 19 creator-mapped production projects. None of their
legacy ML members has current-month spending. The two nonzero historical ML
subjects are absent from current Merv projects and remain unchanged. Another 71
projects have no creator-request provenance; do not invent ownership for them.

Pocket's pilot has an issued native work grant but no GPU resources. Its nine
assignments are revoked and all eleven sessions are released. The earlier
completed runner task retains its historical connection during migration.

This release does not repair the separate rejected Cloudflare credential used to
start researcher workers. Keep Pocket dispatch paused until that credential is
renewed and verified through the ordinary runtime path.

## Verification

Targeted Merv native connection, migration, evidence, work, plugin and UI tests;
configuration-render tests; TypeScript server and UI type checks. The companion
patch passes the managed delegation, existing delegation and account billing
suites, Python type checking for its four changed modules, and Ruff. Tests use
local PostgreSQL and fake infrastructure; no paid provider is started.

## Recovery boundary

This adds `sandboxes-native@2`. The pre-change Merv image rejects a database ahead
of its migration list, so an image-only rollback to that release is insufficient.
Before enabling the flag, retain a verified recovery snapshot and a compatible
fallback image that includes migration 2 with managed funding disabled. Keep
compute paused through a coordinated service/configuration cutover.

The companion Sandboxes change needs no schema migration. Do not roll that
service back while managed roots remain live: older token authentication does
not revalidate their issuing application grant. First revoke those roots with
the new service, confirm revocation, and disable new managed enrollment. Preserve
all closed-work evidence and accounting records throughout recovery.
