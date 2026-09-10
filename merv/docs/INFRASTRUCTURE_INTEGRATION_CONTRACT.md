# Infrastructure integration contract

Implementation contract for [the ownership migration](INFRASTRUCTURE_BUDGET_OWNERSHIP_PLAN.md).
This describes the working-tree service/client boundary. Deployment completion
requires the migration and release evidence recorded in the progress document.

## Identity and authorization

An account owns its infrastructure spending policies. A namespace belongs to
exactly one account and isolates its resources. An account member is an immutable
charge-attribution identity; removing a member prevents new admissions without
erasing historical charges. Accounts and members have service-issued opaque IDs.

An application ID identifies an integration, not an owner or payer.
The account owner authorizes an application grant in the sandbox UI. Grants bind
an application to an account and explicit namespace/member permissions. There is
no authority derived from an application-selected namespace prefix or user name.
An external subject is unique within an application registration. The owner must
authorize its mapping to an existing account member before it can incur charges.

Start with two credential classes:

- Consumer: infrastructure operations and scoped read-only usage.
- Administrator: account/member/namespace/grant and policy administration.

Merv stores consumer credentials only. Native interactive sign-in obtains an
administrator session for the user's authorized account. Credentials minted for
agents default to consumer access. Existing tokens must not become administrators
based on mutable labels. Permission checks cover token creation/revocation,
provider credential changes, budget mutation, and namespace creation as well as
compute admission. Database-operator CLI commands remain explicit privileged
operations and must not be exposed as consumer API shortcuts.

Revoking a grant stops new API authorization and certificate issuance/refresh.
Existing SSH connections and previously issued certificates have separate
lifetimes; revocation must not be described as instantly terminating them.
Lease cleanup continues under service authority after the application disconnects.

Authorization and the compute reservation commit together before provisioning is
accepted. Grant revocation prevents new API requests; already accepted work may
finish within its reserved lease. Workflow steps without a compute reservation
must pass current admission checks before provisioning. Member disablement,
spending suspension and cap reductions prevent new commitments without implicitly
cancelling existing ones. Explicit cancellation is a separate resource operation.
Integrating applications must retain the original authorized subject for durable
work and reauthorize later requests; a lost request context never selects another
payer. Retries and worker restarts must preserve this behavior.

Native workflow records retain the submitting grant ID and member, with no bearer
secret or policy copy. Each new reservation locks and rereads the workflow and
grant; cancellation or revoked/expired authority blocks admission. Replaying a
workflow cannot change its member or replace its original grant. For pre-grant
records, only an explicit offline owner-reviewed import may authorize pending
compute. This migration decision remains subject to current policy and cancellation
and cannot be supplied by a consumer request.

## Integration API

Use the existing `/v1` API, bearer authentication, error envelope, and REST/MCP
resource operations. Extend the principal resolver to validate two optional
request selectors consistently on both transports:

- `X-Sandbox-Namespace`: an explicit namespace permitted by the grant.
- `X-Sandbox-Subject`: an external application subject already mapped to an
  authorized member. The application comes from the credential, not this header.

Single-namespace/member grants can omit selectors. Multi-target grants must
specify them when no unique target exists. Unknown, ambiguous, or unauthorized
targets fail before any resource lookup or billing operation. No fallback to an
account owner, arbitrary project payer, or unlimited namespace is allowed.

Implemented account resources:

| Operation | Purpose |
| --- | --- |
| `GET /v1/accounts` | Discover accounts visible to the caller |
| `GET /v1/accounts/{id}/members` | Discover authorized charge identities |
| `POST /v1/accounts/{id}/members` | Administrator adds an account member |
| `GET /v1/accounts/{id}/namespaces` | Discover account resource namespaces |
| `POST /v1/accounts/{id}/namespaces` | Administrator creates an inheriting namespace |
| `POST /v1/accounts/{id}/grants` | Administrator authorizes an application and selectors |
| `DELETE /v1/accounts/{id}/grants/{grant_id}` | Revoke application authorization |
| `PUT /v1/accounts/{id}/subjects/{application_id}/{subject}` | Administrator binds an external subject to a member |
| `GET /v1/accounts/{id}/budgets` | Administrator reads account policies |
| `PUT /v1/accounts/{id}/budgets/{budget_id}` | Administrator creates/replaces policy |
| `GET /v1/accounts/{id}/usage` | Administrator reads balances; consumer reads selected member/namespace usage without shared balances |
| `GET /v1/accounts/{id}/resource-limits` | Administrator reads resource ceilings |
| `PUT /v1/accounts/{id}/resource-limits/{limit_id}` | Administrator sets a resource ceiling |
| `GET` / `PUT /v1/accounts/{id}/provider-controls` | Administrator reads/sets provider admission controls |
| `PUT /v1/accounts/{id}/suspension` | Administrator suspends/resumes new spending |
| `PUT /v1/accounts/{id}/members/{member_id}/state` | Administrator disables/enables a member |

