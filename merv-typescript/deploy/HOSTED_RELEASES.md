# Hosted Pi/Codex image releases

One row per run of [`hosted-release.mjs`](hosted-release.mjs) that changed, or tried to change,
the hosted worker image. `release.mjs` runs it after every passing production release. Source is
the commit and the content hash of its allowlisted archive; both are also image labels
(`org.merv.hosted.source-commit`, `org.merv.hosted.source-sha256`), beside
`org.merv.hosted.sandboxes-commit`. Image is the amd64 manifest digest that Cloudflare and the
Sandboxes catalog pin, and Release is Standard's `rt1_` id; App is each live app's version,
Standard's first. The host keeps the live pins;
[`hosted-release.json`](hosted-release.json) seeds them and records the latest release. A stuck
run closed with `--abandon` is `abandoned`: production agreed on the release in its row, which the
host keeps as the live pins (see [`PI_OPERATIONS.md`](PI_OPERATIONS.md)). The run's own release is
canaried first; if that fails, the row is `ABANDONED, CANARY FAILED` and the pins are marked
unverified, so each later run rebuilds and canaries them (`rechecked`) until a canary passes or a new
release replaces them. Each run commits this file and `hosted-release.json` by path, with a
`[skip ci]` message, and pushes them when its checkout is at origin/main's tip; otherwise it
leaves them for you to commit.

| UTC               | Run                         | Source                    | Lane     | Image          | Release        | App    | Gates             | Canary                 | Result | Notes                                                                                                                                                       |
| ----------------- | --------------------------- | ------------------------- | -------- | -------------- | -------------- | ------ | ----------------- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-24T17:17Z | `manual burst`              | `c04b88db` —              | worker   | `1d823e64c1a8` | `ae4b27ada355` | v13    | pi, workflow pass | completed at 18:18:23Z | pass   | Hand-run chain; the pinned base of every later release. Its entrypoint, capture-entrypoint.py, is not in Git. v14 (20:07Z) set capacity 50 and removed SSH. |
| 2026-09-25T02:00Z | `20260925T020027Z-16164daf` | `16164daf` `9ec164ae5a72` | boundary | `3ca9ef18a5fe` | `4166a6347f29` | v15    | 3 pass            | completed in 16s       | pass   | Sandboxes 9b80856d                                                                                                                                          |
| 2026-09-25T05:40Z | `20260925T054007Z-61be53a3` | `61be53a3` `4ccc861bbc89` | boundary | `16ce377cfabf` | `44ed11a9f6c4` | v16 v2 | 3 pass            | completed in 31s       | pass   | Sandboxes 9b80856d                                                                                                                                          |
| 2026-09-25T07:42Z | `20260925T074230Z-2587e44e` | `2587e44e` `86220b17dcbf` | worker   | `9df06a5300d8` | `af81b24d303b` | v17 v3 | 1 pass            | completed in 25s       | pass   | Sandboxes 9b80856d                                                                                                                                          |
| 2026-09-25T08:05Z | `20260925T080506Z-e252df19` | `e252df19` `e4366a3a0bde` | boundary | `398532a46097` | `4dee03e1f7af` | v18 v4 | 3 pass            | completed in 22s       | pass   | Sandboxes 9b80856d                                                                                                                                          |
