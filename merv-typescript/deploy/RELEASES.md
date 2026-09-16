# Production releases

Each row is one immutable image built on the VM by `node deploy/release.mjs` from an allowlisted archive of the working tree (the git revision alone does not identify a release in this checkout; the release id carries the content hash). Evidence per release lives under `/opt/merv-typescript/releases/<id>/` on the VM (`source-manifest.json`, `build.log`, `deploy.log`, `staging-refresh-acceptance.json`) and the rollback record under `/var/backups/merv/typescript-staging-refresh/<id>/`.

Checks column: VM status codes for `/health`, `/ui/`, anonymous `POST /tools/ui.shell` (401), approved-origin `/auth/config` (200), unapproved-origin tool call (403); then public HTTPS `/health` and `/ui/`; then each served asset.

**Rollback** to the previous row's image:

```sh
ssh ResearchSuite_Control 'sudo bash -c "cd /opt/merv-typescript/releases/<previous-id>/source/deploy && MERV_TS_IMAGE=merv-typescript:<previous-id> docker compose -f compose.yml up -d"'
```

| When (UTC)        | Release                                  | Image id       | Plugins active/total | Result | Checks                                                                                                             | Rollback                                                          |
| ----------------- | ---------------------------------------- | -------------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 2026-09-16 19:48Z | `20260916T190552Z-be69497b-3a026ebca252` | `3235cf85425f` | 54/54                | pass   | see [CUTOVER_2026-09-16.md](CUTOVER_2026-09-16.md)                                                                 | legacy Python, see cutover record                                 |
| 2026-09-16T21:09Z | `20260916T210826Z-2e5273f8-5daf4318169d` | `c0bdc0419093` | 54/54                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-C4qNuYmg.js 200; /ui/assets/index-yXJbzxTW.css 200 | rollback `merv-typescript:20260916T190552Z-be69497b-3a026ebca252` |
| 2026-09-16T21:37Z | `20260916T213600Z-e531db15-c993e9559496` | `acff59e91751` | 54/54                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-BnQ4YK6J.js 200; /ui/assets/index-4P6A9wbX.css 200 | rollback `merv-typescript:20260916T210826Z-2e5273f8-5daf4318169d` |
