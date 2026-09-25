# Read-only Pi operations

Pi is an optional Fleet client. The Agent sidebar opens conversations, not tasks.
The production configuration keeps workflow dispatch disabled and uses the
authenticated, model-restricted relay with `gpt-6-luna`. Provider credentials stay
on the main server; workers receive only bounded per-command relay authority.

Since 2026-09-24 18:17 UTC Pi is enabled for all existing human-accessible
projects and the service pilot. Owner-authorized enablement does not certify
unfinished security or full UI acceptance; see `docs/PI_IMPLEMENTATION_STATUS.md`.

**Machines.** One operator-owned Pi host project rents every Pi machine with
its reader key (`MERV_PI_HOST_KEY`), a capacity-only exception the founder
approved on 2026-09-24 (`docs/PI_AGENT_PROPOSAL.md`). Each person gets one
machine per project. All of their conversations in that project share it,
running up to its slots at once (Standard 3, Large 4), and it stops 10 minutes
(`MERV_PI_IDLE_TIMEOUT_SECONDS`) after the last answer in any of them. The
person picks the machine or releases it (Release machine) on the Agent page. Every read the agent makes still runs as
the person, with their current permissions. A new project needs no Sandboxes
connection and no onboarding for Pi.

A project's own Sandboxes connection now decides only whether its writers, and
their agents, may run on Large. Every project connected for Pi on 2026-09-24
keeps its connection, so all of its writers may. To keep a project on
Standard only, retire its connection (see below).

## Owner actions and deadlines

- **By 2026-09-30, the founder:** replace the dedicated Cloudflare native
  verification credential (Workers Containers Read, restricted to the control
  host's egress IP) used by the `cloudflare-fleet` provider. It expires on
  2026-09-30. After that Sandboxes refuses every launch after the billed
  machine was already created, so every turn ends as `turn_expired` without an
  answer. The machine and its Fleet slot are held until the allocation's
  deadline. The replacement must cover both Cloudflare apps, Standard and
  Large: `cloudflare-fleet-large` carries its own copy in
  `FLEET_CLOUDFLARE_BRIDGE_LARGE`.
- **By 2026-10-17:** renew every consumer grant. They all expire on 2026-10-24:
  the canary grant at 16:14:06Z, then the 33 grants from the enablement, then
  the QA grant `tok_yd17ci1amwyjo2lv`. Nothing renews them automatically. After
  expiry that project's writers lose Large and its Sandboxes rows; only the host
  grant's expiry (below) stops Pi itself. Renew in one batch: a new grant
  per namespace, one catalog edit that adds every new ID to both allowlists, one
  Sandboxes recreate, one env edit, one Main recreate, then remove the old IDs
  and revoke the old grants.
- **The Pi host's grant** renews like the others, by the `renewBy` in its
  `sandboxes.receipt.json` (7 days before it expires). Every Pi machine for
  every person is rented with it, so when it expires nobody can start one. Keep
  an alarm on that date.

## Credentials and access

- Browser callers use normal authenticated human project membership. The old
  acceptance actor credential is not the browser credential or a production
  identity fallback. Enabling Pi does not make a project without an active human
  membership accessible.
- The Pi host key is a reader actor credential in the host project, with no
  expiry and no member behind it. It only rents machines there; it never reads
  a person's project. To rotate it, adopt the host project
  (`cli.js adopt-project`), issue a new reader credential, swap
  `MERV_PI_HOST_KEY`, recreate Main, then revoke the old credential.
- Each Sandboxes connection, the host's included, has a consumer grant
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

Pi no longer needs this. Connect a project to let its writers run Pi on Large,
or to give it Sandboxes rows, and to connect the Pi host itself.

Run [`pi-connect-project.py`](pi-connect-project.py) as root on the production
host, one phase at a time. Every release carries it under
`/opt/merv-typescript/releases/<id>/source/deploy/`.

```sh
python3 pi-connect-project.py sandboxes <projectId>   # then, once it prints its receipt:
python3 pi-connect-project.py main <projectId>
```

The container names are fixed; the script reads the images, the Sandboxes
catalog path and Main's release directory from the live containers. Never run it
with `python3 -O`, which strips its guards. It refuses to run unless Main (Fleet
allocations, active Pi commands) and Sandboxes (sandboxes, jobs, workflows,
outbox, snapshots) are drained and the project exists, and while a hosted-image
run is open; it holds that pipeline's host lock throughout. It backs up the env and
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
  Revoke that grant and move the directory aside before you rerun; the rerun
  reuses the namespace.
- Record a receipt section in `RELEASES.md` (see below) from the two
  `*.receipt.json` files, then shred the directory. Its backups hold grants and
  secrets.
- To retire a connection, remove its entry and its `MERV_PI_PROJECT_*` line,
  remove its grant ID from both allowlists, recreate both services, and revoke
  the grant. The namespace stays, and reconnecting the project reuses it.

### Provider scope

`cloudflare-fleet` is configured with an explicit namespace list, and that list
is exclusive. A namespace that is not on it gets `provider is not configured` on
its first create. On 2026-09-24 the 33 namespaces enabled at 18:17Z were not on
the list until the QA onboarding added them at 19:33Z, so no send from those
projects could have started a machine before then. The script re-adds every
missing `merv-pi-*` namespace on each run. Replacing the list with
`namespace_prefixes: ["merv-pi-", "fleet-cloudflare-canary"]` would remove this
step, but it widens the scope. That is an owner decision, and the script's scope
step would then need removing: it stops before issuing anything when the list is
gone.

### Shared canary namespace

The service pilot and one human project, the only human connection that predates
18:17Z, share `fleet-cloudflare-canary` and its grant. Sandboxes lists rows per
namespace, and `sandbox.release` needs only write permission. Members of that
project can therefore probably see and release the pilot's machines, including
Pi runtime VMs, and the pilot can do the same to theirs. The recommended fix is a
dedicated namespace: run both phases with `--rehome` for that project. The pilot
keeps the canary grant.

## Setting up the Pi host

Do this once, before the first release that reads `MERV_PI_HOST_PROJECT_ID`.
That release refuses to render Pi without a host, so its health wait fails and
it rolls back. Use one quiet window. Every step below is either a script phase
or an existing tool, and each phase refuses to run out of order or while a
hosted-image run is open. Until step 6, Main keeps launching its v1 release on
the old image, so Pi keeps working. The live Standard release is `current` in the
host's `/var/lib/merv-fleet-pilot/hosted-release/state.json` (its `image` and
`releaseId`), and Main names it in `MERV_FLEET_RUNTIME_RELEASE_ID`;
`deploy/hosted-release.json` in Git can lag behind it.

