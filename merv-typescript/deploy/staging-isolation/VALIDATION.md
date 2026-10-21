# Local preparation validation

Implementation commit `ab7887ac066ea535a0d60efd984e3c2a93a6f581` is based directly on parent
`080dc36c5a28ee09bb3939b17711d651ee4aea79`. Cherry-pick the implementation and this evidence
commit; neither draft 4273404 nor the duplicate guard commit is required.

- `npm run test:deploy`: 140 deployment tests pass, then 4 isolation tests pass with 5 database
  tests skipped, plus 10 Python recovery tests pass.
- `ISOLATION_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:56108/postgres npm run test:staging-isolation:pg`:
  all 9 isolation tests pass without skips, plus the 10 Python recovery tests pass. Only a disposable
  local PostgreSQL container is used. The history test uses actual pinned migrations and a real
  dump/restore. The relay test exercises delivery replay after commit-before-cursor interruption.
- The admission test uses real PostgreSQL triggers, a second connection for late command/warm
  admission, preserves an existing working command, drains naturally, and calls the real Pi
  shutdown method with the drained database state. This is not a live customer ingress test.
- Python tests cover durable handoff boundaries, SIGKILL between file-backed reader effects,
  exact local catalog application, identical-build source provenance, explicit verified outcome
  receipts, lost canary response/resume, terminal-attempt generation and successful replay.
  Reader SIGKILL tests use local service adapters, not actual remote Docker or Cloudflare.
- A local derivative of the existing immutable Main runtime packages the operator modules and
  successfully imports pinned DB, storage, account, billing and relay dependencies with
  `--network none`, without host mounts. This is an operator packaging preflight, not a build or
  acceptance of the required forward Main image.

Exact local log paths/hashes and preflight image ID are in `validation.json`.

## Pending parent operations and independent acceptance

The new SQL admission barrier and complete committed implementation need independent review.
Parent alone performs live host operations. Required inputs remain the dedicated staging-only
R2 bucket and durable bucket-scoped key with actual source/customer denial evidence; dedicated
DB/login and restored selected history/data; fresh vault/CA and gateway; reviewed forward Main
image; TLS/firewall reachability; exact two project links, budget and provider scope; offline relay
boundary; actual two-host receipts; authenticated historical downloads and cross-project denials;
real Pi reply, native observed stop and complete app inventories. Retain the launch fences until
those checks pass. No live deployment, credentials transfer, account grant, bucket creation or
provider mutation was performed by this implementation chat.

## Final-review correction evidence

The review of `8798982dd` found three defects not covered by the original suites: omitted job-log
manifest, non-replayable partial log publication, and missing canonical container names during
Compose replacement. The corrective follow-up fixes all three and adds the regressions recorded
in `corrective-validation.json`. Local checks now pass 140 deployment tests, 10 PostgreSQL
isolation tests (zero skips), and 11 Python recovery tests. Reader lifecycle tests accurately use
a Docker-state adapter at stop/remove/rename/start; log interruption uses an actual killed local
writer process. This corrective candidate awaits the independent reviewer's exact-commit retest.
The older validation/image receipt above applies only to the earlier candidate.
