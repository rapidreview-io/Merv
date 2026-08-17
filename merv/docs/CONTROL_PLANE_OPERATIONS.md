# Operating the hosted brain

This is the production runbook for the `control` preset served by
`merv-control`. The reference container stack lives in
[`deploy/README.md`](../deploy/README.md).

## Security boundary

Control mode is authenticated by default. `SupabaseVerifier` accepts Supabase
session JWTs, RapidReview `rr_sk_` keys, and Merv `mk_`/OAuth credentials.
Project membership and key scope are enforced at the HTTP and MCP funnels.

Required production posture:

- terminate TLS before the brain;
- set `MERV_REQUIRE_AUTH=1`;
- configure exact browser origins in `MERV_ALLOWED_ORIGINS`;
- keep `/api/admin/*` on an operator-controlled network;
- store database, provider, Supabase, and SSH credentials in a secret manager.

An intentionally open control plane requires both `MERV_REQUIRE_AUTH=0` and
`MERV_ALLOW_OPEN_CONTROL=1`. This is for isolated development only; the server
logs the open state at every boot.

## Required configuration

`merv-control` forces `MERV_MODE=control` and fails fast without:

```text
MERV_DB_URL                 Postgres record-store URL
MERV_BLOB_BUCKET            S3-compatible submitted-byte bucket
MERV_MGMT_KEY_PATH          mounted management private key, mode 0600
SUPABASE_URL
SUPABASE_JWT_SECRET
SUPABASE_SERVICE_KEY
SUPABASE_ANON_KEY
```

The management public key comes from `MERV_MGMT_PUBLIC_KEY` or the adjacent
`.pub` file. Drain live sandboxes before rotating this key.

Heavy-object storage is optional and separate from submitted artifacts:

```text
MERV_STORAGE_PROVIDER=s3
MERV_STORAGE_BUCKET=...
MERV_STORAGE_ENDPOINT_URL=...   # MinIO, R2, or custom S3
MERV_STORAGE_REGION=...
MERV_STORAGE_ACCESS_KEY_ID=...  # otherwise normal AWS resolution
MERV_STORAGE_SECRET_ACCESS_KEY=...
```

Presigned URLs must be reachable from agent machines, not just the container.

## Browser and client traffic

`MERV_ALLOWED_ORIGINS` is a comma-separated list of exact HTTP(S) browser
origins. CORS is not authentication. Agent clients connect directly to
`POST /mcp` and pass a project or account-scoped bearer credential.

`GET /api/meta` reports the server/catalog versions, mode, authentication
requirements, and capabilities. A client explicitly below
`min_proxy_version` receives `426 client_too_old`; a missing version header is
currently tolerated. `X-RP-Request-Id` identifies requests in logs.

See [AUTH.md](AUTH.md) for credential and membership behavior and
[CLIENTS.md](CLIENTS.md) for client configuration.

## Sandbox providers

Select one provider with `MERV_EXECUTION_BACKEND` or several with the
comma-separated `MERV_EXECUTION_BACKENDS`. Set
`MERV_REQUIRE_SANDBOX_BACKEND=1` to reject startup when the configured provider
is unhealthy. Without it, the brain may run record-only and expose the provider
failure through sandbox health.

Provider credentials belong in the control environment. Secrets delivered to a
runtime travel through the provider or management channel, never in agent
responses. See [SANDBOX_PROVIDERS.md](SANDBOX_PROVIDERS.md) for provider
settings.

## Cleanup and cost control

Sandbox lifecycle scheduling runs in the brain. Broader cleanup is an
idempotent operator action:

```http
POST /api/admin/cleanup
```

Schedule it with managed cron or a sidecar. A pass reconciles tracked
sandboxes, expires submitted blobs and heavy objects, and recovers stale
provisioning records. It does not discover arbitrary provider VMs that have no
durable Merv row.

The tool-call ledger and its per-call payload records (see
[AGENT_IDENTITY.md](AGENT_IDENTITY.md)) prune themselves on the brain's own
hourly timer at `MERV_TOOL_CALL_RETENTION_DAYS` (default 180); the cleanup
pass is a second net for their blobs. Agent traces are read at
`GET /api/admin/agents` and `GET /api/admin/agents/{agent_id}?payloads=true`
with the operator token. `MERV_AGENT_IDENTITY=optional` stops the brain from
demanding an `agent_id` on MCP calls (it still records one when supplied);
leave it unset in production.

Sandbox admission and spend policy can enforce concurrency, duration, price,
GPU-hour, and USD limits. Keep the provider consoles and billing alerts as an
independent safety net.

Nothing on a sandbox is durable by default. Retain compact evidence through
Artifacts and heavy outputs through Object Storage before release or expiry.

## Observability

The brain writes compact request records to stdout in control mode. Three
different data sources exist:

- project events are durable and commit with accepted research changes;
- `/api/activity` is a bounded in-memory summary ring;
- `/api/debug/tool-calls` is a bounded in-memory request/response ring.

The diagnostic rings reset on restart and are operator surfaces.

The UI uses project-event SSE for refresh hints and ETag polling as fallback.
Terminal and utilization reads use the management transport and short-lived
caches.

## Readiness

The reference Compose stack is an integration environment, not a production
platform. After configuring providers, run:

```bash
python3 deploy/doctor.py --control-url http://127.0.0.1:8787
```

Production additionally needs managed Postgres and backups, durable bucket
lifecycle policy, TLS, secrets management, cleanup scheduling, provider billing
alerts, service monitoring, and a separately deployed UI.
