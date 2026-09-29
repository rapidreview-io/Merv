# Deployment recovery snapshots

`deploy/recovery-snapshot.py` backs up the complete Merv PostgreSQL schema and hosted Code directory while the control container is stopped. It is deployment tooling, not a plugin. Each snapshot has its own database dump and Code archive. Nothing refers to payloads in another snapshot. Old Code backup prefixes and the frozen legacy reader are outside this command's ownership.

## Provisioning

Install Python 3, Git, Docker and a pinned AWS CLI v2 on the host. PostgreSQL source tools run inside the existing database container; verification uses an independently pinned official PostgreSQL image in an ephemeral container with `--network none`. Pre-pull the image, inspect its digest, and use that digest in configuration. No backup dependency is added to the control image.

Install the script at `/opt/merv-recovery/recovery-snapshot.py`, owned by root and not group/world writable. Install the systemd service/timer files from `deploy/recovery-snapshot*` under `/etc/systemd/system`. Create `/var/lib/merv-recovery` and `/var/backups/merv/recovery-staging` mode 0700. Configuration and credential files must be root-owned mode 0600. Example non-secret configuration:

```json
{
  "deployment": "production-main",
  "schema": "merv_ts_prod_20260916a",
  "code_root": "/var/lib/merv-ts/code",
  "state_dir": "/var/lib/merv-recovery",
  "staging_dir": "/var/backups/merv/recovery-staging",
  "container": "merv-typescript-control-1",
  "maintenance_lock": "/run/lock/merv-maintenance.lock",
  "hosted_marker": "/var/lib/merv-fleet-pilot/hosted-release/active",
  "database": {
    "name": "postgres",
    "user": "postgres",
    "command_prefix": ["docker", "exec", "-i", "deploy-supabase-db-1"]
  },
  "verification": { "image": "postgres:17@sha256:REPLACE_WITH_VERIFIED_IMAGE_DIGEST" },
  "store": {
    "url": "s3://BACKUP_BUCKET/recovery-v2/production-main",
    "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com"
  },
  "keep": 3,
  "reserve_bytes": 1073741824,
  "timeout_seconds": 1800,
  "stop_seconds": 60,
  "health_timeout_seconds": 180,
  "max_object_bytes": 5497558138880,
  "idle_tables": [
    "worker_sessions",
    "session_workspaces",
    "fleet_allocations",
    "code_bases",
    "code_units",
    "pi_commands",
    "managed_compute_runs",
    "code_publications"
  ]
}
```

Use the actual database name/role/container, schema and provider object limit. Production and staging need distinct deployment identities and prefixes. The `idle_tables` list is an explicit composition contract: omit a table only when its plugin is deliberately absent, never because a query failed. Missing configured tables fail closed. Source connection parameters can be supplied as PostgreSQL argument arrays or libpq environment/credential files; do not put credentials on command lines. Standard CLI AWS credentials are inherited from `/etc/merv/recovery.env` or the root AWS profile. Prefer a dedicated backup key restricted to its recovery prefix; the app should not hold it. A separate restore key needs only read access. Storage encryption and secret/key escrow are deployment responsibilities.

Main release and hosted-image Main mutation paths must acquire `/run/lock/merv-maintenance.lock` and refuse a pending `/var/lib/merv-recovery/resume.json`. Do not run a second writer host or manual database mutation during capture. The lock does not fence administrators or other hosts automatically.

The included `recovery-snapshot-status.timer` checks freshness hourly independently of backup creation. `status` fails if no complete snapshot has been recorded, its age exceeds `max_age_seconds` (default 30 hours), or the clock is inconsistent. Creation and freshness failures activate `recovery-snapshot-alert.service`, which writes a daemon-error event to the host journal. **This supplies host-level visibility, not off-host notification.** Connect that journal/unit to the existing monitoring channel before claiming unattended external alerting. Monitor both unit failures and `/var/lib/merv-recovery/last-complete.json`; application health and a timer's last attempt are insufficient. Run `systemctl daemon-reload`, enable boot recovery, then enable both timers only after the staging/restore gates pass.

## Commands and guarantees

```sh
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json create
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json verify --snapshot SNAPSHOT_ID
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json prune
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json status
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json recover
```

Manual commands use the same run and maintenance locks as the scheduled service. Prefer `systemctl start recovery-snapshot.service` for creation so supervisor failure cleanup is active. A manually SIGKILLed command leaves the durable resume record; run `recover` immediately, or reboot recovery handles it. Never delete the record to bypass the image/container identity check.

