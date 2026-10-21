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

| Owner                | Fenced entry points                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions             | Timed/explicit sweeps, startup hold-report repair and observation interruption                                                          |
| Fleet                | Wakeups, global reconciliation, workflow-demand reconciliation, startup relay marking; shutdown does not cancel existing allocations    |
| Pi                   | Startup offer preload, host ticks; shutdown does not rewrite existing hosts/turns                                                       |
| Customer experiments | Reconciliation and file retention sweeps                                                                                                |
| Merv domain events   | Timed delivery and explicit `drain`; subscriptions retain existing cursors/retries                                                      |
| Code                 | Store recovery/maintenance, delayed base work, automatic main landing, publication sync, native approved-submission journal wake/replay |
| Research             | Startup resume events and delayed automatic advancement/retry                                                                           |
| Sandboxes adapters   | Run retirement, evidence gathering, running-view refresh and embedded relay subscription                                                |

The embedded Sandboxes host does not start the standalone lifecycle/job/pipeline
workers (see the pinned host's `WORKFLOW_SERVICES` versus `serveWorkers`). Those
external processes, old Main processes and already-running machines are outside this
process fence and require the cutover's separate drain/census. The embedded relay's
existing `domain_event_consumers` row `merv-relay` is left untouched. A fenced boot
with relay enabled refuses to become ready if that row does not exist: otherwise a
first subscription using `from: now` on resume could skip the maintenance backlog.
Do not delete/reset this row or prune either event log during maintenance.

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
5. Add `MERV_BOOT_MAINTENANCE=1` and, if needed, the temporary operator capability to
   Main's env file. Keep all original Fleet/Pi/customer/dispatch settings. Deploy the
   reviewed Main and exact hosted runner with the cutover's no-rollback policy. The
   existing Compose `env_file` carries these variables; no render-config rewrite is
   needed. Recreating the container is required; `docker restart` alone does not
   reload an edited env file.
6. Verify `/health` reports `maintenance: true`, static assets match the release,
   ordinary work/webhook requests are refused and invalid normal credentials still
   fail. Compare retained workflows, admissions/retries, event cursors, provider
   ownership and Git journals against the pre-boot snapshot, allowing documented
   schema/definition registration and explicit operator writes only. Wait longer
   than the scheduling intervals being checked. Complete image/protocol/static
   compatibility checks and approved explicit authenticated operator probes.
7. **Controlled acceptance reopening is a separate release decision.** Keep public
   customer ingress closed. Before removing the global boot fence, census existing
   customer/background demand and decide whether it is safe for _all_ normal
   background consumers to resume with the accepted image pair. This implementation
   has no per-project scheduler exception. If existing demand cannot safely resume,
   keep the fence and run the canary in an isolated approved environment; do not
   claim the production canary passed. Never modify real workflow/retry records to
   manufacture an empty queue.
8. Once that reopening is authorized, restore the two maintenance env variables to
   their exact original values/absence and recreate Main with the same accepted
   image. Verify normal health no longer reports maintenance. Keep the edge closed
   to customers while permitting only the explicitly authorized runner/Git/callback
   routes required by the ordinary hosted acceptance. Their usual credentials,
   review isolation and onboarding apply; no local helper or special MCP config is
   introduced. Run the actual disposable-project Pi/Fleet/native-Git lifecycle,
   shutdown retention receipt and ordinary terminal Claude/Codex onboarding. Normal
   background work and retained event replay are now enabled; this is intentional.
9. After acceptance, restore the exact original edge config and intended existing
   settings. Observe durable event catch-up (including Sandboxes relay), provider
   cleanup, customer reconciliation and Stripe replay. A rejected webhook was not
   acknowledged or stored by Main: verify Stripe redelivery and reconcile provider
   events if retries were exhausted. Retain old images and recovery evidence.

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
