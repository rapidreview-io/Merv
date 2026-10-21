# Historical prerequisite investigation (superseded)

The topology decision below was resolved by the isolated native implementation. Use
[staging-isolation/README.md](staging-isolation/README.md) and
[STAGING_SANDBOXES_ISOLATION_PLAN.md](STAGING_SANDBOXES_ISOLATION_PLAN.md) for the current
operator sequence. This retained investigation is not an instruction to share production DBs,
wait for generic topology approval, or repair the old image with env-only origins.

# Staging native Sandboxes prerequisites

On October 21, 2026, staging migrated its three preserved tasks and started native Main
`sha256:e9ed6dbc1c810138fc2254edcaaa7144fce325bdfc366e17ab48508937151ca8`
from release `20261021T151339Z-6b31044c-9611756680fd`. Keep this image, boot maintenance and
customer ingress fence in place. Never restart the legacy Main or runner against the migrated schema.

Read-only inspection found an empty `/etc/sandboxes/shared.env`, no staging Sandboxes control or
Postgres container, and no `SANDBOXES_DATABASE_URL` or `SANDBOXES_VAULT_KEY` in Main. The old
`MERV_SANDBOXES_URL`, application credentials and encryption key belong to the retired remote
adapter. They cannot authorize the native in-process database adapter. Historical staging setup
explicitly disabled Sandboxes while leaving hosted enablement flags set; rendering silently omitted
Sandboxes, Fleet and Pi. Rendering now rejects that contradictory configuration, and staging hosted
preflight and checkpoint checks require the running Main's rendered hosted plugins.

Production has `sandboxes-control-1`, `sandboxes-postgres-1` and a populated private shared env.
Its Postgres port has no host publication; the control HTTP port is loopback-only. These are not a
staging connection endpoint. Do not copy production's raw shared file or expose its database as a
shortcut. Production Research/Postgres and Sandboxes Postgres are separate services; Merv staging
must remain on `merv_ts_staging` in its own existing database.

The native host uses Sandboxes schema `public`, its vault key and shared `/data`; standalone
Sandboxes owns migrations, workers and gateway. The adapter checks compatible migration history.
The relay has a fixed `merv-relay` consumer ID and resolves `infra_namespaces.merv_project_id`
into the attached Merv state. Sharing production's database with a different Merv state therefore
needs an independently reviewed relay/namespace isolation design. During boot maintenance, the
adapter also refuses an uninitialized relay cursor. Neither copying a production cursor nor
inventing a staging cursor is an authorized fix.

## Required decision before a same-image configuration repair

The infrastructure owner must identify an existing compatible Sandboxes deployment intended for
staging, or explicitly authorize a separate provisioning/isolation task. Supply a reachable private
Postgres endpoint, authorized database role, matching vault key, required private `/data` material,
compatible standalone console endpoint, and provider/account linkage for the approved staging
reader project. Provider grants and credits must remain bounded to staging; existing remote-adapter
application credentials establish none of these native permissions. A shared production deployment
also requires a reviewed solution for the relay cursor and namespace routing before use.

No executable apply helper is provided while those prerequisites are unresolved: a blind env patch
would either fail startup under the fence or introduce cross-environment authority. Do not set hosted
flags false to manufacture acceptance, fabricate grants, mint credentials, create paid resources or
remove maintenance to initialize the relay.

## Parent-owned repair after those prerequisites are reviewed

1. Assert exact current native image, staging database/schema, boot maintenance in saved and live
   env, unchanged ingress fence, no hosted/recovery owner and no active release job. Hold the shared
   maintenance lock. Preserve root-private originals and an intent binding image, all input hashes,
   approved credential provenance and proposed after hashes; fsync files and containing directories.
2. Prepare only reviewed Sandboxes connection settings in the correct env layer. Preserve every
   other byte, current native/OAuth settings and Fleet/Pi pins. Reject duplicate/conflicting keys and
   effective-env drift. Never print connection secrets or include them in command arguments.
3. Render the candidate on the exact image with `--network none`, no service entrypoint and no host
   writable mounts. Require all Sandboxes/Fleet/workflow/Pi plugins and exact staging profile IDs.
4. Perform read-only connectivity checks from the intended container network using the approved
   credentials: database identity, migration checksums, relay/isolation prerequisite, namespace and
   account/provider mapping, intended credits/limits, and required private data readability. Use
   read-only transactions; no DDL, grants, migrations, account changes or provider actions.
5. Only after independent review, atomically replace the approved env files and fsync parent
   directories before same-image Compose recreation under boot maintenance. Preserve the durable
   intent and logs. Any failure remains fenced and requires forward repair; never restore the old image.
6. Verify exact image, normal process readiness with maintenance still true, required rendered plugins,
   saved/effective env equality, unchanged staging pins and no unintended ownership. Rerun the supported
   staging hosted preflight; generic `/health` alone is insufficient. Keep customer ingress closed
   until the real hosted canary and stopped-runtime proof pass.
