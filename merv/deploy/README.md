# Hosted brain reference deployment

This directory is a worked deployment of the Merv brain. The hosted
entry point uses the same `ControlApp` composition as the local brain, with
durable hosted adapters and stricter startup requirements. It is not a managed
service or a production security boundary.

The database-neutral base stack contains:

| Service | Responsibility |
|---|---|
| `control` | FastAPI brain: research records, workflow gates, reviews, sandbox lifecycle, UI API, and token-authorized upload routes |
| `minio` | Submitted-byte blobs and optional heavy-file storage |
| `mgmtkey` | Generates a development-only brain management SSH key |

Add one database choice:

| Choice | Compose/configuration | Use case |
|---|---|---|
| Ordinary PostgreSQL | `docker-compose.postgres.yml` | Smallest local/reference deployment |
| Self-hosted Supabase PostgreSQL | `docker-compose.supabase.yml` | Dedicated Postgres plus a local Studio table dashboard |
| Hosted Supabase PostgreSQL | Base file plus `MERV_DB_URL` | Managed database and hosted Supabase dashboard |
| Other external PostgreSQL | Base file plus `MERV_DB_URL` | Existing managed or self-managed PostgreSQL |

All choices use the same `PostgresStateStore` and startup migrations. There is
no Supabase database SDK or Supabase-specific query path in Merv. Supabase Auth
continues to use the separate production project configured by `SUPABASE_*`,
and artifact bytes continue to use MinIO/S3.

Each agent (local Claude Code, cloud Codex, Replit) connects directly to the
brain's `POST /mcp` endpoint with an `Authorization: Bearer <key>` project key.
There is no local MCP proxy on agent machines, and agents never send a checkout
root; they send only explicit metadata or bounded submitted bytes to the brain.
The browser UI is deployed separately and talks directly to the brain.

## Start with ordinary PostgreSQL

From `merv/`:

```sh
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.postgres.yml \
  up --build -d
curl -s http://127.0.0.1:8787/api/meta
```

The overlay binds PostgreSQL to `127.0.0.1:5432` and supplies `MERV_DB_URL` to
control. Override `MERV_POSTGRES_PASSWORD` and `MERV_POSTGRES_PORT` when needed.

## Start with self-hosted Supabase PostgreSQL

This is a deliberately small Supabase data stack: Supabase PostgreSQL,
`postgres-meta`, and Studio. It does not run GoTrue/Auth, PostgREST, Realtime,
Kong, or Supabase Storage. That keeps the database choice independent of Merv's
existing production authentication project and MinIO artifact plane.

Create an ignored operator env file and replace every `CHANGE_ME`. Use URL-safe
hex values because the application password is inserted into a Postgres URL:

```sh
cp deploy/supabase.env.example deploy/.env.supabase.local
openssl rand -hex 32
```

Then start it:

```sh
docker compose --env-file deploy/.env.supabase.local \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.supabase.yml \
  up --build -d
```

