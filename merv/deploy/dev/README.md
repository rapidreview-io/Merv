# Dev brain on Azure

A second, isolated Merv brain for soaking branches before they reach prod.
Everything lives on one VM: Caddy terminates TLS on a public hostname and
serves the research UI as static files, the brain runs behind it, and the
records (self-hosted Supabase Postgres), blobs, and heavy storage (MinIO) are
volumes on the same box. Prod is untouched by construction: different VM,
database, buckets, OAuth resource URI, and secrets. The only shared pieces
are the RapidReview Supabase **Auth** project (the same logins work) and the
sandbox provider accounts (same quota and billing, separate bookkeeping).

| | |
|---|---|
| VM | `rp-control-dev` in resource group `MERV-DEV-RG` (eastus2, Standard_D2s_v3, Ubuntu 24.04) |
| Host | `https://dev-experiments.rapidreview.io` (IONOS A record → static IP 20.110.24.126; the Azure label `rp-control-dev.eastus2.cloudapp.azure.com` still points at the VM but Caddy no longer serves it) |
| UI | `https://dev-experiments.rapidreview.io/merv/` |
| MCP | `https://dev-experiments.rapidreview.io/mcp` |
| SSH | `azureuser@dev-experiments.rapidreview.io` (same key as prod) |

## Deploy a commit

From a laptop checkout (needs `git`, `node`, `python3`, `rsync`, and SSH to
the VM):

```sh
merv/deploy/dev/deploy-dev.sh            # HEAD
merv/deploy/dev/deploy-dev.sh <sha>      # any commit; the UI is built from the working tree
```

The script ships `git archive <sha>` to `~/releases/merv-<sha8>/` on the VM,
builds `research_state_ui` and rsyncs `dist/` to `/srv/merv-ui`, renders
`Caddyfile.template`, takes a `pg_dump` into `~/research-suite-vm/`, runs
`docker compose up --build -d` from the release directory with the three env
files and the overlay in this directory, waits for `deploy-control-1` to be
healthy, and probes the public host. Releases are kept; data lives in the
compose project's named volumes (`deploy_supabase_pgdata`, `deploy_miniodata`),
so a new release reuses them exactly like prod's release clones.

## One-time VM setup (already done for rp-control-dev)

1. `az vm create` with an Ubuntu 24.04 image, a Standard static public IP with
   a DNS label, and NSG rules for 22/80/443 (`az vm open-port --port 80,443`).
2. Install Docker CE + the compose plugin and Caddy from their official apt
   repositories; `usermod -aG docker azureuser`; `mkdir ~/releases
   ~/research-suite-vm /srv/merv-ui`. If `azure.archive.ubuntu.com` times out,
   point `/etc/apt/sources.list.d/ubuntu.sources` at `archive.ubuntu.com`.
3. Create the env files in `~/research-suite-vm/` (mode 0600):
   - `dev.env` — `MERV_DEV_HOST`, `MERV_DEV_MINIO_USER`,
     `MERV_DEV_MINIO_PASSWORD`, `MERV_PROVIDER_ENV_FILE`, `MERV_WAIT_SECRET`
     (see the header of `docker-compose.dev.yml`).
   - `supabase-db.env` — the four `MERV_DB_SUPABASE_*` secrets plus the two
     loopback ports, as in `deploy/supabase.env.example`.
   - `provider-secrets.env` — `SUPABASE_URL/ANON_KEY/SERVICE_KEY/JWT_SECRET`
     of the auth project, `MERV_REQUIRE_AUTH=1`, the sandbox provider keys
     (`LAMBDA_LABS_API_KEY`, `THUNDER_COMPUTE_API_KEY`), and a dev-only
     `MERV_ADMIN_TOKEN`. Generate secrets with `openssl rand -hex 32`; copy
     shared values host-to-host over SSH pipes rather than through a terminal.
4. Run `deploy-dev.sh`.

## Checking on it

```sh
ssh azureuser@rp-control-dev.eastus2.cloudapp.azure.com
sudo docker ps
sudo docker logs --tail 100 deploy-control-1
sudo docker inspect deploy-control-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'   # live release
sudo docker exec deploy-supabase-db-1 psql -U postgres -d postgres -Atc 'select max(version) from schema_migrations'
```

Studio (table editor) is loopback-only; tunnel it:
`ssh -N -L 55433:127.0.0.1:55433 azureuser@<host>` then open
http://127.0.0.1:55433.

## Pointing agents at dev

- Claude Code: a workspace `.mcp.json` with
  `{"mcpServers":{"merv":{"type":"http","url":"https://<host>/mcp"}}}`
  (the repo's `merv/.mcp.json` is prod). Sign in through the normal MCP OAuth
  prompt; the consent page is the dev UI.
- Runner / `merv-client` on a harness machine (install the dev build so the
  machine carries the deployed branch's skills, then point it at dev):

  ```sh
  curl -fsSL https://<host>/merv/runner/install.sh \
    | MERV_RUNNER_BASE_URL=https://<host>/merv/runner sh -s -- --install-only
  ~/.merv/bin/merv-client configure --control-url https://<host>
  ~/.merv/bin/merv-agent-runner pair      # code → dev Auto-run page
  ```

  A machine is paired with one brain (`~/.merv` is per user), so keep dev
  runners on dev machines.
- Kilo / OpenCode plugins still hard-code the prod URL (`clients/*/plugin.js`).

## Changing the hostname

Set `MERV_DEV_HOST` in `dev.env` to the new name (DNS must already resolve)
and redeploy: the Caddyfile, OAuth resource URI, UI base URL, CORS origins,
and presigned storage host all follow `MERV_DEV_HOST` (done once on
2026-08-19: Azure label → `dev-experiments.rapidreview.io`). MCP clients
re-authenticate once (the resource URI changed). Google sign-in on the dev UI
additionally needs the dev origin in the auth project's Supabase *Redirect
URLs*; email + password sign-in needs nothing.

## Migrations and resets

The migration ladder is append-only: once dev has applied a numbered
migration from a branch, do not edit it — add the next number. If `main` gains
the same number first, renumber the branch and reset dev (drop the
`deploy_supabase_pgdata` volume, redeploy). Dev data is disposable; the deploy
script's `pg_dump` is there for convenience, not as a promise.
