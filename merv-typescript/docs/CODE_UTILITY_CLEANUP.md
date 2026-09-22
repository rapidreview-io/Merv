# Code as an optional utility

Status: implementation complete and verified on staging, 2026-09-22.

Code supplies durable Git operations for parallel research. It never decides research
logic. Research owners choose dependencies, accepted results, review requirements,
resolution work and publication obligations. An optional research integration translates
those decisions into Code operations.

## Required boundaries

- Code has no Workflows or Reviews dependency, including private table reads, workflow
  names/versions, research event subscriptions or policy hidden behind proxy interfaces.
- Code retains repository integrity, exact revisions, writer fencing, transport and
  technical operation receipts. Its research integration owns workflow blockers,
  dependency traversal, review provenance and integration/publication decisions.
- A full research cycle can finish with Code absent. Explicit Git obligations remain
  durable and block safely while Code is unavailable; absence never means approval.
- GitHub remains optional for Git work. Scratch execution requires no Git repository.
- Review acceptance and its exact code evidence remain transactionally consistent.
- Existing retained records and frozen workflow versions remain supported.

## Product behavior

A researcher connects a repository, selects any valid branch as the project base, and prepares
its history with one action. GitHub's default branch is only a suggestion. Preparation freezes
the selected branch and commit across retries, refuses a changed repository connection, and
reports ready only when the exact commit is stored. Existing pinned work keeps its original
base. The UI shows the selected branch, import progress and recovery, and linked changes.

## Configuration migration

- Keep `code` at `@merv/code` with repository root/quota/free-space settings.
- Move writer grace to core `finalizeGraceSeconds` (default 900 seconds).
- Add `code-research` at `@merv/code-research`. Its `repositories` settings own sweep/drain,
  automatic bases, mirror cadence and backup configuration.
- Point `code-tools`, `code-api` and `code-ui` to `@merv/code-research/{tools,api,ui}`.
- Research consumers bind optional `codeResearch`; standalone utilities bind `code`.
- Use `config/no-code.example.json` and runner `workspaceDrivers: []` for no-Git execution.

The actual staging configuration used only core `repositories.root`, so it has no operational
settings to relocate. The deployment renderer explicitly requires the integration in the full
Git-enabled staging profile; the ordinary default keeps it optional.

## Implementation sequence

1. Separate policy from durable Code data and Git operations; make optional integration
   an explicit composition entry rather than a dependency of the utility.
2. Fix research completion without Git and remove obsolete stage dependencies.
3. Narrow workspace command contracts and load machine drivers only where needed.
4. Simplify duplicate/dead integration paths, remove cross-owner database reads, update
   configuration and documentation. Measure total source reduction, including moved code.
5. Run relevant tests, full source/build checks and staging acceptance, including a full
   no-Code cycle and safe suspension/resumption of Git work.

## Staging

The verified staging host is `azureuser@dev-experiments.rapidreview.io` (`rp-control-dev`),
public origin `https://rp-control-dev.eastus2.cloudapp.azure.com`, database schema
`merv_ts_staging`. The DNS connection alias and configured browser origin differ.
The release script defaults to production: both staging arguments must be explicit.
It ships committed HEAD and does not back up the database. Any schema migration requires
a separate staging backup before deployment. Historical September 16 staging instructions
describe the host subsequently promoted to production.

## Completion evidence

Final application source: `a33fd854`, based on `32a0920f`. Commit `c2846759` updates
the release acceptance expectation for the current reflection-approval gate.

- Full local suite: 1,839 tests; 1,628 passed, 211 PostgreSQL-only cases skipped,
  zero failures. Server/UI typechecks, builds and deployment-renderer checks passed.
- Final Linux Git lifecycle and repository preparation gates: 25/25 passed as an
  ordinary user. Git cancellation now terminates descendants that retain output pipes.
- Independent dependency audit found no remaining Workflows/Reviews/research imports
  in core Code. Runtime core dependencies are State and Scope; the research adapter
  owns workflow integration and optionally binds Reviews and Sandboxes.
- A full no-Code research cycle, scratch execution without Git, durable obligations
  through provider outages, exact review evidence, selected-branch replay/recovery,
  generic-owner isolation and unload/recovery are covered by the regression suite.
- Core imports and rebinds without research tables. Technical base schema remains
  core-owned, and previously published migration SQL remains byte-for-byte unchanged.

Compiled-runtime acceptance passed on staging PostgreSQL and object storage: all 53
plugins active, authenticated task/review flow, idempotent verdict replay, signed private
download, five-lens reflection creation, compiled UI assets and restart persistence.
Synthetic dispatch remained disabled. Evidence is retained under
`/opt/merv-typescript/verification/20260922T195512Z-a33fd854/runtime-acceptance-c2846759.json`.

The broad staging regression run reached its 20-minute limit after 401 passing tests
and no failures, before its final files completed. A focused PostgreSQL continuation
passed all 41 tests with zero skips or failures, covering the remaining consolidation,
research, optionality and migration cases. It includes all 15 optional-research
PostgreSQL cases and a complete cycle with Code never loaded. The continuation used
the final application source and the Git-equipped image as an ordinary user.

The schema and repository backup is verified at
`/var/backups/merv/code-utility/20260922T202101Z`. It includes the database dump, repository
data, private environment, container metadata and unchanged Caddy configuration, with
checked hashes and a readable restore list. Staging restarted healthy after the backup.

## Size and simplification