On the Docker host, open [http://127.0.0.1:55433](http://127.0.0.1:55433), then
select **Table Editor** and the `public` schema. Merv's tables appear after the
`control` service has completed startup migrations.

If Docker runs on a remote server, keep the ports bound to loopback and open an
SSH tunnel from the laptop:

```sh
ssh -N \
  -L 55433:127.0.0.1:55433 \
  -L 55432:127.0.0.1:55432 \
  USER@MERV_HOST
```

Then use the same Studio URL on the laptop. This path needs no CORS change:
Studio talks to its metadata service inside the Compose network, and the
browser sees Studio as a single `127.0.0.1` origin. The SSH login is the remote
access boundary. Do not change the bind address to `0.0.0.0`; this minimal
Studio route does not include Kong's dashboard basic-auth layer. If a public
dashboard URL is required, put it behind an authenticated TLS reverse proxy.

The published database port is for `psql`/admin use from the Docker host or SSH
tunnel. Merv connects directly over the private Compose network.

## Use hosted Supabase PostgreSQL

Create a dedicated Supabase project for Merv data. Do not reuse the production
authentication project's database: Merv owns tables in `public`, runs DDL at
startup, and should have an independent backup/restore and failure boundary.

1. In the new project's SQL editor, open
   `deploy/supabase/hosted-bootstrap.sql`, replace the password placeholder,
   and run it once. Then connect as `merv_app` with `psql` and run
   `deploy/supabase/app-default-privileges.sql`.
2. Set `MERV_DB_URL` to the direct database endpoint or the session pooler on
   port 5432. Append `sslmode=require`. Never use the transaction pooler on
   port 6543 because Merv holds session advisory locks during startup.
3. Keep every control replica's DSN byte-for-byte identical. Merv derives its
   cross-replica advisory-lock key from the complete DSN string.
4. Start the database-neutral base Compose file or equivalent production
   deployment. Use the hosted Supabase dashboard's Table Editor to inspect the
   `public` schema.

The `merv_app` role must own its tables and keep `USAGE, CREATE` on `public` so
Merv can apply migrations. A separate schema is not currently supported: the
Postgres adapter's introspection queries explicitly target `public`. The
bootstrap grants no table access to `anon` or `authenticated`; Merv data is not
intended to be a Supabase Data API surface, and RLS is not Merv's tenant
boundary.

## Database preflight

Before starting `control`, validate the target with the same control image:

```sh
docker compose --env-file deploy/.env.supabase.local \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.supabase.yml \
  run --rm --no-deps --entrypoint python control deploy/db_preflight.py
```

For a hosted database, add `--require-tls`. The check verifies connectivity,
read/write mode, the `public` schema privileges, transactional DDL, TLS when
requested, and that session advisory locks survive a round trip. It rejects
the standard Supabase transaction-pooler port. It never prints the password or
full DSN.

## Move an existing Merv PostgreSQL database

Changing overlays changes where new writes go; it does not copy existing data.
For a controlled cutover:

1. Create the dedicated empty target and run the appropriate bootstrap, but do
   not start Merv against it yet.
2. Run the preflight. Take a target baseline backup and verify the source's
   latest backup can be restored.
3. Stop all source writers. Export the Merv `public` schema and data with the
   PostgreSQL client version matching or newer than the source:

   ```sh
   pg_dump --dbname="$MERV_SOURCE_DB_URL" \
     --format=custom --no-owner --no-acl \
     --file=merv-cutover.dump
   ```

4. Restore into the empty target as `merv_app`:

   ```sh
   pg_restore --dbname="$MERV_TARGET_DB_URL" \
     --no-owner --no-acl --single-transaction \
     merv-cutover.dump
   ```

5. Point one control replica at the target and start it. Startup applies any
   newer Merv migrations under the advisory lock. Compare table counts and the
   maximum `schema_migrations.version`, then start the remaining replicas.
6. Keep the source read-only and retain the dump through the rollback window.
   Rollback means stopping target writers and restoring the original DSN; do
   not merge divergent writes.

Use scheduled logical backups (`pg_dump`) plus tested restores for self-hosted
deployments. A Docker named-volume snapshot alone is not a complete backup
policy. Hosted Supabase backup/PITR availability depends on its current plan;
verify it for the dedicated data project before cutover.

## Provider credentials and deploy doctor

Provider credentials use a separate container env file so Compose cannot erase
them with empty `environment` defaults. Keep that file outside the checkout,
restrict it to the deployment account, and pass its absolute path when starting
the stack:

```sh
MERV_PROVIDER_ENV_FILE=/run/secrets/merv-provider.env \
  docker compose \
    -f deploy/docker-compose.yml \
    -f deploy/docker-compose.postgres.yml \
    up --build -d
```

The file may contain `MERV_LAMBDA_API_KEY` (or
`LAMBDA_LABS_API_KEY`), Thunder/Modal credentials, and `HF_TOKEN`. Do not also
declare those names with empty values under the control service's
`environment:` map: Compose gives that map precedence over `env_file`.

The compose defaults intentionally leave sandbox provider credentials empty, so
provisioning is unavailable until a provider is configured. Heavy-storage
presigned URLs are run by
agent clients (and the doctor), so they must be reachable from those machines;
they do not need to be reachable from sandbox execution.

Run the active readiness sweep after a deploy or restart:

```sh
RP_DOCTOR_BEARER_TOKEN=mk_CHANGE_ME \
  python3 deploy/doctor.py --control-url http://127.0.0.1:8787
```

The doctor creates or reuses a smoke project, checks the sandbox provider, and
exercises heavy object storage. It therefore fails on the record-only defaults.
`--skip-storage` skips the storage smoke.

For the local MinIO stack, a host-run doctor may need its Docker hostname
rewritten to the published port:

```sh
RP_DOCTOR_URL_REWRITE=http://minio:9000=http://127.0.0.1:9000 \
  python3 deploy/doctor.py --control-url http://127.0.0.1:8787
```

## Hosted configuration

`merv-control` forces `MERV_MODE=control`. With no
explicit development `repo_root`, startup requires:

- `MERV_DB_URL`: Postgres record store;
- `MERV_BLOB_BUCKET` plus the relevant `AWS_*` settings: durable
  submitted-byte blob store;
- `MERV_MGMT_KEY_PATH`: a mounted **private-key file** readable only
  by the control process; and
- either `MERV_MGMT_PUBLIC_KEY` or an adjacent `<key>.pub` file.

Heavy object storage is optional. Enable it with
`MERV_STORAGE_PROVIDER` and the storage bucket/credentials. This is
separate from the submitted-byte blob store, which hosted startup requires.

Set `MERV_REQUIRE_SANDBOX_BACKEND=1` to reject startup
when the selected provider is unhealthy. Provider credentials and the brain
management key belong only in the hosted secret store; they are never sent to
agent clients.

See `.env.example` for the supported variables.

### Legacy `RESEARCH_PLUGIN_*` names

`MERV_*` is the primary spelling for every variable; the legacy
`RESEARCH_PLUGIN_*` names keep working forever as a fallback (non-empty
`MERV_*` wins, and a legacy-sourced value logs one deprecation line). The
reference compose file also dual-reads host-side substitutions, so a host
that still exports only legacy names deploys unchanged.

One sharp edge for operators with their own compose **override files**:
`environment:` maps merge by key. This base file now sets container env
under the `MERV_*` keys, and a non-empty `MERV_*` beats a legacy name inside
the container — so an override that pins values under `RESEARCH_PLUGIN_*`
keys no longer shadows the base defaults. Rename the keys in your override
to `MERV_*` (or export the value host-side, which the base dual-reads).

## Network and security boundary

The brain serves plain HTTP on port 8787. A real deployment must terminate TLS
at a load balancer or reverse proxy.

The reference compose stack ships with authentication required
(`MERV_REQUIRE_AUTH=1`). A verifier is built from `SUPABASE_URL` and
`SUPABASE_JWT_SECRET` alone — without both the brain will not start. The other
two are optional and buy specific features: `SUPABASE_SERVICE_KEY` (the
service-role key) enables `rr_sk_` API-key and project-member email lookups,
without which those features are disabled; `SUPABASE_ANON_KEY`
is published through `/api/meta` so the hosted UI can sign users in. End-user
auth brings `project_members` tenant isolation and project-scoped `mk_` keys
(the gateway enforces that a key can only act on its bound project). A
record-only dev stack that deliberately wants no auth sets
`MERV_REQUIRE_AUTH=0` **and** `MERV_ALLOW_OPEN_CONTROL=1`; the brain then logs
its open state on every boot. `MERV_ALLOW_OPEN_CONTROL` is parsed strictly: it
accepts only `1/true/yes/on` or `0/false/no/off`, and any other value fails the
boot rather than being guessed, so a typo can never open the plane. CORS
restrictions and the MCP client-version floor
are not authentication. Keep an open stack — the brain, storage
endpoints, and admin routes — on a trusted operator network; do not expose it
directly to the public internet.

The UI may call control/lifecycle routes, but byte transfers — artifact,
storage, and feed uploads, and sandbox output pulls — run agent-side over
presigned or token URLs. The brain never receives a checkout root and cannot
serve arbitrary live checkout files.

## Operations

- Clients send `X-RP-Client-Version`; clients below the floor published by
  `/api/meta` receive HTTP 426.
- The sandbox expiry reaper runs inside hosted control. On restart, it
  reconciles registered active rows.
- Broader cleanup is not scheduled. Invoke `POST /api/admin/cleanup` from a
  trusted cron or sidecar. It handles registered stale sandbox state, blob TTLs,
  storage leases, and stale provisioning records; it does not discover and
  terminate arbitrary provider VMs that have no ledger row.
- HTTP request logs go to stdout. Diagnostic activity and tool-call rings are
  process-local and bounded, so they reset on restart.

## What production must add

- TLS, routing, and a trusted network boundary;
- managed Postgres, object storage, backups, and lifecycle rules;
- a real secret manager and management-key rotation procedure;
- a cleanup scheduler and operational alerting;
- a separately deployed UI with explicit CORS origins; and
- end-user authentication and authorization before any public or multi-tenant
  use.
