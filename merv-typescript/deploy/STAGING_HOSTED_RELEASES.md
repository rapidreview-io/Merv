# Staging hosted cutover releases

Written only by `hosted-release.mjs --staging-cutover`. Source/content columns identify
this run's **pipeline archive**, not a rebuilt runner. Notes and
`staging-hosted-release.json` retain the accepted production run and runner source commit.
The immutable image digest and both staging release IDs come from that accepted production
release. Main deployments remain in `STAGING_RELEASES.md`; production ledgers are untouched.

| When (UTC) | Run | Source | Lane | Image | Release | App | Gates | Canary | Result | Notes |
| ---------- | --- | ------ | ---- | ----- | ------- | --- | ----- | ------ | ------ | ----- |
