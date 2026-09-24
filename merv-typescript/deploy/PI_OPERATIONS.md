# Read-only Pi operations

Pi is an optional Fleet client. The Agent sidebar opens conversations, not tasks.
The production configuration keeps workflow dispatch disabled and uses the
authenticated, model-restricted relay with `gpt-6-luna`. Provider credentials stay
on the main server; workers receive only bounded per-command relay authority.

Since 2026-09-24 18:17 UTC Pi is enabled for all existing human-accessible
projects and the service pilot. Each project connected at 18:17 UTC or later has
its own `merv-pi-*` namespace and a finite 30-day consumer grant. The QA project
was connected at 19:33 UTC by the run that `pi-connect-project.py` generalises. A
new project needs the same connection, not just a membership. Owner-authorized
enablement does not certify unfinished security or full UI acceptance; see
`docs/PI_IMPLEMENTATION_STATUS.md`.

## Owner actions and deadlines

- **By 2026-09-30, the founder:** replace the dedicated Cloudflare native
  verification credential (Workers Containers Read, restricted to the control
  host's egress IP) used by the `cloudflare-fleet` provider. It expires on
  2026-09-30. After that Sandboxes refuses every runtime delivery: every turn
  ends as `turn_expired` without an answer, and each allocation holds a Fleet
  slot and a billed machine until its 1800 s deadline.
- **By 2026-10-17:** renew every consumer grant. They all expire on 2026-10-24:
  the canary grant at 16:14:06Z, then the 33 grants from the enablement, then
  the QA grant `tok_yd17ci1amwyjo2lv`. Nothing renews them automatically. After
  expiry a project's first send fails at create. Renew in one batch: a new grant
  per namespace, one catalog edit that adds every new ID to both allowlists, one
  Sandboxes recreate, one env edit, one Main recreate, then remove the old IDs
  and revoke the old grants.

## Credentials and access

- Browser callers use normal authenticated human project membership. The old
  acceptance actor credential is not the browser credential or a production
  identity fallback. Enabling Pi does not make a project without an active human
  membership accessible.
- Each configured project needs a Sandboxes connection with a consumer grant
  restricted to its approved account, application, namespace and member. Its
  immutable grant ID must also be in the runtime-launch allowlist of both
  Sandboxes control and the pipelines worker, and `cloudflare-fleet` must list
  its namespace (see below). Never substitute an administrator token in the
  application.
- Rendering refuses a connection whose `tokenEnv` variable is unset or does not
  hold an `sbxt_` grant, and the error names only the variable. Before deploying
  the first build with this check, confirm that every connection's variable is
  set. Otherwise that release fails its health wait and rolls back.
- Human project onboarding uses the normal verified-login/membership path. Do not
  fabricate a human JWT, mutate membership tables directly, or convert a canary
  service actor into the user's identity.

## Connecting a project

Run [`pi-connect-project.py`](pi-connect-project.py) as root on the production
host, one phase at a time. Every release carries it under
`/opt/merv-typescript/releases/<id>/source/deploy/`.

```sh
python3 pi-connect-project.py sandboxes <projectId>   # then, once it prints its receipt:
python3 pi-connect-project.py main <projectId>
```

The script reads the container names, images, Sandboxes catalog and Main release
directory from the live containers. It refuses to run unless Main (Fleet
allocations, active Pi commands) and Sandboxes (sandboxes, jobs, workflows,
outbox, snapshots) are drained and the project exists. It backs up the env and
catalog to `/var/lib/merv-fleet-pilot/pi-connect/<projectId>/` before every
write, and writes atomically.

The `sandboxes` phase creates the namespace and a 30-day grant, adds every
`merv-pi-*` namespace to `cloudflare-fleet`, adds the grant to both allowlists
and recreates control and pipelines-worker. It then checks that every namespace
resolves the provider and that the grant is allowlisted. The `main` phase adds the
connection and the grant variable, dry-runs the image's render and recreates Main.
From inside Main it then checks that the grant authenticates as a consumer of the
namespace and that a launch lookup answers 404 (allowlisted), not 403. Any failure
restores the previous file and recreates the services on it.

- A failed `main` phase can be rerun as is. A `sandboxes` failure after the grant
  was issued leaves the namespace and the grant, recorded in `issue.private.json`.
  Revoke that grant and move the directory aside before you rerun.
- Record a receipt section in `RELEASES.md` (see below) from the two
  `*.receipt.json` files, then shred the directory. Its backups hold grants and
  secrets.
- To retire a connection, remove its entry and its `MERV_PI_PROJECT_*` line,
  remove its grant ID from both allowlists, recreate both services, and revoke
  the grant. The namespace stays.

### Provider scope

`cloudflare-fleet` is configured with an explicit namespace list, and that list
is exclusive. A namespace that is not on it gets `provider is not configured` on
its first create. On 2026-09-24 the 33 namespaces enabled at 18:17Z were not on
the list until the QA onboarding added them at 19:33Z, so no send from those
projects could have started a machine before then. The script re-adds every
missing `merv-pi-*` namespace on each run. Replacing the list with
`namespace_prefixes: ["merv-pi-", "fleet-cloudflare-canary"]` would remove this
step, but it widens the scope. That is an owner decision.

### Shared canary namespace

The service pilot and one human project, the only human connection that predates
18:17Z, share `fleet-cloudflare-canary` and its grant. Sandboxes lists rows per
namespace, and `sandbox.release` needs only write permission. Members of that
project can therefore probably see and release the pilot's machines, including
Pi runtime VMs, and the pilot can do the same to theirs. The recommended fix is a
dedicated namespace: run both phases with `--rehome` for that project. The pilot
keeps the canary grant.

## Restarts and limits

- Connections and grants are read when a service starts. Any onboarding, renewal
  or retirement therefore recreates Sandboxes control, pipelines-worker and Main.
  Main's shutdown stops every Fleet allocation and interrupts every live Pi turn
  in every project with `service_unavailable`. This is a design limitation, so
  schedule the change for a quiet window.
- `render-config.mjs` runs on every start, and the restart policy is
  `unless-stopped`, so a bad env value crash-loops Main. The rollback in
  `release.mjs` restores only the image, not the env. Keep a backup of the env
  and dry-run the render before any recreate.
- A new `MERV_FLEET_RUNTIME_RELEASE_ID` changes the Fleet profile, and every
  existing allocation is then asked to stop. Roll it out drained. The hosted
  runtime is digest-pinned; rebuilding it requires its coordinated
  release/catalog and isolation gates, not just a main-server rollout.
- Before you raise a Fleet limit, confirm that Sandboxes `infra_resource_limits`
  (`max_concurrent` for the account, member and namespaces) allows the new
  concurrency. A refused create otherwise holds the slot.
- Keep the **USD 100 all-time cap**, accrued spend and accounting, Fleet limits
  **1/1/1** and the native maximum of **3** unless the owner changes them.

## Consumer rotation

1. Verify current images, configuration, human access and provider identity, and
   confirm that nothing is running. Save the private rollback configuration.
2. Through the existing account-admin grant API or trusted operator control
   service, issue a consumer with the exact previous scope and a 30-day TTL.
   Store the returned secret once in protected server configuration, never in
   Git, command arguments, transcripts or worker context. Reconcile an ambiguous
   issuance by its recorded attempt and grant ID; do not retry it blindly.
3. Add the new grant ID to both runtime-launch allowlists, verify identity and
   expiry, install the new consumer credential and recreate the affected
   services from immutable images.
4. Verify authenticated readiness, a bounded Pi turn, streaming and release.
   Remove the superseded grant ID from both allowlists and revoke that grant
   once no active launch depends on it.
5. Record the Git revision, image, configuration hashes, grant ID, expiry,
   renewal deadline, budget and cleanup, never the secret. If no valid scoped
   consumer can be activated, fence new Pi work. An expired grant cannot serve as
   a rollback credential.

## Releases, receipts and evidence

A `release.mjs` row marked `pass` covers health, UI, authentication and origin
checks. It does not test Agent, so run a bounded Pi turn separately. The plugins
column records what the running container reported, and which of Fleet, Fleet
workflow and Pi it composed. Env-only changes produce no row: enabling Pi,
connecting or retiring a project, renewing grants and changing limits. For each
one, add a dated receipt section at the top of `RELEASES.md`. List what changed,
the env and catalog SHA-256 before and after, grant IDs and expiries, and the
plugin count the container reports afterwards. Never record a secret.

Publish the reviewed main-server source before building an immutable release.
Reconcile concurrent changes; do not deploy an old checkout. Do not change
published migration SQL or remove production migration-ledger rows for rollback.
Complete Merv-controlled capture and secret scanning remain the security
boundary. Scan all available provider logs with source/time/pagination checks,
and keep recording the provider-internal visibility limitation. Previously accepted
evidence is not proof of a new run's complete logs. Do not relabel ordinary
release regression checks as a fresh full security acceptance. Keep diagnostic
SSH disabled and temporary administrator keys absent after maintenance.

## Clearing a wedged allocation

Use this only when the code cannot release an allocation itself. The 2026-09-24
18:28Z example was an `uncertain` row with no runtime, `createAttempted` set, and
the only global slot held.

- Find it with the query below. Use `->>`, because `->` never matches a JSON
  `null`.
- Unless the failure provably happened before any network call, first confirm
  that Sandboxes holds no sandbox for the create key `<allocation id>:create`.
- Use one transaction that first takes
  `pg_advisory_xact_lock(hashtextextended('merv-state:<schema>', 0))`. In it, set
  both the `phase` column and `data_json` to `phase: released`, `intent: stop`,
  `retryAt: null`, `error: null` and `failures: 0`. Never delete the row: Pi's
  reconcile would then fail on every tick, and Pi could not start. Never update
  only the column, because Pi's runtime lock would then stay.

```sql
SELECT id FROM <schema>.fleet_allocations
WHERE phase <> 'released' AND data_json::json->>'runtime' IS NULL;
```
