# Imported private staging — September 16, 2026

The imported TypeScript service is running privately on `127.0.0.1:3081`; the existing SSH tunnel exposes it locally at `http://127.0.0.1:3481/ui/`. This is a **rehearsal snapshot**, not the final public migration. Legacy Python, Caddy, Vercel and the sandbox services remain unchanged. This note contains only aggregate results already returned by accepted verification commands; raw protected acceptance files have not been copied to the workstation.

## Accepted candidate

This section records the original imported candidate. Its data was preserved in the later [private staging refresh](STAGING_REFRESH_2026-09-16.md), which records the currently running image.

- Image: `merv-typescript:20260916T084713Z-be69497b-80c96e74099a`
- Image ID: `sha256:e707c1e23633e36f7c46844bea23ec0cf00fc85ad660fe59e60c224d7ef87abd`
- Source content SHA-256: `80c96e74099a28858693b69597ce9b697d0a87591550f322252c840ddc4f4eb1`
- Source archive SHA-256: `c9bf3970fd29514a503b09e4e6bc9c6ddbdd7b4baaf858be20f070d7a4bccf1b`
- Source snapshot: `python81v2-20260916T082545Z`, projection version 2, captured in one read-only repeatable-read transaction.
- Snapshot SHA-256: `9cc1a052004bf8ed3340610bb354aba9acac6264d2a0c137865a281a6afcfaae`
- Target schema: `merv_ts_rehearsal_20260916v2`; object prefix: `merv-ts/merv_ts_rehearsal_20260916v2`.

Backend/UI typechecks and production builds passed. The final native suite passed **780 tests**, with no failures and one optional Nisa integration skipped; all **9 deployment tests** passed. The immutable Linux image built and its compiled CLI ran successfully on the VM.

## Preserved data and verified files

| Result | Count |
| --- | ---: |
| Native projects | 30 |
| Existing shared-account memberships | 43 |
| Native claims | 200 |
| Native readable artifacts | 3,224 |
| Original readable artifact records | 2,938 |
| Figure/feed-derived native file bindings | 286 |
| Exact retained objects verified and copied | 2,961 |
| Immutable archived history records | 54,314 |
| Original artifact records retained in history | 4,489 |
| Explicit metadata-only historical artifact records | 1,551 |

Every copied object passed source and destination streaming SHA-256 and size verification. Native rows and hashes, all historical rows and canonical hashes, every artifact availability envelope, and the retained receipt fingerprints reconciled exactly. Reconciliation report SHA-256: `7edd3a2b85b38fef761053336bd2ac8f48d4bc218ccb2c3d13ddc510dae01295`.

The metadata-only records correspond to 1,228 exact project/hash keys already documented in the September 9 migration audit, across 13 projects. The complete ID/project/hash/size tuple set matched that audit with **zero newly missing keys or rows**. None represented an artifact-submitted/pinned event, submission attachment, or figure parent. They remain visible as historical references with an explicit unavailable-bytes label; no bytes were fabricated and no record was dropped. Any other missing object fails the import.

History details fit the existing UI bound: the largest archived record is **710,212 bytes** and **none exceed 4 MiB**.

## Actual provider and runtime acceptance

Signed R2 downloads passed for an ordinary 3,369-byte file (HTTP 200 and full hash) and a 65,536-byte bounded range of the largest retained 4,877,283-byte figure (HTTP 206; its full object hash had already been verified during import). Both honored forced attachment, `private, no-store`, and `application/octet-stream`. There is **no empty file among the verified imported files**; this category was explicitly reported absent rather than reconstructed or claimed tested.

A separate same-image synthetic acceptance used only `merv_ts_smoke_20260916_01` and `merv-ts/merv_ts_smoke_20260916_01`. All 53 default plugins activated. It exercised actual PostgreSQL/R2 and MCP calls, a completed task and independent review, idempotent verdict replay, one agent across two assignments, five observed tool calls with numeric payload token estimates, research advancing into a five-lens reflection, signed download, compiled UI assets, and application restart persistence. The isolated synthetic records/objects remain available as evidence; no dispatch or external mounts ran.

The imported private server has **54 active plugins**, including the historical reader. Health/UI/JS/CSS return 200, anonymous projects return 401, the expected HTTPS Origin is accepted and an unrelated Origin returns 403. Parent-agent browser verification through the existing signed-in account shows **29 authorized projects out of 30 global projects**, preserved memberships and working native claim navigation. The same authenticated browser also opened a historical experiment detail, a metadata-only lineage record with no false download link, and a verified native artifact detail with its download control. Original artifact media types remain preserved; an old octet-stream plan is offered as a file rather than reinterpreted as text. Provider download bytes were verified separately without logging signed URLs.

## Rollback and remaining gates

The prior private staging environment/image are preserved at `/var/backups/merv/typescript-staging-switch/20260916T084713Z-be69497b-80c96e74099a`. The original `merv_ts` staging schema remains unchanged with zero projects. Protected source exports, source audit, prepared manifests and import receipts remain on the VM under `/var/lib/merv-legacy-exports/python81v2-20260916T082545Z`; these contain private research records and must not be included in review packets.

The snapshot contains 78 nonterminal historical workflow instances: 34 experiments, 30 project-synthesis instances (23 waiting, seven writing), four reflections, five research waves and five review requests. These are historical records, not resumed native work.

The [final critical review](../docs/reviews/production-readiness-fable-final-v2-20260916.md) subsequently completed, with conditional approval of the reviewed excerpts. Public deployment still requires the agreed handling of old work, a controlled legacy-writer pause, and a **fresh** final export/import/reconciliation into a new final schema/prefix. See `README.md` for that sequence and `UI_CUTOVER_PLAN.md` for narrow public UI routing. No public cutover or legacy writer pause has occurred.
