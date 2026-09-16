# Temporary legacy UI cutover — reviewed September 16, 2026

**Historical planning baseline.** Routing-only releases were built without alias promotion on September 16; their preview checks passed. The explicit `/merv/` rule was added after the direct legacy preview returned 404 for that path. See the separate cutover execution record for final deployment status. The rest of this document records the original plan and its gates. Redirect the known browser routes on both legacy entry points to `https://experiments.rapidreview.io/ui/`. Preserve the websites and non-UI downloads. Public routing waits for shared-user login, the requested Fable review, historical import/media acceptance, and disposition of active legacy workflows.

The prepared [redirect fragment](rapidreview-redirect.fragment.json) now uses the five narrow rules below. The previous blanket `/merv/:path*` rule also captured the existing runner installer and skill catalog; it was removed before deployment. This plan supersedes the older blanket-routing instructions in [README.md](README.md).

## Verified source and routing order

| Surface | Verified source | Existing behavior |
| --- | --- | --- |
| `rapidreview.io` | `/Users/guraltoo/Documents/dev/proj/experiments/RR_Site/vercel.json:3` | Four `/docs/maps` and `/map` redirects; retain all four. |
| `rapidreview.io/merv` | Same file, lines 35–40 | External rewrites to `https://research-suite-chi.vercel.app/merv` and its descendants. |
| Other main-site routes | Same file, lines 25–61 | `/docs`, `/nisa`, sitemap rewrites, then `/(.*)` → `/index.html`; retain their exact order. `trailingSlash:false` remains unchanged. |
| Direct legacy UI | `/Users/guraltoo/Documents/dev/proj/experiments/Merv/research_state_ui/vercel.json:6` | Specific skill and runner rewrites first, then static-file extensions, then the `/merv/:path*` SPA fallback. Preserve all four rewrites and the download headers. |
| Direct legacy aliases | Same file, lines 27–29 | `/` → `/merv`; `/p/:path*` → `/merv/p/:path*`. Preserve these aliases; they will then reach the new redirect. |
| Actual UI pages | `research_state_ui/src/main.jsx:12`, `src/App.jsx:235` | Router base `/merv`; valid page families are `/`, `/projects`, `/projects/new`, and `/p/:projectId/...`. |
| Non-UI consumers | `research_state_ui/src/components/AutorunPairing.jsx:6`; `merv/clients/kilo/plugin.js:4` | Published installer uses `/merv/runner/install.sh`; the Kilo client uses `/merv/.well-known/skills/`. |

