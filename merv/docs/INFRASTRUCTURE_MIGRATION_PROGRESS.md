# Infrastructure ownership implementation checkpoint

**Production update, 2026-09-10 UTC:** The ownership cutover is live. See
[the production release record](INFRASTRUCTURE_PRODUCTION_RELEASE.md) for deployed
checks, retained history and recovery details. Checkpoints below are historical.

2026-09-09. The objective remains the complete ownership migration in
[the plan](INFRASTRUCTURE_BUDGET_OWNERSHIP_PLAN.md), including a lightweight,
application-neutral service contract. This checkpoint is not a cutover approval
or a claim that the objective is complete.

## Implemented and checked

- Merv consumes sandbox-issued consumer grants. Its runtime does not read local
  allowances, calculate infrastructure charges, or send budget claims. Historical
  policy tables remain for offline migration and recovery.
- Native account/member/namespace policies, per-member defaults, provider controls,
  suspension, scoped reporting and administrator UI use one admission engine.
  Matching member overrides replace defaults without relaxing independent caps.
- The generic native importer preserves policies, prior adjustments, controls,
  subjects, resource attribution and pending workflow attribution. Account-scoped
  ID collisions require explicit distinct remappings. Preview rolls back; apply
  and identical replay are transactional. Imported charges retain twelve-place
  precision and cannot be future-dated.
- Merv's read-only exporter produces that public manifest, including inherited
  defaults, explicit overrides, UTC-day charges and explicit native-overlap
  reconciliation. Its conflict report prevents ambiguous data becoming a usable
  manifest. See [the operator guide](../deploy/BUDGET_MIGRATION.md).
- The pinned legacy quota engine now executes offline against projected snapshots.
  Its decisions are compared with native review and real service admission in all
  six policy/resource bridge scenarios. Applied final deltas verify the preceding
  native receipt and append only uncovered legacy intervals. Native imports can
  explicitly preserve unchanged grants and queued authority during history repair.
- A cross-project test exports SQLite, previews/applies/replays against real
  PostgreSQL, then exercises Merv's real HTTP client and an independent client
  against the same imported allowance. The provider is an in-process fake.
- Service reports preserve opaque application references for grouping imported
  costs by experiment. Merv sums returned amounts, without reconstructing charges.
  Reports include measured historical hours and explicitly flag incomplete
  duration coverage rather than inferring hours from monetary adjustments.
- Signed v2 wait links preserve the authenticated subject across later worker
  reads. Tampering/removing the subject fails before service lookup. Existing v1
  links retain their subject-free semantics and cannot invent a multi-member payer.
- Grant creation and policy/subject writes validate targets inside the account
  lock. Create/renew timestamps are taken after lock acquisition, including when
  waiting across UTC midnight. Regression tests exercise these races.
- Reference Compose mounts the consumer connection file as a secret. The native
  Compose stack no longer configures a Merv signing key. Composition and storage
  verifiers use explicit configured projects and consumer grants.

## Verification evidence

- Latest native full suite: **615 passed, 8 skipped**, in
  `/tmp/merv-native-cutover-full.log` (174.19 seconds), including
  receipt verification, authority-preserving repair, queued-grant revocation,
  fresh-process registry import and earlier accounting/admission coverage.
- Latest Merv full suite: **1713 passed, 1 skipped, 1523 subtests passed** in
  `/tmp/merv-cutover-full.log` (239.96 seconds), with the six real-service cases
  and the disposable Docker cutover rehearsal enabled. Additional image checks
  passed **2 tests** in `/tmp/merv-cutover-image-check.log` after that full run.
  The subsequent complete packaged-service restore check and both image checks
  passed **3 tests** in `/tmp/merv-packaged-cutover-final.log` (39.04 seconds).
  Existing short test HMAC keys and Starlette
  deprecation account for the 76 warnings.
- Cross-project exporter/service/client contract passed using a fresh database.
  The migration/accounting/auth/registry group passed 88 tests before the final
  concurrency cases; those cases passed in the 12-test accounting group and the
  native full suite.
- Both UI production builds passed. Native settings were inspected in a local
  browser: a default appeared as independent allowances for two members, and
  editing it to 12.5 updated both. Preview server/tab/database were removed.
- Docker Compose configuration resolution proved the private host file maps to
  `/run/secrets/merv_sandbox_connections`, with no JWT environment variable.
