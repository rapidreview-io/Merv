# Deploy Merv research control

Merv owns research records, workflow, authorization, spending policy, and its
artifact/evidence bytes in a dedicated R2 bucket through boto3.
Deploy [merv-sandboxes](https://sandboxes.rapidreview.io) independently for
compute, provider credentials, SSH certificates, jobs, and large dataset/model
storage. Management SSH keys, compute SDKs, and VM cleanup workers live there.

## Required configuration

Copy `.env.example` to a private operator env file. Set:

- `MERV_DB_URL`: dedicated PostgreSQL database. Hosted Supabase works through
  its direct endpoint or session pooler; transaction pooling is unsupported.
- `MERV_SANDBOXES_URL`: service origin, including HTTPS in production.
- `MERV_SANDBOXES_JWT_SECRET`: at least 32 random bytes, identical to
  `SANDBOXES_MERV_JWT_SECRET` in the infrastructure deployment.
- `MERV_WAIT_SECRET`: stable signing key for bounded run-wait links.
- `MERV_BLOB_BUCKET`, `MERV_BLOB_ENDPOINT_URL`, `MERV_BLOB_ACCESS_KEY_ID`, and
  `MERV_BLOB_SECRET_ACCESS_KEY`: Merv's own R2 artifact storage. Region defaults
  to `auto`; `MERV_BLOB_PREFIX` optionally prefixes project/digest keys.
- Supabase authentication settings and public UI/CORS/OAuth URLs as documented
  in `.env.example` and [AUTH.md](../docs/AUTH.md).

Merv signs short-lived namespace-scoped service tokens after checking project
access. Never expose that signing secret to browsers, agent clients, or SSH
machines. Provider connections belong to the external service's credential
vault. Configure shared providers there with namespace prefix `merv-project-`
when they should only be available to Merv projects.

## Start the service

The base Compose file contains only the research control service. Add either
`docker-compose.postgres.yml` or `docker-compose.supabase.yml` for records, or
supply an external database URL. For example:

```sh
docker compose --env-file /secure/merv.env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.postgres.yml \
  up -d --build
```

Check the selected database overlay's example env file before first startup.
Put TLS in front of port 8787 and restrict database ports to trusted networks.
Startup checks authenticated infrastructure access when
`MERV_REQUIRE_SANDBOX_BACKEND=1` (the deployment default). A configured URL
alone does not make infrastructure healthy.

Local record-only development can omit R2 and infrastructure configuration.
Each missing capability returns an explicit unavailable error when used.
There is no automatic fallback to local blob storage or built-in compute.

## Production changes and rollback

The historical [SANDBOXES_CUTOVER.md](SANDBOXES_CUTOVER.md) covers retirement
of built-in compute and migration of large-object storage. Follow
[ARTIFACT_R2_CUTOVER.md](ARTIFACT_R2_CUTOVER.md) for schema59 and the separate
artifact migration into Merv-owned R2, preserving content IDs and history.

For subsequent releases, back up the research database, retain the prior
image, build an immutable release, and restart control against the same env
file. Verify `/health`, authenticated `/api/meta`, project reads, stored
artifacts, and the external infrastructure connection. Run database migrations
through normal startup; never rewrite an applied migration. Keep native
service releases and their database backups independently recoverable.

Logs and API diagnostics are described in
[CONTROL_PLANE_OPERATIONS.md](../docs/CONTROL_PLANE_OPERATIONS.md). Research
records survive a process restart; bounded diagnostic rings do not.
