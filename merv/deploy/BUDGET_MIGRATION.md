# Move legacy budgets into the infrastructure service

The exporter is an offline Merv deployment tool. It reads Merv's legacy tables
and produces the public merv-sandboxes account-import format. merv-sandboxes does
not import Merv modules, query its database, or interpret research objects.

This tooling does not perform a production cutover. Keep new admissions and
policy edits frozen during the final inventory, conversion, native preview and
apply. An earlier inventory is suitable for rehearsal, not final reconciliation.
Existing service-managed jobs and lease cleanup continue during an admission
freeze. Retain both databases and the reviewed artifacts for recovery.

## Capture inputs

Use a stable deployment identifier across rehearsal and final exports:

```sh
python deploy/export_infrastructure_budgets.py inventory \
  --postgres-env MERV_DB_URL --source-id my-deployment \
  --output legacy-budget-snapshot.json
```

For SQLite, replace `--postgres-env MERV_DB_URL` with `--sqlite /path/to/state.sqlite`.
The exporter uses one read-only transaction and fixed column projections. It
never exports provider credentials, API keys or command environments. Output
files are mode 0600, refuse overwrite, and still contain private user/usage data.
It requires the legacy policy/accounting columns present in Merv's current
schema; an incompatible source schema fails rather than treating missing policy
as unlimited. PostgreSQL uses the existing Merv control dependency, psycopg.

On the native service, suspend each affected account and capture its inventory:

```sh
sbx account inventory acct_existing --config service.toml --output native-account.json
```

Prepare a version-1 native base manifest according to the service's account-import
contract. It must explicitly preserve existing native policies, resource limits, adjustments,
provider controls, subject bindings, all resource attribution and pending workflow
attribution. Declare every namespace that shares a source account's budgets.
List native namespace owners explicitly. New destination members need distinct
IDs and explicit old-to-new mappings where native identities already exist.

## Resource ceilings and live leases

The current snapshot also projects legacy sandbox status, provider, saved lifetime
allowance and expiry. Regenerate older snapshots missing that projection; it is
needed to prove that live resources remain counted after migration. It does not
include resource commands, SSH material or provider secrets.

Concurrent-machine, total-lifetime and hourly-price tenant ceilings convert to
native account resource limits after the same complete tenant/account scope
checks as cumulative budgets. If any resource ceiling applies, every legacy
resource in provisioning, running or cleanup-pending state needs a reviewed entry
in `mapping.resources`:

```json
{
  "resources": {
    "legacy-sandbox-uid": {
      "native_sandbox_id": "sbx_existing",
      "evidence": "Operator verified the provider resource and saved lease"
    }
  }
}
```

The corresponding native resource must be live, explicitly attributed in the
base manifest, in the mapped namespace, and on the mapped provider. Multiple
legacy resources cannot collapse into one native concurrency slot. Missing or
inconsistent mappings block conversion.

The legacy extension path increments both `time_limit` and `expires_at` by the
requested extension. Its preserved lifetime origin is therefore
`expires_at - time_limit`, not an inferred generation accounting timestamp.
For a pending resource without saved expiry, the mapping must include a reviewed
`lifetime_started_at`. The exporter emits native `lifetime_resolutions` if the
legacy origin predates the native origin. If the native origin is earlier, it
keeps that origin and reports the stricter allowance: adoption must not reset an
already running lifetime clock. A conflicting base-manifest resolution blocks
conversion. Save these decisions with the migration review.

Native hourly-price checks reject unknown prices even if the old caller omitted
its unknown-price flag. The report records this intended tightening. Merv does
not reproduce any of these checks at runtime.

## Review the Merv ownership map

```json
{
  "version": 1,
  "source_id": "my-deployment",
  "application_id": "my-research-application",
  "tenant_accounts": {"merv-tenant-id": "acct-destination"},
  "projects": {
    "project-id": {
      "namespace": "research-project",
      "default_member_id": "member-example"
    }
  },
  "users": {"merv-user-id": "member-example"},
  "providers": {"lambda_labs": "lambda"},
  "generations": {}
}
```

Provider values are native plugin IDs, not connection aliases. Confirm them in
the target inventory/provider catalogue. The service creates no identity from an
untrusted subject header; the manifest contains the approved subject bindings.
Merv later stores only its service URL, consumer credential and namespace mapping.

`tenant_accounts` explicitly approves moving a tenant's cumulative allowance to
the named native account, including that account's future namespaces. It is
required when a populated `usd_budget` or `gpu_hours_budget` is exported. Select every project belonging
to that tenant; do not combine independent tenants into one account ceiling.
The snapshot must include each generation's saved `tenant_id`. Missing attribution,
departed projects with retained tenant usage, or incomplete project selections
block conversion and need explicit reconciliation, not inferred ownership.