- Both current release images built. The packaged Merv client reads the private
  connection file under UID 10001 without the native SDK or old budget module;
  the native registry/importer load without the Merv package. Image IDs and
  requirement coverage are recorded in the
  [release audit](INFRASTRUCTURE_RELEASE_AUDIT.md).
- Actual release entrypoints now start against disposable restored databases as
  application owners without superuser rights. Merv migrates the full legacy
  research schema from 45 to 60, retains key authentication and research reads,
  and consumes native allowance through its sandbox tools. Native cleanup
  completes while Merv is stopped; restart and subsequent grant revocation pass.
- Targeted Ruff and both repositories' `git diff --check` passed.

## Remaining release requirements

1. Repeat the prepare/import/grant/finalize deployment sequence with the
   reviewed operational inputs and verify the complete packaged service restart
   against restored research/native databases, including database roles. Merge
   provider additions into native configuration without dropping unrelated
   instances. Exercise the hardened compute verifier only against the explicitly
   reviewed live offer and native allowance; its offline checks allocate no cloud
   resources and do not establish production readiness by themselves.
2. Validate deployed runner/wait behavior with the installed grant mappings.
   The source audit found durable runner and signed-wait identity, with no
   additional background infrastructure callers needing identity changes.
   Native queued provisioning persists and revalidates the submitting grant.
3. Verify all active quotas against reviewed operational inventories. Concurrent
   resources, total lifetime, hourly price, cumulative money and compute hours now
   have native enforcement and export paths. Live-resource/lifetime mappings must
   be reconciled; dormant storage values remain explicit in the report.
4. Run shadow decision comparison and final-delta reconciliation against reviewed
   deployment snapshots. Transactional interruption/replay and post-admission
   repair pass the disposable service bridge. Docker backup/restore and HTTPS
   activation recovery also pass with fixtures; operational data reconciliation
   and deployment-specific restore/startup are still required.
5. Review real ownership/policy inventories and operational cutover inputs. No
   production imports, cloud rentals, service restarts, commits or pushes were
   performed during this checkpoint. Retain historical data through a defined
   recovery window; retire remaining compatibility only after reconciliation.
6. Close the operational gaps identified in the requirement-by-requirement
   release audit and retain evidence against the chosen release tree. Passing
   local tests do not establish untested deployment operations.

## Queued authority and provider scope checkpoint

- Migration 0020 adds a saved workflow grant ID and explicit offline migration
  authorization. New workflow submissions bind the authenticated member/grant;
  consumer bodies cannot set these authority fields, and responses omit them.
- New workflow reservations reread and lock both the workflow and its grant in
  the admission transaction. Revocation, expiry, disabled members, suspension,
  cancellation and withdrawn migration approval prevent new compute. No bearer
  secret or budget snapshot is stored with queued work.
- A lost reservation response recovers the accepted machine even after grant
  revocation; a later provision node is denied and existing resources clean up.
  Idempotent workflow replay preserves the original grant and payer.
- Renewal now revalidates its requesting grant in the reservation transaction,
  while retaining the resource's original payer. A disabled requesting member
  cannot renew another member's resource.
- The importer clears old workflow grants and requires explicit
  `authorize_pending_compute` approval for remaining rentals. Preview and apply
  report the approved and blocked pending workflows. Old rows default to no
  inferred authority. Documentation includes the worker restart/review sequence.
- Native provider configuration accepts exact `namespaces` lists, including an
  empty list that exposes a host credential to no tenant. Prefix and exact
  selectors cannot be combined. This is the generic prerequisite for replacing
  the old Merv-prefix staging configuration; the staging script itself still
  needs replacement.
- Expanded workflow/auth/accounting/import/API/provider regressions passed
  **134 tests, 1 skipped** (`/tmp/merv-workflow-authority-expanded.log`). Final
  workflow/MCP/registry/permissions/job checks passed **62 tests**
  (`/tmp/merv-workflow-authority-final.log`). Exact provider scope and related
  provider/deployment checks passed **37 tests**
  (`/tmp/merv-exact-provider-scope-tests.log`). Merv client, remote sandbox/wait,
  and real service bridge checks passed **46 tests**
  (`/tmp/merv-authority-client-checks.log`).
- The final native full suite passed **563 tests, 8 skipped** in 158.56 seconds
  (`/tmp/merv-native-authority-full.log`), covering migration 0020, queued
  authorization, renewal authorization and exact provider namespace selection.
  Targeted Ruff and both repository diff whitespace checks passed. No production
  imports, service restarts, cloud rentals, commits or pushes were performed.