Freeze production releases from step 1 until step 6 is done. A `release.mjs` in
between can move Standard to a new image, and the Large copy and the machines
would then pin a retired release. The `large` and `machines` phases and
`release.mjs` refuse such stale pins, but after one of those refusals the steps
from step 1 have to be done again.

1. **Large app** (the founder, holding the Wrangler login). With the pipeline's
   wrangler (`output/fleet-cloudflare-tools`), run `wrangler deploy --env large`
   from a deployment copy of
   `fleet-sandboxes/deploy/cloudflare-sandbox/worker/wrangler.jsonc`, with
   `env.large.containers[0].image` set to the live Standard `image`. This creates
   Worker `merv-sandboxes-bridge-large` and the `standard-3` application
   `merv-sandboxes-bridge-large-sandboxcontainer-large` with `max_instances` 10,
   as `deploy/hosted-wrangler-large.json` names it. The hosted pipeline deploys
   every later image to it, and refuses while its name or `max_instances` differs
   from that template. Give it its own token (`openssl rand -hex 32`, then
   `wrangler secret put BRIDGE_TOKEN --env large`; deploys keep it) and note its
   application ID. Put its `bridge_url` and `bridge_token` in one JSON object in
   a root-only file. Leave out `cloudflare_api_token`: step 4 then gives Large
   the native verification credential Standard uses, server-side, and that
   credential must cover both apps.
2. **Host project.** Run `python3 pi-connect-project.py host`. In Main's
   database this creates the project `Pi host`, with no member, and a reader key.
   The setup operator is retired as it finishes. The key stays in
   `/var/lib/merv-fleet-pilot/pi-connect/_host/host.private.json`, and the
   printed receipt names the host project ID.
3. **Host connection.** Run `sandboxes <hostId>`, then `main <hostId>`. These
   are the two ordinary phases above.
