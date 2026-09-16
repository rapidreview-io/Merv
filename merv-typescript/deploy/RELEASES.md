# Production releases

Each row is one immutable image built on the VM by `node deploy/release.mjs` from an allowlisted archive of the working tree (the git revision alone does not identify a release in this checkout; the release id carries the content hash). Evidence per release lives under `/opt/merv-typescript/releases/<id>/` on the VM (`source-manifest.json`, `build.log`, `deploy.log`, `staging-refresh-acceptance.json`) and the rollback record under `/var/backups/merv/typescript-staging-refresh/<id>/`.

Checks column: VM status codes for `/health`, `/ui/`, anonymous `POST /tools/ui.shell` (401), approved-origin `/auth/config` (200), unapproved-origin tool call (403); then public HTTPS `/health` and `/ui/`; then each served asset.

**Rollback** to the previous row's image:

```sh
ssh ResearchSuite_Control 'sudo bash -c "cd /opt/merv-typescript/releases/<previous-id>/source/deploy && MERV_TS_IMAGE=merv-typescript:<previous-id> docker compose -f compose.yml up -d"'
```

| When (UTC)        | Release                                  | Image id       | Plugins active/total | Result | Checks                                             | Rollback                          |
| ----------------- | ---------------------------------------- | -------------- | -------------------- | ------ | -------------------------------------------------- | --------------------------------- |
| 2026-09-16 19:48Z | `20260916T190552Z-be69497b-3a026ebca252` | `3235cf85425f` | 54/54                | pass   | see [CUTOVER_2026-09-16.md](CUTOVER_2026-09-16.md) | legacy Python, see cutover record |
