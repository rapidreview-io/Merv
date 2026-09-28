# Staging releases

Rows written by `node deploy/release.mjs --host <staging alias> --public <staging origin>`, which
appends here instead of [RELEASES.md](RELEASES.md) whenever `--public` is not the production
origin. Nothing in this file describes production; it exists so a staging deploy can never be
mistaken for one. The columns are the same as the production log, and evidence per release lives
under `/opt/merv-typescript/releases/<id>/` on the staging VM.

The staging environment runs the merv-typescript stack beside the legacy Python brain on the dev
VM: its own database schema, its own data volume, its own compose project and its own
`/etc/merv/typescript.env`. Deploying here changes nothing on production.

| When (UTC)        | Release                                  | Image id       | Plugins active/total | Result | Checks                                                                                                             | Rollback                                                                |
| ----------------- | ---------------------------------------- | -------------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 2026-09-22T18:27Z | `20260922T182729Z-f8de3383-de642f070ed6` | `f8175d2b8f0b` | 53/53                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-Cu-pJu-i.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback ``                                                             |
| 2026-09-22T20:24Z | `20260922T202229Z-c2846759-77841261f83c` | `07355da621df` | 54/54                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-C-x2sFqy.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback `merv-typescript:20260922T182729Z-f8de3383-de642f070ed6`       |
| 2026-09-22T20:51Z | `20260922T205001Z-b0b1fa62-820589bddbf3` | `f8a4789d471b` | 51/51                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-BCtnbjEA.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback `merv-typescript:20260922T202229Z-c2846759-77841261f83c`       |
| 2026-09-23T02:16Z | `20260923T021429Z-1ce9f9cc-72daa99ac859` | `4ef52e40178f` | 50/50                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-DInaBOKC.js 200; /ui/assets/index-DOKmk6ae.css 200 | rollback `merv-typescript:20260922T205001Z-b0b1fa62-820589bddbf3`       |
| 2026-09-23T02:28Z | `20260923T022622Z-99c392f0-13937dc55496` | `dbc3c525b965` | 50/50                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CStmhJW_.js 200; /ui/assets/index-DOKmk6ae.css 200 | rollback `merv-typescript:20260923T021429Z-1ce9f9cc-72daa99ac859`       |
| 2026-09-23T08:29Z | `20260923T082657Z-2e1b7d45-20df33170035` | `b056f86ef695` | 50/50                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CuZKWTfW.js 200; /ui/assets/index-DOKmk6ae.css 200 | rollback `merv-typescript:20260923T074647Z-f90c8fbc-18a2e05270cc`       |
| 2026-09-23T09:12Z | `20260923T091030Z-193d9376-4aeea6a3c2c9` | `5d55c4174856` | 50/50                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CuZKWTfW.js 200; /ui/assets/index-DOKmk6ae.css 200 | rollback `merv-typescript:20260923T082657Z-2e1b7d45-20df33170035`       |
| 2026-09-26T07:35Z | `20260926T073309Z-964d5acb-bc17d8223c6a` | `3957b5b6a2f3` | 47/50 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CmIgAPeZ.js 200; /ui/assets/index-C9fxelnr.css 200 | rollback `merv-typescript:20260923T091030Z-193d9376-4aeea6a3c2c9`       |
| 2026-09-26T11:51Z | `20260926T114832Z-00d2ef63-31f669e6c9d4` | `3e36b95ab13a` | 47/50 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CmIgAPeZ.js 200; /ui/assets/index-C9fxelnr.css 200 | rollback `merv-typescript:20260926T073309Z-964d5acb-bc17d8223c6a`       |
| 2026-09-26T19:02Z | `20260926T185444Z-d3767b6a-0aae51feab2a` | `d21dc15061e2` | 51/54 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CmIgAPeZ.js 200; /ui/assets/index-C9fxelnr.css 200 | rollback `merv-typescript:20260926T114832Z-00d2ef63-31f669e6c9d4`       |
| 2026-09-26T20:25Z | `20260926T202248Z-d5c3ee46-3893b16e3121` | `efcc969d6f6b` | 51/54 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-CmIgAPeZ.js 200; /ui/assets/index-C9fxelnr.css 200 | rollback `merv-typescript:20260926T185444Z-d3767b6a-0aae51feab2a`       |
| 2026-09-28T08:07Z | `20260928T080410Z-ea6213dc-d32825744c74` | `948fc8be931b` | 49/52 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-DOQjBjDX.js 200; /ui/assets/index-C9fxelnr.css 200 | previous image `merv-typescript:20260926T202248Z-d5c3ee46-3893b16e3121` |
| 2026-09-28T10:07Z | `20260928T100508Z-9dd78c98-08e73d382ae7` | `bf33ce7d00bc` | 49/52 no fleet/pi    | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-DOQjBjDX.js 200; /ui/assets/index-C9fxelnr.css 200 | previous image `merv-typescript:20260928T080410Z-ea6213dc-d32825744c74` |