Every current project member needs a user mapping. Every existing generation
needs a known payer, charge source, price and interval, or an explicit resolution
with evidence. Missing price is not treated as zero. Example resolution:

```json
{
  "member_id": "member-example",
  "source": "host",
  "hourly_rate": "1.25",
  "ended_at": "2026-09-08T12:00:00Z",
  "evidence": "Reviewed provider receipt, retained with this migration"
}
```

Save the resolution under the generation's ID in `generations`. Known payer,
source, price or stop time cannot be changed by a resolution. An open legacy
generation without a reviewed stop time requires adoption into native accounting
before it can migrate. To reconcile adopted runtime, provide `native_sandbox_id`
and evidence. The exporter verifies native namespace, payer, source, plugin,
price and interval; it imports only the preceding, uncovered usage. This prevents
double-counting an interval already in the service ledger.

An owner may explicitly defer incomplete **closed** history for reconciliation
inside the native service. Set `mapping.deferred_generations` to a mapping from
each generation ID to its approval evidence. The exporter retains each source
record as a generic native `usage_gaps` entry, preserving every known field and
the interval; it does not manufacture a payer or a zero-cost adjustment. Complete
charges, open intervals, possible native overlap and simultaneous deferral and
resolution are rejected. All other records still undergo normal strict conversion.

The native service reports incomplete history and blocks finite budgets whose
scope and window could include a gap. Old gaps outside current daily/monthly
windows do not block those windows. Unknown members/providers match conservatively;
an all-time allowance cannot silently ignore them. Later reconciliation uses
native `history_resolutions` with verified attribution, hourly price and evidence.
It atomically books daily adjustments and preserves the original record. Delta
export retains deferred records and refuses changes to their original evidence;
resolve them through the native importer, not by rewriting legacy history.

## Convert and reconcile

```sh
python deploy/export_infrastructure_budgets.py convert \
  --snapshot legacy-budget-snapshot.json --mapping approved-map.json \
  --base-manifest native-base.json --native-inventory native-account.json \
  --output-dir budget-rehearsal
```

Repeat `--native-inventory` for additional source accounts. The new output directory
is mode 0700. `report.json` records input hashes, policy decisions, native overlap,
research associations, suspension requirements and conflicts. With no conflicts,
`account-import.json` contains the candidate native import. With conflicts, exit
code 2 is returned and no manifest is written. A successful conversion still
requires native preview; it is not approval to reopen spending.

Conversion preserves these semantics:

- Provider defaults become native `member_default` policies, including for future
  members. Explicit user overrides, including unlimited, become matching member
  policies. Platform-only caps retain `source=host` filtering.
- Project/provider caps become namespace policies. Provider enablement stays in
  the service. Existing native base policies cannot be silently overwritten.
- A shared legacy user allowance requires all of that user's payer projects in
  one reviewed account. Distinct legacy users cannot silently become one balance.
- Closed historical usage is split at UTC midnight and imported with stable IDs
  and provenance. Money and compute hours round to twelve decimal places, half to even;
  the interval and quoted rate remain in provenance for reconciliation.
- Active spending stops require continued suspension. Account import always
  leaves spending suspended; explicitly review the report before resuming.
- A tenant's cumulative USD or compute-hour allowance becomes an account `all_time` policy after
  the complete scope and explicit mapping checks above. It includes imported
  history and never resets. Native admission also reserves future commitments;
  the report records this intentional change from the old accrued-only threshold.
- The dormant `blob_bytes_budget` value is preserved in the report. The legacy
  admission engine never enforced it, so migration does not activate a new policy.
- `gpu_hours_budget` becomes `metric=compute_hours`, with no currency. It measures
  VM wall-clock hours, not GPU-count-weighted hours. Native overlap is excluded
  from both imported money and hours. Merv only groups service-reported hours for
  its research views; it does not enforce this allowance.
- Resource-count, total-lifetime and hourly-price ceilings become native resource
  limits. Live resources require the explicit reconciliation described above;
  incomplete mappings still block conversion.

Existing native adjustments without measured duration remain unresolved under
finite hour budgets. Do not replace or duplicate their monetary charges. Use the
native importer's reviewed `hour_resolutions` mapping in the base manifest to fill
previously unknown hours during the combined import while preserving cost and
attribution. If enrichment was already applied separately, capture a fresh native
inventory and omit fulfilled resolutions from the new manifest; retain their
receipts with the migration evidence. Known durations are immutable. Enrichment
requires a new batch ID; old unchanged receipts still replay.

