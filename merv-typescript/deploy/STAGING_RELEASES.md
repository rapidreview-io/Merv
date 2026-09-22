# Staging releases

Rows written by `node deploy/release.mjs --host <staging alias> --public <staging origin>`, which
appends here instead of [RELEASES.md](RELEASES.md) whenever `--public` is not the production
origin. Nothing in this file describes production; it exists so a staging deploy can never be
mistaken for one. The columns are the same as the production log, and evidence per release lives
under `/opt/merv-typescript/releases/<id>/` on the staging VM.

The staging environment runs the merv-typescript stack beside the legacy Python brain on the dev
VM: its own database schema, its own data volume, its own compose project and its own
`/etc/merv/typescript.env`. Deploying here changes nothing on production.

| When (UTC)        | Release                                  | Image id       | Plugins active/total | Result | Checks                                                                                                             | Rollback                                                          |
| ----------------- | ---------------------------------------- | -------------- | -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 2026-09-22T18:27Z | `20260922T182729Z-f8de3383-de642f070ed6` | `f8175d2b8f0b` | 53/53                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-Cu-pJu-i.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback ``                                                       |
| 2026-09-22T20:24Z | `20260922T202229Z-c2846759-77841261f83c` | `07355da621df` | 54/54                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-C-x2sFqy.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback `merv-typescript:20260922T182729Z-f8de3383-de642f070ed6` |
| 2026-09-22T20:51Z | `20260922T205001Z-b0b1fa62-820589bddbf3` | `f8a4789d471b` | 51/51                | pass   | vm 200/200/401/200/403, public 200/200, assets /ui/assets/index-BCtnbjEA.js 200; /ui/assets/index-DZBFiweU.css 200 | rollback `merv-typescript:20260922T202229Z-c2846759-77841261f83c` |
