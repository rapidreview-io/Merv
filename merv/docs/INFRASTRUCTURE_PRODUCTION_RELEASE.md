# ResearchSuite infrastructure budget release

Production cutover: 2026-09-10 UTC.

Merv now uses scoped consumer grants issued by the independent merv-sandboxes
service. merv-sandboxes owns budget administration, usage accounting, reservations
and enforcement. The services no longer share an infrastructure JWT secret.
Research authentication and project authorization remain in Merv.

## Production result

- A dedicated `researchsuite` owner administers `acct_researchsuite`. Six Merv
  users are mapped separately, with 29 project connections and 42 verified
  project/subject memberships. The existing `dev` account remains separate.
- The existing $50/day per-user Lambda default, $140/day Lambda project cap,
  $10/day GCP project cap, provider controls and retired native smoke limits
  were preserved. Host credentials are restricted to exact reviewed namespaces.
  Existing encrypted provider connections and native data volumes were retained.
- The native import retained two stopped smoke resources and terminal workflow
  attribution. There were no active legacy/native machines, jobs or workflows
  at the final freeze. No pending work needed new compute authorization.
- Verified history became 115 daily adjustments. The 91 incomplete closed
  historical records remain native usage gaps under the owner's approved
  deferral. They block overlapping finite budgets, including all-time caps;
  current configured daily/monthly windows are complete. They are not zero-cost
  charges. Resolving those records later requires supporting evidence.
- Final frozen legacy tables matched the reviewed snapshot exactly. No final
  usage delta was required. Native preview, apply and identical replay passed.
- Both public services returned HTTP 200 after maintenance was removed. Merv
  research schema is 60; native schema is 0024_unresolved_history. Spending was
  reopened only after native identity, policy and storage checks passed.

## Verification

The final release derives from Merv implementation `9b8a3284` plus licensing
commit `354c4184`, and native implementation `babe0dde` plus product document
`c7b9582`. Linux AMD64 images were built from committed source on the production
VM. The native control and worker use `merv-sandboxes-control:c7b9582`; Merv uses
`merv-control:354c4184`. Later release-documentation commits do not change these
runtime sources.

- Full suites: Merv 1,723 passed, 5 skipped and 1,527 subtests; native 623 passed,
  8 skipped. Packaged image/service checks: 3 passed. Post-typing-cleanup groups:
  native 75 passed; Merv 102 passed and 545 subtests. Native strict mypy, Ruff,
  UI build/lint, and agent/gateway Go tests passed.
- Real production databases were restored and migrated on an isolated network,
  including the production database roles. All 3,250 archived volume files were
  restored and hash-verified. Rehearsal containers were removed.
- Six shadow admission cases were reconciled. Two intended stricter denials
  reserve the full requested lease, whereas the old engine checked accrued
  usage only. Live native review reproduced the imported decisions without
  reserving resources or invoking cloud providers.
- All 42 deployed subject memberships authenticated through native HTTPS.
  Consumer access to administrator history/grants, unmapped subjects, and other
  project namespaces was denied. Dedicated owner login and native reports passed.
- Merv authenticated project, sandbox-list and compute-cost HTTP reads passed;
  the installed client forwarded the actual user subject. The temporary Merv
  verification key was revoked in cleanup.
- Preserved storage checks passed for 10 research artifacts and 31 workload
  objects, including all 26 recovered objects; 26,852,898 bytes were read.
  Small objects received full SHA-256 verification and the large object received
  a bounded range check. Inventory retained 4,422 complete artifacts and 740
  available workload objects. Existing 120 uploading records were not promoted.
- Delayed runner/wait identity, concurrency, grant revocation, denied renewal,
  independent-client enforcement, and cleanup while Merv is stopped have
  controlled integration coverage. This cutover created no paid cloud resources;
  it does not claim a new live cloud rental or a live runner workload was tested.

## Operations and recovery

The authoritative deployment record is root-private on ResearchSuite_Control at
`/home/azureuser/research-suite-vm/budget-cutover-9b8a3284`. It contains the reviewed
plan, original/final database dumps, volume/configuration backups, import receipts,
scoped connection file and verification results. `/etc/merv/budget-release.json`
points to this release and its `start-release.sh` launcher. Existing databases,
Hatchet and SSH gateway remain independently deployed; do not remove Compose
orphans when operating the application-only release files.

Keep the original databases/configuration/volumes and historical tables through
**2026-10-10 UTC at minimum**. Do not restore pre-cutover databases over new native
usage; use the documented reconciliation/forward-repair workflow once new
admissions exist. No historical tables or archived volumes were deleted.
Owner credentials and a complete copy of the cutover evidence are retained in
private local operator storage, outside Git. Paper work is also excluded from
this repository.

Both repositories consolidate on `codex/artifact-tool-consolidation`. The release
is promoted by fast-forward to `main` and `prod`. Merv has an authenticated GitHub
remote; merv-sandboxes currently has no Git remote, so its branch promotion is
local and its deployed source is retained on the VM.