4. **Large machine.** Run
   `python3 pi-connect-project.py large <hostId> --release <live Standard rt1_> --application <uuid> < large-bridge.json`.
   It refuses unless Main and Sandboxes are drained and the bridge's `/health`
   reports `standard-3`. It also refuses while a price cap on the account, the
   member or the host namespace is below Large's $0.2201/h (see Machines). It
   adds the `cloudflare-fleet-large` provider, which reaches only the host
   namespace, and a copy of the live Standard release with only the provider
   changed. It refuses unless Main and its env name `--release` for Standard.
   It recreates Sandboxes control and pipelines-worker and checks that the host
   resolves Large, is offered `standard-3`, loaded both releases, and that both
   apps run the release's image.
   Last, it sets the host namespace's limit: 50 at once, 86400 s each, and
   $0.23/h. Its receipt names the Large release ID. `hostConcurrency` is the
   lowest concurrency cap on the host, so a cap below 50 shows there. A failed
   run restores the catalog and leaves the limits alone. Move its `large-*`
   backups aside before you rerun it.
5. **Main's env.** Copy the new release's `deploy/` directory to the host, and
   from it run `python3 pi-connect-project.py machines <hostId>`. The phase
   writes these variables and recreates nothing:
   - `MERV_FLEET_RUNTIMES`, with Standard (3 slots) and Large (4 slots, agent).
   - `MERV_FLEET_PROJECT_LIMITS={"<hostId>":50}`.
   - `MERV_FLEET_ALLOCATION_TIMEOUT_SECONDS=86400`, the value production already
     runs. A host moves to a fresh machine 15 minutes before its deadline, so the
     deadline must stay long.
   - The host ID and key.
   - `MERV_PI_RUNTIME_KEY=project` and `MERV_PI_AGENT_MOVES=true`.

   The `MERV_FLEET_RUNTIME_*` lines stay. The phase refuses unless Main and its
   env still name step 4's Standard release and both apps still run its image.
   It dry-runs the render twice:
   once with the running image, so a rollback still starts, and once with the
   new release's renderer mounted over it. If either fails, it restores the env;
   move its `*-machines-env.private` files aside before you rerun it.

6. **Release.** Take a `pg_dump` of Main's database now, after step 2 has
   created the host project. Then run `node deploy/release.mjs` from origin/main's
   tip. It first checks the pins Main will take from the env against the host's
   record (`hosted-release.mjs --check`), and refuses before any change if they
   differ. It releases Main, which runs the pi@2 migration, and its hosted run then
   builds and gates the v2 image, deploys it to both apps, points both machines
   (and the legacy key) at its releases and canaries a Pi turn, whose machine it
   releases. Both ledgers commit themselves.

   **The Pi gap.** From Main's release until the hosted run's switch, every Pi
   turn fails: Main v2 sends a v2 bootstrap to the v1 image, which refuses it.
   That gap is the hosted run's build, gates, push, catalog, drain and two
   deploys, about 15 minutes (the first automated run took about that end to
   end), and the switch then recreates Main once more. Keep the window quiet, or
   the drain waits for turns and launches in flight.

   If the hosted run fails, it rolls both apps back to the v1 image, which Main
   v2 cannot use, so Pi stays down until a hosted run passes: fix the cause and
   run `node deploy/hosted-release.mjs`. To roll Main back instead: until the
   migration, `release.mjs` rolls itself back on a failed health wait; after it,
   the older image refuses the database, so restore that `pg_dump` and run
   `node deploy/release.mjs` at the previous commit, without `--skip-hosted`.
   Its hosted run, the previous pipeline, finds Standard and the legacy key on
   the release the host recorded. After a passing hosted run that is the v2
   release, so it rebuilds the v1 image, deploys it to Standard, points the
   legacy key back at it and canaries a Pi turn; Pi is down from Main's release
   until that switch. Never put an image back by hand
   (`deploy/cloudflare-sandbox/rollout.py`): the apps, Main's env and the host's
   record would then disagree, and every later release refuses. The Large app,
   its catalog copy and `MERV_FLEET_RUNTIMES` stay on the v2 release, which the
   older Main never reads; `release.mjs` refuses a later cutover until they name
   the live release again. A dump from before step 2 has no host
   project, and the host key then stops authenticating. Restoring one means
   removing the `MERV_PI_HOST_*` lines, moving `_host` aside and running the
   phases again from step 2. The production Standard app (version 15) is at
   `max_instances` 50, the host limit; keep it there.

7. **Canary.** Check each of these:
   - Two conversations in one project share one machine.
   - Two projects get two machines.
   - Revoking a membership fails only that project's turn.
   - The machine stops 10 idle minutes after the last answer.
   - A move to Large made mid-answer lets that answer finish on Standard.
   - With Large switched off, people stay on Standard.

   Record a `RELEASES.md` receipt from the phases' receipts, then shred both
   directories.

## Machines