Vercel evaluates deployment redirects before filesystem routes and rewrites. Therefore a redirect in either file wins over its existing SPA/proxy rewrite; moving a download rewrite above a blanket redirect would **not** exempt the download. Project/dashboard routing rules run earlier still, so inspect those before publishing. [Vercel routing order](https://vercel.com/docs/routing#routing-order).

Local provenance: RR_Site revision `2d376f3459e860fb8c8f5cf5bc19abaab46a7ac9`, clean worktree when inspected. Its `vercel.json` SHA-256 is `e303867e6426a2c711b8127ccb609fc129dcd1335cf971cd05b516ce9cc15ff5`; the legacy UI file is `c69615dbe154bddb932e615d1076205bb6d9f0f19fd60a752a753b3d267c0922`. The authenticated discovery below subsequently confirmed both deployed Git revisions; `git show` of each deployed revision produces exactly these local configuration bytes.

## Authenticated deployment provenance — 2026-09-16 08:50 UTC

Existing access is available. The already-cached official Vercel CLI **59.15.1** completed a noninteractive `whoami` and refreshed its existing session; no new login, account, credential enrollment or permission grant was needed. Authenticated REST GETs confirm team **`guraltoos-projects`**, ID **`team_e6ia3A72yL6mFl161Uh2LBdl`**, and confirmed **OWNER** membership. No secrets or environment values were printed or retained in the evidence reports.

| Production entry point | Project and root | Current rollback deployment | Deployed Git source |
| --- | --- | --- | --- |
| `rapidreview.io` | `rr-site`; `prj_8ogsVpqvfBbrRXkBxM0397CxORQQ`; repository root | `dpl_3a7H7GTTvweXJdtydrT5W5s2wcbn`; `rr-site-f1l430vz3-guraltoos-projects.vercel.app` | `rapidreview-io/RR_Site`, `main`, `2d376f3459e860fb8c8f5cf5bc19abaab46a7ac9` |
| `research-suite-chi.vercel.app` | `research-suite`; `prj_nOw8GmL5Mpt7mqERgY6uIbo4du9T`; `research_state_ui` | `dpl_HXBM7C2DWX6Qbi56JJTDsJy96J9m`; `research-suite-nzhwgrund-guraltoos-projects.vercel.app` | `rapidreview-io/Merv`, `main`, `63f941018ffdef6f11bfea93d22621e7769ddd8d` |

Both aliases point to **READY production** deployments in that team; neither alias has a domain redirect. Deployment creation times are August 18 at 02:41:30 UTC and September 12 at 22:23:09 UTC, respectively. Both projects select Vite and Node **24.x**. The legacy UI's deployed configuration selects `dist` and `npm run build`; that build also reads sibling `merv/scripts/build_runner_bundle.py` and `merv/clients/kilo/build_catalog.py`, so preserve the monorepo layout when preparing its routing-only release. The two project-level routing-rule queries returned zero routes. Recheck alias deployment IDs immediately before cutover; this is a point-in-time baseline.

Sanitized local evidence: `/private/tmp/merv-vercel-readonly-provenance.json` and `/private/tmp/merv-vercel-routing-provenance.json`. The reads used the documented [alias](https://vercel.com/docs/rest-api/aliases/get-an-alias), [deployment](https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url), [project](https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name), [routing-rule](https://vercel.com/docs/rest-api/project-routes/get-project-routing-rules), and [team](https://vercel.com/docs/rest-api/teams/get-a-team) GET endpoints. The Vercel connector is unavailable and browser inventory was empty; the existing official CLI/session is the verified access path.

## Proposed patch

Append these five objects to **each existing `redirects` array**, preserving its current entries and every other configuration field:

```json
[
  { "source": "/merv", "destination": "https://experiments.rapidreview.io/ui/", "permanent": false },
  { "source": "/merv/", "destination": "https://experiments.rapidreview.io/ui/", "permanent": false },
  { "source": "/merv/projects", "destination": "https://experiments.rapidreview.io/ui/", "permanent": false },
  { "source": "/merv/projects/:path*", "destination": "https://experiments.rapidreview.io/ui/", "permanent": false },
  { "source": "/merv/p/:path*", "destination": "https://experiments.rapidreview.io/ui/", "permanent": false }
]
```

This is an additive fragment, not a complete `vercel.json`. Temporary redirects support reversible cutover; validate the resulting response status and Location on preview before production. [Vercel configuration redirects](https://vercel.com/docs/routing/redirects/configuration-redirects).

Known legacy deep links intentionally land at the new project selector: native workflow detail URLs are not compatible with historical records. The archive preserves source IDs; it does not turn those records into active native workflows. Existing static assets, unknown paths, installer/catalog paths and backend APIs retain their previous rules. This redirects normal entry/navigation; it does not terminate already-open browser sessions or make cached old code unusable.

## Destination prerequisite and remaining blockers

- **Destination must work before either Vercel change.** The new UI loads `/auth/config` and root-level `/tools/...` on the same origin (`packages/ui/web/auth.ts:60`, `api.ts:184`), plus account/project and artifact routes. Forwarding only `/ui/*` is insufficient. [Caddyfile.cutover.snippet](Caddyfile.cutover.snippet) switches the entire Merv origin from Python on `127.0.0.1:8787` to TypeScript on `127.0.0.1:3081`; that is a separate backend cutover. Preserve unrelated Caddy hosts and keep Python available for rollback. A selective API split requires its own complete endpoint review; this plan does not imply one is ready.
- **Deployment access is resolved; local linkage still needs care.** `vercel` is not on PATH, but official CLI 59.15.1 is cached at `/Users/guraltoo/.npm/_npx/67eb4586ca667318/node_modules/vercel/dist/vc.js`. RR_Site has its expected project link; the legacy UI checkout has none. Use the verified project/team IDs above in an isolated checkout from the exact deployed commit. Do not infer or create a replacement project. No write/deploy operation was used to test access.
- **Login and account continuity:** complete real shared-account HTTPS login, imported project membership/history and authorized file-download acceptance; verify the Supabase OAuth redirect allowlist if Google login is used. A shared user ID does not transfer a browser session across origins. Do not forward stored credentials or assume an old OAuth callback completes in the new origin.
- **Work continuity and review:** final Fable review and active-work disposition remain pending. The parent deployment audit reports 510 legacy agent sessions released/expired and none live; active workflow records remain. Absence of a live session does not prove old clients cannot write. Preserving installer/catalog URLs does not make their old protocol, credentials or runner contracts compatible with the TypeScript backend.

## Execution and acceptance after gates pass

1. Recheck both deployed project configurations and any dashboard redirects; save current deployment IDs, source/config checksums and the current Caddyfile. Prepare isolated routing-only changes from those exact deployed sources, so publishing a redirect does not ship unrelated checkout changes.
2. Make the reviewed TypeScript destination and its APIs available; finish real HTTPS login/history/download acceptance before redirecting legacy users. Record which target schema and object prefix contain the accepted imported data.
3. Preview the redirect patch for each project. Compare the matrix below to a baseline, including response content type for installer/catalog files. Only then publish the direct legacy project and RR_Site routing changes, one at a time, verifying after each.
4. Retain previous deployments, Python container/configuration/database and old objects during the rollback window. The existing runbook requires legacy retention through at least **2026-10-10**.

| Requests to verify | Required result |
| --- | --- |
| Both hosts: `/merv`, `/merv/`, `/merv/projects`, `/merv/projects/new`, `/merv/p/<known-id>/experiments` | Reach new `/ui/` without loop; old deep link is not claimed to select a native workflow. Verify trailing-slash handling on preview. |
| Both hosts: `/merv/runner/install.sh`, an existing `/merv/.well-known/skills/...` file | Same legacy download and content type; never new-UI HTML. Fetch as bytes for verification, never execute the installer. |
| Direct host: `/`, `/p/<known-id>` | Existing alias followed by temporary new-UI redirect. |
| Main site: `/`, `/nisa`, a `/nisa/...` route, `/docs`, a `/docs/...` route, `/map`, `/sitemap.xml` | Existing application/rewrite/redirect behavior unchanged. |
| New origin: `/ui/`, compiled JS/CSS, login, project selector, historical detail and authorized download | Work as the accepted shared user; unauthorized and wrong-project access rejected. |

## Rollback

1. Confirm Python still answers on its retained upstream, then restore only the saved `experiments.rapidreview.io` Caddy routing; validate the full configuration before reload. Preserve unrelated hosts. Coordinate this with the following redirect reverts so users are not left at an unavailable `/ui/` destination.
2. Remove only these five added redirects from **both** Vercel projects, or restore their recorded pre-cutover deployments when no intervening unrelated deployment would be lost. Verify both legacy UI entry points, installer/catalog files, `/nisa`, `/docs` and the main homepage.
3. Preserve new PostgreSQL schemas, roles, object prefixes, receipts and TypeScript writes. A route rollback must not restore an older database over new writes. TypeScript writes will not automatically appear in Python; reconcile separately if needed. Stop only the new Compose service if necessary after traffic is restored.

Review performed with local source inspection, official documentation and authenticated read-only Vercel metadata queries. The existing CLI session was routinely refreshed. No project linkage, route, deployment, permission, active service or source outside this repository was changed; no new login or external message was performed.
