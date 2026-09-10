# Cutover smoke verification

Run release verifiers with sandbox-issued consumer connections and the configured
Merv artifact `MERV_BLOB_*` storage. Budget editing, grant issuance and provider
administration happen in merv-sandboxes. These checks do not sign policy claims.

## Read and storage checks

Run inside the new Merv image after the reviewed imports and service health checks:

```sh
python /tmp/verify_sandboxes_cutover.py --project-id proj_existing --subject merv-user-id
python /tmp/verify_sandboxes_cutover.py --project-id proj_existing \
  --other-project-id proj_isolation --subject merv-user-id --write-storage
```

Both project IDs must be in `MERV_SANDBOXES_CONNECTIONS_FILE`, mapped to distinct
existing native namespaces. The subject must have an approved binding for each
grant. The verifier checks consumer role and actual namespace before writing.
Omit the subject only for a connection that does not require a subject selector.
Do not invent a project/namespace name to bypass grant setup.

The default run reads research data and existing artifact/workload bytes. Research
queries use database-enforced read-only transactions. Historical transfer bounds,
sample selection and schema compatibility are explicit in the verifier's CLI;
use `--help` to review them against the release. `--pre-cutover` permits its
documented earlier research schemas and is not a waiver of accounting migration.
Merv artifact history must already exist in the configured Merv-owned R2 bucket.

The storage write check uses unique object identities under the selected configured
namespace. It verifies upload, resumed multipart transfer, download and namespace
isolation, then deletes those exact objects. Artifact content keys are known
before upload so a lost response can still be cleaned up. Workload cleanup waits
for confirmed deletion; unresolved IDs require recovery and make the check fail.
Reports contain IDs, hashes and assertions, not signed URLs or credentials.

`verify_merv_composition.py` uses `MERV_VERIFY_PROJECT_ID` and optional
`MERV_VERIFY_SUBJECT`. It clears production database URLs before importing Merv
and creates synthetic research records and an agent key only in temporary SQLite.
It checks hosted HTTP/MCP authentication and the configured native connection.
Run it in a disposable container with no published ports and a temporary `/tmp`.

If translating legacy upload handles, run `verify_migrated_uploads.py --report -`
inside the new control container, passing the successful reviewed import receipt
on stdin. It checks only the selected migrated receipts and native object metadata,
preserves completion handles, and does not complete or delete migration sessions.
See [the historical storage record](SANDBOXES_STORAGE_MIGRATION_HISTORY.md) only
to interpret old receipts; its retired authentication instructions do not apply.

## Bounded compute check

Before any rental, the operator configures an explicit compute allowance in
merv-sandboxes and selects the provider, offer, lease and maximum extension.
Provision two distinct smoke namespaces and their consumer grants in advance.
Provider visibility uses exact namespace configuration; names grant no authority.

1. Authenticate both smoke connections with `GET /v1/auth/me` and verify their
   account, member and namespace mappings. Read available provider offers and
   confirm the reviewed currency, current price and lease fit the approved bound.
2. Generate a temporary Ed25519 caller key outside the Merv container. Submit one
   sandbox create with a unique smoke name and stable idempotency key, recording
   both before the request. The native service checks current budgets and reserves
   the lease. Persist the returned resource ID immediately. Do not create a
   replacement automatically after a lost response or provisioning failure.
3. Poll the exact resource to readiness within the reviewed deadline. A timeout
   enters cleanup. Request a short-lived caller certificate and check SSH using
   the returned gateway host key with strict host-key checking.
4. Run one short durable job with stable idempotency and tiny retained output.
   Check exit code, stdout/stderr and its exact output snapshot. Through the
   second namespace, require denial for this sandbox, job, output and snapshot.
5. If the approved scenario includes renewal, request it once after the job
   succeeds and verify the deadline change. Native accounting retains the original
   payer and checks the requesting grant and current budget again. Never send an
   allowance, historical usage or signed budget claim from Merv.
6. In cleanup, delete only the recorded sandbox and associated smoke output IDs.
   Recover a lost create by its exact idempotency key. Wait for provider-confirmed
   stop, then verify the durable job remains readable. Delete the exact output
   snapshot, revoke the temporary certificate, and remove the temporary SSH key.
   Report unresolved IDs and fail if cleanup does not finish.

`verify_merv_compute.py` implements the fixed Lambda A10 smoke scenario with a
600-second initial lease, one 300-second extension, a USD 1.29/hour offer ceiling,
and a USD 1 service-reported resource-cost bound. These are verifier constraints,
not live price claims or policy settings. Review that exact offer and configure
the allowance in the native service before running it; its offline tests do not
authorize a cloud rental. Set `MERV_SMOKE_PROJECT_ID`,
`MERV_SMOKE_OTHER_PROJECT_ID`, `MERV_SMOKE_PUBLIC_KEY`, and optional
`MERV_SMOKE_SUBJECT`, together with the normal service URL and connection file.

Both consumer connections and their distinct actual namespaces are checked
before provisioning. The script prints the create idempotency key before
submission and records a unique job/workflow name before requesting output
capture. It waits at most 60 seconds for the host SSH bridge to return
`{"ssh_ok": true}` on stdin. Cleanup recovers the exact create key, cancels only
the matching output workflow, confirms resource stop and workflow completion,
then deletes snapshots attributed to that job on that machine. Unresolved or
conflicting receipts fail cleanup and retain the keys/IDs in its sanitized report.
Other resources in the same namespace are excluded. Lease expiry remains a
backstop; it is not proof of cleanup. The cloud provider's invoice can differ
from the native compute estimate and needs its own reconciliation.

## Release evidence

Retain read/connection reports, scoped storage results, the reviewed compute
intent and lifecycle/cleanup evidence alongside accounting reconciliation and
the recovery rehearsal. Passing a smoke test cannot substitute for unresolved
legacy quotas, final usage deltas, ownership conflicts or recovery requirements.