Opaque grant secrets are shown once and stored hashed by the service. The
integration client keeps its copy in server-side secret storage. Grant rotation
creates a replacement and then revokes the old grant. Account IDs in URLs are
always checked against the authenticated credential.

The native owner UI is the connection approval surface for the first release.
No cross-application login federation or shared authentication database is needed.
The owner provisions the grant and subject mappings there; Merv's connection
settings accept the resulting credential and validate discovery permissions.

## Policy and accounting

A policy contains: stable ID, account, scope (`account`, `member`, `namespace`,
`member_default`),
scope target, metric (`money` or `compute_hours`), optional provider-plugin and charge-source filters, UTC window
(`day` or `month`) or cumulative window (`all_time`), currency, and decimal cap. Null means unlimited; zero admits
no additional positive commitments in that metric. Monetary policies carry a
currency; compute-hour policies carry null. One compute hour is one resource's
wall-clock hour, without multiplying by GPU count. All matching policies must pass.

A `member_default` targets the account and supplies a separate allowance for each
current or future member. A saved member policy replaces defaults only when its
metric, window, currency, provider and source match exactly. Unlimited overrides are
explicit; they do not bypass account, namespace or differently filtered limits.

Policies and provider enablement are saved only in the service. Requests cannot
carry budgets, accumulated spend, or overrides. Native API schema validation
rejects such fields. Charge source is derived from the selected provider
connection, not a caller assertion. Provider aliases do not create separate
allowances for the same underlying provider-plugin policy.

Use reservation creation as the canonical start of conservative compute
accounting, including provisioning. Confirmed stop closes usage; unknown or
failed cleanup remains chargeable. This deliberately replaces the currently
different native readiness-based estimate and Merv admission estimate. UI labels
must identify the resulting figures as conservative compute estimates.

Within each affected UTC window, charge accrued time plus future lease commitment
without overlap. A rental spanning midnight/month-end reserves against each
window it intersects. Creation and renewal serialize on a stable account lock
initially; account-wide serialization is simpler to verify than dynamic multi-lock
ordering. Policy updates use the same lock. Additional concurrency optimization
is deferred until measured contention warrants it.

Reservation identity is stable across retries. Renewals replace the future
portion of the existing reservation, preserving the original account, member,
namespace, provider, and source. Policy edits never relabel historical usage.
Represent imported historical costs with immutable idempotent adjustment entries
and provenance; do not recalculate them in Merv at request time.

An all-time allowance includes the entire reconciled ledger, including historical
entries that predate the account's creation. It has no reset or calendar boundary;
usage and denial responses expose null `window_start` and `window_end`. The same
admission transaction reserves the complete future lease against that allowance.
Daily/monthly policies continue to apply independently when configured.

Historical adjustments may include an explicit measured `compute_hours` value.
Missing duration remains unknown, including on zero-cost entries. Finite hour
policies refuse new commitments when matching historical duration is unresolved.
Scoped usage reports include measured hours and flag incomplete coverage; native
administration shows an unresolved available balance without disabling policy
editing. Offline reviewed imports can fill previously unknown hours while
preserving monetary amounts and attribution, with a replay-safe evidence receipt.

