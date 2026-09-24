# Hosted Pi/Codex image releases

One row per run of [`hosted-release.mjs`](hosted-release.mjs) that changed, or tried to change,
the hosted worker image. `release.mjs` runs it after every passing production release. Source is
the commit and the content hash of its allowlisted archive; both are also image labels
(`org.merv.hosted.source-commit`, `org.merv.hosted.source-sha256`). Image is the amd64 manifest
digest that Cloudflare and the Sandboxes catalog pin, and Release is the `rt1_` id Main uses. The
live pins and the bundle inputs that change detection watches are in
[`hosted-release.json`](hosted-release.json).

| UTC               | Run            | Source       | Lane   | Image          | Release        | App | Gates             | Canary                 | Result | Notes                                                                                                                                                       |
| ----------------- | -------------- | ------------ | ------ | -------------- | -------------- | --- | ----------------- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-24T17:17Z | `manual burst` | `c04b88db` — | worker | `1d823e64c1a8` | `ae4b27ada355` | v13 | pi, workflow pass | completed at 18:18:23Z | pass   | Hand-run chain; the pinned base of every later release. Its entrypoint, capture-entrypoint.py, is not in Git. v14 (20:07Z) set capacity 50 and removed SSH. |
