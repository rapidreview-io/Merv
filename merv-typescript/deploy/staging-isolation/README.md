# Isolated staging operator kit

This kit prepares the two existing staging Cloudflare apps on the existing staging VM and
PostgreSQL. Parent executes host operations after independent review. No command below has
been run on a live host by the implementation chat. Source/main remain fenced as described in
the launch ledger. Never restart legacy Main or runner after the committed workflow migration.

The old draft at commit 4273404 is superseded by this document and the corrected
STAGING_SANDBOXES_ISOLATION_PLAN.md. Apply the implementation commits to parent main; do not
cherry-pick the duplicate 7a guard or the original draft separately.

## Bound inputs and durable evidence

Install the committed `deploy/hosted-release-vm.py`, `deploy/hosted-sandboxes-probe.mjs` and this
complete directory at `/opt/merv-staging-operator-kit/deploy/`, preserving relative layout. Root
owns the kit and `/var/lib/merv-fleet-pilot/staging-isolation` (0700); all inputs/outputs are 0600.
Hash the kit and retain its source commit. Keep all old recovery backups and originals.
Every operator command runs with `umask 077`; capture stdout/stderr to that private directory.
Do not put credentials in command arguments or publish signed object URLs.

Required inputs are actual observed source/destination database identities, immutable
Main/controller/gateway images, accepted production runner image/catalog, scoped storage
credentials, and exact namespace/project links. DB identities include database, oid, role,
server address and port, collected with `history.mjs identity`; record the SSH host identity too.
`source.images` and `destination.images` map actual Main/controller container names to their
immutable Docker image IDs. Bind the gateway digest and kit/source hash in the outer operator
manifest. A forward Main image containing the origin renderer fix is necessary: current e9
cannot honor an env-only origin change. Build/review that image through the normal release path;
keep e9 and its preserved data until the forward image has passed network-none rendering.

Choose existing staging hostname with distinct port:
`https://dev-experiments.rapidreview.io:8443`. Main remains
`https://dev-experiments.rapidreview.io`. Verify firewall/TLS reachability before admission;
merge `Caddyfile.fragment` into the preserved Caddy config, leaving Main's worker and customer
fence unchanged. This native origin serves `/mcp`, `/agent`, `/ui/*`, `/v1/*`; `/sbx` alone is
not a native service endpoint. Gateway public endpoint is that staging hostname on TCP 2222.

## History and storage, before provider connectivity

1. On production, run `private-source.py /root-private/source-excerpt.env`. Transfer only that
   reviewed excerpt over the existing private operator channel. It contains two bridge env
   values, two provider descriptors, public Supabase configuration, and the nonsecret source bucket name. Never transfer the full
   source env, account, database, production vault or gateway material.
2. Run `node --import tsx selection.mjs /root-private/selection.json` from the installed app
   dependencies with `STAGING_MERV_DATABASE_URL` pointing to staging's existing Merv DB and
   `STAGING_HISTORY_DATABASE_URL` to source Sandboxes, both supplied privately. Both transactions
   are read-only. The result binds all 75 exact Fleet/Sandboxes IDs, all 14 closed work rows,
   six captures, the retained connection and all 15 native file references. Keep its raw ledger
   evidence and compare with the reviewer's 75-ID baseline, including the 32/43 project split.
3. Source-only `blobs.mjs export SELECTION BLOBDIR BUNDLE` follows explicit logical and actual
   FK edges under a repeatable-read transaction. Set `STAGING_HISTORY_DATA_DIR` to source `/data`
   when selected job output is present. Set `STAGING_OBJECT_CREDENTIAL_FILE` to a private JSON
   object with source `endpoint,region,bucket,accessKey,secretKey,adoptedBuckets`; this process
   only GETs exact selected keys. Every byte is hashed. Transfer the bundle and content-addressed
   blobs; verify the bundle SHA256 and each byte file again after transfer.
