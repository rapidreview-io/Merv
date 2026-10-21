# Staging native Git and hosted cutover

Run from the reviewed, committed checkout containing this driver and the source-archive/client
packaging fix. The parent release operator owns all host changes. These commands have **not**
been executed against hosts. Do not use an ordinary hosted rollout to migrate staging.

## Observed staging and recovery repair

Read-only inspection on 2026-10-21 found healthy legacy Main image
`sha256:7a4a94fa3e048baa875122acac5b794b5d4387b614e395a549106620e505b8c9`, schema
`merv_ts_staging`, and three unfinished `in_progress` tasks eligible for 46, subject to the
final offline contract/hash check:

- `wf_35af4cf695f74114bbbfd920054bfac2` (43)
- `wf_95c523ad5b334cb698dd65726e7a06a9` (44)
- `wf_e722a7ce3fc14d95bae7e8109a524e94` (43)

The local census was empty: sessions, leases, writers, transfer commands, workflow allocations,
managed runners, Pi hosts/turns, compute, checks, cleanup and publication locks. Historical
prepared mirror operations are not active upload/import/export ownership. Repeat the census
under the fence; also require empty provider ownership. Never clear records to make a gate pass.

`recovery-snapshot.service` fails before capture because its installed old script queries
`code_units.writer_state`, a removed column. The service **does** have a working AWS CLI via
`/etc/merv/recovery.env` (`/opt/merv-recovery-tools/bin/aws`); credentials are not the observed
problem. Downloading the October 6 COMPLETE manifest succeeded using that environment.
The reviewed `deploy/recovery-snapshot.py` passed `idle()` and `inventory()` read-only against
staging. Its inventory validates all repository/database promises; this is not a fresh backup.
The last recorded complete snapshot remains `20261006T040839Z-1ea13f7660ba4c7e9e4106d76f31e469`.
No recovery resume marker was present. Source PostgreSQL and pg_dump are both 17.6; the configured
pinned verification image is installed. About 46 GiB was free; the current script rechecks space.

Install the reviewed recovery script before capture (keep `/etc/merv/recovery.env` and all keys):

```sh
scp deploy/recovery-snapshot.py azureuser@dev-experiments.rapidreview.io:/tmp/merv-reviewed-recovery.py
ssh azureuser@dev-experiments.rapidreview.io 'sudo -n install -o root -g root -m 0755 /tmp/merv-reviewed-recovery.py /opt/merv-recovery/recovery-snapshot.py'
```

In root's `/etc/merv/recovery.json`, retain all other fields and set `idle_tables` to
`["worker_sessions","fleet_allocations","code_bases","code_workspaces","pi_commands","managed_compute_runs","code_publications"]`.
The reviewed script also checks Code cleanup automatically. Preserve the staging schema, container,
Code root, deployment `staging-main`, R2 destination, database command prefix and verification
image. Do not replace the configuration with production's.

After fencing ingress, draining genuine ownership and **stopping Main**, capture through the
existing service so its private environment is applied:

```sh
ssh azureuser@dev-experiments.rapidreview.io 'sudo -n systemctl start recovery-snapshot.service'
ssh azureuser@dev-experiments.rapidreview.io 'sudo -n systemctl start recovery-snapshot-status.service'
ssh azureuser@dev-experiments.rapidreview.io 'sudo -n cat /var/lib/merv-recovery/last-complete.json'
```

Require a new snapshot ID, successful service/status and COMPLETE. `create` performs an isolated
restore/inventory verification, uploads each payload, downloads it and checks its checksum, then
uploads and verifies COMPLETE. A stopped Main stays stopped. Do not hold the maintenance flock
externally while calling recovery. Record the downloaded COMPLETE SHA-256 for migration. Keep
configuration, image IDs, external blobs and any runner-only bytes with the recovery evidence.
A failure here blocks migration; do not reuse the October 6 backup.

## Migrate and install staging Main

Before fencing, create a dedicated staging reader canary credential if absent. Choose the existing
staging E2E project below only after confirming it is the intended canary project; do not reuse its
operator/human key. The command stores a new reader key root-only and checks its identity:

```sh
node deploy/hosted-release.mjs --staging-cutover --mint-canary \
  --host ResearchSuite_Control --staging-host azureuser@dev-experiments.rapidreview.io \
  --canary-project project_7fb4bb69697f4ed8bf575ed5a351fa7f \
  --canary-credential /var/lib/merv-fleet-pilot/hosted-canary/staging.json
```