These changes do not complete the cutover tooling, legacy quota mapping, final
delta reconciliation, recovery rehearsal or operational release requirements.

## Staging and native provider-import checkpoint

- Replaced JWT staging with `prepare` and `finalize`. Preparation retains private
  backups, uses reviewed project/namespace mappings and exact host-provider
  scopes, preserves Merv artifact settings, and emits provider additions without
  replacing the existing native provider list. It creates no consumer token.
- Finalization verifies every reviewed subject through the native `/auth/me`
  endpoint after owner grant issuance. Account, member, application, namespace
  and consumer role must match. It atomically publishes private activation files
  only after all checks pass. Incomplete preparation, changed plans and existing
  activation outputs are rejected. The helper performs no import or restart.
- Moved provider credential import into generic native `sbx providers import`;
  deleted Merv's namespace-prefix-specific importer. Native preview rolls back,
  apply is atomic, matching entries replay without changing timestamps and
  conflicting keys cannot be overwritten. Suspended account ownership and
  disabled provider controls are enforced. New keys remain unverified; import
  does not contact cloud providers. CLI failures omit credential-bearing details.
- Replaced current cutover/smoke instructions with the consumer-grant procedure.
  Old storage details remain explicitly historical. The current smoke guide calls
  out the older compute verifier's remaining preflight and cleanup deficiencies.
- Staging/Compose checks passed **10 tests**, including actual local Compose
  interpolation and rendering (`/tmp/merv-staging-compose-verified.log`). The
  broader deployment/export/verifier group passed **42 tests and 22 subtests**
  (`/tmp/merv-staging-final-checks.log`). Native import/vault/provider checks passed
  **19 tests**; final import and CLI checks passed **8 tests**
  (`/tmp/merv-provider-import-final.log`).
- The native full suite passed **570 tests, 8 skipped** in 168.44 seconds
  (`/tmp/merv-native-provider-import-full.log`). The additional unexpected-CLI-error
  redaction case was verified separately in the 8-test import group. The final
  staging checks passed **10 tests** (`/tmp/merv-staging-final-tests.log`). Targeted
  Ruff and both repository whitespace checks passed. Docker was used only to
  parse/render local test Compose configuration; no production changes occurred.

The staged artifacts are reviewable inputs, not evidence that production has
switched. Final accounting deltas, populated legacy quotas, complete recovery
rehearsal, installed-secret verification and operational cutover remain unfinished.

## Exact compute-verifier cleanup checkpoint

- Both configured consumer connections and their distinct actual namespaces are
  validated before provisioning. The facade's create idempotency key is recorded
  before submission; cleanup recovers only that key and rejects missing or
  conflicting receipts. It never retries provisioning automatically.
- Each output job has a unique, pre-recorded name. Cleanup recovers its native
  workflow, verifies the VM and job association, cancels that workflow if needed,
  waits for terminal state, and deletes only snapshots attributed to that job on
  that machine. Unrelated resources, including snapshots on the same VM, remain
  untouched. Receipt conflicts fail closed and retain recovery identifiers.
- Cleanup independently attempts certificate revocation after resource/output
  failures. The SSH response has a 60-second deadline. The verifier checks the
  service-reported cost of its own resource rather than unrelated namespace
  monthly spending; reports describe an estimate, not a cloud invoice guarantee.
- Deployment/verifier checks passed **46 tests and 22 subtests**
  (`/tmp/merv-compute-verification-final.log`), including invalid secondary grants,
  concurrent unrelated resources, lost create/job responses, receipt conflicts,
  snapshot deletion failure and SSH timeout. Current smoke instructions describe
  the fixed offer/lease bounds and required native allowance setup.
- [Verified legacy quota notes](INFRASTRUCTURE_QUOTA_MIGRATION_NOTES.md) record
  the actual pre-removal semantics. The misleading GPU-hours field measured
  wall-clock compute hours; the blob quota was a schema-only placeholder. Native
  quota work must follow those facts rather than infer behavior from field names.

No live compute was requested. Quota implementation, final-delta reconciliation,
recovery rehearsal and operational release verification remain unfinished.

The final Merv full-suite run passed **1637 tests and 1511 subtests**, with one
skip, in 201.37 seconds (`/tmp/merv-full-compute-verifier-check.log`). Targeted
Ruff and diff whitespace checks passed. Native runtime code was unchanged in
this checkpoint; no cloud rentals, production imports or restarts occurred.

## Cumulative allowances and Merv key simplification

