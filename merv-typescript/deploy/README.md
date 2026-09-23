# Azure deployment: staged replacement

> **Production switched on 2026-09-16.** Read [the execution record](CUTOVER_2026-09-16.md) for the actual image, final schema, import, public routing and rollback state; [client reconnection](CLIENT_CUTOVER.md) replaces the legacy plugin setup. Older staging/planning instructions below are historical.

These files prepare the TypeScript backend and its `/ui/` application for the existing Azure VM. They do not deploy anything by themselves. Stage independently, finish the authenticated checks below, then change routing. The user selected preservation through import. The importer and isolated rehearsal are described in `LEGACY_REHEARSAL.md`; unfinished legacy work is retained as history until a separate continuity decision is made.

## Observed production layout — September 16, 2026

| Component                       | Current location                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Azure VM                        | `rp-control-1`, resource group `RESEARCH-SUITE-CONTROL-RG`, `20.98.245.95`                                   |
| Saved SSH alias                 | `ResearchSuite_Control`, user `azureuser`                                                                    |
| Public backend                  | `https://experiments.rapidreview.io`, Caddy → `127.0.0.1:8787`                                               |
| Python backend                  | `deploy-control-1`, image `merv-control:63f94101`                                                            |
| Current backend release         | `/home/azureuser/research-suite-vm/support-separation-63f94101/merv-compose.json`                            |
| Metadata database               | `deploy-supabase-db-1`, PostgreSQL 17.6, database `postgres`, schema `public`, Python schema version 81      |
| Internal Docker network         | `deploy_default`; database also binds only `127.0.0.1:55432` on the host                                     |
| Legacy browser UI               | Vercel: `https://rapidreview.io/merv` → `https://research-suite-chi.vercel.app/merv`                         |
| Main website routing repository | `/Users/guraltoo/Documents/dev/proj/experiments/RR_Site`, `rapidreview-io/RR_Site`, Vercel project `rr-site` |
| Backend secrets                 | `/etc/merv/control.env`, mode 0600; database administration values in `/etc/merv/database.env`               |
| New staging port                | `127.0.0.1:3081`, separate TypeScript staging service                                                        |

The old UI is **not** a static directory or a separate container on Azure. Stopping Caddy, the Python backend, or the entire RapidReview Vercel project would affect more than the UI. Sandboxes, the SSH gateway, Hatchet, and their databases are separate services and must remain untouched. Existing production retention instructions keep the previous database/configuration/volumes through at least **2026-10-10**.

## Isolation and account compatibility

- Create a dedicated `merv_ts_app` login and an administrator-created `merv_ts` schema owned by it. Grant database CONNECT; do not grant database CREATE, superuser, membership in `merv_app`, or access to the Python tables. The State provider supports an existing owned schema without database CREATE.
- Use the existing PostgreSQL server, but **never** point TypeScript at `public`. The Python and TypeScript schemas are incompatible. The reviewed offline importer preserves project IDs, memberships, claims and artifact metadata; a separate immutable archive retains historical research records. It does not resume Python workflows.
- Reuse the existing remote object service configuration names, but set the new private environment file's `MERV_BLOB_PREFIX=merv-ts`. Leave the legacy prefix, objects, bucket configuration, and environment file unchanged. The isolated import uses a versioned `merv_ts_*` schema and matching `merv-ts/<schema>` prefix. Every imported historical file must be independently verified and copied before metadata import; the baseline `merv_ts` staging schema stays separate.
- Shared Supabase authentication preserves the human account identity. It does not automatically copy projects, project memberships, actor credentials, API keys, histories, or in-flight work. A real shared-account sign-in has passed on the staged service. Imported membership and history acceptance still require the fully reconciled imported schema. `adopt-project` grants ownership of a project already present in the TypeScript database; it is not an importer.
- The server uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and, only for HS256 verification, `SUPABASE_JWT_SECRET`. Do not copy `SUPABASE_SERVICE_KEY`, legacy operator tokens, cloud-provider credentials, or sandbox connection secrets into the new container.
- Determine the current **user JWT signing mode** before setting `MERV_TS_AUTH_MODE=hs256` or `jwks`. An HS256 anon API key alone does not establish how current user JWTs are signed. Verify an actual user login without recording its token. Google sign-in additionally needs `https://experiments.rapidreview.io/ui/` in the Supabase redirect allowlist.
- Nisa/sandbox mounts and runner hosts need their own supported TypeScript configuration. The old Python connection file is not imported by this deployment. Their existing services continue to run independently.

## Build an immutable release

Run from `merv-typescript`. Record the source revision plus a hash/archive of any reviewed uncommitted release changes; a Git SHA alone is insufficient for this checkout. Use a unique image tag and a reviewed Node 22 image digest for `NODE_IMAGE`.

```sh
docker build --platform linux/amd64 \
  --build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:REVIEWED_DIGEST \
  -f deploy/Dockerfile -t merv-typescript:RELEASE_ID .
```