Then preview and apply using native operator tooling:

```sh
sbx account import budget-rehearsal/account-import.json --config service.toml
sbx account import budget-rehearsal/account-import.json --config service.toml --apply
```

Use a new batch ID for a new reviewed input set. Replaying the identical applied
manifest is safe; changing content under the same batch ID is rejected. Do not
use a previously converted manifest as the base for another full conversion. Preserve
the original native base and reconcile final deltas as described below. After new native
admissions, recovery needs forward repair or reconciled delta replay; restoring
an old accounting database alone would lose those commitments.

## Final usage delta and forward repair

If the initial import was only previewed, capture the final source snapshot and
run a fresh full conversion against reviewed native inputs. If it was applied,
use `export_infrastructure_delta.py`. Run this offline utility in the native
operator Python environment: it uses the native `AccountImport` schema and
`manifest_fingerprint` receipt codec, without adding a sandbox package dependency
to Merv's running application. This keeps schema/default handling in the service.

Freeze legacy policy/ownership edits and suspend the destination account. Capture
the final legacy snapshot, then a fresh native inventory at or after that source
cutoff, including its `import_batches`, and prepare a current
base manifest preserving all native policies, resource limits, member states,
provider controls, subjects, historical adjustments, live resource attribution
and pending workflow authority. Namespace `expected_account_id` is now the
destination account. Omit already fulfilled hour/lifetime resolutions and old ID
remappings. Preserve every pending workflow's current `operator_authorized` value
as `authorize_pending_compute`; its existing grant remains in the service.

```sh
python deploy/export_infrastructure_delta.py \
  --snapshot final-snapshot.json --mapping final-mapping.json \
  --base-manifest current-native-base.json --native-inventory current-native.json \
  --previous-manifest initial/account-import.json --previous-report initial/report.json \
  --previous-snapshot initial-snapshot.json --previous-mapping initial-mapping.json \
  --output-dir final-delta
sbx account import final-delta/account-import.json --config service.toml
sbx account import final-delta/account-import.json --config service.toml --apply
```

The previous manifest must match an actual native receipt. Installed source
charges must match that manifest; every base charge must match current inventory.
The tool checks source history and attribution, excludes native compute overlap,
and subtracts previously credited intervals before producing new entries. It
preserves installed entries verbatim and reports any decimal rounding difference
introduced by splitting an interval. Missing history, changed payer/source/rate,
overlapping credits or shortened credited intervals produce conflicts and no
manifest. Unknown historical hours require separate reviewed enrichment first.
Each later delta uses the last applied delta's manifest/report and its retained
source snapshot/mapping. Repeated capture with no new usage adds no charges.

Native policies remain authoritative after the first import, including subsequent
owner edits. The delta preserves the current native base instead of restoring
old legacy values. Legacy policy or identity changes during the freeze block the
usage delta and require separate ownership/policy reconciliation. The report's
source conversion decisions describe source coverage; `policy_authority` identifies
the current native base as the terms that will remain installed.

The generic import flag `preserve_existing_authority` is set in delta manifests.
Native import verifies unchanged account/namespace ownership, default members,
compute payers and workflow authority. It retains existing grants and queued
grant references, including their normal revocation checks. It does not convert
queued consumption into permanent operator authorization. Current native terms
and their modification timestamps remain intact. The account remains suspended
until reconciliation and an explicit resumption.

An interruption before commit leaves no receipt or partial import. Inspect fresh
inventory and retry the exact manifest. If the commit succeeded but the response
was lost, identical replay returns the saved receipt without adding costs. After
new native admissions, keep the native database authoritative and use this forward
repair path; do not restore an old database over new resources or commitments.
The disposable bridge tests this sequence and checks live resources, grants,
provider connections and native policy edits. Full deployment backup/activation
rehearsal and review of real ownership inventories remain separate release gates.

## Shadow policy review

Use native `sbx account review` to evaluate reviewed case inputs against the
candidate import without applying it or reserving compute:

```sh
sbx account review cases.json --config service.toml \
  --import-manifest budget-rehearsal/account-import.json \
  --output candidate-review.json
```

The native case format is documented in merv-sandboxes' accounts and budgets
guide. Review cases are independent and use a repeatable-read snapshot. Account
resumption, default-policy creation and candidate-import changes are rolled back.
The report records whether spending was assumed enabled. Actual grant authority,
provider capacity and operational cutover remain separate checks.

Execute the pinned legacy quota engine against a private projected snapshot:

```sh
python deploy/replay_legacy_admission.py \
  --snapshot legacy-snapshot.json --mapping replay-mapping.json \
  --native-review candidate-review.json --repository /path/to/Merv \
  --output legacy-decisions.json
```

The replay mapping extends the export mapping with `cases`, keyed by native case
ID. Every case explicitly supplies legacy `project_id`, `user_id` and `provider`.
Creation also requires `price_unknown_reason`, including the empty string when
that was the original caller's value. This field affects actual legacy behavior;
do not infer it from an absent quote. Renewal supplies `sandbox_uid`, backed by
the reviewed `resources` mapping. The native target expiry must correspond to an
exact positive whole-second legacy extension. Other renewal mappings require
separate reviewed cases rather than rounding or changing their meaning.

The tool extracts revision `55c1a1c894bdf83b7f32b2389002b46528329487` from the
specified local repository and executes its actual quota and store methods in
a temporary SQLite database at the native review's evaluation time. It does not
start Merv, restore credentials, or run application migrations. The worker blocks
network connections and subprocess creation; each independent case rolls back.
Reports include source hashes, mapped requests, original denials and evidence
digests. Both the output file and temporary evidence are private. Its scope is
the legacy quota gate: provider selection, capacity, authentication and upstream
application guards remain separate contract checks.

`compare_infrastructure_admission.py` compares these recorded legacy decisions
with the native output. It performs no budget calculation:

```sh
python deploy/compare_infrastructure_admission.py \
  --legacy-decisions legacy-decisions.json --native-review candidate-review.json \
  --output shadow-comparison.json
```

The legacy document requires `version: 1`, `source_id`, the immutable 40-character
`source_revision`, `snapshot_sha256`, a timezone-aware `as_of`, and `cases`.
Each case contains its `id`, boolean `allowed`, `native_request_sha256`, execution
`evidence` and `expected_native_reason` (null for allowance; the mapped native
denial reason or error code for rejection). Preserve the original request and
legacy execution records with that evidence. Both evaluations must use the same
instant and exactly the same case set. Native request/input/state checksums must
validate; missing cases or changed request mappings block reconciliation.

Changed outcomes remain unresolved until reviewed. To record an intended change,
copy its binding fields from `differences` into a JSON object keyed by case ID,
add nonempty `evidence`, and pass that file using `--resolutions`. The bindings
include both full report hashes, snapshot/request hashes and actual decisions.
Changing an input, snapshot, mapped denial reason or outcome invalidates the
resolution. Unused resolutions are rejected. Keep the evidence for stricter
commitment reservations, unknown-price rejection and preserved lifetime origins;
do not automatically accept a new allowance where legacy admission denied one.

The comparison writes a private file, refuses overwrite, and exits 2 for
unresolved differences or conflicts. `selected_cases_reconciled` covers only the
recorded cases; it is not a proof of every policy or approval to switch authority.
The adapter tests execute this pinned engine against controlled fixtures and
compare its results with real native HTTP responses. Replaying the reviewed
deployment snapshot remains an operational release gate. The current inventory
also projects live payer/charge-source and
quoted-price fields plus generation creation order, which that engine uses to
resolve committed usage. Regenerate older snapshots before legacy replay.

## Contract verification

Before restarting native workflow workers, review every unfinished workflow in
the native inventory. The `workflows` entries in the base import manifest map
`workflow_id` to `member_id`; `authorize_pending_compute` defaults to false.
Set it to true only when the owner has approved that workflow's remaining
rentals under its destination account. The importer clears old submitting grants
and reports `authorized_pending_workflows` and `blocked_pending_workflows` in
both preview and apply. Existing reservations can recover and finish without a
new grant, but unreserved provision nodes require this explicit approval after
the move. Current budgets, suspension, disabled members and cancellation still
apply. Restart workers after reviewing this report and completing the import.

The optional cross-repository test requires the native service installed in the
test environment and a disposable PostgreSQL maintenance database. It creates
and drops its own database and configures only the in-process fake provider:

```sh
MERV_SANDBOXES_TEST_DATABASE_URL=postgresql://localhost/postgres \
  pytest tests/infrastructure/test_service_budget_integration.py -q
```

It exercises a real SQLite export, native schema validation, transaction preview,
apply and replay, then Merv's real HTTP client and an independent application
against the same service allowance for daily money, cumulative money, compute
hours, concurrency, lifetime and hourly price. It also checks non-reserving
native review against actual HTTP denials, executes the pinned legacy quota
engine, and reconciles its results with the offline comparison tool. Cumulative
money/hour cases explicitly demonstrate the intended move from accrued-only
thresholds to future commitment reservations. No
billable infrastructure is provisioned.
