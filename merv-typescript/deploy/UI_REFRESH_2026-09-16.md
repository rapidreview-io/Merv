# Private UI refresh — 16 September 2026

Accepted at **2026-09-16 18:37:38 UTC**. Only the private TypeScript preview was refreshed. The public Python service, Caddy/Vercel routing, authentication configuration and imported storage were unchanged.

## Release and rollback

| Item | Value |
| --- | --- |
| Preview | `http://127.0.0.1:3481/ui/` through the existing localhost-only SSH tunnel |
| VM binding | `127.0.0.1:3081` |
| Image | `merv-typescript:20260916T183554Z-be69497b-f125cc2c1eea` |
| Image ID | `sha256:f38bceb200865dc9cead86a7dcfac1897788f3f9fbc6078020eef9b0d13e7a50` |
| Source manifest SHA-256 | `f125cc2c1eea8b7e9986ff4c980cf402a9b0e6cd7a53063b5c3a908ec8a553c3` |
| Source archive SHA-256 | `ad35affafd9fb9e1f0ac3fe0be4bb70a2ef601efaea14ae8f9cb0c3f23d1ce23` |
| Pinned Node base | `node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` |
| VM release directory | `/opt/merv-typescript/releases/20260916T183554Z-be69497b-f125cc2c1eea` |
| Rollback backup | `/var/backups/merv/typescript-staging-refresh/20260916T183554Z-be69497b-f125cc2c1eea` |
| Previous image | `merv-typescript:20260916T174429Z-be69497b-4ae73519db64` |
| Previous image ID | `sha256:da68b3bf57b97337a79662b68d5d3f742605174bfeabcca3b77aa87c7bc22e3a` |

The protected release directory retains `build-manifest.json`, `build.log`, `staging-refresh.log` and `staging-refresh-acceptance.json`. The root-private rollback directory retains the previous environment file and image/Compose metadata. This note was written after packaging and is not part of the release fingerprint.

## Scope and verification

- Fable's UI foundation adds the project Overview, navigation organized by user jobs, new presentation styles and mobile navigation. Local integration adds bounded list filtering and makes agent assignments/activity primary, with operational controls separate.
- The release contains 460 allowlisted files. Every production service, configuration and dependency file outside `packages/ui/web/` matched the previous accepted manifest exactly. Other additions are the synthetic UI fixture, navigation test and deployment documentation.
- UI/backend typechecks passed. Local UI/backend builds passed; the immutable Linux image independently built the UI and backend and passed the compiled CLI check.
- Parent browser verification before release covered Overview, task search/no-match/detail, agent live filtering/activity/Operations/mobile drawer/Escape, mobile navigation focus containment, and archive page/detail Back/Forward state restoration. These checks used the synthetic local fixture.
- The deployed container is healthy and all **54 configured plugins** are active. Compiled UI markers and Research's existing three mandatory dependencies were verified.
- `/health` and `/ui/` returned 200. Anonymous `/projects` returned 401. The approved HTTPS Origin returned 200; an unapproved Origin returned 403.
- The private environment stayed byte-identical and root-owned mode 0600. Compose, schema `merv_ts_rehearsal_20260916v2`, prefix `merv-ts/merv_ts_rehearsal_20260916v2` and import source `python81v2-20260916T082545Z` were preserved.
- Before/after counts remain **30 projects, 43 memberships, 3,224 native artifacts, 200 claims and 54,314 archived research rows**. Artifact, membership and archived-record/availability metadata checksums match.
- The legacy container's image/start time and the Caddyfile checksum stayed unchanged. No public cutover, import, storage copy or synthetic production smoke work was performed.

## Delivered assets

Both assets returned 200 directly on the VM and through the existing local tunnel, with matching hashes:

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `/ui/assets/index-BaDevE5R.js` | 549,370 | `4f36e15d10e1343c75c621fada3603c18ef888419fa34c0202d1dbe273d0b725` |
| `/ui/assets/index-Bchm1hIc.css` | 22,173 | `c7d65caa7dd1e481ba1d5e3862707207cb59da43287ab4119567a477dd8f7b95` |

Authenticated post-refresh browser acceptance is being handled separately by the parent task; this deployment check does not claim it. Previous import, membership and remote-byte acceptance remain documented in the earlier staging/rehearsal notes. Public cutover still requires its separate writer-pause, fresh final snapshot/import and authorization gates.

Only release identifiers, hashes and safe aggregates are recorded here. No credentials, signed URLs, private user identities or research contents were transferred into this note.

Parent browser verification: reloaded the deployed UI through port 3481 and confirmed the new sign-in copy, shared-account email/password and Google controls, and bearer-credential disclosure. No real credential was entered during this refresh. Authenticated interaction checks for this UI wave used the separate synthetic local fixture; signed-in acceptance against imported production projects is not claimed.


## Second UI pass — 19:08 UTC

After the user's real-account login confirmation and UI feedback, Fable reviewed the navigation and imported-research experience again. The next immutable release is `20260916T190552Z-be69497b-3a026ebca252`, image ID `sha256:3235cf85425ff0311e58b51d856d76fb66ff80ce136e1fc75d74259e7ca07042`.

- Previous research moves into the Research navigation group and gets a prominent library entry on Overview. Empty native-work sections become compact when imported research exists.
- Operations and Activity navigation groups collapse; internal project IDs are removed from the sidebar heading.
- Historical experiments, tasks, reflections, claims, literature, papers and posts get category controls and readable detail sections. Technical JSON and provenance are collapsed by default. Detail titles come from actual record content.
- Typography, spacing, file labels and responsive reader layout were adjusted. The synthetic browser fixture confirms category navigation, readable experiment details, collapsed original JSON, and preserved Back/Forward/close behavior. Temporary mobile viewport testing was reset afterward.
- UI typecheck/build and 44 focused navigation, identity, UI, history and boundary checks passed. The VM refresh verified all non-UI production files unchanged, all 54 plugins active, all compiled assets served, and the imported data/configuration unchanged.
- User reported successful Supabase login and project visibility at the private preview. The agent did not enter the user's credentials. This does not claim a later production HTTPS browser login.

The VM retains `staging-refresh-acceptance.json` under `/opt/merv-typescript/releases/20260916T190552Z-be69497b-3a026ebca252/`. Compiled JS: `/ui/assets/index-ehyZzkjU.js`, SHA-256 `43eed7b65643818f78c85a488a223ddb27dbf8302d9c274be03a49449f03ea17`; CSS: `/ui/assets/index-LoFAxWkj.css`, SHA-256 `c9f1980f292ebd62b68dad4b2ddbf5a3f98c40c972a3ba249ef1cb8674a7cb44`.

See [Fable's second UI review](../docs/reviews/ui-second-pass-fable-20260916.md). Public deployment is recorded separately in the cutover execution record.
