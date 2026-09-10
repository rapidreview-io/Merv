# Infrastructure ownership cutover

Merv retains research authentication, permissions, records and its own artifact
R2 configuration. merv-sandboxes owns infrastructure identities, budgets, provider
credentials, resource lifecycle and large workload storage. Merv connects with
`MERV_SANDBOXES_URL` and a private `MERV_SANDBOXES_CONNECTIONS_FILE`; there is no
shared signing key or application-supplied spending allowance.

This procedure is not complete until policy/usage reconciliation and recovery
rehearsal pass. [BUDGET_MIGRATION.md](BUDGET_MIGRATION.md) describes the exporter
and importer, including outstanding legacy quota conflicts. Do not switch an
account with unresolved conflicts. The older storage procedure is retained only
as [historical evidence](SANDBOXES_STORAGE_MIGRATION_HISTORY.md).

## Prepare backups and reviewed mappings

By default the staging helper targets the existing Docker host: `deploy-control-1`,
`deploy-supabase-db-1`, `sandboxes-control-1`, `sandboxes-pipelines-worker-1`,
and `sandboxes-postgres-1`. Its source paths are explicit in the script. Review
them against the actual deployment before use. For another host or a disposable
rehearsal, supply the complete `deployment` object described below.
It retains both database dumps, image references/tags, original configuration,
native data and Merv management volumes. No service is restarted or database
imported by staging. Backups contain secrets and must remain private.

Create a reviewed deployment plan, consistent with the ownership manifest:

```json
{
  "version": 1,
  "service_url": "https://sandboxes.example.org",
  "application_id": "research-application",
  "projects": {
    "proj_existing": {
      "namespace": "existing-resource-namespace",
      "account_id": "acct_destination",
      "subjects": {"merv-user-id": "member_destination"}
    }
  },
  "host_provider_namespaces": {
    "lambda": ["existing-resource-namespace"],
    "thunder_compute": []
  }
}
```

An optional `deployment` object in this same plan identifies all source locations:

```json
{
  "containers": {
    "merv": "source-merv",
    "native": "source-native",
    "worker": "source-worker"
  },
  "databases": {
    "merv": {"container": "source-merv-db", "user": "postgres", "database": "postgres"},
    "native": {"container": "source-native-db", "user": "sandboxes", "database": "sandboxes"}
  },
  "volumes": {
    "native-data": "source-native-data",
    "merv-management": "source-management"
  },
  "files": {
    "native-original.env": "/srv/native/.env",
    "merv-provider-original.env": "/srv/merv/provider-secrets.env",
    "merv-supabase-original.env": "/srv/merv/supabase-db.env",
    "merv-compose-original.yml": "/srv/merv/docker-compose.override.yml",
    "merv-launcher-original.sh": "/srv/merv/control-up.sh",
    "Caddyfile-original": "/etc/caddy/Caddyfile"
  }
}
```

Custom configuration must name every role and file; missing values never fall
back to the original host. Files require absolute paths. If production uses
additional Compose overlays or environment files, include each one in
`deployment.additional_files`, mapping a unique `extra-` prefixed filename to
its absolute source path (for example, `extra-native-overlay.json`). These files
are retained with the same private permissions and checksums as the required
backups. Inventory the active container's Compose labels and referenced files;
an old launcher or a release directory alone may omit active configuration.
Volume archives run in
a temporary container using the inspected native image, with a read-only source
mount, no network, and no image pull. The image must contain `tar` and gzip support,
as the reference control image does. This also works when the Docker volume
mountpoint is inside Docker Desktop's VM. A missing volume is rejected before
Docker can create an empty replacement.

Every credential-bearing project needs an explicit mapping. Every existing
Lambda/Thunder host credential needs an explicit namespace selection; an empty
selection exposes it to no namespace. The project subjects identify the active
users whose consumer grants must be verified before activation. They carry no
budget values. Existing resource namespace names are preserved.

```sh
python deploy/stage_sandboxes_cutover.py prepare \
  --plan approved-deployment.json --stage-directory /private/cutover-initial
```

The new directory is mode 0700 and its files are mode 0600. Preparation produces
no consumer credential. A completion summary fingerprints the reviewed plan;
finalization rejects a modified plan or incomplete preparation. The summary also
records each prepared file's SHA-256 and size. Missing or changed backups,
configuration, or extracted evidence block finalization before grant requests.
Stages made before this evidence manifest was added require a new preparation.
A preparation
failure can leave useful partial backups; retain them and use a new directory
after resolving the failure. Restore database archives into disposable databases
to verify recovery, rather than relying only on archive listings. Full Supabase
restoration requires its migration administrator for managed objects.

`native-provider-additions.json` contains exact namespace scopes and credential
references. Merge these additions into the reviewed native provider configuration,
preserving every unrelated instance and resolving alias collisions explicitly.
Do not replace the native provider list with this additions file. The accompanying
`native-provider.env` contains only transferred secrets; its overlay supplies
them to control and the workflow worker. It does not alter provider selection,
native storage configuration or budget policies.

