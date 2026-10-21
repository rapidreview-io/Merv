# Boot maintenance local verification — 21 October 2026

No production deployment, migration or mutation was performed. Work ran in the managed
`launch-maintenance-fence/Merv` worktree, initially based on integration
`7607a3ecc9591fae277579726c319f70554979df`, then merged with reviewed native Git
`9081a32ec1fe5c31dd2b4f3bdeebfd2a90ceead2`. The native author's worktree was read only.
No companion patch remains: native approval-journal fencing is implemented directly.

Node: 22.13.1. PostgreSQL tests used local port 5432 and disposable test schemas,
removed by the existing test fixture. No production credentials or connections were used.

Passed:

- `npm run typecheck` after native Git integration.
- `npm run build`, including client bundles, TypeScript, board renderer and runtime assets.
- `node --import tsx --test tests/maintenance.test.ts tests/maintenance-events.test.ts tests/fleet.test.ts tests/pi.test.ts tests/sessions.test.ts tests/customer-experiments-service.test.ts`: 85 passed, 0 failed. Includes native approval-scheduler guards, Fleet/Pi shutdown preservation, a full Main restart retaining an actual dispatch hold and disabled dispatch setting, and queued event/retry replay across separate processes.
- `node --import tsx --test tests/maintenance.test.ts tests/maintenance-events.test.ts tests/code-submissions.test.ts tests/managed-shutdown.test.ts`: 10 passed, 0 failed, on the integrated native Git tree.
- Before the native merge, `node --import tsx --test tests/maintenance.test.ts tests/maintenance-events.test.ts tests/domain-events.test.ts tests/api.test.ts`: 36 passed, 0 failed. These establish the existing normal HTTP/auth and durable-event behavior on the original integration baseline.
- `git diff --check`.

The PostgreSQL test commands require `MERV_TEST_POSTGRES_URL` set to an isolated local
test database. Child test processes remove Node's inherited test-context variable and
assert the child actually ran its expected tests, rather than accepting an empty exit.

Required real-host evidence remains in [the runbook](../deploy/BOOT_MAINTENANCE.md):
actual container environment and Caddy fences, retained Sandboxes relay cursor,
external writers/ownership drain, matched backup restore, exact image compatibility,
normal hosted/Git callback reachability after an authorized acceptance reopening,
Git crash/replay and reviewer isolation, OAuth/client onboarding, Stripe redelivery
and post-resume journals. Local tests do not establish those gates.

The operator HTTP capability admits only the individual request and normal route
authority still applies. It does not make a hosted end-to-end canary work while global
schedulers and ordinary worker HTTP requests remain paused. Reopening requires the
explicit release decision described in the runbook and resumes all normal background
consumers without changing their durable dispatch/retry decisions.