The build runs `npm ci`, builds the UI **before** compiling the backend, copies its assets, prepares JavaScript-only workspace exports, and removes development dependencies. The runtime invokes `node dist/src/cli.js`; it does not require TSX or TypeScript stripping. `prepare-runtime.mjs` changes generated package manifests only. Verify the final Linux image, not just the source execution path:

```sh
docker run --rm --entrypoint node merv-typescript:RELEASE_ID dist/src/cli.js help
docker image inspect --format '{{.Id}}' merv-typescript:RELEASE_ID
```

Transfer the image using the existing release mechanism, or `docker save`/`docker load` over the verified SSH connection. Keep a root-owned immutable release directory containing the Compose file, image ID, source manifest, rendered configuration checksum, and this runbook. Do not include secrets in that directory's normal logs or in an image/build argument.

## Back up and stage independently

1. Reinspect the live Caddy configuration, container image IDs, compose labels, network, database version, disk space, and port 3081. The observed values above can change. Save the current Caddyfile and the current Vercel deployment ID before editing either route.
2. Take a PostgreSQL custom-format backup and a roles/configuration backup into a root-owned mode-0700 directory. Backup files must be mode 0600; roles/configuration can contain secrets. Check `pg_restore --list` and record the backup checksum. Preserve the current Docker volumes and remote objects. A route rollback must not restore an older database over new writes.
3. With the database administrator, create only the dedicated login/schema described above. Set its password through a private credential channel, never command-line arguments, logs, or chat. Verify it cannot create schemas or read legacy application tables. Do not alter the `merv_app` role or the `public` schema.
4. Prepare `/etc/merv/typescript.env` as root:root 0600 using `typescript.env.example`. Copy only the named required values internally from the existing private configuration; never print the file. Use a new database-role password and the new artifact prefix. If the database is moved off the local Docker network, configure verified TLS in State rather than adding an unchecked URI TLS option.
5. Create `/var/lib/merv-ts`, owned by container UID/GID 1000, mode 0700. It stores local runtime state; it is not the metadata database or artifact storage. Do not reuse the legacy data directory. Code keeps one Git repository per project beneath it (`/var/lib/merv-ts/code`), which is authoritative and must be backed up with the database; see [Code operations](../docs/CODE_OPERATIONS.md#the-code-repository). The runtime image carries Git for it, and the server refuses to start with `code_git_unsupported` without one of at least 2.38. One server writes to this volume at a time.
6. Start the separate Compose project with its immutable image. Use `sudo` if needed to read the private environment file. Avoid `docker compose config` without `--quiet`, because rendering can print secrets.

```sh
MERV_TS_IMAGE=merv-typescript:RELEASE_ID docker compose -f deploy/compose.yml config --quiet
MERV_TS_IMAGE=merv-typescript:RELEASE_ID docker compose -f deploy/compose.yml up -d
```

Do not use `--remove-orphans`, the legacy project name, or a Compose command that includes the legacy stack. This composition binds only localhost, joins the database network, and does not change public routing. Never run `init` or `actor` in the production container: they are for local instances, and there they would write a bootstrap project and credentials into the database named by `MERV_DB_URL`, under schema `merv` or `MERV_DB_SCHEMA`, outside the `merv_ts*` schema this deployment uses. Both refuse to run while `MERV_TS_DB_SCHEMA` is set.

For browser staging, use an SSH tunnel from the workstation and open `http://127.0.0.1:3081/ui/`:

```sh
ssh -N -L 3081:127.0.0.1:3081 ResearchSuite_Control
```

Password login works through the same Supabase project. OAuth through this tunnel also needs its exact localhost callback in the authentication allowlist; it does not replace the final HTTPS login check.

## Readiness gates before public cutover

- Complete the source test suite, real PostgreSQL acceptance, remote-object acceptance, UI build/typecheck, and critical review. Retain their results alongside the release manifest.
- The container is healthy and all expected plugins are active. `/health` alone is a process check, **not** proof that the database, remote objects, or each optional plugin works.
- The real shared user can sign in, create/select the intended project, create a machine key, and authenticate to project APIs. Unauthorized and wrong-project requests fail. Do not retain user tokens in captured logs.
- Create/read an artifact through remote storage, advance a task, independently review it, and inspect agent/session/tool-call UI data. Restart only the new container and verify metadata, remote bytes, permissions, and the UI remain available.
- Complete the selected legacy import: verify every original artifact, completed figure and retained feed-media object; reconcile native and archived rows/hashes; then verify the real account sees its imported memberships and downloadable history. Resolve missing source files and the handling of unfinished old work before public cutover.
- Resolve existing MCP clients and agents. The old and new tool/credential contracts are not interchangeable. Routing `/mcp` to TypeScript is a backend cutover, not merely a UI change. Keep legacy public routes until the intended transition is explicitly agreed and tested.
- Verify actual HTTPS behavior, including the configured allowed origin and the Google callback if used. The generated API configuration explicitly allows `https://experiments.rapidreview.io`; forwarding through Caddy otherwise presents an HTTPS Origin to an HTTP backend and can reject requests.

## Public routing and temporary UI pause

`Caddyfile.cutover.snippet` shows the intended backend origin after a **full** approved cutover. Merge it into the saved current configuration, preserving unrelated host blocks and any required logging/security settings. Validate with Caddy before reload; do not install the snippet as the complete Caddyfile. Preserve the Python container, its immutable image and private configuration for rollback, but keep its writers stopped after the final snapshot. Save and test the previous upstream `127.0.0.1:8787` before the controlled pause. Follow the final-snapshot sequence below; an old writable backend must not silently diverge while TypeScript goes live.

After the new HTTPS UI passes acceptance, apply `rapidreview-redirect.fragment.json` to the current `RR_Site/vercel.json` as four narrow additional temporary UI redirects. See `UI_CUTOVER_PLAN.md` for the exact route patterns. This file is a fragment, not a complete Vercel configuration. Preserve every existing redirect, `/nisa`, `/docs`, sitemap rewrite, and catch-all route. Publish only the routing change, then verify the four UI route patterns, existing `/merv` installer/skill asset paths, `/nisa`, `/docs`, and the normal homepage. Old deep links cannot be interpreted as TypeScript project IDs, so they go to the new project selector.

The direct fallback `research-suite-chi.vercel.app/merv` remains an old UI unless its own Vercel deployment receives an equivalent temporary redirect. Decide whether to redirect that fallback too; do not pause the whole RapidReview application. Keep the old Vercel deployment IDs so both narrow routing changes can be reverted.

## Final snapshot and controlled writer pause

The rehearsal is not a final migration while the legacy application still accepts writes. Do not route production to its copied snapshot. After the active-work continuity decision, authenticated acceptance and critical review:

1. Reinspect current writer ownership. On September 16, all `merv_app` sessions came from `deploy-control-1` (`172.18.0.2`); TypeScript used its separate role/address. No Merv/research/control systemd service was present. Recheck actual database sessions and scheduled jobs immediately before pausing; a historical inventory is not a future guarantee. No query contents or credentials belong in the report.
2. Put only the Merv backend/UI routes into the reviewed maintenance state so clients stop starting work. Gracefully stop **only `deploy-control-1`**, wait for in-flight requests to drain, and verify its database connections and any other identified legacy writers are gone. Its `unless-stopped` policy preserves the explicit stop. Do not stop PostgreSQL, Caddy as a service, sandbox workers, Hatchet, the SSH gateway, or unrelated products.
3. Keep legacy writers quiescent. Make a fresh PostgreSQL/config backup and a new consistent projection-v2 export with a new source ID and protected directory. Reapply the independently checksum-verified historical lineage audit; any new unexplained missing file or changed exception fails the gate.
4. Import into a **new administrator-created final schema and its exact separate prefix**, using the accepted immutable image. Verify all retained file bytes, prepared native metadata, all archived rows/hashes, every availability envelope and receipt; retain aggregate source/native/history counts and every report checksum. Never overwrite or clear the rehearsal to reuse its name.
5. Start the accepted TypeScript image privately against that final schema/prefix/source ID; perform the authenticated membership/history and remote download checks. Then validate and apply the narrowly reviewed public routing changes. Keep the Python container stopped but available for deliberate rollback.
6. End maintenance only after the final public HTTPS UI/API checks pass. Record the start/end times and maintenance behavior. If verification fails before new TypeScript writes are accepted, restore the original Merv routing and explicitly restart the legacy control container. Once TypeScript accepts writes, a rollback must preserve them and acknowledge that Python does not contain those changes.

This sequence deliberately uses a bounded maintenance window instead of an incremental migration system. Do not promise its duration until the rehearsal's measured transfer/import times are known. The public pause, final capture and routing changes require their separate final authorization; none was performed by the isolated rehearsal.

## Rollback

1. Enter the agreed Merv maintenance state, stop new TypeScript writes, then deliberately restart the preserved Python control container if rollback is approved. Restore the prior **Merv routing** on Caddy and validate/reload it; leave the sandbox host block untouched. Confirm the legacy container answers through its old upstream. Preserve all new TypeScript writes; they are not automatically reflected in Python.
2. Revert the four narrow Vercel Merv UI redirects, or restore the recorded previous routing deployment. Revert the fallback UI redirect too if applied. Verify other product paths still work.
3. Stop only the `merv-typescript` Compose service if required. Preserve the `merv_ts` schema, its role, the new remote prefix, and local runtime directory for diagnosis and eventual resumption. Do not delete volumes or restore the old DB backup as part of a routing rollback.
4. New TypeScript writes will not appear in the legacy UI. Record that continuity limit and retain them; importing them back into Python is a separate task.

Authorized staging has created an isolated role/schema, private environment, localhost-only service and separate object prefix. The reviewed rehearsal may create only its additional versioned schema/prefix. Legacy tables, configuration, services, source objects and public routing remain unchanged; no Caddy or Vercel cutover has been performed. See `STAGING_2026-09-16.md` and the protected rehearsal receipts for actual evidence.