`merv-base.env` preserves the established authentication/database settings and
`MERV_BLOB_*` artifact storage values. Review it against the complete deployed
application configuration before installation; the helper uses an explicit
allowlist. Provider credentials are excluded. Artifact storage does not move as
part of this budget migration.

## Freeze, reconcile and import

Freeze policy edits and new rentals/renewals; suspend affected native accounts.
Pause native workflow coordination before upgrading records that lack saved
grants. Preserve already accepted jobs, resources and cleanup workers. Capture
final backups and export the final legacy policy/usage state while the stopped
legacy container and its configuration remain available. Use a new final staging
directory, such as `/private/cutover-final`, for the final preparation pass.

Run the exporter and native import preview described in
[BUDGET_MIGRATION.md](BUDGET_MIGRATION.md). Reconcile every policy, payer, current
commitment, historical adjustment, provider control and queued workflow against
the inventories. Apply only the reviewed manifest and retain its receipt. The
destination remains suspended. New worker startup must follow explicit review
of `authorize_pending_compute` for unfinished workflows.

Distinguish an unapplied rehearsal from an already applied account import. The
former needs a fresh full export; the latter needs the documented final-delta
export against its applied receipt and current native inventory. A delta keeps
existing native policy edits, grants and queued authority. Retain the previous
snapshot, mapping, manifest and report as its evidence; do not reuse stale source
policy values as the current native base. Preview, interrupted retry and identical
replay must succeed in the disposable rehearsal before operational activation.

After ownership import, transfer namespace-owned credentials using the native
operator CLI, in the native environment with its existing vault key:

```sh
sbx providers import /private/cutover-final/native-own-provider-import.json \
  --config service.toml
sbx providers import /private/cutover-final/native-own-provider-import.json \
  --config service.toml --apply
```

The default previews and rolls back. Apply inserts the entire batch atomically;
replay accepts identical connections and refuses to overwrite different keys.
Each namespace must belong to the declared suspended account. Disabled provider
entries require the corresponding imported native spending control. No provider
network calls occur; imported keys remain unverified until checked through normal
provider administration. The previous Merv-specific provider importer is retired.

## Create grants and finalize the connection

In merv-sandboxes, the account owner creates the application grant and external
subject bindings from the reviewed plan. Consumer credentials cannot change
budgets or provider configuration. Save the issued credentials privately:

```json
{
  "proj_existing": {
    "namespace": "existing-resource-namespace",
    "token": "sbxt_REPLACE_WITH_ISSUED_CREDENTIAL"
  }
}
```

```sh
python deploy/stage_sandboxes_cutover.py finalize \
  --stage-directory /private/cutover-final --connections issued-connections.json
```

Finalization calls only `GET /v1/auth/me` for every reviewed project/subject. It
requires the exact account, member, application, namespace and consumer role.
Only after all checks pass does it publish the private `activation` directory
containing the connection JSON, Merv env, Compose overlay and sanitized receipt.
This verifies connection ownership, not accounting reconciliation or available
budget. It neither issues grants nor restarts services. It refuses to overwrite
an existing activation directory. An interrupted `activation.pending` directory
requires operator inspection before removal/retry.

Install the activation files using the reviewed release Compose configuration.
Pass the activation env file to Compose's interpolation step as well as using
the overlay. An `env_file` service entry alone does not override the base file's
explicit environment values:

```sh
docker compose --env-file /private/cutover-final/activation/merv.env \
  -f deploy/docker-compose.yml \
  -f /private/cutover-final/activation/merv-connection-overlay.json config
```

This command prints resolved secrets; inspect its output privately and never
attach it to a public report. Include the deployment's reviewed database and
other necessary overlays before activation.

The overlay mounts only the connection file at
`/run/secrets/merv_sandbox_connections`. Local Compose preserves host ownership:
make that file readable by Merv's container UID 10001 while retaining mode 0600
and keeping the containing operator directory private. Check the rendered Compose
configuration privately before restarting; inherited environment/volume entries
must not retain old provider credentials or retired signing keys. Keep native
administrator credentials out of Merv.

Start the new Merv release against the existing research database. Verify reads,
authentication and connection ownership, then reopen admission under native
budgets and perform the reviewed bounded checks in
[SANDBOXES_SMOKE.md](SANDBOXES_SMOKE.md). Retain old data, configurations and
images for the agreed recovery window. Do not remove unrelated containers or
volumes as part of a Compose restart.

## Recovery boundary

Before any new-engine writes, restoring the frozen databases and old deployment
may be possible after verifying intervening resource state. Once new accounting,
resource or research writes occur, preserve fresh dumps and prefer forward repair.
Returning to an old engine requires explicit delta replay and reconciliation;
restoring an old snapshot or toggling a compatibility flag would lose commitments.
Final-delta and interrupted-recovery rehearsal remain mandatory release gates.

