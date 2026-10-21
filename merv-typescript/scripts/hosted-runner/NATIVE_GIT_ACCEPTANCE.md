# Native Git acceptance gates

`tests/experiment-native-lifecycle.test.ts` exercises the real application in a disposable PostgreSQL schema. It enrolls two managed work hosts, leases actual experiment stages, uses worker MCP and runner metadata HTTP, transfers objects with ordinary Git HTTP, and runs both approved milestones through Code Work's journal. Only allocation liveness and report rendering use the existing test adapters; no workflow, authorization, submission, approval or Git result is fabricated.

The test submits dirty planning code, verifies the exact tree without a preapproval commit, independently approves the plan, continues execution in the same producer directory, submits dirty results, independently approves them, and verifies managed teardown's durable receipt. Commit counts prove exactly two milestone commits and no duplicate shutdown commit. Review credentials cannot push. Conversations are declared and uploaded over the actual signed-upload protocol.

With `MERV_LINUX_REVIEW_IMAGE`, each fetched review checkout also passes through `linux-submission-review.py` in local Docker. It copies that checkout into the container, verifies its exact parent and indexed tree, and invokes the production `readonly_code` and `prepare_assignment_identity` functions. It verifies the submitted files, executes their check from writable scratch, and requires denial of file writes, Git index/config/HEAD/ref changes, remounting and supervisor credential reads, with no retained capabilities. The copy has independent Git metadata and is otherwise writable by the assignment identity, so Docker's input mount is not the source of the tested denial.

## Run locally

Use an isolated local PostgreSQL service. Without a Docker image, the test runs the complete service/HTTP lifecycle and explicitly reports that the Linux boundary was not checked:

```sh
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:64306/merv \
  node --import tsx --test tests/experiment-native-lifecycle.test.ts
```

For the Linux phase, use a candidate image or a local test image containing Python 3, Git, mount, an administrator UID/GID 1000 and a private assignment UID/GID 12001. A minimal local image can be built without any model credentials:

```sh
docker build -t merv-review-local:test - <<'EOF'
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git mount \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 administrator && useradd -u 1000 -g 1000 -m administrator \
 && groupadd -g 12001 assignment && useradd -u 12001 -g 12001 -m assignment
EOF
MERV_TEST_POSTGRES_URL=postgres://merv@127.0.0.1:64306/merv \
  MERV_LINUX_REVIEW_IMAGE=merv-review-local:test \
  node --import tsx --test tests/experiment-native-lifecycle.test.ts
```

The test uses `--network none` for review containers, adds mount capability only to the trusted parent, and removes each container on exit. This minimal image is not a release artifact. The test's parent drives the workspace driver directly and marks completed scripted actions stopped; it does not run MachineRunner's guardian or the hosted supervisor.

## Evidence still required for a hosted release

| Boundary               | Existing evidence                                                                                                                                         | Remaining acceptance                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service lifecycle      | Real app, PostgreSQL, managed credentials, MCP, native Git HTTP, exact submitted trees, approvals and shutdown receipt in the test above.                 | Run after transport changes; include restart and lost-response regressions from the runner, submission and Git HTTP suites.                                                                                                                                 |
| Linux review isolation | Exact fetched submissions through production mount/identity functions in local Docker; `linux-review-gate.py` also tests a standalone synthetic checkout. | Run the release gate against the exact combined candidate image and prove the provider grants mount authority to the supervisor while denying it to the reviewer.                                                                                           |
| Hosted supervisor      | `linux-workflow-gate.py` runs the actual supervisor/guardian/launcher against a synthetic Main and tests reset/continuity.                                | Run a complete planning, review, execution, results-review and teardown workflow against real Main through the exact candidate supervisor and protected launcher. Scripted agent actions can avoid model spend, but must not replace server business logic. |
| Public Git ingress     | Local tests talk directly to the app's HTTP listener.                                                                                                     | Verify Git clone/fetch/push through the deployed Caddy/TLS path, including gzip upload-pack requests, protocol negotiation, large/chunked bodies, cancellation, timeouts and request limits. Preserve Basic authentication and content encoding end to end. |
| Provider lifetime      | Local managed shutdown verifies durable receipts and acknowledgement gating.                                                                              | Prove allocation stop/repurpose cannot delete the provider host before receipt acknowledgement; demonstrate retry after a lost response and verify host deletion afterwards. Unexpected provider loss remains outside guaranteed dirty-file retention.      |

The older `local-smoke.ts` invokes a paid model and ends at one task's review handoff; it is not this complete lifecycle gate. No local result above establishes deployed Cloudflare, TLS proxy, model, provisioning or provider-cleanup acceptance.

## Production preflight, 2026-10-21

The running server was inspected through SSH and public HTTPS. It remains release
`20261021T064230Z-7871b0af-85410a2ad390` (image
`sha256:7f7b6177a78023f4e3b954b8f28466fb1b622c26509fcf9370502b17b9c730a4`).
Its read-only cutover check found 39 unfinished legacy workflow instances across
30 projects and one dispatched Code command. There were no active writers, workflow
allocations or live managed runners. The legacy records include work awaiting payment
and review; they were not changed or cancelled. Hosted pins match their recorded releases.

Public `/health` and `/ui/` returned 200; the undeployed Git route returned 404.
DNS resolved to the Azure host and responses advertised Caddy without `CF-Ray`, so
this check does not establish a Cloudflare HTTP-edge path. These are observations of
the existing deployment, not acceptance of this candidate. Exact identities and
results are in `verification/native-git-production-readiness-2026-10-21.json`.

The owner chose migration/drain before a separate canary, then authorized implementation
and production acceptance. The locally tested migration preserves38 workflows in place and
retains the remaining artifact-only review; a hardened read-only production plan passes.
The [cutover plan](../../deploy/NATIVE_GIT_CUTOVER_PLAN.md) and its disposition ledger
cover the required legacy repairs, preservation, maintenance and acceptance gates.
No workflow closure, infrastructure provisioning or candidate deployment has occurred.

Once the candidate is deployed and its disposable project is ready, the standalone
operator probe exercises public Git without creating projects or credentials:

```sh
node deploy/public-git-probe.mjs --base-url https://CANDIDATE_ORIGIN \
  --project DISPOSABLE_PROJECT_ID --token-env MERV_GIT_PROBE_TOKEN \
  --out /private/acceptance-output --run-id UNIQUE_RUN_ID
```

Its report records observed protocol headers, outcomes and limits; it leaves its own
refs in the disposable project because remote deletion is intentionally disabled.
Retain the evidence and revoke the test credential. Remove test infrastructure only
when it is isolated and its disposal is authorized. This probe alone does not establish
hosted lifecycle or provider teardown.
