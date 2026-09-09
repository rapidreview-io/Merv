# Move production to merv-sandboxes

This is the historical sandbox-infrastructure cutover runbook. Its evidence
storage steps have been superseded: Merv now stores artifacts, figures, feed
bytes, and diagnostic payloads in its own R2 bucket using `MERV_BLOB_*`
configuration. See `ARTIFACT_R2_CUTOVER.md` for that migration. Native sandbox
and large dataset/model storage remain under merv-sandboxes as described below.

Merv retains its research PostgreSQL database. Sandbox lifecycle, provider
credentials, submitted blobs, and heavy object bytes move to the independent
`merv-sandboxes` service. The Merv process needs only `MERV_SANDBOXES_URL` and
`MERV_SANDBOXES_JWT_SECRET` for infrastructure access.

## Preserve the existing deployment

Production is reached through the existing `ResearchSuite_Control` SSH alias.
The historical Merv service is `deploy-control-1`; its research database is
`deploy-supabase-db-1`. Its release directory and exact image are available in
`docker inspect`, under the Compose working-directory label and `Image`.
Capture these before changing anything. The older `deploy-postgres-1` is not
the current research database.

`stage_sandboxes_cutover.py --stage-directory <new-absolute-directory>` creates
restricted backups, exact image rollback tags, the paired delegated secret,
provider-transfer manifests, and Compose overlays without restarting services.
Its Lambda and Thunder host connections use
`namespace_prefixes=["merv-project-"]`; standalone native-service users cannot
use Merv's platform credentials. The project's own GCP key is staged separately
for its namespace vault.

On the Docker host, create a mode-0700 cutover directory outside the checkout.
Save the previous image with a rollback tag; copy the existing Compose files,
operator env files and Caddyfile there with mode 0600. Export both PostgreSQL
databases before deployment, and again after stopping the old Merv writers:

```sh
docker exec deploy-supabase-db-1 pg_dump -U postgres -d postgres -Fc > merv.dump
docker exec sandboxes-postgres-1 pg_dump -U sandboxes -d sandboxes -Fc > sandboxes.dump
pg_restore --list merv.dump > merv-restore-list.txt
pg_restore --list sandboxes.dump > sandboxes-restore-list.txt
```

These commands must run from the restricted cutover directory. Verify both
archives with a restore into disposable databases before final cutover.
For the complete Supabase dump, restore as `supabase_admin`: the ordinary
`postgres` role cannot restore Supabase's managed `vault.secrets` table.
Retain Docker volumes, the old images, both dumps, and original object buckets
through the rollback window. Do not run Compose with `--remove-orphans` during
cutover; stop retired services explicitly only after verification.

## Configure the external service

Deploy the merv-sandboxes release containing delegated Merv authentication,
object retention, and operator adoption support. Set the same random secret in
`SANDBOXES_MERV_JWT_SECRET` and `MERV_SANDBOXES_JWT_SECRET`; never print it or
place it in source control. Keep exact provider connections and spending limits
when moving platform and project credentials into the external service.

Production heavy bytes already live in R2 bucket `test1`. The new service uses
bucket `sandboxes` on the same account with the same credential identity. Set:

```dotenv
SANDBOXES_STORAGE__ADOPTED_BUCKETS=["test1"]
SANDBOXES_STORAGE__NAMESPACE_MAX_BYTES=5497558138880
```

The allowlisted bucket remains owned by the external service. Public upload
requests cannot choose an adopted bucket. Native internal catalog locators
preserve its existing keys, so adopting terabytes does not require copying
them. The namespace limit must cover existing bytes and incomplete uploads;
the former 1 TiB native default is smaller than production's largest project.

Merv heavy objects use namespace `merv-project-<project_id>` and name equal to
their SHA-256. Submitted blobs use namespace `merv-blobs` and name
`<original_namespace>/<sha256>`. The Merv ledger's IDs, names, versions and
research relationships remain intact.

## Import and verify bytes

Place `migrate_to_sandboxes.py` on the Docker host and in a disposable native
service worker. Give that worker access to the native database and legacy MinIO
networks, using the existing native configuration securely. Set `MIGRATION_WORKER`
to its container name. Export while the old control container still exists:

```sh
python3 migrate_to_sandboxes.py --blob-endpoint http://deploy-minio-1:9000 --export legacy-source.json
docker exec -i "$MIGRATION_WORKER" python /tmp/migrate_to_sandboxes.py \
  --trust-legacy-multipart --report /tmp/merv-storage-audit.json < legacy-source.json
```

The export is created exclusively with mode 0600 and contains source S3
credentials. It must stay in the restricted operator directory. The worker
defaults to an audit: it reads and verifies source bytes without creating
native objects. Its output/report contains no credentials.

