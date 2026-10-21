# Main boot maintenance for the native Git cutover

This is a **transition fence**, not a live drain switch or a per-project canary mode.
The parent release operator owns production changes. No deployment was performed by
this implementation.

Set `MERV_BOOT_MAINTENANCE=1` in Main's existing `/etc/merv/typescript.env` before
starting the compatible image. Unset (or `0`) is the normal default. Any other value
fails configuration. The process captures this policy before plugin activation and
stored-secret overrides; changing the environment of a running process or reloading
a plugin cannot release it. Restoration requires a new Main process.

The same Fleet/Pi/customer composition stays enabled. The fence does not call dispatch
toggles, clear retry holds, cancel sessions, change workflow state, revoke credentials,
advance event cursors, or rewrite durable admission decisions. Schema migrations,
contract registration and durable consumer registration still run. This is not a
read-only database mode and does not replace the offline migration census.

## What is paused

| Owner                | Fenced entry points                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions             | Timed/explicit sweeps, startup hold-report repair and observation interruption                                                                                                 |
| Fleet                | Wakeups, global reconciliation, workflow-demand reconciliation, startup relay marking; shutdown does not cancel existing allocations                                           |
| Pi                   | Startup offer preload, host ticks; shutdown does not rewrite existing hosts/turns                                                                                              |
| Customer experiments | Reconciliation and file retention sweeps                                                                                                                                       |
| Merv domain events   | Timed delivery and explicit `drain`; subscriptions retain existing cursors/retries                                                                                             |
| Code                 | Native Git automatic journal recovery, store recovery/maintenance, delayed base work, automatic main landing, publication sync, native approved-submission journal wake/replay |
| Research             | Startup resume events and delayed automatic advancement/retry                                                                                                                  |
| Sandboxes adapters   | People startup backfill/sign-in provisioning, run retirement, evidence gathering, running-view refresh and embedded relay subscription                                         |

