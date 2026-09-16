# Private staging refresh — 16 September 2026

Accepted at **2026-09-16 17:47 UTC**. This refresh changes the private TypeScript preview only. The public Python backend, Caddy and Vercel routing remain unchanged.

## Release

| Item | Value |
| --- | --- |
| Image | `merv-typescript:20260916T174429Z-be69497b-4ae73519db64` |
| Image ID | `sha256:da68b3bf57b97337a79662b68d5d3f742605174bfeabcca3b77aa87c7bc22e3a` |
| Source manifest content SHA-256 | `4ae73519db64820f9d2ec757d2dcbe5bf30c7e848235e2c3e208a9aa2b9d0220` |
| Source archive SHA-256 | `4886a73d70ed3c22679b0c59fbe0c24520043727232172246c1e3470ea3df56f` |
| Pinned Node base | `node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5` |
| VM release directory | `/opt/merv-typescript/releases/20260916T174429Z-be69497b-4ae73519db64` |
| Schema | `merv_ts_rehearsal_20260916v2` |
| Blob prefix | `merv-ts/merv_ts_rehearsal_20260916v2` |
| Import source ID | `python81v2-20260916T082545Z` |
| VM binding | `127.0.0.1:3081` |
| Existing local tunnel | `http://127.0.0.1:3481/ui` |

## Changes included

- Research now requires only State, Scope and Workflows. Paper, Reflections, Knowledge and Consolidation bind independently; missing providers block only operations that use them. Provider lifetime checks fence asynchronous calls and committed request replay remains independent of optional providers.
- The project chooser supports name/ID search, visible IDs and stable alphabetical ordering.
- Previous research navigation preserves list position and restores keyboard focus when returning from detail views.
- Dependency documentation reflects 56 package plugins and 144 edges: 138 required, six optional. The deployed history UI adds one optional migration adapter outside that base package inventory.

The original Fable readiness packet reviewed the preceding candidate. The optional Research design subsequently received Fable review, and its implementation received an independent source review; the one between-call provider replacement finding was fixed and tested. No claim is made that the earlier packet contained this later implementation. UI changes received local browser verification before this image was built.

## Verification

- Backend/UI typechecks and UI-then-backend production builds passed.
- Thirty focused Research, Reflections and optional-Code tests passed, including provider removal/replacement, preserved historical corpus handoff, no-code completion and v2/v3 replay with all optional providers absent.
- The final relevant test selection covered 118 unique tests. Three initially failed because the disposable local PostgreSQL cluster used the wrong socket port; after restoring its expected port, all nine tests in the two affected suites passed. This was a targeted regression gate, not another full-suite run.
- Docker build and compiled CLI passed with the original pinned Node base. An isolated, network-disabled compiled-module check confirmed Research's three mandatory dependencies.
- Refreshed container healthy; all 54 configured plugins active.
- Health, UI and both compiled JS/CSS assets returned 200. The served JavaScript contains the new project search UI.
- Anonymous project request returned 401; the approved HTTPS origin returned 200; an unapproved origin returned 403.
- Private environment file bytes, schema, source ID and blob prefix stayed unchanged. The imported data retained **30 projects, 43 memberships, 3,224 native artifacts, 200 claims and 54,314 archived research rows**. Before/after metadata checksums also matched for native artifacts, memberships and historical records including availability envelopes.
- Legacy backend image/start time and Caddy checksum stayed unchanged.

The parent browser check found the local SSH tunnel had exited. The same localhost-only tunnel was restored with keepalive, and local health returned 200. A fresh browser tab successfully loaded the refreshed sign-in UI. The original signed-in tab remained on the browser's connection-error page, which its automation policy would not let the agent leave; authenticated post-refresh acceptance is therefore not claimed. Earlier authenticated import acceptance, object-copy and provider-download acceptance remain recorded in [REHEARSAL_2026-09-16.md](REHEARSAL_2026-09-16.md). The new search/archive behaviors were verified locally using synthetic fixtures before this image was built. This refresh did not recopy objects, repeat import or create another smoke schema.

## Rollback and retained evidence

Previous image: `merv-typescript:20260916T084713Z-be69497b-80c96e74099a` (`sha256:e707c1e23633e36f7c46844bea23ec0cf00fc85ad660fe59e60c224d7ef87abd`).

Root-private backup: `/var/backups/merv/typescript-staging-refresh/20260916T174429Z-be69497b-4ae73519db64`, containing the prior private environment and image/Compose rollback metadata. Protected build and acceptance evidence remain inside the VM release directory, including `build-manifest.json`, `build.log` and `staging-refresh-acceptance.json`.

This note contains only aggregate results and release hashes returned by the accepted tooling. Raw private reports, credentials, identities, research records and signed URLs were not copied into it.

The preview still uses the rehearsal snapshot. Public cutover still needs a separate writer pause, fresh final export/import/reconciliation and the remaining product decisions; this image refresh does not perform or authorize that cutover.
