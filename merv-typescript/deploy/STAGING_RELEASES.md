# Staging releases

Rows written by `node deploy/release.mjs --host <staging alias> --public <staging origin>`, which
appends here instead of [RELEASES.md](RELEASES.md) whenever `--public` is not the production
origin. Nothing in this file describes production; it exists so a staging deploy can never be
mistaken for one. The columns are the same as the production log, and evidence per release lives
under `/opt/merv-typescript/releases/<id>/` on the staging VM.

The staging environment runs the merv-typescript stack beside the legacy Python brain on the dev
VM: its own database schema, its own data volume, its own compose project and its own
`/etc/merv/typescript.env`. Deploying here changes nothing on production.

| When (UTC) | Release | Image id | Plugins active/total | Result | Checks | Rollback |
| ---------- | ------- | -------- | -------------------- | ------ | ------ | -------- |
