# Move Merv evidence to its own R2 bucket

Merv stores artifacts, figures, feed media, and diagnostic payloads directly in
R2 using boto3. merv-sandboxes continues to own ML datasets, models, and compute.
The artifact component owns immutable content; Research owns associations,
role validation, replacement visibility, and explicit submission snapshots.

## Prepare

1. Retain the current image, launcher, configuration, and PostgreSQL backup.
2. Provision a private Merv artifact bucket. Set `MERV_BLOB_BUCKET`,
   `MERV_BLOB_ENDPOINT_URL`, `MERV_BLOB_ACCESS_KEY_ID`, and
   `MERV_BLOB_SECRET_ACCESS_KEY` in a protected operator env file. Region
   defaults to `auto`; keep `MERV_BLOB_PREFIX` stable once data exists.
3. Build the release image, run the regression suite, and rehearse migration 59
   against a disposable copy of the production database. Verify artifact IDs,
   hashes, figure references, associations, and submission membership.

## Copy and switch

Run the operator with the new release's Python dependencies and `src` on
`PYTHONPATH`. The source env contains the current Merv sandbox service URL and
signing secret; the destination env contains the new `MERV_BLOB_*` settings.

```sh
python deploy/migrate_artifacts_to_r2.py \
  --source-env /secure/control.env --destination-env /secure/r2.env \
  --report /secure/artifact-inventory.json
python deploy/migrate_artifacts_to_r2.py \
  --source-env /secure/control.env --destination-env /secure/r2.env \
  --report /secure/artifact-copy.json --apply
```

The copy reads only native namespace `merv-blobs`. It preserves each internal
`namespace/sha256` key, verifies source and destination bytes, and checks
existing keys on every rerun. It never deletes source objects or accesses ML
dataset/model namespaces. Reports exclude credentials and signed URLs.

Pause Merv writes for the final inventory and back up the frozen database.
Require its hash/count/bytes to match the fully verified copy report; if they
changed, repeat `--apply` and compare again. `--verify-only` can independently
read back every destination without writes. Require zero failures throughout.
Configure Merv to use its R2 bucket, deploy the new image, and let normal
startup apply migration 59. Do not redeploy merv-sandboxes for this change.

Verify hosted authentication, old artifact/figure reads, generic
`artifact.upload`/`artifact.read`/`artifact.attach`, workflow reads, snapshot
membership, and separate native ML storage health. The artifact upload token
API remains compatible. Retain the source bucket and protected backups.

## Rollback

Before live writes resume, stop the new image and restore the frozen database,
old configuration, and old image together. Migration 59 removes workflow
columns from the content table, so the old image cannot use the upgraded
database. After new writes, reconcile those records and any new R2 bytes before
restoring a backup; restoring blindly would discard accepted work. No automatic
fallback or dual-write path exists. Artifact retention must account for every
consumer and frozen snapshot before deleting completed content.
