# Tests

Run `npm test` with `MERV_TEST_POSTGRES_URL` pointing to local PostgreSQL 17.
Tests use isolated schemas. The command runs every `tests/*.test.ts` file; the
reduction deletes or consolidates tests rather than excluding files or adding skips.
Run `npm run test:deploy` separately for deployment and staging-isolation checks.

Use Node 22.13.1 or later. Build the Board renderer once with
`npm run build:board-renderer`; report rendering also requires Chromium. Browser
component tests use the DOM harness. Linux process and root-only isolation checks
require the matching platform.

## Reduction measured on 2026-11-07

The requirement is at least 60% fewer main-suite test cases. Counts include nested
cases reported by Node's test runner. Source lines are tracked separately; retaining
a distinct authorization or recovery check takes priority over a line-count target.

| Main suite                      |    Prepared baseline |                After |
| ------------------------------- | -------------------: | -------------------: |
| Reported cases                  |                1,318 |    393 (70.2% fewer) |
| Passed / skipped                | 1,317 / 1 Linux-only |              393 / 0 |
| Top-level cases                 |                1,156 |                  375 |
| Test files                      |                  164 |                  129 |
| Test source lines               |               65,062 | 29,783 (54.2% fewer) |
| First-review isolated wall time |             130.61 s | 63.54 s (51.4% less) |

The baseline ran on Node 22.13.1, PostgreSQL 17 and macOS, including npm's pretest
schema cleanup. The complete final run passed with zero failures. No test selection changes hide remaining files. These
local timings are not a CI performance guarantee. The second review adds five cases, bringing the full passing run to 393 cases (71.60 seconds of test-runner time while builds ran concurrently); that duration is not a like-for-like runtime comparison. The optional Linux mount gate was not exercised on this macOS host.

Deployment validation passed 43 release tests, 11 PostgreSQL staging-isolation tests and 12 Python isolation tests in 20.03 seconds. Separate recovery, predeployment, prebuilt-release and staging-ownership Python gates passed (9, 4, 6 and 4 tests), as did the website signup regression. Server/browser typechecks and builds, formatting, and plugin-map generation passed. Thirteen unused fixtures were deleted; executable acceptance fixtures were retained.

The subsequent Work page redesign adds two generalized DOM cases. Its complete UI run passes 23/23; with those cases, the suite has 395 reported cases (70.0% below baseline). The table above records the preceding full adversarial-review run.

Release integration preserves nine newer upstream regression cases. With the generated browser/PDF assets built first, the combined suite passes 404/404 with no skips (69.3% below the original baseline).

## Retained coverage and tradeoffs

The suite retains representative checks for project and credential isolation;
transaction rollback, replay and restart; immutable artifacts and upload recovery;
independent reviews and recorded owner decisions; native Git admission and frozen
submission approval; workflow dependencies, lease fencing and continuity; Fleet
capacity, lease expiry and cost limits; and consequential customer, payment, model
relay and browser actions. Regressions from the adversarial review exercise the
corrected behaviors. Board fixtures load the services a test needs instead of
starting the full product for every assertion.

Removed coverage includes repeated transport and setup permutations, generated
catalog and presentation snapshots, source-text assertions, and many historical
GitHub/import/migration variants. Standalone scheduling, API summary and UI variants
are also less exhaustive. The remaining suite does not promise the same breadth of
legacy or presentation coverage as the baseline.

Keep new tests focused on a concrete failure risk. Prefer the owning service and
add integration coverage when wiring introduces a distinct risk. Extend existing
invariant or regression tests before adding another fixture or suite. Assert
observable outcomes and permission boundaries rather than incidental wording,
layout, private structure or exact query counts.
