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

The pre-migration server was inspected through SSH and public HTTPS. It was release
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

The owner chose migration/drain before a separate canary. The coordinating release applied
the reviewed plan at 12:41:55 UTC after a fresh verified backup: 38 workflows migrated in
place, the artifact-only review retained, and the abandoned command retired with unknown
execution outcome. No isolated canary was created. The [cutover plan](../../deploy/NATIVE_GIT_CUTOVER_PLAN.md)
records the applied plan and recovery identities. Its migration receipt does not establish
hosted lifecycle, public Git, or provider shutdown acceptance.

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

## Actual hosted experiment after controlled reopening

`deploy/hosted-native-acceptance.mjs` uses the public operator API and Fleet's normal
dispatch. Its default `check` is read-only. `start` creates one idempotent experiment;
`watch` collects evidence and answers only its prescribed dirty-checkout continuity
pause; `collect` only reads; `drain` requests planned shutdown for that terminal
experiment's exact allocations. It never enrolls a runner, claims a workflow,
authors evidence, submits a verdict, changes dispatch, or clears an existing hold.
Planning, design review, execution, rendered reporting and results review are actual
hosted agent work. The immutable request includes the exact worker probe, supplied
through `/usr/bin/python3 -I -B -c` so checkout modules and Python environment
overrides cannot replace its imports, and it adds no file to the reviewed checkout.
Reviewers compare the index directly with the exact submitted tree without
`write-tree`, which would require a forbidden index lock on the read-only mount.
`linux-native-acceptance-probe.py` documents a local Docker regression using the
production mount and identity helpers, exact submitted content, and real denied
Git writes. It also checks stale index metadata, hidden changes and linked Git
metadata; it does not establish hosted/provider acceptance.

The retained project `project_c54cd6d765d8467d948bb638c55f169d` (Fleet Git acceptance
2026-09-23) had a human admin, an active human operator and only terminal work at the
read-only workflow census. The 14:11 UTC observer also found six prepared September 23
`mirror-accepted` records. Commit `058c57222` retired execution/retry of that kind;
the observer now reports them separately and leaves them untouched. Actual pending
capture/retention operations still block preflight. Earlier temporary keys were
expired/revoked. The 14:18 UTC credential census found no active actor credential,
covering user API key or live OAuth grant. The actual admin must sign in and create
a bounded project-scoped machine key under **Settings → Keys**, then securely set
`MERV_ACCEPTANCE_TOKEN`. That `mk_` key supports operator HTTP and Git; an OAuth
credential supports `/mcp` only. This CLI issues no credentials. Recheck the project
before use. Existing customer projects and the
preserved artifact review are not test targets. The release owner must first accept
the exact Main/hosted pair and reopen the required authenticated routes. Set the
two expected pins from that release's retained manifests, never from an arbitrary
latest image. Budget/compute authorization must cover the real model sessions;
an instance dispatch budget is not a hard dollar spending cap.

From the reviewed `merv-typescript` checkout, with those values securely set:

```sh
run_native_acceptance() {
  node deploy/hosted-native-acceptance.mjs --mode "$1" \
    --base-url https://experiments.rapidreview.io --host ResearchSuite_Control \
    --project project_c54cd6d765d8467d948bb638c55f169d \
    --main-image "$MERV_ACCEPTANCE_MAIN_IMAGE" \
    --runtime-release "$MERV_ACCEPTANCE_RUNTIME_RELEASE" \
    --run-id oct21-native --out /tmp/merv-hosted-oct21-native \
    --token-env MERV_ACCEPTANCE_TOKEN
}
run_native_acceptance check
run_native_acceptance start
run_native_acceptance watch
```

Run `watch` immediately after `start`: the planned question must be answered before
the five-minute idle host retirement if the test is to prove unchanged dirty inode
continuity. It stops after 30 minutes; inspect any real hold/question rather than
resetting it. Retry `start` with the same private output directory after an uncertain
create response. The journal retains the identical request. The standard Cloudflare
profile and every observed allocation must match the supplied runtime pin.

Then run the existing public Git probe above using this project's key and a separate
output directory, retain both approval commits via public fetch, and request cleanup:

```sh
run_native_acceptance drain
run_native_acceptance collect
```

Repeat `collect` through shutdown completion. Evidence files are private and retain
the exact API replies, paginated conversations, tool-result probe output and the
bounded read-only Main/Sandboxes observer. `acceptanceComplete` intentionally remains
false: a collected narrative or registry state is not a verified end-to-end result.
Before accepting, independently establish all of these joins:

- Every worker is a managed session on the expected Cloudflare release. Its probe's
  protected `launcher.launchId` matches that session's host reference; allocation,
  epoch, actual model grant, and runtime bootstrap belong to this test.
- The two planning visits have identical path/device/inode, HEAD/index tree, dirty
  status digest and canary digests across the owner pause. After design approval,
  the assigned path and canary persist and HEAD becomes the exact approval commit;
  an inode replacement at that explicit baseline change is allowed.
- Each reviewer is independent of its producer, has the exact submission parent and
  tree attached, and its actual probe demonstrates read-only kernel mounts, EROFS
  for worktree/Git writes, denied remount, and protected launcher identity. Publicly
  fetched approval commit parents/trees must match those frozen submissions.
- Planned stop has a completed durable capture and closed writer before the matching
  allocation/epoch shutdown acknowledgement; provider deletion follows that receipt.
  Join operation IDs and object hashes, not timestamps alone. Confirm the exact native
  instance is absent through the provider's read API; registry deletion alone is
  insufficient. Keep evidence, revoke the test key, and preserve retained Git refs.

**Remaining retry prerequisite:** there is no supported public operator endpoint to
drop a managed runner's receipt response after its commit. Repeating `fleet drain`
tests only operator request idempotence. A naturally observed lost-response retry, or
a separately authorized narrowly scoped one-shot fault on the test allocation's
receipt response, is required to prove that remaining gate on the deployed image.
Do not change global ingress or add an unscoped production fault hook to claim it.
The current executable path supplies the real workflow, observations and planned
stop; it does not claim that this missing retry proof has happened.
