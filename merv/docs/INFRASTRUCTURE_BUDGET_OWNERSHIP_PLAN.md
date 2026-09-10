# Infrastructure budget ownership migration

**Production update, 2026-09-10 UTC:** The ownership cutover is live. See
[the production release record](INFRASTRUCTURE_PRODUCTION_RELEASE.md) for deployed
checks, retained history and recovery details. Checkpoints below are historical.

Status: target design and delivery plan. The working tree contains partial
implementation; this document does not certify completion or production cutover.

## Outcome

merv-sandboxes owns infrastructure budget administration, policy storage, usage
accounting, reservations, enforcement, and spending reports. Merv authenticates
its users, enforces research permissions, and consumes infrastructure through
the same public integration API available to other applications.

Merv stores infrastructure connection references, member mappings, namespace
mappings, and research associations. It does not store allowances, calculate
remaining budgets, or supply spend/policy claims on infrastructure requests.

## Baseline being replaced

- Native sandbox budgets are namespace-scoped monthly caps with lease and idle
  controls in `control/src/merv_sandboxes/spend.py`.
- Merv stores daily project/provider and user/provider limits and calculates
  legacy spend in `merv/src/merv/brain/infrastructure/budget.py`.
- Merv signs those values into service JWTs. The sandbox registry separately
  enforces them in `registry/merv_budget.py` during creation and renewal.
- Native tokens currently identify one namespace. The spend budget update route
  accepts the ordinary authenticated principal; administrative and consumption
  credentials need an explicit separation.
- Merv-specific namespace and issuer checks live in sandbox authentication.

## Working-tree checkpoint

Inspection on 2026-09-09 found a sandbox-issued credential client in Merv and
generic accounts, policies, grants, and an account importer in merv-sandboxes.
These are implementation foundations, not evidence that the migration is done.
Merv's `project_spend` now consumes a scoped native report, including service-side
historical adjustments and hardware/day totals. Generic consumer usage,
administrator controls, native inventory and replay-safe import have focused
coverage. The Merv-specific read-only exporter now converts inherited defaults,
explicit caps and historical usage into the generic import format; see
[the migration guide](../deploy/BUDGET_MIGRATION.md). Native import preserves
colliding policy/charge IDs through explicit remappings. Cumulative monetary and
compute-hour allowances now use the native ledger, and the exporter converts
them after complete tenant-scope checks. Unused Merv key ceilings have also been
removed from runtime identity plumbing. Generic concurrent-resource, total-lifetime
and hourly-price ceilings now have native enforcement, administration, inventory
and import, plus Merv export and two-application coverage. Pinned legacy replay,
receipt-verified final-delta export and transactional interruption/forward repair
now have controlled integration coverage. A disposable Docker rehearsal covers
backup/restore, imports, grant issuance and HTTPS activation recovery; both current
release images build and pass isolated packaging checks. The delayed-caller audit
found persisted runner identity and signed wait identity, with no policy copies.
Full packaged-service startup and restart now pass on disposable restored
databases: the cached legacy Merv schema migrates from version 45 to 60, existing
credentials and research reads survive, and native cleanup completes while Merv
is stopped. Reconciliation of real operational inventories and operational
cutover remain unfinished. See the
[migration progress record](INFRASTRUCTURE_MIGRATION_PROGRESS.md) for verification
evidence and its limits, and the [release audit](INFRASTRUCTURE_RELEASE_AUDIT.md)
for the remaining gates. Preserve unrelated working-tree changes.


## Remaining delivery plan from the current working tree

Use the existing accounts, grants, ledger and importer as foundations. The phases
below complete and verify them; they do not call for a second implementation.
This planning update does not authorize or perform a production cutover.

1. **Finish native policy coverage.** Extend the existing accounting engine with
   cumulative monetary and compute-hour allowances. Add generic concurrent-resource,
   total-lifetime and per-resource hourly-price ceilings. Use the same account
   transaction lock for policy changes, creation and renewal. Expose their
   administration, inventory and import through native interfaces. Preserve
   existing daily/monthly and member-default semantics. Exit: every active legacy
   limit has an explicit native equivalent and concurrency/lifecycle coverage.