- Native migration 0021 permits `all_time` policies in the existing policy table.
  Creation and renewal use the same account lock, ledger, adjustments and
  reservation calculation as daily/monthly budgets. Cumulative allowances include
  imported usage predating account creation, never reset, and expose null window
  boundaries. Native settings offers an all-time option. Generic inventory and
  import preserve it without application-specific code.
- Native coverage checks old imported usage and stopped resources across years,
  replay without duplicate costs, renewal replacement, independent calendar caps,
  default/member overrides, concurrent namespaces, unpriced offers, suspension
  and two application grants sharing one allowance. The focused native group
  passed 27 tests; the full result is recorded above. The native UI production
  build passed in `/tmp/merv-native-cumulative-ui-build.log`.
- Merv's exporter now projects `sandbox_generations.tenant_id` because the legacy
  cumulative ledger used that saved attribution. A `tenant_accounts` mapping and
  complete tenant/project/generation scope are required for cumulative USD export.
  Incomplete historical attribution and combined tenants block conversion.
  Dormant blob quota values remain visible in the report without inventing new
  enforcement. The report explains reservation of future usage as an intentional
  change from legacy accrued-only admission.
- The exporter/real-service bridge is parameterized for daily and all-time limits;
  its group passed **18 tests** in `/tmp/merv-cumulative-export-tests.log`, including
  SQLite inventory, native preview/apply/replay and both real client adapters.
- Removed unused key ceilings from the Merv key model, create/rotate arguments,
  SQL insertion, authenticated principal and OAuth/gateway plumbing. HTTP rejects
  attempts to set even null/zero infrastructure ceilings and directs users to
  merv-sandboxes. Historical columns remain untouched for recovery. Existing keys
  authenticate and rotate without copying or advertising dormant values.
- Key/OAuth/session/pairing/gateway checks passed **103 tests and 42 subtests** in
  `/tmp/merv-key-simplification-tests.log`. A subsequent stronger runner check
  rebuilds the HTTP gateway/key lookup after session claim, observes the original
  subject on the later native job request, and verifies parent revocation prevents
  any native request. That group passed **19 tests and 5 subtests** in
  `/tmp/merv-delayed-key-subject-tests.log`.
- New native and exporter files pass targeted Ruff; both repositories pass
  `git diff --check`. The broader pre-existing Merv auth/session files have existing
  lint findings; comparison against HEAD found no new findings from the key
  simplification. Do not describe those whole files as lint-clean.

Compute-hour accounting and remaining resource quotas, full shadow comparison,
final-delta recovery and the operational release gates remain incomplete. This
checkpoint does not establish production readiness or authorize reopening
admission on unresolved accounts.

## Compute-hour accounting and reviewed historical enrichment

- Native migration 0022 adds `metric=compute_hours` to the existing policy table
  and nullable measured hours to historical adjustments. Monetary policies remain
  the default and retain their currency/precision semantics. Hour policies have
  no currency, support all scopes/windows, and use the same admission lock,
  lifecycle intervals and renewal replacement as money. CPU, free and unpriced
  resources count wall-clock hours without GPU multiplication. Money and hour
  policies apply independently, including member/default override matching.
- Missing historical duration stays unknown. Finite matching hour policies reject
  admission, while administrator usage returns partial accrued hours, a coverage
  flag and an unresolved available balance. Scoped reports include measured
  adjustment hours, daily hours, known reserved hours and unknown-history/horizon
  counts. Private evidence remains outside consumer reports.
- Generic `hour_resolutions` records owner-reviewed evidence when an offline import
  fills a previously unknown adjustment duration. It cannot change money, payer,
  source, provenance or an already measured duration. Preview rolls back the
  enrichment and apply/replay retain one entry. New-default serialization preserves
  unchanged pre-0022 import receipt hashes; measured hours require a new batch.
- The Merv exporter converts the historically named `gpu_hours_budget` into native
  cumulative compute-hour policies after complete tenant attribution checks. It
  exports twelve-place historical hours on the same non-overlapping daily intervals
  as monetary adjustments. Merv only groups returned hours and forwards coverage;
  it has no hour-policy store or admission calculation.
- The optional real-service bridge now exercises daily money, cumulative money
  and cumulative hours with Merv and an independent client. Export/bridge/report
  checks passed 38 tests in `/tmp/merv-hour-export-tests.log`. After extending
  reserved-hour reporting, the Merv report/bridge group passed 20 tests in
  `/tmp/merv-hours-reporting-bridge-final.log`; the native report/accounting group
  passed 44 tests in `/tmp/merv-hours-reporting-final.log`.