Run these entry points **inside the reviewed candidate image**, using staging's environment and
DB network, with `/private` mapped to a root-only persistent directory. They initialize no services.
After the fresh backup, with Main and external writers stopped:

```sh
node --import tsx deploy/git-cutover-migrate.mjs --plan /private/staging-native-plan.json
# Inspect ready=true, precisely the three task IDs above, and all empty blocker lists.
node --import tsx deploy/git-cutover-migrate.mjs \
  --apply /private/staging-native-plan.json --offline \
  --operator "$OPERATOR_ID" --reason 'Preserve staging unfinished work during native Git migration' \
  --backup-id "$VERIFIED_SNAPSHOT_ID" --backup-sha256 "$COMPLETE_MANIFEST_SHA256"
```

Do not copy production's `--retire-command` or migration count. Preserve the receipt. Install Main
with boot maintenance enabled in staging's saved environment (following BOOT_MAINTENANCE.md):

```sh
node deploy/release.mjs --host azureuser@dev-experiments.rapidreview.io \
  --public https://rp-control-dev.eastus2.cloudapp.azure.com --no-rollback --skip-hosted
```

Require native protocol label `org.merv.native-git-protocol=1`, maintenance in both live/saved env
and health, and both staging providers in the live/saved runtime definitions. Keep ingress fenced.

## Prepare accepted hosted pair, then accept

Production must already have closed its native cutover successfully. Its durable `finish=pass`,
plan, pushed digest and checkpoint must agree with live production state, pins and catalog.
An open production release, unaccepted image or changed source refuses staging preparation.
There is no image override and no rebuild. The driver uses that accepted Sandboxes bridge commit.

```sh
node deploy/hosted-release.mjs --staging-cutover --prepare-cutover \
  --host ResearchSuite_Control --staging-host azureuser@dev-experiments.rapidreview.io \
  --canary-project project_7fb4bb69697f4ed8bf575ed5a351fa7f \
  --canary-credential /var/lib/merv-fleet-pilot/hosted-canary/staging.json
```

Require **exit 5 / PREPARED**. Staging owns its run marker under
`/var/lib/merv-fleet-pilot/hosted-release/active` and artifacts under
`/opt/merv-typescript/hosted/<run>/`. Production's gateway only adds the two staging catalog entries
using the existing shared-catalog transaction; it may recreate catalog readers on their exact
current images. It never switches production pins or records a production release. Both staging
apps settle on the immutable digest with SSH off. Staging Main is recreated on its exact image
with both new pins and its legacy Standard key, still fenced. No drain holds or retry rewrites occur.
The provider census refuses active staging machines, pending bootstrap and nonzero native instances.

Interrupted preparation resumes forward:

```sh
node deploy/hosted-release.mjs --staging-cutover --resume \
  --host ResearchSuite_Control --staging-host azureuser@dev-experiments.rapidreview.io
```

Use the original committed pipeline. Plain resume never accepts a prepared pair. There is no
rollback/abandon; failures retain the open marker and candidate config. Repair the cause and resume.

After authorizing background demand, remove the boot flag in staging's saved environment and use
the locked **same-image** recreation block in BOOT_MAINTENANCE.md **on the staging host**. Do not
start another Main release while the marker is open. Retain customer ingress fencing while allowing
the ordinary authenticated worker/Git/callback routes required by acceptance. Then:

```sh
node deploy/hosted-release.mjs --staging-cutover --resume --accept-cutover \
  --host ResearchSuite_Control --staging-host azureuser@dev-experiments.rapidreview.io
```

Acceptance rechecks the exact Main image/pins, actual maintenance removal, accepted production
source, both live/saved catalog entries and settled staging apps. It runs the existing real Pi
canary with the staging reader via ordinary HTTP, checks that the assigned release served it,
stops the conversation/person machine and waits for Fleet's released allocation **and observed
stopped runtime**. Only success closes the staging marker and writes staging state/ledgers.
A failed canary leaves the run open; preserve or re-establish the fence before forward repair.

`STAGING_HOSTED_RELEASES.md` records the pipeline source separately from the accepted runner source;
`staging-hosted-release.json` records accepted production provenance and both pins. Main deployment
rows remain in `STAGING_RELEASES.md`. No staging attempt is described as a production release.