2. **Complete Merv simplification.** Remove unused infrastructure limit fields
   from key creation and runtime identity plumbing; reject attempts to configure
   these retired knobs rather than silently accepting them. Keep historical
   columns only for recovery. Audit queued work and runner credentials for durable
   subject attribution. Exit: Merv retains research authorization, connection
   configuration and research associations, with no infrastructure policy engine.
3. **Complete export and reconciliation.** Map complete legacy tenant scopes into
   accounts, export cumulative usage without overlapping native ledger entries,
   and explicitly report dormant configuration. Compare legacy and native
   decisions without reserving twice. Explain intended differences such as future
   commitment reservation and unknown-price rejection. Exit: every policy and
   usage entry is reconciled or blocks migration with an actionable conflict.
4. **Rehearse cutover and recovery.** On disposable deployments, run inventory,
   preview, import, identical replay, grant setup and connection verification.
   Simulate interruption at each stage, including final-delta import. Test forward
   repair after native admissions begin. Preserve existing resource IDs, jobs,
   provider access and outputs. Exit: reproducible operator steps and reconciled
   reports, not just importer unit tests.
5. **Prove application independence and release.** Exercise Merv and a minimal
   independent client against one shared account/member allowance and separate
   accounts. Verify permissions, concurrent admissions, revocation, denied
   renewals, and cleanup while Merv is unavailable. Then use reviewed ownership
   mappings for the operational freeze, final delta, authority switch and reopening
   of admission. Set a recovery retention deadline before retiring historical
   data. Exit: one authoritative ledger and admission path, with the release
   evidence listed below.

Steps 1 and 2 can be reviewed separately. Step 3 depends on native policy coverage;
step 4 depends on the complete migration and client contract; step 5 depends on
reconciliation and the recovery rehearsal. Do not substitute passing existing
tests for any missing exit gate.

### Remaining resource-limit design

Keep resource constraints distinct from accrued money/hour allowances, but
evaluate both inside the same native admission transaction. Use generic
account/member/namespace scopes and optional provider and charge-source filters.
Every matching independent constraint must pass. These controls belong in native
administration, inventory and the application-neutral import format; Merv only
translates historical configuration during migration.

- **Concurrency:** count committed provisioning immediately and retain resources
  until stop is confirmed. Concurrent applications cannot claim the same last
  slot. Renewal does not consume a second slot. Replaying an accepted request does
  not reserve again.
- **Total lifetime:** compare requested expiry with the resource's preserved
  lifetime origin. Renewal and ownership migration cannot reset that origin.
  Verify the legacy origin from source and require reviewed reconciliation where
  adopted live resources lack equivalent metadata. Keep this origin separate from
  any accounting interval whose meaning differs.
- **Hourly price:** use the service's provider quote and an explicit currency.
  Reject unknown prices and unsupported currencies when a price ceiling applies;
  a known zero price is distinct from an unknown price.

Lowering these limits blocks new commitments that violate them; terminating
existing resources remains an explicit operation. Admission denial must preserve
cleanup access and avoid exposing another member's private usage. Extend import
preview, replay, collision handling and preservation checks to these constraints
without invalidating unchanged historical import receipts.

### Legacy quota decisions

The verified semantics are recorded in
[the quota migration notes](INFRASTRUCTURE_QUOTA_MIGRATION_NOTES.md). In particular:

- `usd_budget` is cumulative, so a daily or monthly replacement is insufficient.
- `gpu_hours_budget` actually measures VM wall-clock hours; migrate it as compute
  hours without inventing GPU-count multiplication.
- Extensions must obey a total resource lifetime ceiling, with an explicit
  lifetime origin for adopted live resources.
- `blob_bytes_budget` was dormant schema configuration. Preserve it in the
  migration report; activating storage metering is separate work.
- Tenant limits cover all tenant projects. Partial mappings or merges of
  independently limited tenants require explicit resolution before import.

## Ownership after migration

| Responsibility | Owner |
| --- | --- |
| Research login, project permissions, experiment associations | Merv |
| Infrastructure account membership and external-subject bindings | merv-sandboxes |
| Budget configuration, defaults, provider controls and suspension | merv-sandboxes |
| Prices, compute estimates, commitments and admission decisions | merv-sandboxes |
| Provider secrets, resource lifecycle, jobs and lease cleanup | merv-sandboxes |
| Project-to-namespace mapping and server-side consumer credential | Merv |
| Research presentation of infrastructure usage | Merv, using service-reported amounts |