4. `provision.mjs SECRET_FILE PROVISION_RECEIPT` uses `STAGING_POSTGRES_ADMIN_URL` for the existing
   staging postgres database. It durably generates the dedicated login password and fresh vault
   before DDL, creates only `sandboxes_staging` and its login, and refuses inherited authority,
   role memberships or existing customer/Merv table access. If PUBLIC table grants exist, use
   reviewed role-specific pg_hba rules denying this login to every DB except sandboxes_staging;
   prove actual denied connections. Do not repair by granting access to Merv or legacy tables.
5. Create a new local volume `sandboxes_staging-native-data`, owned by 10001:10001, using the
   pinned image with `--network none`. Do not reuse old `/data` wholesale. Run the pinned
   standalone `sbx migrate` against the dedicated DB over the existing `deploy_default` network,
   with no provider credentials/configuration and no published Postgres port. Record exact migration
   checksums. This kit does not substitute custom DDL for the pinned migrations.
6. Capture target identity with `history.mjs identity unused unused IDENTITY_FILE`. Run
   `history.mjs import BUNDLE BLOBDIR IMPORT_RECEIPT` with `STAGING_HISTORY_DATABASE_URL` set to
   the new DB, `STAGING_HISTORY_IDENTITY_FILE` to that identity and `STAGING_HISTORY_DATA_DIR`
   to its fresh private data volume. Import is transactional, preserves IDs, rejects same-ID drift,
   and resumes idempotently. Imported members are disabled, accounts suspended, human password
   verifiers removed, revoked tokens stay revoked, consumed bootstrap secrets are removed, and
   historical namespaces remain unlinked. Source-row hashes and sanitized original attribution stay
   in the bundle. No source credit balances, grants, active credentials or relay cursors are imported.