- Native UI build passed in `/tmp/merv-native-hours-ui-build.log`. In a disposable
  local deployment, browser checks created a 3.5-hour all-time allowance, verified
  its saved metric/window/null currency, showed “Needs reconciliation” after an
  unmeasured opening entry, and edited the allowance to 4 hours without losing its
  metric. The browser tab, server and disposable database were removed.
- Targeted native and exporter Ruff checks and both repositories' diff checks
  pass. The full-suite results above precede only the final reserved-hour reporting
  addition and equivalent explicit admission-rate branch; the final focused
  accounting group passed **71 tests** in `/tmp/merv-hour-accounting-final.log`.

Remaining work is the generic concurrent-resource, total-lifetime and hourly-price
quota implementation/export, complete shadow reconciliation, final-delta and
interrupted-cutover recovery, reviewed operational inputs and release audit. No
cloud resources, production imports, commits, pushes or service restarts occurred.

## Native resource ceilings and live-resource migration

- Migration 0023 adds generic resource limits and a preserved lifetime origin
  independent of accounting timestamps. Account/member/namespace constraints,
  optional provider/source filters, concurrency, total lifetime and explicit
  currency/hourly price run in the existing account admission transaction.
  Committed provisioning occupies a slot until confirmed stop, failed deletion
  stays counted, renewal does not add a slot, and idempotent replay does not
  reserve again. Unattributed potentially matching live resources block capped
  admission instead of disappearing from the count.
- Native owner REST and settings UI can manage these constraints. Consumer
  credentials cannot read or change the account's limit configuration. Every
  independent constraint applies; a child unlimited value cannot relax a parent.
  Known free prices differ from unknown prices and currency mismatch. Public
  denials omit shared occupancy and private amounts.
- Generic inventory and import preserve resource constraints and lifetime origins.
  Colliding IDs require distinct explicit remappings. Reviewed earlier origins
  can be imported with private evidence; ownership transfer cannot advance or
  reset the clock. Preview rolls back, apply/replay preserve one representation,
  and default new fields preserve previous import receipt fingerprints.
- Merv's exporter now projects the legacy sandbox lease metadata and converts all
  three resource ceilings after complete tenant-scope checks. Every live legacy
  resource under a resource ceiling needs a distinct reviewed native mapping.
  The original extension code establishes its origin as saved expiry minus saved
  lifetime allowance. The exporter emits earlier-origin resolutions or reports
  a stricter preserved native origin. Missing, collapsed, stopped or conflicting
  resource mappings block conversion. Dormant storage configuration remains a
  reported historical value, not a newly activated policy.
- The bridge now tests daily money, cumulative money, compute hours, concurrency,
  lifetime and hourly price through real Merv/native adapters. It caught Merv
  dropping new denial reasons; the thin client now forwards the stable reason
  codes while keeping upstream private details redacted. It adds no policy
  storage, accounting or admission calculation to Merv.
- Native full suite passed **601 tests, 8 skipped** in
  `/tmp/merv-native-resource-limits-full.log` (186.67 seconds). Coverage includes
  simultaneous admissions across namespaces, replay, renewals, delayed deletion,
  scope/provider filters, account isolation, a target-ownership race, missing
  attribution, import collisions, lifetime reconciliation and consumer denial.
- Export/bridge/client checks passed **54 tests** in
  `/tmp/merv-resource-export-bridge-final.log`. Additional exporter assertions
  reject rewriting a known lifetime origin or collapsing two legacy resources
  into one native slot; that group passed **23 tests** in
  `/tmp/merv-resource-export-final.log`.
- The full Merv suite passed **1658 tests, 1 skipped, 1517 subtests** in
  `/tmp/merv-resource-limits-full.log` (215.46 seconds), with 76 existing test-key
  and Starlette warnings. The extra exporter assertions above passed separately
  after the full run started; no later runtime changes were made.
- Native UI production build passed in
  `/tmp/merv-native-resource-limits-ui-build.log`. A disposable browser deployment
  created and edited all three ceilings, verified saved values and distinct
  zero/unlimited semantics, and was visually inspected. Its tab/server/database
  were removed; database absence was verified. Targeted Ruff and both repositories'
  diff checks pass.

Complete shadow comparison, final-delta and interrupted-cutover/forward-repair
rehearsal, reviewed operational inventories and the final release audit remain.
No production imports, cloud rentals, commits, pushes or production restarts were
performed. The goal remains active.