Merv never needs the numeric allowance to request a resource. It submits the
authorized identity and resource parameters; the service returns the resource or
a structured denial. Account owners manage allowances in the sandbox UI. Merv
links to that UI and may display authorized usage without maintaining a second
policy store.

## Target contract

### First-release user journey

1. The owner signs in to merv-sandboxes, configures provider connections and
   account/member budgets, and creates the required resource namespaces.
2. The owner authorizes a consumer application grant and any external-subject
   bindings. A single-member connection needs no per-request subject selection.
3. Merv receives the service URL, consumer credential and project-to-namespace
   mapping. Merv validates the connection and keeps the credential server-side.
4. An agent uses Merv's existing sandbox tools. Merv checks research access and
   forwards the resource request with the authenticated subject where required.
5. merv-sandboxes authorizes the identity, checks every applicable budget, and
   atomically admits the lease or returns a structured denial. Merv displays that
   result and service-reported usage. Budget changes happen in the sandbox UI.

This release uses explicit owner setup. Automated account linking or a federated
sign-in flow can be added later without changing the budget ownership boundary.

### Durable work and revocation decision

Persist the authorized application subject with queued Merv work that will make
later infrastructure calls; do not rely on an HTTP request's transient context.
Revalidate the consumer grant and subject when making each later call. Missing,
revoked or disabled authority must fail explicitly rather than select a different
payer. This durable field is identity metadata, not a copied spending policy.

The run-wait endpoint now carries that subject in a versioned signed capability.
It restores the verified subject inside its executor for every service read,
including after a process restart with the same wait key. Changing or removing
the subject invalidates the capability before lookup. Subject-free legacy links
remain valid for connections that do not require a selector; they never select
an arbitrary member of a multi-member grant. Native queued provisioning saves
the submitting grant ID and checks it during each new reservation. The same
transaction rereads workflow authority and cancellation state, so a stale worker
cannot bypass a revocation, cancellation, or reviewed ownership import.

Treat a native provisioning operation as accepted only after its authorization
and reservation commit together. Revoking a grant blocks new API requests;
already accepted provisioning may finish within its committed lease. A queued
workflow step that has not reserved compute must pass current admission checks
when it runs. Member disablement, spending suspension and cap changes block new
commitments; they do not silently cancel existing reservations. Explicit resource
cancellation remains separate. Test this boundary for retries and worker restarts.

An infrastructure account is the owner of budgets and authorized provider
connections. Namespaces isolate resources within an account. Members identify
authorized consumers and can have additional spending limits. Existing native
users retain access through memberships; existing namespaces retain their IDs.

Applications receive revocable grants scoped to accounts, members, namespaces,
and operations. Consumption grants can request machines, execute jobs, use
storage, and read permitted usage. They cannot update budgets, change account
ownership, connect chargeable providers, or grant themselves additional access.

For the initial version, use sandbox-issued opaque credentials and an owner
approval flow in the sandbox UI; do not introduce a new shared user database or
require federation. A grant may bind one member, or explicitly authorize an
application to act for a saved set of members. External identities are keyed by
application ID plus external subject. A caller-provided user ID never creates
billing authority by itself. Merv keeps grant secrets server-side.

Machine creation carries a namespace, an authorized consumer identity where
needed, and the existing machine/job parameters. The service derives the account
and immutable charge attribution, loads policy, and admits the request. Renewal
preserves original attribution even if another authorized user requests it.
Namespace creation, if delegated, always inherits account limits and cannot
create an unbudgeted escape route.

API operations cover account/member/namespace discovery, grant authorization and
revocation, budget administration, usage/reservation queries, and existing
infrastructure operations. Exact endpoint schemas and error codes are finalized
in phase 1. No endpoint or claim is named after Merv.

## Budget semantics

- One enforcement engine evaluates all applicable account, member, namespace,
  and provider-filtered limits. All must pass; child policies cannot relax parents.
- Service-owned per-member defaults apply to future members too. A saved member
  override replaces only defaults with matching metric/window/currency/provider/source;
  it never relaxes an independent account or namespace ceiling.
