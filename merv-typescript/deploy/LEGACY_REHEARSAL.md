# Consistent legacy export and isolated import rehearsal

`legacy-rehearsal.mjs` is an offline deployment command. It does not expose HTTP tools or change public routing. Run a reviewed compiled image as root, with a root-owned mode-0700 export directory mounted at `/export`. It writes mode-0600 snapshots/reports and prints only a report SHA-256, aggregate copy progress counts or a sanitized error code. Keep the directory on the VM; research contents and source credentials do not belong in chat or build contexts.

## Phases

```sh
node /app/deploy/legacy-rehearsal.mjs export /export
node /app/deploy/legacy-rehearsal.mjs plan /export
# Stop here until the source snapshot, import code, media preparation and tests are reviewed.
node /app/deploy/legacy-rehearsal.mjs import /export
node /app/deploy/legacy-rehearsal.mjs reconcile /export
```

The export uses one PostgreSQL connection configured read-only before any application query. It opens a `REPEATABLE READ READ ONLY` transaction, verifies schema 81, records its transaction snapshot/time, and reads independent counts plus every exact allowlisted history projection and `project_members`. It never selects credential rows. Foundation projects, memberships, completed artifacts and claims are derived from this same capture, not from a later connection. Claims stay in the export format but are not imported (research claims are retired). The export includes the required history projection version. Older projected snapshots cannot be relabeled after a projection change; capture a new source ID/directory. Known structured secret fields are removed by `projectLegacyHistoryRow`; user-authored research prose remains private research content.

Each report is written to an exclusive private temporary file, fsynced, linked atomically without replacement, and followed by a directory fsync. Interrupted temporary files never become a partial immutable report. `snapshot.json` is immutable. `manifest.json` records its SHA-256, capture provenance and source counts. `plan` verifies the file hash, both importer plans, every source count, matching foundation/history projections and matching capture time. Its report retains per-project counts, both fingerprints and the exact historical instances that have no terminal outcome. Those instances are **preserved history, not resumable native work**.

The media inventory covers completed artifacts, completed figures with parent-artifact/project provenance, post images, HTML embeds and locally retained link-preview images. It derives only the existing `prefix/projectId/hash` keys. It deduplicates by project/hash, checks conflicting known sizes and identifies post-media sizes that need HEAD requests. It does not fetch external URLs or treat sandbox storage-ledger bytes as completed native artifacts.

The import prepares media with the shared `planLegacyMedia` / `prepareLegacyMediaFoundation` helpers. Each exact object is copied and independently verified before metadata import; missing post sizes are discovered through bounded HEAD checks. Figures and retained feed files become deterministic native artifacts with explicit source bindings. A separate immutable `prepared-<schema>.json` records those bindings, verified object receipts and the prepared foundation. The original snapshot, original foundation count and fingerprint remain unchanged. HTML embeds are downloadable bytes with a safe binary media type. Public cutover additionally requires authorized UI download acceptance.

The source also contains historical lineage rows whose file bytes never belonged to the retained Merv blob corpus. These are not inferred from a failed download. An optional root-private `preexisting-artifact-audit.json` must match the reviewed September 9 audit checksum pinned in the deployment command. Every unavailable row must match its exact original ID/project/hash/size tuple. Submitted or pinned evidence, figure parents, and hashes needed by any other retained artifact/figure/feed file cannot be exempted. Every other missing object remains an error. The original rows and links remain unchanged in history with an explicit metadata-only retention envelope; only verified files become native readable artifacts. `retention-plan.json` and the prepared manifest distinguish original counts, metadata-only rows and verified native files. The original `plan.json` and snapshot are not rewritten.

## Configuration names

Export requires only:

- `MERV_LEGACY_DB_URL`: existing source connection, used exclusively through a read-only session.
- `MERV_LEGACY_SOURCE_ID`: unique immutable snapshot ID.
- `SUPABASE_URL`: existing shared identity issuer base.

Pass values inside a protected VM process environment or a dedicated private environment file. Docker `--env NAME` can inherit an already-set value without placing it in command arguments. Do not print `docker inspect` environment arrays or expanded Compose configurations.

Import/reconciliation additionally use:

- `MERV_DB_URL`: the dedicated `merv_ts_app` target role.
- `MERV_TS_DB_SCHEMA`: an administrator-created versioned schema, for example `merv_ts_rehearsal_20260916`. The importer refuses the current `merv_ts` staging schema and all unrelated schemas.
- `MERV_BLOB_PREFIX`: exactly `merv-ts/<MERV_TS_DB_SCHEMA>`. This prevents a rehearsal from occupying the running staging prefix or the legacy prefix.
- Target `MERV_BLOB_BUCKET`, `MERV_BLOB_ENDPOINT_URL`, `MERV_BLOB_ACCESS_KEY_ID`, `MERV_BLOB_SECRET_ACCESS_KEY`, optional `MERV_BLOB_REGION`.
- Source `MERV_LEGACY_BLOB_BUCKET`, `MERV_LEGACY_BLOB_ENDPOINT_URL`, `MERV_LEGACY_BLOB_ACCESS_KEY_ID`, `MERV_LEGACY_BLOB_SECRET_ACCESS_KEY`, optional `MERV_LEGACY_BLOB_REGION` and `MERV_LEGACY_BLOB_PREFIX`.

The source and destination must be on the same supported object endpoint for the verified conditional copy. The destination credential must be able to read the source object. Native artifact transfers are capped at 512 MiB per object; the bounded streaming transfer verifies source size/ETag/hash, conditionally copies the object, and verifies destination bytes before metadata is written. This is not a transfer of the multi-terabyte sandbox storage ledger.

Create the rehearsal schema as the existing database administrator, owned by `merv_ts_app`, with no PUBLIC privileges. The app role keeps its restriction against database-wide CREATE. Preserve the current `merv_ts` schema, current Compose environment, old public tables, source object prefix and all public routes.

## Import behavior and evidence

The target initializes only State, Scope, Blobs and Artifacts. The first foundation import requires an empty target project table. At most four independent object transfers run together. A failure stops new transfers and waits for every in-flight stream to drain. Every exact artifact, figure and retained feed-media copy finishes before the metadata transaction opens. The importer consumes only those current-process verified receipts, and does not repeat their network copies inside the transaction. Foundation metadata and its receipt commit together. Historical projections and their receipt commit in a second transaction. If the second phase fails, an identical rerun reuses the matching foundation receipt; changed content for the same source ID is rejected.

Reconciliation recomputes the prepared manifest from the protected source snapshot and receipts, checks its exact snapshot/target binding (schema, database host/name, storage endpoint, bucket and prefix), then compares native project, membership and artifact rows to their mapped source fields, including every derived media artifact, hash and size. It separately compares each historical artifact availability envelope and the stored retention receipt fingerprint; source JSON/hash verification alone is insufficient. It compares every historical record and canonical data hash and records every project's native/history counts. Receipts distinguish credential exclusion, nonresumable old work, and object coverage. They do not represent completed public-cutover authorization.

After a successful rehearsal, leave its schema and prefix intact as evidence. A final consistent capture uses a **new source ID, export directory, versioned schema and prefix** after the agreed handling of old active work. Do not import a changed final export into a nonempty rehearsal target or erase staging data to make the importer pass.

The server renderer accepts `MERV_TS_DB_SCHEMA` (default `merv_ts`) for a later deliberate schema switch. Once the matching full import has passed, `MERV_TS_LEGACY_SOURCE_ID` adds the compiled historical-reader UI adapter for that exact source. Its absence retains the normal default composition. Neither setting changes the running server until an explicitly reviewed deployment updates its environment and restarts it.

## Tests

The focused deployment fixtures exercise transaction ordering, exact allowlisted projections, secret-field exclusion, independent-count mismatch rollback, snapshot-provenance mismatch, schema/prefix isolation, media deduplication, unknown sizes, figure provenance, safe media types, unchanged source counts, derived file bindings and mismatched copy receipts. Run after compiling the TypeScript modules:

```sh
node --import tsx --test deploy/legacy-rehearsal.test.mjs
```

The core foundation/history import suites additionally verify native PostgreSQL transactions, idempotent receipts, late-failure rollback and row/hash preservation. Production export is read-only; a real-data import remains a separate reviewed execution step.

## Observed legacy availability exception

The September 16 rehearsal found 1,228 unavailable object keys corresponding to 1,551 original artifact rows in 13 projects. Exact ID/project/hash/size comparison matched the September 9 migration audit with zero new missing keys or rows. Every row predates migration 24; none has an artifact-submitted/pinned event, a submission join, or a figure depending on it. This preexisting lineage metadata is retained in the immutable historical archive and labeled explicitly; it is not represented as verified downloadable evidence. The approved prior audit digest is `701a765373829fff4cd9ab33321a6ee72e784763337e1da6c882c094eea75ade`. Any changed tuple, different audit, shared required-file key or new missing file fails the importer.