The embedded Sandboxes host does not start the standalone lifecycle/job/pipeline
workers (see the pinned host's `WORKFLOW_SERVICES` versus `serveWorkers`). Those
external processes, old Main processes and already-running machines are outside this
process fence and require the cutover's separate drain/census. The embedded relay's
existing `domain_event_consumers` row `merv-relay` is left untouched. A fenced boot
with relay enabled refuses to become ready if that row does not exist: otherwise a
first subscription using `from: now` on resume could skip the maintenance backlog.
Do not delete/reset this row or prune either event log during maintenance.

Explicit native Git requests retain their own reconciliation and crash fences.
Explicit Sandboxes `ensure`/credit actions also retain authorization and effects.
A committed operator admin/billing change keeps its post-commit account-link
reconciliation: dropping that notification would lose the requested change, because
startup backfill intentionally preserves already-linked projects. Unadmitted sign-in
notifications are suppressed; the next normal backfill discovers those saved people.

## HTTP and operator boundary

Public `GET /health`, `GET /ui/`, and `GET /ui/assets/*` remain available. Health adds
`maintenance: true`; normal health retains its old response. Other requests are
refused with 503 before a route handler runs; protected routes retain their normal
401 authentication failures. Websocket upgrades are fenced too.

For explicit operator requests only, configure a temporary random
`MERV_MAINTENANCE_OPERATOR_TOKEN` (at least 32 characters) in the same protected env
file. Send it as `x-merv-maintenance-operator` **in addition to** the route's ordinary
credential. This capability does not confer project permissions, bypass reviewer
isolation, or change any worker credential. Omit the token entirely if no acceptance
requests are needed. Keep it out of logs, browser storage, scripts and saved MCP
configuration. Use an authenticated loopback request through the existing operator
access path; Caddy must continue refusing non-static public ingress even when this
header is supplied. Do not add an edge bypass keyed only on a client-supplied header.

The capability applies only to that HTTP request. It does **not** propagate to Git
workers, hosted runner polling, Pi worker callbacks, model relay calls, or durable
event handlers. Explicit global sweep/reconcile/drain calls remain paused even from
an admitted request. Operator-created durable work can wait for resume. A health
check, an admitted tool call or a successfully queued approval is not end-to-end
hosted/native-Git acceptance.

## Activation and release sequence

1. Preserve the original protected env file, Caddy config, exact Main/runner pins and
   durable dispatch/admission/retry snapshots as release evidence. Record whether
   the two maintenance variables were originally absent. Do not print secrets.
2. Install and validate edge maintenance: allow only the three public GET patterns
   above; return 503 for all other ingress including **both** Stripe webhook routes.
   Leave normal authenticated loopback operator access available. Verify direct
   ports and other ingress cannot bypass this edge rule.
3. Complete the cutover ownership census and genuine drain with the existing
   supported mechanisms. This boot flag does not drain active work. Do not toggle
   Sessions dispatch merely to simulate maintenance: those toggles can clear holds.
   Confirm the existing Sandboxes `merv-relay` cursor. Fence external writers too.
4. Stop Main, take and verify the fresh matched recovery snapshot, and run the
   approved offline workflow migration as in `NATIVE_GIT_CUTOVER_PLAN.md`. Do not boot
   an incompatible image or run Main concurrently with the migration.
5. Set `MERV_BOOT_MAINTENANCE=1` in Main's env file; retain the original
   Fleet/Pi/customer/dispatch settings. With no hosted run already open, deploy Main
   as an intentional intermediate step from the reviewed committed checkout:

   ```sh
   node deploy/release.mjs --host ResearchSuite_Control --no-rollback --skip-hosted
   ```

   `--skip-hosted` is required here: the ordinary coordinated path immediately runs
   a live canary, which cannot pass under the boot fence. Verify `/health` reports
   `maintenance: true`, static assets match, and work/webhook requests are refused.

6. From the **same committed checkout**, prepare the hosted half:

   ```sh
   node deploy/hosted-release.mjs --host ResearchSuite_Control --prepare-cutover
   ```

   This persists a forward-only cutover plan. Preflight verifies native-compatible
   Main, both effective/saved maintenance flags and health, plus an empty read-only
   ownership census. It reads the existing root-only canary credential but defers
   its ordinary HTTP identity check. Create/verify that credential before entering
   maintenance; this command does not mint one. The cutover drain refuses live
   ownership instead of setting holds or waiting for paused reconcilers. Candidate
   build/Linux gates, catalog installation, deployment of every live app, Main pin
   switch and native health/isolation checks run normally. It then records the
   exact Main image, hosted digest and per-app pins and returns **exit 5: PREPARED**.
   This is a durable checkpoint, not failure or canary success. No canary or staging
   rollout has run. Retain its run ID and host records. Compare workflow, retry,
   event and Git journal snapshots; only documented migrations/registrations and
   explicit operator effects should differ.

   An interrupted preparation resumes with `node deploy/hosted-release.mjs --host
ResearchSuite_Control --resume`. Plain resume stops at the checkpoint again;
   it never authorizes a canary. The original committed pipeline must remain
   available. Another driver's lease can take up to five minutes to expire.

7. **Authorize controlled reopening separately.** Keep public customer ingress
   closed. Assess all existing background demand: this global fence has no
   per-project exception. Prepare the ordinary authenticated worker/Git/callback
   paths needed by the production canary. If that demand cannot safely resume,
   stay PREPARED; use an isolated canary environment without claiming production
   acceptance. Do not clear real records or retry decisions to manufacture idleness.
8. Restore the two maintenance variables to their original normal values/absence
   in `/etc/merv/typescript.env`. Recreate **the same Main image** on the host using
   its existing Compose project, under the shared deployment/recovery lock. The
   open hosted marker intentionally prevents `release.mjs` from starting another
   Main deployment, so do not use it for this recreation. In the existing root
   operator shell, after the deliberate env edit:

   ```bash
   (
     exec 9>/run/lock/merv-maintenance.lock || exit 1
     flock -w 1200 9 || exit 1
     test ! -e /var/lib/merv-recovery/resume.json || exit 1
     MAIN_IMAGE_ID=$(docker inspect -f '{{.Image}}' merv-typescript-control-1) || exit 1
     MAIN_COMPOSE_DIR=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1) || exit 1
     [[ "$MAIN_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
     [[ "$MAIN_COMPOSE_DIR" == /* && -d "$MAIN_COMPOSE_DIR" && -f "$MAIN_COMPOSE_DIR/compose.yml" ]] || exit 1
     cd "$MAIN_COMPOSE_DIR" || exit 1
     MERV_TS_IMAGE="$MAIN_IMAGE_ID" docker compose -f compose.yml up -d --no-deps --force-recreate control || exit 1
   )
   ```

   Run this as one Bash block. Every prerequisite failure aborts before Compose;
   exiting the subshell releases its lock on success or failure. A nonzero result
   means reopening did not complete: diagnose it before invoking acceptance.

   Verify normal health and allow the explicitly authorized callback routes. All
   normal background consumers now resume with their original saved decisions.
   From the original committed release checkout, run:

   ```sh
   node deploy/hosted-release.mjs --host ResearchSuite_Control --resume --accept-cutover
   ```

   The host requires the saved and effective maintenance flags to be removed, health
   to agree, and the exact prepared image pair, catalog and pins to remain intact.
   It rechecks native readiness and runs the **ordinary real Pi canary**, including
   its normal credentials/callbacks and observed provider release. No operator
   header propagates, no local helper is installed, and no special MCP configuration
   is introduced. Only a passing canary closes the run and updates the live ledger.
   Then complete the additional native Git producer/reviewer lifecycle, shutdown
   receipt and ordinary terminal Claude/Codex onboarding in the approved project.

9. After acceptance restore intended customer ingress and observe event/Stripe
   replay and cleanup. A rejected webhook was not acknowledged: verify redelivery
   and reconcile provider events if retries expired. Staging is **explicitly
   DEFERRED** by this cutover run: never send `code.git.1` to an incompatible staging
   Main. Keep its existing hosted apps/pins until its separate compatible Main/data
   migration and release are reviewed; production success is not staging acceptance.
   Do not run a subsequent ordinary hosted release (which automatically stages)
   until staging Main/data compatibility is established.

A cutover error returns 3 and leaves the run open. The driver never deploys the old
image, restores an old catalog, switches back to old pins, or abandons the run. The
host guard also leaves cutover pins alone. A failed Main recreation retains the
candidate env rather than restoring incompatible pins. Before the checkpoint,
repair the cause under maintenance and use `--resume`; after it, repair and use
`--resume --accept-cutover` only when reopening is authorized. A failed live canary
leaves the candidate pair and evidence in place; the operator must retain/re-establish
the edge and boot fences while diagnosing. Do not treat a failed canary as accepted.
A different candidate or Main image requires separately reviewed forward recovery;
the original checkpoint deliberately refuses image/pipeline drift. Do not delete
host run records or use `--abandon` to bypass that refusal.

Removing the fence never clears an existing retry deadline. Once resumed, the normal
consumer may process a now-due retry and record its normal outcome. Merv event handler
effects and cursor advance remain atomic; Sandboxes relay remains its existing
at-least-once protocol with `sbx_event_id` deduplication, not a new exactly-once claim.

## Local evidence and remaining real-host gates

Tests exercise strict/default boot policy, immutable settings, public/normal-auth/
operator boundaries, real scheduler entry methods without dependency access, Fleet
and Pi shutdown preservation, a full assembled Main boot/restart, and PostgreSQL
backlog/retry preservation through maintenance followed by ordinary resume without
duplicate effects. The native approval scheduler is included in the same process
fence test. Existing domain-event/API and native approval/shutdown suites also run.

The parent must still verify on the actual integrated image/host: effective env and
Caddy configuration, the pre-existing Sandboxes relay cursor, no second Main or
external writers, all live ownership/drain categories, image compatibility, native
Git crash/replay and isolation acceptance, ordinary hosted callback reachability,
OAuth/onboarding, payment redelivery, recovery restore and post-resume journals.
These are release gates, not assertions established by local tests.
