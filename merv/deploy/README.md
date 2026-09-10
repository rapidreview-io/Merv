# Deploy Merv research control

Merv owns research records, workflow, research authorization, and its
artifact/evidence bytes in a dedicated R2 bucket through boto3.
Deploy [merv-sandboxes](https://sandboxes.rapidreview.io) independently for
compute, provider credentials, SSH certificates, jobs, and large dataset/model
storage. Management SSH keys, compute SDKs, and VM cleanup workers live there.

## Required configuration

Copy `.env.example` to a private operator env file. Set:

- `MERV_DB_URL`: dedicated PostgreSQL database. Hosted Supabase works through
  its direct endpoint or session pooler; transaction pooling is unsupported.
- `MERV_SANDBOXES_URL`: service origin, including HTTPS in production.
- `MERV_SANDBOXES_CONNECTIONS_FILE`: private JSON file containing project-to-namespace
  mappings and sandbox-issued consumer credentials. With Compose this is the host
  path; the container reads `/run/secrets/merv_sandbox_connections`.
- `MERV_WAIT_SECRET`: stable signing key for bounded run-wait links.
- `MERV_BLOB_BUCKET`, `MERV_BLOB_ENDPOINT_URL`, `MERV_BLOB_ACCESS_KEY_ID`, and
  `MERV_BLOB_SECRET_ACCESS_KEY`: Merv's own R2 artifact storage. Region defaults
  to `auto`; `MERV_BLOB_PREFIX` optionally prefixes project/digest keys.
- Supabase authentication settings and public UI/CORS/OAuth URLs as documented
  in `.env.example` and [AUTH.md](../docs/AUTH.md).

An infrastructure owner authorizes Merv in the sandbox settings UI. Use consumer
credentials scoped to explicit namespaces and members; Merv refuses administrator
connections. Bind authenticated Merv user IDs under the grant's application ID.
Merv enforces research permissions and forwards authorized subjects; the service
owns infrastructure authorization, budgets and provider credentials. No shared
signing key, shared user database or reserved namespace prefix is required.

The private connection file has this shape (replace every placeholder):

```json
{
  "project-id": {"namespace": "research-project", "token": "sbxt_REPLACE_WITH_CONSUMER_TOKEN"}
}
```

Keep credentials out of browsers, agent responses and source control. For the
reference Linux Compose deployment, the source file must be readable by container
UID 10001; use an owner-readable file owned by that UID inside a protected operator
directory. Local Compose file-backed secrets preserve host permissions; `uid` and
`mode` declarations alone do not fix host-file access. With a process runner,
mount the file through its secret store and set its in-process path directly.

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
Startup requires service health when `MERV_REQUIRE_SANDBOX_BACKEND=1` (the
deployment default). Before a connection's first resource request Merv validates
its consumer role and selected namespace; the service checks the grant and subject
on every request. A healthy endpoint alone does not prove a project's access.

Local record-only development can omit R2 and infrastructure configuration.
Each missing capability returns an explicit unavailable error when used.
There is no automatic fallback to local blob storage or built-in compute.

## Production changes and rollback

The current [SANDBOXES_CUTOVER.md](SANDBOXES_CUTOVER.md) covers reviewed account
ownership, backups, provider import and consumer connection activation. Follow
[ARTIFACT_R2_CUTOVER.md](ARTIFACT_R2_CUTOVER.md) for schema59 and the separate
artifact migration into Merv-owned R2, preserving content IDs and history.
Use [BUDGET_MIGRATION.md](BUDGET_MIGRATION.md) for policy and usage ownership.
Staging separates `prepare` from `finalize`; only finalization, after native
account import and owner grant issuance, writes connection activation files.
The read verifier
now requires `--project-id` (or `MERV_VERIFY_PROJECT_ID`) naming a configured
connection. `--write-storage` also requires a separately configured
`--other-project-id` for isolation checks; it validates both grants before writing.
Use `--subject`/`MERV_VERIFY_SUBJECT` when the grants require an external subject.
The composition verifier uses the same `MERV_VERIFY_PROJECT_ID` and optional
subject while keeping its synthetic research records in disposable SQLite.

For subsequent releases, back up the research database, retain the prior
image, build an immutable release, and restart control against the same env
file. Verify `/health`, authenticated `/api/meta`, project reads, stored
artifacts, and the external infrastructure connection. Run database migrations
through normal startup; never rewrite an applied migration. Keep native
service releases and their database backups independently recoverable.

Logs and API diagnostics are described in
[CONTROL_PLANE_OPERATIONS.md](../docs/CONTROL_PLANE_OPERATIONS.md). Research
records survive a process restart; bounded diagnostic rings do not.