## Native admission review and offline comparison

- Native `sbx account review` evaluates independent cases using the real billing
  and resource admission code plus namespace/default lease controls. It creates
  no compute reservations, performs no provider calls and starts no workers.
  Creation uses reviewed offer facts; renewal reads the saved payer, offer and
  lifetime origin. Grant authentication and provider capacity are explicitly
  outside this policy-only review.
- Review runs against a repeatable-read snapshot under the account lock. A
  private inventory, lease controls, service defaults, evaluation time and
  canonical JSON input/request/state digests accompany the results. Concurrent
  cleanup between cases cannot change the snapshot. Shared monthly-default
  seeding was factored into `BillingService.ensure_monthly_policy_in` so review
  and real admission agree even before the namespace's first rental.
- The optional spending-enabled assumption runs inside a savepoint and always
  rolls back, as do seeded defaults. A proposed import can be reviewed inside its
  rollback-only preview; combining review and apply is rejected. An already
  applied batch must be reviewed as current state instead of returning a stale
  receipt. Private CLI reports refuse overwrite and redact invalid input content
  and database errors from terminal diagnostics.
- Merv's new offline `compare_infrastructure_admission.py` compares recorded
  legacy outcomes without implementing a budget calculation. It validates native
  evidence digests, requires identical case sets and evaluation times, and binds
  each legacy decision to its mapped native request. Changed decisions require
  explicit evidence bound to both complete reports, snapshot/request hashes and
  outcomes. Changed inputs/reasons and unused approvals invalidate reconciliation.
  Its result is deliberately scoped to the recorded cases.
- The real-service bridge now compares each actual native HTTP denial with a
  non-reserving review and verifies CLI-style JSON evidence through the Merv
  comparator, across all six budget/resource scenarios. These are explicitly
  labeled protocol fixtures, not purported legacy-engine executions.
- Native full suite passed **607 tests, 8 skipped** in
  `/tmp/merv-native-admission-review-full.log`. The initial review/import/admission
  group passed 44 tests, and snapshot/CLI additions passed 46 tests in
  `/tmp/merv-admission-review-focused.log`. Merv comparison unit checks passed
  11 tests in `/tmp/merv-admission-comparison.log`; the cross-project group passed
  40 tests in `/tmp/merv-shadow-review-bridge.log`.
- Inspecting the real legacy quota source found an exporter defect: the reserved
  global spending halt is `__global__`, not `global`. Export and tests now use
  the source-defined value and distinguish an ordinary tenant called `global`.
  The current projection also captures payer, charge source, quoted price and
  generation creation order needed by a future faithful legacy replay. The final
  exporter/comparison/bridge group passed **44 tests** in
  `/tmp/merv-shadow-projection-final.log` after these changes.
- Full Merv suite passed **1673 tests, 1 skipped, 1519 subtests** in
  `/tmp/merv-shadow-review-full.log` (215.20 seconds), with the same 76 existing
  test-key/Starlette warnings. Final targeted Ruff and both repositories' diff
  checks passed. No UI change required a new visual build in this step.

Remaining: execute the pinned legacy engine
`55c1a1c894bdf83b7f32b2389002b46528329487` against the reviewed snapshot and
reconcile its recorded decisions; implement final-delta import and interrupted
cutover/forward-repair rehearsal; obtain reviewed operational inventories and
complete the release audit. No production state or cloud resources were changed.

Final-delta implementation must distinguish an unapplied rehearsal (fresh full
conversion) from an applied batch (preserve installed entries and append only
uncovered usage). Validate prior export hashes and authoritative native coverage;
reject changed payer/source/rate, overlapping credits, missing history or a
shortened already credited interval. Preserve native policy edits after authority
has switched rather than overwriting them with stale legacy configuration.
Existing importer preservation checks currently reject duplicate/changed entries;
they are not a final-delta implementation. Keep any source-specific interval
reconciliation offline in Merv, with a generic native import format and one ledger.

## Pinned legacy replay and final-delta recovery

- `deploy/replay_legacy_admission.py` now executes the actual pinned quota module
  and store methods against a disposable SQLite projection. It fixes evaluation
  time to the native review, checks request/payer/provider/resource mapping and
  input digests, blocks worker network/subprocess use, and rolls back each case.
  Source and evidence hashes accompany private output. It does not import old
  application surfaces or start migrations. The initial test exposed macOS's
  `/var` symlink in the archive traversal guard; both paths are now canonicalized.