Creation checks for active sessions, unreleased Fleet allocations, active/pending-cleanup Code checks, owned writers, unfinished retained workspace captures, active publication locks, Pi commands and managed compute. An unsettled human PR by itself is not a writer and does not block capture. It checks before and after stopping the service. Old receiving uploads do not block forever: their partial files are preserved. Productive work causes a failed/skipped run and keeps previous recovery points unchanged. This idle-only schedule does not guarantee a daily recovery point under continuous load. Configure an alert on staleness and agree an operator maintenance window if needed; do not silently cancel jobs.

The resume record is fsynced before shutdown. It records the exact container ID/image and prior running state. Capture occurs only after a clean stop; an already-stopped service stays stopped. Capture preserves identity markers, Git objects and refs, quarantine/held bundles, partial uploads and ordinary temporary files. Only the writer socket is omitted. Symlinks and unexpected special files are refused instead of traversed. Successful capture restarts the exact previous service before upload or verification. Systemd ExecStopPost and boot recovery recover an interrupted capture; a replaced container/image needs operator diagnosis, not an automatic override.

Each run restores its custom PostgreSQL dump into a fresh scratch database and extracts Code to an empty scratch root. Production verification has no network and no application startup. It checks Git integrity, project/binding identity, DB-promised commits, receipts, current unit refs, and journal-phase exceptions. Held rejected bundles remain bytes to preserve; they need not pass admission. Payloads are uploaded and downloaded again for SHA-256 verification before writing the immutable `COMPLETE.json` marker. No mutable latest pointer exists. Per-command timeouts, systemd total timeout, private scratch and a conservative free-space check bound operations; an ENOSPC failure still requires restart cleanup and alerting.

Only completion-marked snapshots are usable. Retention re-verifies the newest `keep` points before deleting older points. It deletes each old completion marker first, then its payloads, so interrupted deletion cannot leave a selectable half-backup. Incomplete prefixes are ignored and never count toward retention; inspect/remove old abandoned prefixes separately under the run lock. Configure the provider to abort abandoned multipart uploads. Do not attach lifecycle expiry to completed payloads independently of their markers. The script owns only `recovery-v2/<deployment>` and never prunes legacy `code/` or `db/` backups.

## Isolated restore, then explicit activation

Restore requires a new database name and nonexistent Code destination. It never starts Merv or applies data to an existing database. Add a **separate isolated target** to private config, for example:

```json
{
  "restore_database": {
    "name": "postgres",
    "user": "postgres",
    "command_prefix": ["docker", "exec", "-i", "merv-recovery-drill"]
  }
}
```

Start that PostgreSQL container without network and with sufficient disk. Then:

```sh
python3 /opt/merv-recovery/recovery-snapshot.py --config /etc/merv/recovery.json restore \
  --snapshot SNAPSHOT_ID --database merv_restored_drill --code-root /var/backups/merv/restored-code
```

Failure preserves newly created restore data for diagnosis; it never drops a caller-named database. Successful output says `restored-isolated`, not active. Map restored files to the application UID/GID only in the new destination. Role/extension provisioning, exact compatible application image and configuration/decryption keys must be recoverable separately. An old-format backup uses the frozen legacy reader and its existing manual database restoration instructions; do not rewrite or discard old backups during this cutover.

Before activation, fence the old control host and workers. A snapshot can contain credentials later revoked, expired leases, pending checks, provider jobs, old GitHub publication state and allocations that changed after capture. Reconcile those through their owning services before enabling live providers/dispatch, rotate relevant credentials, and preserve the original database/directory. Do not bulk-delete journals or assume a database rollback reverses external effects. Rehearse startup on a disposable copy with external capabilities blocked/faked, replay pending Code journals, then prove a new checkpoint/handoff works. Backup verification itself does not claim that arbitrary live external workflows can be rolled back.

## Scope and rollout gates

This protects the Merv schema (including inline artifact bytes) and server Code. It does not protect blob-only artifacts, large uploads, future transcripts, Pi checkpoints, sandbox datasets/volumes, auth-provider state, remote GitHub or unuploaded runner work. Those require separate protection. Never advertise these two files as a backup of all research bytes.

Cutover requires: legacy restore kit preserved and tested; two independent native pre-release reviews with both returning SHIP (the owner waived the originally proposed Opus/Fable gate); staging real storage roundtrip; measured outage/disk usage; crash/restart tests; isolated restore and journal replay/new-checkpoint canary; then the coordinated local-main/origin/staging/production release order. Preserve old backups and previous images until the owner approves retirement. No snapshot job should run while the hosted-release marker is active.

Local tests use disposable databases on the explicitly provided test cluster:

```sh
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:55439/merv python3 deploy/recovery-snapshot.test.py
```

The suite exercises real PostgreSQL dump/restore and real Git; control-container and object-storage boundaries are local fixtures. The real deployed systemd/Docker/AWS path must still pass its staging canary. Native test/fixture configurations may set `verification.database` to an explicit local database command configuration instead of `verification.image`; production should use the isolated container path.