Physical source lines at the final candidate (package `src/**/*.ts`, including both
sides of moved code): Code plus its adapter 19,234 → 19,489 (+255); all packages
67,251 → 67,613 (+362). These counts exclude UI TSX, tests and configuration.
The user accepted modest net growth for optionality and repository setup on 2026-09-22.

The shared operation journal removes 93 lines and PostgreSQL guard composition removes
95 more, without changing published migration strings. Other duplication was removed
from GitHub requests, filesystem helpers, base traversal and tool registration. New
optionality, lifecycle and repository setup behavior outweigh the removed duplication.
Preserving recovery and historical workflows takes priority over further cosmetic cuts.

## Staging release before legacy plugin retirement

Release `20260922T202229Z-c2846759-77841261f83c` is healthy at
<https://rp-control-dev.eastus2.cloudapp.azure.com/ui/>. Its image is
`sha256:07355da621dfa0058652631fae04da81f8397d47256b13eee8f8123771922857`.
All 54 configured plugins are active: the 53 default plugins plus the existing legacy
history UI. Core Code and the optional research adapter load separately.

Health, UI and its JavaScript/CSS assets return 200; anonymous protected access returns
401; the approved origin returns 200 and an unapproved origin returns 403. The container
has zero restarts. The existing schema, browser origin and Caddy configuration were
preserved. The prior image and checked database/data backup are available for rollback.
Release evidence is retained under
`/opt/merv-typescript/releases/20260922T202229Z-c2846759-77841261f83c/`, including source/build
manifests, acceptance results and `code-cleanup-final-verification.json`.

The initial cleanup passed these staging gates; the later retirement and production release are recorded below.

## Complete retirement of the dedicated Consolidation plugin

The follow-up cleanup removes `@merv/consolidation` completely: its package, configuration,
tools, UI, Research capability, candidate/decision API and dedicated Code publication owner.
Consolidation continues through ordinary Tasks. Default composition now contains 50 plugins
(51 with the retained historical-import UI), and there is no `consolidation.*` tool surface.

Existing database and Git records stay untouched. Published Consolidation migration and
workflow fingerprints are marked retired instead of rewritten. Old Research cycles retain
readable records and committed command replay; unsupported consolidation handoffs report
`research_consolidation_retired`. Retained dedicated publications remain readable but cannot
be resumed or merged, and do not block the bounded polling of current unit publications.

The preflight census found no dedicated Consolidation records or publications in production,
and none in staging. Production holds three version-3 Research cycles in `defining`.
One of those cycles selected Git and will report the retired handoff; its records are retained, and a new cycle uses ordinary Tasks.

Local retirement checks pass: 1,780 tests, 1,586 passed, 194 PostgreSQL cases skipped locally, zero failures. Server/UI type checks, both builds and deployment configuration tests pass. The strict compiled-runtime acceptance also passes against staging PostgreSQL and S3: all 50 default plugins, task delivery/review/replay, agent continuity, private downloads, reflection and restart persistence. All 55 targeted PostgreSQL checks pass (44 repository/publication/research cases and 11 research automation cases); the full CI formatting gate also passes.

Staging release `20260922T205001Z-b0b1fa62-820589bddbf3` is healthy with 51/51 configured plugins and zero restarts. Its image is `sha256:f8a4789d471beb3e997a57f56add211de5868c92348c225c4aeb51d86f59c027`. Public health, UI, assets, authentication and origin checks pass; schema, blob prefix and Caddy routing remain unchanged. The backup is `/var/backups/merv/consolidation-retirement/20260922T204928Z`. Verification is retained under `/opt/merv-typescript/verification/20260922T205001Z-b0b1fa62-820589bddbf3/`; public checks are in that release's `retirement-final-verification.json`. The implementation and evidence were fast-forwarded to main. Production promotion is recorded below.

## Final clean-checkout verification

The full GitHub SQLite job passed. The full PostgreSQL job passed 1,778 cases and skipped one; its sole failure was a pre-existing ordering assumption in the backup concurrency test. PostgreSQL may finish concurrent authorization checks in either order. The test now holds the first admitted backup open before asserting that a second is refused and remains retryable. No runtime code changed. The corrected check passed all 20 checks across ten SQLite/PostgreSQL repetitions on staging. Full CI was restarted for `43e7cc3c`: <https://github.com/rapidreview-io/Merv/actions/runs/35785042466>.

## Production release

Release `20260922T211125Z-43e7cc3c-771e92e60ae8` is live at <https://experiments.rapidreview.io/ui/> from application commit `43e7cc3c359668579ca2cf4c4317bd269b585f37`. Image: `sha256:623e37b155983758660660a546ee6d4e42aff28781bc0748ba9d17d8f07b2573`. All 51 configured plugins are active, with zero restarts and no legacy Consolidation provider. Health, UI and assets return 200; protected anonymous requests return 401, the approved origin returns 200, and unapproved origins return 403. Served asset hashes match the tested staging build. The production schema, blob prefix and Caddy configuration are unchanged.

The checked database/data/configuration backup is `/var/backups/merv/consolidation-retirement/20260922T205837Z`. The previous image `merv-typescript:20260922T144623Z-94860148-01a971624785` remains available for rollback. Deployment manifests, acceptance checks and `retirement-final-verification.json` are retained under `/opt/merv-typescript/releases/20260922T211125Z-43e7cc3c-771e92e60ae8/`. The final push contains release evidence only; the full CI rerun for the test-only fix was still running when the user requested immediate closeout.
