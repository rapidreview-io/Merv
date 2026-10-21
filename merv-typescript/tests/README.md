# Critical test suite

Run `npm test` from `merv-typescript` with `MERV_TEST_POSTGRES_URL` pointing to a
local PostgreSQL 17 database. Tests create and clean up isolated schemas. Run
`npm run test:deploy` for release, rollback and hosted-runner checks. Browser
component tests use the existing DOM harness; the experiment report integration
also needs Chromium (`npx playwright-core install chromium`). Tool compatibility
rendering needs `npm run build:board-renderer` once in a fresh checkout. Linux process and
root-only isolation checks run only on the matching platform.

## Runtime target

The target is a 75% reduction in the combined wall-clock time of `npm test`
followed by `npm run test:deploy`. Both commands run their entire remaining suite;
there is no hidden legacy suite or allowlist.

| Command               |    Baseline |                   After |
| --------------------- | ----------: | ----------------------: |
| `npm test`            |      94.9 s |                  65.7 s |
| `npm run test:deploy` |     236.4 s |                  16.2 s |
| **Combined**          | **331.3 s** | **81.9 s (75.3% less)** |

After reconciling with remote main at `1620bf93b`, the measured run passed 935 main-suite tests and 74 deployment tests, with two
Linux-only main-suite skips on macOS.

Measurements use Node 22.13.1 and the same local PostgreSQL 17 instance on macOS,
with the commands run sequentially and including npm's pretest schema cleanup.
The baseline was captured after the initial file-removal pass, so it is already
smaller than the original 378-file suite. These are local measurements, not a CI
runtime guarantee. CI distributes the remaining main-suite files across two shards.

We removed duplicate workflow/session permutations, UI polling and presentation
checks, historical snapshots and unused fixtures. Release tests retain representative
success, rollback, interrupted rollback recovery, prerequisite refusal and staging
failure scenarios. Their fixture commits the real release scripts and small app and
vendor trees, exercising real Git packaging without repeatedly hashing the entire
application. Formatting of simulated ledgers is stubbed; formatting remains a
separate CI check. Deployment hosts and Wrangler remain simulated.

## Retained coverage

| Risk                                                                   | Representative retained suites                                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-project access, credential expiry/revocation, membership changes | `actor-credentials`, `credential-auth`, `identity`, `shared-membership`, `user-keys`, `user-key-api`, `admin-platform-read`              |
| Durable transactions, concurrent writes, replay and restart            | `state-postgres`, `domain-events`, `workflows`, `app`                                                                                    |
| Evidence integrity, uploads and scoped downloads                       | `artifact-rows`, `artifact-large`, `artifact-collections`, `artifact-download`, `blobs-s3`                                               |
| Independent review, exact evidence, rejection and rollback             | `structured-reviews`, `review-exclusions`, `review-flow`, `review-return`, `experiments`, `reflections`                                  |
| Dependency gates, execution authority and bounded automation           | `workflow-dependencies`, `workflow-execution`, `workflow-leases`, `workflow-limits`, `research-automatic`                                |
| Git admission, retention, ownership and recovery                       | `code-admission`, `code-operations`, `code-writers`, `code-main-landing`, `code-github-automation`, `runner-code-v2-integration`         |
| Worker isolation, revoked authority and session recovery               | `sessions`, `sessions-integration`, `runner-process`, `runner-integration`, `session-continuity`, `session-liveness`                     |
| Model/tool authority, checkpoint integrity and usage limits            | `pi`, `pi-authority`, `pi-relay`, `pi-worker`, `fleet`                                                                                   |
| Payment/acceptance gates and customer data isolation                   | `payments`, `customer-experiments-domain`, `customer-experiments-service`, `customer-experiments-files`, `customer-experiments-identity` |
| Browser identity isolation, safe rendering and consequential actions   | `ui-identity-client`, `ui-artifact-upload`, `ui-markdown`, `ui-reviews`, `ui-shell`, `ui-tasks`                                          |

Exact wording/layout, generated inventories, source-text assertions, historical
migration snapshots, query-count microbenchmarks, and repeated permutations of
behavior already exercised at its owning layer are no longer release gates.
Current migration atomicity, restart behavior and failure recovery remain covered.
This deliberately gives up exhaustive UI, legacy-version and adapter coverage.

## Keep it small

- Test a meaningful failure risk: lost data, unauthorized access, incorrect money
  or resource usage, a broken workflow gate, or an unusable core user action.
- Prefer one owning-layer test plus an integration test only where wiring adds a
  different risk. Add a regression to an existing suite before creating a file.
- Assert durable outcomes and permission boundaries. Avoid pinning incidental
  wording, DOM arrangement, private implementation structure or exact query counts.
- When replacing a behavior, replace its tests. Do not retain an obsolete suite
  solely to document how the old implementation worked; Git keeps that history.