7. `blobs.mjs stage BUNDLE BLOBDIR STORAGE_RECEIPT` writes only
   `staging-native/history/<namespace>/<object>/<digest>` in a dedicated staging-only bucket,
   using a durable Object Read & Write key restricted to that bucket. Parent must supply or
   provision that bucket/key. Prefixes organize objects; they are not a credential boundary.
   The private credential JSON requires `allowedWritePrefix:"staging-native/"` and
   `scopeEvidenceSha256` of retained Cloudflare bucket-policy evidence. The tool checks target
   HEAD succeeds and HEAD of every known source bucket returns 403 (404 is insufficient).
   Retain actual source-object GET/write denial evidence as part of live acceptance.
   R2 [durable tokens](https://developers.cloudflare.com/r2/api/tokens/) support bucket scope;
   prefix-scoped [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
   need a session token, unsupported by the pinned runtime. Target session tokens are refused. The tool verifies exact GET bytes after write and never overwrites a mismatched key.
   Original artifact references, IDs, digests and source object locators remain unchanged in the
   provenance; only the target internal storage locator changes. Runtime storage prefix is
   `staging-native/live`. Never give runtime the source/customer writable key.
8. Rehearse a real `pg_dump --format=custom` / `pg_restore` into another isolated local DB, restore
   selected `/data` files and blobs, then compare every imported row and byte digest. Save raw dump
   hash, restore log and row manifests, not a hand-authored success flag. Keep source rows untouched.
   Readable Kopia snapshots require a separate selected-repository rekey/rehearsal; the exporter
   explicitly refuses those rather than silently breaking vault-derived repository passwords.
   Current read-only inspection found one deleted snapshot among mw namespaces and no provider
   credential in the legacy Pi namespace; the exact selected export must still prove its own closure.

## Relay, links and local services

Run `relay.mjs EXPECTED_BOUNDARY RECEIPT` with `node --import tsx`, target identity/URL and
`MERV_BOOT_MAINTENANCE=1`. Use the observed isolated event head (normally zero), before new links
or runtime events. It takes the pinned append fence and registers the pinned merv-relay definition
without constructing an event worker. Existing cursor/definition drift refuses. Never copy/reset
production's cursor or start consumption temporarily.

Prepare `links.json` with exactly these project IDs and distinct fresh names matching
`merv-stg-native-<16 lowercase hex>`:

- `project_0f7c9971aa5747939e2f9a9b6e760d56`
- `project_7fb4bb69697f4ed8bf575ed5a351fa7f`

Run `links.mjs LINKS RECEIPT` under maintenance on the isolated DB. The supported native bootstrap
creates a non-login operator person and separate account for each namespace; it creates no human
identity or bearer. It uses native account/link/limit/budget APIs: one concurrent allocation,
900-second maximum lease, $1/hour ceiling, $5 all-time Cloudflare cap per account ($10 maximum
across both). These are caps, not copied balances or unlimited credit. Current designated bridges
have no operator connection_id; if that changes, stop and review an explicit native prepaid grant
and entitlement instead of silently bypassing credit admission. Parent reviews these bounded terms
before execution. Historical Pi/work/ML namespaces remain unlinked.

`config.mjs SOURCE_EXCERPT MAIN_ORIGINAL SPEC PRIVATE_OUTPUT_DIR` prepares raw candidate envs.
SPEC contains `publicOrigin,mainOrigin,databaseUrl,vaultKey,namespaces,runnerImage,catalog,storage`.
The two catalog entries come from production's accepted release lookup, with only provider aliases
changed. `storage` supplies scoped target `endpoint,region,bucket,accessKey,secretKey`. Both provider
allowlists and runtime launch grants name only the two new namespaces, with no wildcard. Inspect
candidate hashes and exact Main delta; unrelated Main bytes/pins are preserved. Use disabled
shared env first. Never install the enabled candidate before source relinquishment.

Run `sbx ca init` on the new volume using the pinned standalone image with `--network none`.
Install the reviewed `compose.yml` and exact controller/gateway digests in root-private release.env.
Start the disabled controller and actual gateway sharing only this volume; controller initializes
its gateway server key/token there. Verify fresh CA and gateway fingerprints differ from source,
private authenticated `http://sbx-control:8000`, external SSH host-key pinning and TLS endpoint
reachability. Run read-only target migration/identity/row/link/storage/cursor probes. Render the
forward Main image with `docker run --rm --network none --entrypoint node --env-file CANDIDATE
EXACT_IMAGE /app/deploy/render-config.mjs /tmp/config.json`, no writable host mount. Require all
seven hosted plugin IDs and correct origins. Parent recreates this exact forward image while
boot maintenance and customer ingress remain fenced; capture preservation census before/after.

## Exclusive handoff and hosted acceptance

Create one root-private plan JSON: `version:1,apps,source,destination,publicOrigin,historySha256,
restoreRehearsal,relay`. `source/destination` contain `database` identities and `images` maps;
`destination.targetSha256` binds the enabled shared env candidate. `apps` is exactly the constant
map in `handoff.py`. Place that candidate at the destination's
`/var/lib/merv-fleet-pilot/staging-isolation/destination.target` (0600). Never put secrets in plan.

`handoff.py` takes JSON on stdin: `{action,role,plan,peer}`. Execute these ordered invocations and
retain every raw request and output privately:

1. `reserve/source`, then `reserve/destination`. Both durable hosted-owner markers remain until
   release; source original envs precede intent. Destination refuses an already-enabled controller.
2. `relinquish/source` with the exact destination reservation receipt as peer. It persists the
   original namespace billing control, denies Cloudflare spending only in the historical staging
   namespace under the native account lock, drains the two app inventories, writes the target,
   installs the temporary Pi admission barrier described below, waits for natural drain, and
   verifies the barrier and empty Pi state before each exact-image reader recreation.
   Source customer providers remain byte-equivalent descriptors; unrelated allocations are not
   released or rolled. After both readers lose the aliases/catalog, it rechecks complete native
   inventories with the old two descriptors and verifies persisted denial, then writes relinquishment.
3. Transfer the exact relinquishment receipt privately. `enable/destination` refuses anything else,
   verifies target DB/images/maintenance and candidate hash, durably saves source receipt and
   enable intent before applying the enabled candidate, then runs staging-local native inventory.
   An interruption always resumes the same plan forward. Never restore production provider entries.
4. Transfer the destination receipt and `release` each owner using that same receipt. Accepted
   binding remains at `.../accepted.json`. No completed handoff removes the original evidence.
5. Run the existing hosted driver with **both** `--staging-cutover --isolated-staging`. Production
   is queried only for accepted provenance. Local identity/catalog/census/native actions run on
   staging and have no production fallback. Prepared receipts bind the isolated DB/apps/readers,
   accepted runner image and exact staging releases. Driver canary has a durable idempotency intent;
   lost responses resume the same command; terminal failed attempts rotate only after verified
   release and complete native census. It never stops the shared Pi machine and waits up to
   900 seconds for natural idle release. Failed canaries cannot become accepted.
6. Before reopening, compare exact original task/admission/history preservation under the fence.
   Follow the existing parent-owned same-image controlled reopen path, then run
   `--staging-cutover --isolated-staging --resume --accept-cutover`. Require ordinary existing-reader
   Pi reply, allocation release, actual native stopped proof and both native inventories.
7. For each of the 15 retained references, use the ordinary authenticated artifact route as its
   owning project, GET the returned bytes and verify digest/length. Repeat with the other staging
   project and an unrelated project: require 403/404 and zero bytes. Never publish signed URLs.
   Preserve the distinct 32/43 runtime ownership mapping; do not equate raw storage GET with auth proof.
8. Only after the independent acceptance checklist and raw evidence review pass, parent restores
   the original ingress policy and exactly the previously active/enabled recovery timers. Keep all
   backups and forward recovery journals. Old Main/runner stay stopped.

## Validation and remaining execution gates

Local tests use disposable PostgreSQL with the exact pinned migrations, native billing and account
services, an actual dump/restore, selected-byte corruption and authorization checks. Handoff tests
inject every local durable journal write plus SIGKILL after each reader recreation effect. The
latter executes the actual recreation method with file-backed local service effects instead of Docker;
it is not proof of live controller/gateway behavior. Run with:

```
ISOLATION_TEST_DATABASE_URL=postgresql://... node --import tsx --test --test-concurrency=1 deploy/staging-isolation/*.test.mjs
python3 -m unittest discover -s deploy/staging-isolation -p 'test_*.py' -v
node --test deploy/*.test.mjs
```

Parent must still collect real DB identities, selected source bytes and scoped target storage
credential evidence, verified target TLS/firewall reachability, controller/gateway images, private
source/target handoff receipts, and real smoke/download/stop evidence. These are concrete operator
inputs/execution gates, not generic topology approval. The kit does not claim live acceptance or
supply fabricated observations to the independent verifier.

## Later forward releases

Production's accepted lookup now accepts a passed ordinary hosted release after a completed native
cutover baseline. An unverified/failed current release still refuses. After handoff, ordinary
production propagation deliberately discovers no staging apps on production; explicitly run the
same staging driver with `--staging-cutover --isolated-staging --prepare-cutover` for each later
accepted production runner. Its ordinary source lookup remains read-only. Review/fence/prepare/
accept uses the existing flow, not an implicit production fallback.

For later Main/controller image changes, call `refresh-readers.py` with JSON stdin:
`{action:"prepare",update:"reviewed-update-id",images:{<Main>:<new-sha>,<control>:<new-sha>},migrations_sha256:<reviewed-ledger-sha>}`.
It records the original binding, exact desired image pair and unchanged pins/providers/catalog
under maintenance and deployment locks. Perform the normal parent-owned forward image release.
Then call the same request with `action:"accept"`; it verifies actual images, DB/app ownership,
origin, unchanged pins/catalog, reviewed migration ledger and local native emptiness before
atomically updating the reader binding. Keep all earlier receipts. Hosted operations fail closed
between a reader image change and this acceptance; never hand-edit accepted.json. Preparation
is not a lock held across the normal release, which uses its own established ownership locks.

Import additionally requires `STAGING_HISTORY_EXPECTED_SHA256` from the independently reviewed
export digest in the durable operator intent. A self-consistent but rehashed bundle cannot extend
the imported selection. Do not obtain this value by trusting an unreviewed bundle's own field.

`npm run test:deploy` includes the new local unit/handoff tests. The real DB path is
`npm run test:staging-isolation:pg` with `ISOLATION_TEST_DATABASE_URL` explicitly set; it refuses
missing configuration and serializes test files to avoid database-name collisions. Use only a
disposable local PostgreSQL, never staging or production. Run `runtime-check.mjs` using the exact
packaged Main image with `docker run --rm --network none --entrypoint node IMAGE --import tsx
/app/deploy/staging-isolation/runtime-check.mjs` before any host change. It imports pg, AWS SDK,
pinned native packages and every operator module without opening a DB or provider. The Main
Dockerfile now packages these operator modules; no host Node/npm installation is assumed.

### Source Pi admission during reader replacement

The handoff temporarily installs two named, definition-checked SQL INSERT triggers in the source
Merv schema. They reject new Pi commands and new `pi-host` Fleet allocations across HTTP, warm
and background admission, including stale Main processes. Existing commands/allocations are
never cancelled or changed by this barrier. Installation waits for prior writers to commit;
then handoff waits up to 900 seconds for existing commands to finish, warm hosts to expire, and
all Pi allocations to release naturally. The barrier remains through both reader replacements.
No ingress configuration is changed. New Pi sends/warm requests temporarily fail and may retry
after the barrier is removed; existing streams continue during drain. On timeout or crash the
durable barrier stays installed. Resume `relinquish`, or run `restore-admission` with the same
source plan/owner to remove only the kit's exact triggers/function without changing providers.
Successful source verification removes the barrier before recording relinquishment.
Independent review must validate this new database admission mechanism before live use.

Production source lookup follows `current` (identical-build) receipts back to a passed immutable
image using the retained build equality proof. New `rechecked` and `abandoned` verified outcomes
have an explicit exact-image/canary acceptance receipt. Legacy outcomes lacking that receipt
remain refused; a finish label alone is not acceptance evidence.

## Recovery corrections after final review

The history bundle includes `dataFiles` in its independently reviewed digest. Import refuses
retained nonempty job-output rows without a complete file manifest; flat files and segmented
stdout/stderr retain their exact bytes, absolute offsets and start markers. Missing segments,
transfer corruption and unrelated conflicting final files refuse. Each file is written and
fsynced in a new private temporary directory on the destination filesystem, then published by
an atomic non-overwriting hard link and directory fsync. A killed writer leaves no partial final
file; replay ignores its private temporary inode and installs the same approved bytes. A DB
rollback can leave complete verified files, which the same bundle safely reuses on retry.

Before reader mutation, the kit saves `reader-originals.json` (0600) on that same host with both
exact image IDs, Compose identity, original environment and network names. **This file contains
secrets: never transfer the source's reader metadata to staging or publish it.** The handoff
captures it at reservation; local catalog operations capture it before the first file change.
A durable `reader-target.json` binds the exact environment bytes for forward retry. Recovery
checks any existing canonical reader's image and Compose identity. If Compose removed its
canonical name before rename, only this saved metadata supplies the one-shot SQL environment
and the exact Compose invocation; arbitrary temporary containers are never selected as authority.
Health checks still require a real canonical container. The public `handoff.py` actions,
including `restore-admission`, activate this recovery context under the existing owner locks.
Retain the metadata, target and originals until independent handoff acceptance.

These corrections address the three findings in the final review of `8798982dd`. They still
require independent retest; neither local tests nor this runbook constitutes deployment approval.

### Driver entry and Compose temporary-name recovery

Before its health-dependent drain, isolated `--resume` now calls `recover-catalog`. This action
can only replay an existing intent with an existing `reader-target.json`; without those markers
it returns without creating or applying a catalog. It requires the same owner/source/binding,
preserved boot maintenance and empty Main/native ownership through read-only one-shot queries.
After repair the ordinary live HTTP maintenance/health and drain checks still run. Initial catalog
creation remains strictly after the ordinary drain.

Compose can leave its replacement under a temporary name; another `compose up` need not rename
it. Recovery therefore inspects the unique matching candidate and verifies the saved image,
Compose project/service/ordinal, replacement label, exact target environment, command/user/health
configuration, mounts/security/ports and network set. It records a private rename intent, then
renames that exact container ID. A mismatched or ambiguous candidate refuses. Canonical health
is checked after normal Compose start. This follows the separate remove/rename operations in
[Compose convergence](https://github.com/docker/compose/blob/v2.39.4/pkg/compose/convergence.go#L572-L628).
Both replaced-container-ID labels (tested Compose 2.32) and service-name labels (Compose 2.39)
are bound to the original identity.

`python3 deploy/staging-isolation/real-reader-gap.py` is an optional **local Docker-only** regression.
It requires an already-local `python:3.12-slim` image and creates/removes uniquely named test
containers/networks. It restores the real missing-name/temporary-replacement state for Main and
controller in four fixtures and runs the actual helper, Compose, rename and health checks.
Only application rendering/migration preflights are adapted. It is not live handoff acceptance.

## Lossless history bundle version 2

A fresh export now emits `version:2, encoding:"postgres-exact-text-v1"`. Do not reuse a version 1
bundle: its PostgreSQL BIGINT/numeric values may already have been rounded by JSON parsing.
Re-export and independently review/bind the new digest before importing. Selection and handoff
plan versions are unchanged; this version applies to the history transport only.

The exporter uses each actual column's declared type to transport BIGINT, NUMERIC/DECIMAL,
MONEY, arrays, JSON and JSONB as database text (SQL NULL stays null). Thus certificate keys and
session FKs are decimal strings; JSON columns contain raw database JSON text, preserving nested
large integers/decimals and JSON null separately from SQL NULL. Original-row hashes include this
lossless representation. Logical/FK traversal and destination conflict reads use the same encoding.
The importer supplies individual parameters to the original typed columns; no schema changes or
certificate omissions are involved. Unsafe numeric row selectors and incorrectly encoded exact
columns refuse. File lengths/offsets must be safe nonnegative integers before byte arithmetic;
this constraint never converts certificate IDs or accounting numerics to JavaScript numbers.

Sequence resetting is performed inside PostgreSQL without adding one to a maximum value. It
retains the destination sequence high-water mark, including retries, and marks an imported
INT64_MAX as used so PostgreSQL reports exhaustion rather than wrapping or reusing history IDs.
Descending or cycling sequences require separate review. The pinned certificate serial is a BIGINT primary
key without an owned serial sequence; this generic reset applies only where an owned sequence
actually exists.

Closed sessions can retain a pre-existing missing logical certificate reference only when the
export transaction observes zero rows for the exact serial. The `missingReferences` manifest
binds each session primary key, original-row SHA256, namespace, exact certificate serial and
zero-row observation into the independently reviewed bundle digest. The session row and serial
remain unchanged. No certificate is invented or omitted; present targets follow normal closure.
Declared foreign keys, open sessions, unapproved namespaces, ambiguous targets and all other
missing references still refuse export.

Import validates the complete manifest against session/certificate closure and rejects omitted,
extra or altered entries. It checks destination certificate absence under a transaction table
lock and returns the manifest in its receipt, including on idempotent replay. Operators must
independently compare this manifest with read-only source evidence and bind the fresh export
digest before importing; a destination cannot independently reconstruct a past source absence.

Native job certificate identities (`jobs:job_<id>`) follow the pinned jobs executor's identity
contract, rather than an API-token lookup. Export and import require a sandbox-bound user
certificate with the matching namespace/key ID and `sbx:<sandbox_id>` SSH principal, and exactly
one terminal job in that same namespace and sandbox. The referenced job is included in closure;
certificate fields stay unchanged. Malformed identities, missing/nonterminal jobs, binding
mismatches and declared token FKs refuse. This handles only the evidenced jobs identity form;
other token strings retain strict API-token traversal and active-token rejection. The closed
session missing-certificate manifest is unchanged.