## Disposable rehearsal

The opt-in rehearsal uses uniquely named containers, databases, networks and
volumes. It requires cached PostgreSQL and application images and the native
Python package in the test environment:

```sh
MERV_CUTOVER_DOCKER_REHEARSAL=1 \
  pytest tests/infrastructure/test_cutover_docker_rehearsal.py -q
```

Defaults are `postgres:17-alpine`, `deploy-control:latest`, and
`sandboxes-smoke-control:latest`. `MERV_CUTOVER_LEGACY_IMAGE` and
`MERV_CUTOVER_NATIVE_IMAGE` can select other cached images containing the required
Python/psycopg and archive utilities. The test never pulls an image or uses an
existing application container. Its uniquely named resources and rollback tags
are removed after success or failure, and absence of its containers/volumes is
checked.

It executes real PostgreSQL dumps/restores and volume archives, verifies restored
native vault decryption, grants, resource/job records and output bytes, then runs
legacy conversion, native account/provider preview/apply/replay and fresh owner
grant issuance. It checks missing/changed preparation evidence, an interrupted
activation write, and subsequent finalization over verified local HTTPS. Merv's
actual client loads the resulting connection file, reads retained outputs, and
obeys the same owner-edited native budget as an independent application. Source
containers remain running throughout preparation.

This uses projected legacy research fixtures, synthetic job state/output, a fake
compute provider and unverified fixture provider keys. The current native API runs
locally against the restored database; source application containers supply
inspection/extraction environments. It does not establish managed Supabase restore
permissions, a full packaged Merv server restart against migrated research data,
real cloud credential validity or operational cutover readiness. These remain
explicit release checks on reviewed deployment inputs.

### Current release image checks

Build from the reviewed working trees using each project's actual Dockerfile,
then run the isolated packaging checks from Merv's Python project directory:

```sh
# From Merv/merv:
docker build -f deploy/Dockerfile -t merv-budget-cutover:reviewed .
# From the merv-sandboxes repository:
docker build -f deploy/control.Dockerfile -t sandboxes-budget-cutover:reviewed .
# From Merv/merv, using the test environment:
MERV_CUTOVER_IMAGE_REHEARSAL=1 \
MERV_CUTOVER_CURRENT_MERV_IMAGE=merv-budget-cutover:reviewed \
MERV_CUTOVER_CURRENT_NATIVE_IMAGE=sandboxes-budget-cutover:reviewed \
  pytest tests/infrastructure/test_cutover_images.py -q
```

The checks use disposable fixture credentials and no network. They verify that
Merv's default UID 10001 reads a mode-0600, correctly owned, read-only bind-mounted
consumer file and constructs its client without the native SDK or the removed
local budget module. The native image imports its registry and generic importer
without the Merv package. This is packaging and file-access evidence; it does not
start either full service or validate a real grant. Record immutable image IDs
alongside the test result and repeat the relevant check if runtime code changes.

### Packaged service restore and independence

The additional check starts the actual release entrypoints and native lifecycle
worker on an internal Docker network, with no published host ports:

```sh
MERV_CUTOVER_IMAGE_REHEARSAL=1 \
MERV_CUTOVER_CURRENT_MERV_IMAGE=merv-budget-cutover:reviewed \
MERV_CUTOVER_CURRENT_NATIVE_IMAGE=sandboxes-budget-cutover:reviewed \
MERV_CUTOVER_LEGACY_IMAGE=deploy-control:latest \
  pytest tests/infrastructure/test_packaged_cutover.py -q
```

The cached legacy image must expose the old project-key ceiling fields. It
creates the complete legacy research schema, project/experiment rows and an
existing project key. The check dumps/restores that database and a native
database/data volume under dedicated application owners without superuser,
role-creation or database-creation privileges. Merv's actual startup performs its
pending research migrations, authenticates the retained key and serves the
retained research records. Native startup migrates its restored database and
retains the owner and consumer credentials.

A native grant covering two members requires Merv to forward its authenticated
subject. An actual `sandbox.request` through Merv rents fake compute even though
the retained historical Merv cap is zero and the old key lease ceiling is lower
than the requested lease. Changing the native allowance to zero denies an
independent client's new request and Merv's renewal. With Merv stopped, native
deletion proceeds to confirmed stop. Merv restarts with the same connection file
and key, then a native grant revocation denies its infrastructure reads.

The test saves a private `packaged-release-evidence.json` in its pytest temporary
directory with image IDs, source/restored research schema versions and checked
outcomes; it contains no credential values. Retain this evidence with the test
log for the reviewed images. All test-owned containers, volumes and networks are
removed, including on failure. Runtime images and unrelated resources remain.

This verifies ordinary PostgreSQL restore and both packaged services with a fake
provider. It does not contact managed Supabase authentication, access research R2
bytes, validate cloud credentials, or reconcile deployment-specific data. Those
checks still use the reviewed operational deployment and mappings.