- `MERV_FLEET_RUNTIMES` is the one catalog. Each entry is a Sandboxes runtime
  profile, and it is also the machine a person picks: `label` is what the
  picker shows, `slots` how many turns share the machine, and `agent` whether
  the agent may move itself there. The first entry is the default.
- Standard is always allowed. A person, and their agent, may use another machine
  only in a project that has its own Sandboxes connection, and only with at
  least write permission there. Otherwise the picker shows the machine as
  unavailable, and the agent is not offered `switch_machine`. The agent moves
  only with `MERV_PI_AGENT_MOVES=true`. It starts the new machine and moves
  there only once the machine is proven ready.
- Sandboxes resource limits and provider controls name the plugin, `cloudflare`,
  never the app, so nothing in Sandboxes caps or disables Large alone:
  - The host namespace limit covers both machines.
  - Large's only ceiling of its own is its app's `max_instances` of 10.
  - A price cap below Large's price makes Large unrentable.
  - A `cloudflare` provider control stops Standard and Large together.
- **Turning Large off:** remove the `large` entry from `MERV_FLEET_RUNTIMES`
  and recreate Main. To leave Main running instead, set `"enabled": false` on
  the `cloudflare-fleet-large` provider and recreate Sandboxes. Its offer then
  disappears, and moves to Large fail while people stay on Standard. Hosted
  releases, and so production `release.mjs` runs without `--skip-hosted`, then
  refuse until it is enabled again, since they cannot read the Large app that
  Main still names.
- Fleet caps the host at its `MERV_FLEET_PROJECT_LIMITS` entry and at
  `MERV_FLEET_GLOBAL_LIMIT`. Pi holds one machine per person per project, or
  two while it moves, and starts a move only while at least 3 slots are free.

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
- A changed release in a `MERV_FLEET_RUNTIMES` entry changes that machine's
  profile, and every allocation on it is then asked to stop. Roll it out
  drained. The hosted runtime is digest-pinned; `hosted-release.mjs` (run by
  `release.mjs`) builds it from committed sources and moves it together,
  drained, gated and canaried, with automatic rollback: the image on every
  Cloudflare app that serves one of Main's machines (Standard, and Large once
  `MERV_FLEET_RUNTIMES` names it), the release and its Large copy in the
  catalog, and each machine's release id (Standard's also in
  `MERV_FLEET_RUNTIME_RELEASE_ID`). It refuses while any of them differs from
  what it recorded, and `release.mjs` checks the same before releasing Main.
- An open hosted run blocks every Main release, emergencies included. When it
  can neither finish nor roll back, `node deploy/hosted-release.mjs --abandon`
  closes it once production agrees on one of its releases: every live Cloudflare
  app runs that image with no rollout, Main and the env file name its release
  ids, and both Sandboxes services' catalog holds them. Otherwise it refuses and
  names what disagrees; the run stays open. On the run's own release it first
  runs a canary; if that fails, it exits 4 and marks the live pins unverified,
  and every later run canaries them again until one passes.
- Before you raise a Fleet limit, confirm that Sandboxes `infra_resource_limits`
  (`max_concurrent` for the account, member and namespaces) allows the new
  concurrency. Also confirm that each Cloudflare app's `max_instances` allows
  it. Otherwise the extra creates are refused, and those turns fail.
- Keep the **USD 100 all-time cap** and accrued spend and accounting unless the
  owner changes them.

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
- A `provisioning` row may still have its create in flight; it is not a wedge.
- Unless the failure provably happened before any network call, first confirm
  that Sandboxes holds no sandbox for the allocation, with the second query in
  the Sandboxes database.
- Use one transaction that first takes
  `pg_advisory_xact_lock(hashtextextended('merv-state:<schema>', 0))`. In it, set
  both the `phase` column and `data_json` to `phase: released`, `intent: stop`,
  `retryAt: null`, `error: null` and `failures: 0`. Never delete the row: the
  Pi host slot that names it could then never be reconciled. Never update only
  the column: Fleet reads each allocation from `data_json`, so the slot would
  stay held. Every Pi allocation is in the host project.

```sql
SELECT id, project_id FROM <schema>.fleet_allocations
WHERE phase IN ('uncertain', 'releasing') AND data_json::json->>'runtime' IS NULL
  AND data_json::json->>'createAttempted' = 'true';
-- Sandboxes: the create key is a hash of the project and '<id>:create'.
SELECT id, state FROM sandboxes WHERE idempotency_key = 'runtime:' ||
  encode(sha256(convert_to('["<project_id>","<id>:create"]', 'UTF8')), 'hex');
```