- Support daily and monthly UTC calendar windows, plus cumulative allowances
  required to preserve active legacy limits before cutover. Preserve existing
  user/provider platform-only cap semantics through an explicit charge-source
  filter, rather than silently applying them to customer-owned credentials.
- Use explicit unlimited values and define zero as no new spending. Convert the
  legacy native zero-means-unlimited setting during migration.
- Use decimal money, explicit currencies, idempotent reservations, and
  transactionally serialized admission across all applicable scopes.
- Report accrued estimated spend, committed future spend, and remaining allowance
  separately. Define one canonical metering interval and test provisioning,
  failure, cleanup delays, renewal, and calendar rollover. Allocate commitments
  consistently across affected budget windows.
- When a monetary cap applies, reject unpriced or unsupported-currency offers
  unless an explicit administrator policy supplies a conservative pricing rule.
- Lowering a cap blocks new commitments and renewals above allowance; it does not
  implicitly terminate existing work. A separate spending suspension blocks new
  commitments. Destructive stop-all behavior remains an explicit operation.
- Failed deletion does not release commitments as though the machine stopped.
  Expiry/cleanup continue independently of Merv.
- Describe these figures as compute estimates, not reconciled cloud invoices.
  Storage/network billing and payment collection are outside this migration.
  Admission caps bound commitments under the configured pricing model; delayed
  provider cleanup or inaccurate prices can still make actual charges exceed an
  estimate. Continue recording such usage and block further commitments rather
  than truncating the ledger at the cap.

## Implementation sequence

### 1. Define and lock the public contract

Document account/member/namespace relationships, grant scopes, charge attribution,
budget precedence, metering/window semantics, revocation behavior, and structured
denial responses. Inventory existing policies, namespace ownership, credentials,
and live leases without exposing secrets. Specify an audited owner migration path.

Done when a standalone application and Merv can be represented without special
issuer names, namespace prefixes, research objects, or caller-supplied budgets.

### 2. Implement accounts and permissions in merv-sandboxes

Add account membership and scoped application grants. Adapt existing native users
and namespace tokens without granting consumption tokens administrative rights.
Separate human budget administration from compute access across REST, MCP, CLI,
and token minting. Add owner connection approval, rotation, and revocation.

Done when consumers cannot raise limits, select unauthorized payers, mint broader
credentials, or access another account, including through indirect API routes.

### 3. Implement the unified accounting and budget engine

Build one durable reservation/accounting implementation and generic policy model.
Route machine creation and renewal through it. Expose usage and budget APIs and
move all budget editing into the sandbox UI. Keep the old admission paths only
behind a temporary migration mode; never reserve the same lease twice.

Done when native and integrated clients obey identical policy semantics and
concurrent requests cannot bypass account/member limits across namespaces.

### 4. Migrate existing data and reconcile

Map existing namespaces and payers to accounts/members. Import Merv limits,
provider enablement, spending suspensions, and native monthly caps. Import any
needed legacy usage as idempotent, provenance-tagged opening entries. Preserve
existing machine/job IDs, provider connections, SSH access, and payer attribution.

Shadow-evaluate policy decisions without creating duplicate reservations. Produce
a reconciliation report explaining every difference from legacy decisions and
totals. Freeze policy writes and new rentals/renewals briefly at cutover, capture
the final delta, switch authority, and reopen admission. Existing jobs continue.

Done when each policy, active lease, reservation, and required historical entry has
one authoritative representation. Keep backups and a tested recovery procedure.
Before new-engine writes, rollback may restore the old path. After new admissions,
prefer forward repair; restoring old accounting requires explicit delta replay and
reconciliation, not merely toggling a flag.

### 5. Reduce Merv to a thin client

Replace Merv JWT signing with scoped sandbox credentials and identity mappings.
Preserve agent-facing `sandbox.*` operations while forwarding infrastructure work.
Replace budget forms with links to sandbox administration and optional read-only
usage. Move provider administration there too; Merv discovers available offers.
Use service-reported usage for research views, joining by saved associations.

Remove runtime reads/writes of Merv budget tables, legacy spend calculations,
infrastructure spending stops, provider-policy duplication, and `merv_budget`
claims. Retain obsolete tables read-only only for the defined recovery window,
then remove them in a later migration.

Done when Merv can request infrastructure without knowing any allowance and its
only infrastructure authorization inputs are its grant and mapped identities.