- The six real-service bridge scenarios now use actual legacy executions.
  Daily, concurrency, lifetime and hourly-price denials agree. Cumulative money
  and compute-hour cases demonstrate the intended difference: native admission
  reserves future usage whereas the old cumulative gate checks accrued usage.
  Separate replay checks cover reserved global/tenant halts, original caller
  unknown-price semantics, saved-payer renewal, default overrides and invalid
  mappings. The scope is the quota gate, not upstream provider/authentication.
- `deploy/export_infrastructure_delta.py` distinguishes applied imports from
  unapplied rehearsals using the actual native receipt. It verifies the prior
  export and source evidence, checks immutable generation facts and installed
  charge attribution, subtracts credited intervals and native overlap, and adds
  only uncovered usage. Native inventory must be at least as recent as the source
  cutoff. Lost/shortened/overlapping history, changed source policies or ownership,
  invented base charges and changed receipts block output. Rounding differences
  from interval splitting remain explicit; installed entries never change.
- Delta export retains current native policies and controls, including subsequent
  native edits. Its native schema/receipt codec dependency is confined to this
  offline operator utility; Merv's runtime dependency and connection contract
  remain unchanged. The native inventory adds generic import receipt metadata,
  and `manifest_fingerprint` centralizes the existing receipt codec. A source
  converter aliasing defect was fixed so later resolution-map edits cannot mutate
  previously retained evidence in memory.
- Generic `preserve_existing_authority` imports require unchanged namespace
  ownership/default members, compute payer/source, and workflow authority, with
  no identifier remapping. They preserve grants, queued grant references and
  existing policy/limit timestamps. They do not turn a queued grant into operator
  authority or bypass later revocation. Default ownership migration behavior and
  pre-hour-accounting receipt hashes remain compatible.
- A disposable PostgreSQL bridge now performs final-delta preview, interruption
  before commit, successful apply and identical replay after native admissions.
  It verifies preserved resources, grants, provider connections and an independent
  native policy edit. Native workflow tests verify queued continuation and later
  revocation; ownership-change attempts roll back atomically. This is transactional
  recovery evidence, not a full deployed backup/activation rehearsal.
- Native full suite passed **614 tests, 8 skipped** in
  `/tmp/merv-native-delta-full-final.log`. The first run found that the old-receipt
  test fixture accidentally included the new flag; the fixture now reconstructs
  the historical shape and also proves enabling preservation changes the hash.
  The corrected import/hour/workflow/review group passed **45 tests** in
  `/tmp/merv-native-delta-final.log` before the final full run.
- Merv full suite passed **1695 tests, 7 skipped, 1521 subtests**, with the same
  76 existing warnings, in `/tmp/merv-delta-full.log`. The six optional native
  cases passed separately. Replay/export/comparison/bridge passed **72 tests** in
  `/tmp/merv-delta-shadow-focused.log`; the final export/bridge group, including
  rounding, private CLI output and stale inventory, passed **49 tests** in
  `/tmp/merv-delta-export-final.log`. Final targeted Ruff and both diff checks pass.

Remaining: full disposable deployment prepare/backup-restore/import/provider/
grant/finalize/activation recovery rehearsal; reviewed real ownership and policy
inventories plus operational shadow/delta reconciliation; audit of delayed Merv
callers and every release requirement against the stable tree. No production
imports/restarts, cloud rentals, commits or pushes were performed. The goal stays
active; passing these checks is not a release or cutover approval.

## Docker recovery, release packaging and caller audit

- Staging now accepts a complete explicit deployment source map for containers,
  databases, volumes and files. Incomplete custom maps fail before side effects;
  they cannot fall through to the default deployment. Volume backups use an
  inspected cached image and a read-only Docker mount, including on Docker
  Desktop. Missing volumes are rejected rather than silently created.
- Preparation records byte counts and SHA-256 digests for every artifact.
  Finalization verifies them before making authentication requests. Changed,
  removed or old unsealed preparation is rejected. Existing private outputs and
  transactional activation behavior remain intact.
- A real disposable Docker rehearsal dumps/restores both PostgreSQL databases
  and data volumes, preserves fixture research data, native resource/job IDs,
  encrypted vault values and retained output bytes, then runs account/provider
  preview/apply/replay, fresh owner grant issuance and HTTPS finalization. It
  exercises interrupted preparation, rejected old grants and interrupted
  activation publication. Merv's actual client reads restored output and obeys
  an owner-edited allowance shared with an independent application.