Resource limits are separate native constraints evaluated in the same admission
transaction: `max_concurrent`, `max_lifetime_seconds`, and `max_hourly_price`.
They support account/member/namespace scope and provider/source filters. Every
matching constraint must pass. A null ceiling is unlimited; zero is a real limit.
Native owners administer them through `/v1/accounts/{account}/resource-limits`
and the settings UI. Consumer tokens cannot read or modify account configuration.

Concurrency includes accepted provisioning through confirmed stop; renewal does
not consume another slot. Lifetime uses a preserved origin, not a fresh allowance
on each renewal. Hourly prices come from native offers; unknown prices and
currency mismatches cannot bypass a price ceiling. Merv forwards the public
`concurrency_exceeded`, `lifetime_exceeded`, `hourly_price_exceeded`,
`unpriced_offer` and reconciliation reasons without calculating limits or
exposing private upstream details. Native inventory/import preserve the
constraints and reviewed earlier lifetime origins across account moves.

Usage responses distinguish accrued, reserved, and available amounts per policy
and currency, with an `as_of` timestamp. Consumers see only granted identities
and namespaces. A denied admission keeps the existing error envelope and includes
`reason=budget_exceeded`, policy ID, window boundaries, currency and requested
additional commitment. The internal decision retains cap/accrued/reserved evidence;
public and persisted workflow errors omit those account aggregates. Owners read
them through account usage. Do not leak unrelated members' usage.

## Migration inventory and ownership

| Existing source | Destination / treatment |
| --- | --- |
| Sandbox `users.namespace` and native tokens | Explicit account/namespace ownership; existing native tokens become consumers, owners sign in again |
| Sandbox `budgets` | Generic namespace monthly policies; convert legacy zero to null |
| Merv `provider_user_caps` | Member/provider daily policies, retaining platform-source filtering and default-cap inheritance |
| Merv `sandbox_provider_settings.daily_usd_limit` | Namespace/provider daily policies |
| Merv provider `enabled` flags | Service-owned namespace/provider admission controls |
| Merv `spend_kill_switches` | Account suspensions; host-wide stops become explicit service-operator controls |
| Merv `sandbox_generations` closed usage | Provenance-tagged historical adjustments where required by retention/accounting |
| Native sandbox request `merv_budget` attribution | Explicit immutable account/member/provider/source attribution |
| Native live machine and job records | Preserve IDs, namespaces, leases, provider credentials, and access |
| Merv `remote_sandbox_links` | Remain research associations; add explicit namespace/connection mappings |
| Merv provider/budget UI forms | Replace with sandbox administration links and scoped read-only usage |

Account migration must use an explicit owner-reviewed mapping. Neither a common
Merv tenant nor a shared provider credential is sufficient evidence that users
share a billing account. Existing projects sharing a payer must land in one
account to retain cross-project limits; ambiguous/shared ownership is a reported
migration conflict, not an inferred merge.

Freeze old policy writes and new admissions for final cutover. Reconcile legacy
usage, active leases, opening entries, all policies, and user mappings. Keep a
machine-readable conflict report and prohibit switching unresolved accounts.
Do not dual-reserve in shadow mode. Preserve old data for a defined recovery
window, then remove retained historical Merv tables. Runtime budget computation
and compatibility claims are already removed from the thin integration.

Offline final deltas verify the preceding native import receipt, preserve
installed charges and current native policies, and append only uncovered source
intervals. The generic `preserve_existing_authority` import option retains grants
and queued grant references only with unchanged ownership/payer/workflow authority.
It does not bypass revocation or current admission. These source-specific export
and replay utilities remain in Merv's deployment directory; the native importer
and receipt codec contain no Merv schema or identity assumptions.

## Acceptance evidence

The full migration requires tested consumer/admin isolation on all transports;
account/member/namespace isolation; two independent applications sharing one
allowance; concurrent requests and retries; renewals and calendar boundaries;
unpriced/currency-mismatched offers; revocation; policy reduction and suspension;
failed provisioning/cleanup; replay-safe imports and cutover recovery; stable
Merv agent tools; and working sandbox budget/grant administration UI.

Neither a schema-only migration nor passing native namespace-budget tests alone
proves completion. The Merv client must have no stored allowance, budget update
path, signed policy claims, or request-time spend calculation, and the sandbox
runtime must have no Merv-specific authorization or accounting branches.
