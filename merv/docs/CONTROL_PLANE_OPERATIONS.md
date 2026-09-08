# Control plane operations

Merv runs the research API, MCP gateway, and workflow against its PostgreSQL
record database. The independent merv-sandboxes service owns physical bytes,
cloud credentials, VM provisioning, SSH certificates, durable jobs, expiry,
and cleanup. Operate and back up both services separately.

## Startup and health

Hosted control requires `MERV_DB_URL`, `MERV_SANDBOXES_URL`,
`MERV_SANDBOXES_JWT_SECRET`, `MERV_WAIT_SECRET`, and the end-user authentication
configuration in [AUTH.md](AUTH.md). Set `MERV_REQUIRE_SANDBOX_BACKEND=1` to
check authenticated service access at startup. Invalid or incomplete
configuration fails startup instead of selecting a built-in backend.

`GET /health` checks the Merv process. Inspect authenticated `/api/meta` and
provider reads to verify infrastructure reachability. Upstream infrastructure
failures return a structured `infrastructure_unavailable` error (HTTP 503),
while project authorization still happens in Merv. Do not print signing keys,
provider fields, presigned transfer URLs, or authorization headers in logs.

## Compute and spending

Merv associates native sandbox IDs and jobs with research experiments.
`merv-sandboxes` owns machine state, expiration, job execution, and cleanup.
Check its control/worker logs and provider health when provisioning fails.
There is no Merv SSH management key, VM bootstrap script, or reaper to repair.

Merv's saved project caps, platform payer caps, enabled flags, and spend kill
switches remain research policy. Each create/renew call carries a signed daily
policy including the original payer and legacy daily spend. The native
service atomically reserves remaining lease commitments across projects and
rejects admissions that exceed a cap. Extending a lease must pass a fresh
policy check. Historical terminated sandbox records remain read-only.

## Storage

Merv retains the object ledger, artifact identities, retention policy, and
research relationships. Its storage adapters use the external HTTP API for
both submitted blobs and heavy objects. Native storage owns multipart uploads,
presigned URLs, checksum validation, physical deletion, and expiry. Repair
provider access in that service, never by adding S3 credentials to Merv.

Use the migration report and native object catalog when diagnosing legacy
objects. Adopted R2 objects retain their old bucket/key; copied MinIO blobs
have verified SHA-256. A historical multipart digest with size-only evidence
is explicitly distinguished from a newly verified full checksum.

## Observability

- `/api/activity?limit=100`: bounded in-memory activity ring.
- `/api/debug/tool-calls`: bounded in-memory tool-call diagnostics.
- `/api/projects/{project_id}/events`: durable accepted research events.
- `/api/projects/{project_id}/events/stream`: SSE notifications for UI refresh.

Diagnostic rings reset on restart. Durable events and records remain in the
research database. Use a dedicated PostgreSQL database and session-compatible
connections because migrations and other operations use advisory locks.

## Deployment and recovery

See [deploy/README.md](../deploy/README.md) for ordinary deployment and
[SANDBOXES_CUTOVER.md](../deploy/SANDBOXES_CUTOVER.md) for the migration and its
rollback constraints. Preserve source buckets and offline legacy volumes
through the rollback window. A rollback after new native writes requires
reconciling those writes; restoring an old database would lose them.