- The rehearsal exposed a native registry/jobs import cycle hidden by the usual
  test import order. Moving the annotation-only registry import under
  `TYPE_CHECKING` fixes standalone import. A fresh interpreter regression and the
  native full suite pass.
- Both real Dockerfiles build; the native build includes the UI production
  build. Isolated packaging checks verify Merv's default UID reads the correctly
  owned mode-0600 connection file through a read-only bind mount, and neither
  release package depends on the other application's Python module. These checks
  construct/import components; they do not start the complete services.
- The delayed-caller audit traces both MCP transports, HTTP routes, runner
  session persistence, signed wait execution and workflow delivery handlers.
  Existing tests verify saved runner identity after composition reconstruction,
  source-key revocation before native lookup, wait tamper rejection and executor
  context reset. No new infrastructure caller requiring policy or identity
  duplication was found. Details are in the release audit.
- Docker rehearsal/staging checks passed **19 tests** in
  `/tmp/merv-docker-cutover-integrated.log`. Native full coverage passed
  **615 tests, 8 skipped**; Merv full coverage with the optional bridge/rehearsal
  enabled passed **1713 tests, 1 skipped, 1523 subtests**. The two additional image
  checks passed separately. Current totals and artifact IDs appear above and in
  the release audit.

The uniquely named rehearsal resources were cleaned up; the existing test
database and unrelated Docker resources remain. The two current release images
are retained locally. No production imports/restarts, real cloud rentals, commits
or pushes occurred. Real deployment inputs, data reconciliation, packaged service
startup and bounded operational verification remain required.

## Full packaged-service restore checkpoint

- Added `tests/infrastructure/test_packaged_cutover.py`, enabled by the existing
  image rehearsal opt-in. It creates a full research database using the cached
  older Merv package, plus a native database and data volume, then dumps/restores
  both under non-superuser application owners on an internal Docker network.
  No host ports are published. Both current images run their actual entrypoints;
  the native lifecycle worker remains enabled.
- Merv upgrades the restored research schema from **45 to 60**, authenticates an
  existing project key, and serves retained project/experiment rows. Its actual
  `sandbox.request` succeeds using native allowance despite a retained local
  zero cap and an old key ceiling below the requested lease. A multi-member
  consumer grant exercises authenticated subject forwarding.
- A native budget edit to zero blocks independent-client creation and Merv
  renewal. With Merv stopped, native deletion reaches confirmed stop. Merv then
  restarts with the same private credential file and serves retained research
  and native usage. Native grant revocation returns a structured permission
  denial on the next Merv infrastructure read.
- Source and restored legacy caps/key fields remain unchanged. Application
  database roles retain no superuser, create-role or create-database privileges.
  The test writes private evidence containing image IDs and schema versions.
- The full packaged check plus the two component image checks passed **3 tests**
  in **39.04 seconds**, `/tmp/merv-packaged-cutover-final.log`. Fixture errors
  uncovered during development were corrected against the actual schemas and
  HTTP contracts; no additional runtime change was required. Targeted Ruff and
  repository whitespace checks pass. All uniquely named fixture resources were
  removed; cached images and unrelated resources remain.

Remaining operational inputs are unchanged: the deployment target and reviewed
ownership/provider/live-resource mappings are needed for real inventory and
shadow/final-delta reconciliation, provider verification and cutover. The
packaged fixture uses the native fake provider and does not access research R2
bytes or managed Supabase authentication. No production import/restart, real
cloud rental, commit or push was performed.

## Real production discovery and restore

The deployment target is now known and reachable. Read-only production discovery
and private backups cover both databases, active configuration overlays and
native/management volumes. The user approved a dedicated ResearchSuite native
owner account with separate mappings for the six Merv users; `dev` stays separate.

Actual production dumps restored and migrated successfully in isolation: Merv
schema 59 to 60 with 29 projects and 254 experiments retained, plus native schema
0012 through the current migrations. Application-role preflight and cleanup
passed. No application or lifecycle workers ran on these real data copies.

The deployment staging tool now retains explicitly selected additional config
files and Merv's existing upload size ceiling. All 22 staging checks pass.
Production remains unchanged. The remaining accounting issue is 91 historical
generation records with incomplete verified attribution/price, all ending in
July. The private ownership proposal and unresolved source records are retained
for reconciliation; final import/cutover and the authorized branch merges remain
pending. See the release audit for evidence and the boundary of each check.