Existing single-PUT objects are checked against provider SHA-256 and size.
Legacy Merv multipart uploads verified size only; their historical digest
cannot be reconstructed cheaply from a multipart ETag. The explicit
`--trust-legacy-multipart` flag preserves that digest and records
`legacy_manifest_sha256_size_verified` separately from provider-verified
checksums. It never silently calls those hashes newly verified.

The worker copies and hashes all submitted MinIO blobs. It also recovers
available heavy objects missing from R2 from the retained MinIO bucket
`research-plugin-storage`; this recovers the older project's 26 objects that
otherwise already appeared missing in the old deployment. Copied objects go
into the native bucket. Replays fully hash each source blob and verify the native copy again, but reuse matching published receipts without uploading the bytes again. Blob MIME types and absolute expiration timestamps are preserved. Already
expired source blobs are counted separately and need not be revived. Heavy
objects remain pinned until the Merv ledger applies retention or deletion.

After the audit has no failures, import:

```sh
docker exec -i "$MIGRATION_WORKER" python /tmp/migrate_to_sandboxes.py \
  --apply --trust-legacy-multipart --report /tmp/merv-storage-import.json < legacy-source.json
docker exec "$MIGRATION_WORKER" cat /tmp/merv-storage-import.json > ./merv-storage-import.json
chmod 0600 ./merv-storage-import.json
```

The import is restartable. It preserves source bytes, uses deterministic names
and idempotency keys, and reports every failure. Retry transient failures until
the final report has none. Do not proceed with missing available bytes.

For old uploading rows, complete matching bytes are adopted as available
native objects. Missing or incomplete bytes get fresh native upload sessions;
these uploads can restart through Merv. Old partial multipart uploads and
sidecar metadata remain in the original bucket for operator recovery. Their
existing multipart parts cannot be resumed through a different service's
upload protocol.

## Freeze and switch Merv

Stop old Merv writers and confirm zero active legacy sandboxes. Take final
dumps, regenerate the source export and rerun the import so no last-minute
writes are missed. Keep the stopped old control container until its final
export completes. Use the successful final report to update upload IDs and
completion-token references in one guarded database transaction:

```sh
python3 migrate_to_sandboxes.py --source-user supabase_admin \
  --apply-upload-mapping merv-storage-import.json
```

Supabase's ordinary `postgres` role can read these tables but cannot update
them. The explicit `--source-user supabase_admin` uses the existing migration
administrator; it does not broaden table grants.

The mapping requires the old uploading rows still match the exported state.
It preserves all ledger IDs and translates them into resumable native targets.
The encoded migration handle contains the project, native object ID, and legacy
ledger row ID. The row ID keeps completion handles distinct when several pending
ledger rows share the same immutable native bytes. Three production pending rows
had declared sizes inconsistent with a matching available SHA; the report records
the fully verified canonical available row and size. The mapping transaction
repairs only those pending sizes, checks exact old-or-new handle/size pairs, and
rechecks the canonical row's project, SHA, available status, and size. Completion
tokens carry no size payload and keep their original row IDs.

For this production host, run the disposable operator worker on both
`sandboxes_default` and `deploy_default`. Use `sandboxes-postgres-1` for the native
DB hostname and `http://deploy-minio-1:9000` for the source blob endpoint. The
public Caddy object routes do not proxy bucket-root listing requests. Do not attach
production application containers to extra networks. The staged operator wrapper
supports `--apply-only --source <frozen-export> --report-prefix native-storage-final`
for the final pass and removes its temporary container afterward.
Repeated application accepts already-translated rows.

Start the new Merv image against the same research database, using the external
service URL and delegated secret. Remove its provider credentials, S3
credentials and management-key mount. Verify authenticated project access,
historical blob reads, heavy downloads (including recovered MinIO objects),
new storage upload/complete/download, provider listing, and a bounded sandbox
lifecycle. Compare research-table counts against the frozen snapshot.

Only after these checks pass, stop the retired MinIO and old PostgreSQL
containers. Keep their volumes and source buckets as rollback backups. Update
Caddy to remove obsolete MinIO proxy routes, and verify public Merv and
merv-sandboxes health. Update the production launcher to use the new release
and external-infrastructure env file so a later restart preserves the cutover.

## Rollback

Before new production writes, stop the new Merv control, restore the final
research dump (which restores old upload IDs), and restart the recorded old
image with its saved env files, management volume, and MinIO. Restore the old
Caddyfile if its routes changed. The source buckets were never deleted.

After new writes, preserve a fresh dump of both databases before rolling back.
New native uploads are not automatically present in old storage, and the old
Merv build cannot read native upload IDs. Export/copy those new bytes and
translate their ledger rows before returning to the old build; restoring an
older dump would discard those research writes. Do not merge divergent
databases or delete the native data to force a rollback.