### 6. Remove compatibility and prove independence

Delete Merv-specific sandbox authentication, budget checker, namespace reservations,
and compatibility configuration after cutover verification. Update both projects'
deployment documentation, client guidance, and sandbox-operation skills.

Exercise a minimal second application using the documented public API. Verify two
applications sharing an account share limits, while separate accounts stay isolated.

Done when there is one budget authority and one admission engine, no Merv-specific
runtime policy branch in merv-sandboxes, and no infrastructure budget computation
or administration in Merv.

## Reviewable delivery units

Land these as separately reviewable changes in dependency order. Preparatory
client work can happen earlier, but switching live authority requires the
migration and reconciliation gate.

| Unit | Repository | Deliverable and exit gate |
| --- | --- | --- |
| 1. Contract and inventory | Both | Versioned identity/policy/error schemas, permission matrix, explicit ownership map and unresolved-conflict report |
| 2. Accounts and grants | merv-sandboxes | Owner administration, consumer credentials, subject binding, member disablement, rotation/revocation; REST/MCP/CLI cannot bypass permissions |
| 3. Accounting and administration | merv-sandboxes | One create/renew admission transaction, scoped usage APIs, budget/provider/suspension UI; concurrency and lifecycle tests pass |
| 4. Migration tooling | Both | Merv exports its legacy data into a generic manifest; sandbox importer previews, validates and applies it idempotently; reconciliation and interrupted recovery are tested |
| 5. Thin integration | Merv | Validated consumer connection, authenticated subject propagation including queued work, stable agent tools, service-reported usage and administration links; no runtime local budget authority |
| 6. Cutover and retirement | Both | Rehearsal, final freeze/delta reconciliation, explicit operational cutover, second-application smoke test, compatibility retirement and updated deployment guidance |

The Merv-specific exporter belongs in Merv. The sandbox importer accepts a
versioned application-neutral manifest; it must not query Merv tables or parse
Merv research objects. Preserve historical attribution through explicit migration
data, not permanent application-specific authentication branches.

Before switching, verify every account's members, namespaces, inherited/default
caps, provider controls, prior adjustments, live leases and queued provisioning
work. Do not infer historical charge source from today's provider credentials.
Require an explicit resolution where ownership or historical attribution is
ambiguous. Replaying a completed import must neither duplicate costs nor move
resources again.

Connection validation must check the actual grant and selected namespace/member
permissions; an unauthenticated health check alone is insufficient. Merv must not
retain an administrator credential to work around a missing consumer read API.
Verify the committed-reservation boundary described above for revocation, queued
provisioning, member disablement and account suspension. Cleanup and release
remain available when spending is suspended.

## Release decision

Completion means a native client, Merv, and a minimal independent application all
use the same authorization and admission path. Two applications mapped to the
same member share that member's allowance across namespaces. Separate accounts
cannot inspect or spend each other's balances. Removing Merv from the deployment
does not interrupt budget administration, metering or lease cleanup.

For acceptance evidence, retain the permission and concurrency test results,
migration dry-run/apply/replay reports, accounting reconciliation, UI checks and
the two-application scenario. Define the recovery retention deadline at cutover;
do not delete old data before reconciliation and that recovery window are complete.

## Required verification

- Consumer/admin permission matrix across REST, MCP, CLI, and delegated grants.
- Cross-account/member/namespace attribution attacks and grant revocation.
- Concurrent admissions across applications and namespaces; idempotent retries.
- Daily/monthly rollover, active lease reservations, renewals, cap reductions,
  unpriced offers, currency mismatch, provisioning failure, and delayed cleanup.
- Immutable payer attribution and provider charge-source filtering.
- Migration replay, interrupted cutover recovery, zero/unlimited conversion,
  accounting reconciliation, and continued access to existing jobs and outputs.
- End-to-end Merv tool compatibility plus an independent application integration.

## Scope exclusions

No customer payment collection, invoice reconciliation, new currency conversion,
research artifact relocation, or generic identity-provider platform. Research
permissions, experiment links, reviews, and research-specific presentation remain
in Merv. Preserving active legacy compute/resource quotas is required for this
migration. New storage/network metering and activation of dormant storage quota
fields are separate work; any future infrastructure quota enforcement belongs in
merv-sandboxes.
