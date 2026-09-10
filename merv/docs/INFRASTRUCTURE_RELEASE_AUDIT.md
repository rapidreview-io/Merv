# Infrastructure ownership release audit

**Production update, 2026-09-10 UTC:** The ownership cutover is live. See
[the production release record](INFRASTRUCTURE_PRODUCTION_RELEASE.md) for deployed
checks, retained history and recovery details. Checkpoints below are historical.

2026-09-09. This records working-tree evidence for the
[ownership plan](INFRASTRUCTURE_BUDGET_OWNERSHIP_PLAN.md), not operational release
approval. Native paths below refer to the sibling `merv-sandboxes` repository.
The test logs are local, temporary evidence; retain reviewed copies with the
release record before relying on them for an operational cutover.

## Requirement coverage

| Requirement | Implementation and checked evidence | Remaining release evidence |
| --- | --- | --- |
| Application-neutral identity | Native `accounts.py`, `tokens.py` and consumer permission tests; grants select authorized account/member/namespace and application subject. Old Merv budget JWTs and namespace-name privilege are rejected. | Review the actual owner/member/subject mapping for every connected project. |
| Separate consumption and administration | Native account routes and REST/MCP permission tests cover consumer denials; owner settings hold budget, provider and suspension administration. Merv validates consumer role through `/auth/me`. | Verify installed credentials are the reviewed grants and contain no administrator access. |
| One budget authority | Native `BillingService.admit` handles create and renewal under the account lock; `SpendService` reads the ledger and writes native monthly policy instead of performing separate money admission. | Reconcile actual native and legacy policies before switching authority. |
| Preserve active legacy limits | Native account billing, compute-hour and resource-limit tests cover daily/monthly/all-time allowances, defaults/overrides, concurrency, lifetime and hourly price. Merv exporter maps legacy fields; dormant blob configuration is reported. | Resolve live resource lifetime origins, complete tenant scope and unknown historical attribution/duration. |
| Accounting and lifecycle | Native accounting/lifecycle tests cover immutable payer/source, reservations, calendar splits, retries, renewals and unconfirmed cleanup. Native queued-authority tests distinguish accepted reservations from later unreserved work. | Compare real usage and reservations at a reviewed cutoff; estimated compute charges remain distinct from provider invoices. |
| Thin Merv integration | Runtime client accepts URL and private project-to-namespace/consumer-token mappings; requests carry authenticated identity and resource parameters, not allowances. Packaged Merv starts against restored legacy research data, authenticates the existing key and serves research/usage reads plus sandbox create/renew tools. | Repeat against reviewed deployment research data, grant mappings and overlays. |
| Durable identity | Runner claims save source identity; gateway reconstructs it on later authenticated requests. Wait capabilities sign and restore the subject inside their executor. Details below. | No additional caller defect found in this audit; repeat if a new background infrastructure caller is added. |
| Generic migration and repair | Native importer preview/apply/replay, receipt checks and unchanged-authority repair; offline Merv export, pinned legacy replay and final-delta conversion. Six real PostgreSQL bridge cases compare decisions and exercise repair after admissions. | Execute these tools against reviewed deployment snapshots and resolve every reported difference/conflict. |
| Backup and activation recovery | Docker rehearsal restores PostgreSQL dumps/data volumes, vault/output retention and imports, then verifies HTTPS activation recovery. The packaged test restores a full legacy Merv schema (45 to 60) and native schema/data under non-superuser application owners and starts both actual service entrypoints. | Verify deployment-specific roles, overlays and recovery procedure; ordinary PostgreSQL fixtures do not establish managed Supabase restore compatibility. |
| Packaged independence | Both actual Dockerfiles build. Image checks prove UID/file access and absent cross-project Python dependencies. Full entrypoints start against restored databases; Merv also restarts and retains authentication/research access. | Record released image digests and repeat with reviewed deployment configuration. |
| Independent application | The packaged Merv tool and independent native client obey one edited allowance. With Merv stopped, the native worker completes fake-resource cleanup; after Merv restarts, native grant revocation blocks its reads. | Perform the reviewed bounded deployment smoke scenario with the real provider and allowance. |
| Historical retirement | Historical Merv tables remain available for offline migration/recovery; no runtime allowance reads remain in the infrastructure and identity surfaces. | Set the recovery retention deadline, reconcile final deltas, then schedule later historical-data removal. |

## Delayed Merv caller audit

- HTTP middleware establishes the authenticated subject; tool dispatch also sets
  and resets it explicitly in `surface/transport/api/gateway.py`. Both MCP
  transports invoke that gateway. Streamable MCP's task/thread execution carries
  the request to the gateway, so it does not rely solely on inherited thread
  context.
- `surface/transport/api/agent_sessions.py` obtains `source_key_id` and
  `source_user_id` from the authenticated principal, not caller body fields.
  `agent_sessions/agent_sessions.py` persists them and requires the same authority
  on an idempotent claim. Later gateway authentication reconstructs the principal
  from that record and checks the source key's current owner, tenant and scope.
  Existing regression coverage reconstructs the HTTP composition, reads a native
  job with the saved subject, then revokes the source key and verifies denial
  before any infrastructure request.
- `infrastructure/sandboxes.py` places the subject in the signed v2 wait
  capability. `surface/transport/api/runs_wait.py` verifies it and explicitly
  restores it inside the dedicated executor. Existing tests cover tampering,
  omission, fresh-router use and thread-context reset. Subject-free legacy links
  do not invent a member for a multi-member grant.
- The workflow delivery thread dispatches research workflow/review and optional
  MLflow tracking actions. Its registered handlers do not provision or renew
  native infrastructure. The other durable brain thread performs ledger
  retention. Neither requires a new saved infrastructure subject today.
- Native workflows persist their grant ID and member, then revalidate inside
  the reservation transaction. Merv does not duplicate this queue authority or
  store a budget snapshot. Native lease cleanup operates independently of Merv.

## Checked release artifacts

- Native full suite: **615 passed, 8 skipped**, 174.19 seconds,
  `/tmp/merv-native-cutover-full.log`.
- Merv full suite with real service bridge and Docker rehearsal enabled:
  **1713 passed, 1 skipped, 1523 subtests**, 239.96 seconds,
  `/tmp/merv-cutover-full.log`. The 76 warnings are the existing short test HMAC
  keys and Starlette deprecation. This run predates the additional image checks.
- Packaging checks: **2 passed**, `/tmp/merv-cutover-image-check.log`.
- Full packaged restore plus both packaging checks: **3 passed**, 39.04 seconds,
  `/tmp/merv-packaged-cutover-final.log`. Legacy research schema **45** migrated
  to **60** under the application database owner. Existing project-key fields
  and historical caps remained unchanged; Merv tool admission used native policy.
- Merv image `merv-budget-cutover:rehearsal-20260909-01`:
  `sha256:829bb412c0094d2aed30a596e343ee3dd205890257e00df3839326b0cf96a55f`.
- Native image `sandboxes-budget-cutover:rehearsal-20260909-01`:
  `sha256:9d63550d760f7901f3a83070581a96c983f0284852b1908ea4a879d1f81e342d`.
- Legacy Merv seed image `deploy-control:latest`:
  `sha256:e925ab497dc6f40a0ad0d0d1a724208723c7ee240176d3dc07bd9dd2194461bc`.

Images remain local. Rehearsal-owned containers/volumes/networks were removed;
the existing test database and unrelated Docker resources remain. The rehearsal
uses fake compute, synthetic running-job records and fixture provider keys; it
does not execute that job or validate a real cloud credential.

The additional packaged test runs real fake-provider creation and cleanup,
without submitting jobs or making external network calls. It verifies public
native API and Merv HTTP/MCP traffic through separate service containers, then
checks source/restored research rows and application role privileges. Its private
`packaged-release-evidence.json` records image IDs and outcomes in the pytest
temporary directory. Research R2 byte access and managed Supabase authentication
remain outside this fixture check.

## Operational sequence still required

1. Identify the target deployment and reviewed ownership, namespace, subject,
   provider and live-resource mapping files. Produce private inventories.
2. Restore the target's research/native databases and volumes in an isolated
   deployment; validate database roles and start both packaged services with the
   reviewed overlays and correct consumer-file ownership.
3. Reconcile all policies and usage, run pinned legacy/native shadow decisions,
   and retain reports explaining every intentional difference.
4. Freeze policy writes and new rentals/renewals, capture the final source/native
   inventories, apply the reconciled delta, issue/verify the required grants and
   activate the thin client. Preserve active resource/job identities and access.
5. Run the bounded compute verifier against the reviewed offer and native
   allowance, verify retained research/output access and independent native
   operation, reopen admission, and set the recovery retention deadline.

No production import, restart, cloud rental, commit or push is established by
this evidence. Operational steps require concrete deployment inputs; elapsed
time or passing fixture tests cannot supply them.

## User-authorized branch consolidation

After the work and required checks are complete, consolidate the changes on
`codex/artifact-tool-consolidation`, then merge that branch into `main` and
`prod`, as requested by the user. This merge authorization is already given;
do not request it again. It is conditional on completing the work above.

At this checkpoint Merv is already on `codex/artifact-tool-consolidation`;
merv-sandboxes is on `codex/complete-merv-sandbox-port`. Preserve both working
trees and existing staged changes while preparing the eventual consolidation.
Resolve branch availability and the intended release commit independently in
each repository, review the consolidated diff, and validate any merge conflict
resolutions before updating the target branches. Do not treat today's local
test results as evidence for a later changed or merged tree.

## Production inventory and restore checkpoint

The user supplied the ResearchSuite production VM and approved a dedicated
ResearchSuite native owner, keeping the existing `dev` infrastructure separate.
Read-only inventories cover 29 Merv projects, 42 memberships across six users,
and 12 persisted native namespaces. All legacy/native machines were stopped or
failed and native jobs/workflows were terminal at capture. This is a point-in-time
inventory, not a final admission freeze.

Both full production database dumps were restored on an isolated internal Docker
network without published ports. The current Merv image migrated the actual
production schema from **59 to 60**, retaining 29 projects and 254 experiments;
database preflight passed under the non-superuser application role. The current
native image migrated the actual **0012_workflow_graph** database and inventoried
all 12 resulting accounts. No application, lifecycle or job workers ran against
these copies. Cleanup completed without errors. The packaged service startup
checks above remain separate fixture evidence.

Private backups now include the production databases, active configuration files,
runtime container settings, native data volume and retained management volume.
They have private permissions and SHA-256 evidence outside Git. The active native
deployment uses an environment file outside its release directory; both services
also depend on external Compose overlays. Staging now accepts explicitly named
additional configuration files and preserves Merv's upload size ceiling.
Staging regression checks passed **22 tests**, including private backup retention,
path/collision rejection and refusal to finalize after backup tampering. The
actual Compose environment sources were resolved from container labels; rendered
configuration matched both running images and all configured environment values.
The volume archives were also restored privately: all **3,250 regular files**
matched their archived SHA-256 digests, and the temporary copy was removed.

The private ownership proposal maps the six Merv users separately into the shared
ResearchSuite account. It preserves the $50/day per-user Lambda default, the
existing $140/day Lambda and $10/day GCP project caps, and retired native test
limits. It is not yet an importable manifest: 91 of 194 legacy generation records
lack verified historical price/payer/source information. All 91 ended in July;
the full legacy history ends in August. Retained sandbox/event records examined
so far do not establish the missing accounting facts. Missing values are not
zero charges and have not been assigned to a guessed owner.

No production imports, account creation, service restart or cloud rental was
performed at this checkpoint. Final historical reconciliation, frozen inventory,
operational cutover and branch consolidation remain outstanding.

## Approved unresolved-history treatment and verification

The user approved retaining incomplete history in the native service. Migration
0024 adds generic usage-gap records with known attribution, intervals and source
evidence. They are not zero-cost adjustments. Overlapping finite budgets reject
admission; current daily/monthly windows outside the old intervals remain usable.
Account and scoped usage reports identify incomplete totals. Native administrator
history access exposes retained evidence, while consumers receive only scoped
counts. Evidence-based resolution preserves known facts and atomically books
daily adjustments without duplicate charges on replay.

The actual production copies passed conversion, native preview, apply and replay:
29 project connections, six application subjects, **115 verified daily adjustments**,
**91 unresolved records**, and two retained native smoke machines. The existing
`dev` inventory remained unchanged. All currently configured budget windows were
complete after import. This was an isolated local rehearsal, with no provider
calls or production mutation; operational account IDs must come from the actual
target migration.

Checks for this update:

- Merv full suite: **1723 passed, 5 skipped, 1527 subtests**, 230.86 seconds.
- Native full suite: **623 passed, 8 skipped**, 188.01 seconds. The historical
  receipt fixture was updated to reconstruct its original pre-migration schema.
- Packaged services and image checks: **3 passed**, 44.15 seconds. The fixture now
  waits for PostgreSQL TCP readiness, avoiding its temporary initialization server.
- Native UI build/lint and agent/gateway Go tests passed.
- Strict native typing and full source/test Ruff checks passed. Annotation and
  local variable cleanup followed the full suites and receives targeted regression
  coverage before the commit; no budget semantics changed in that cleanup.

Local rehearsal images are ARM64; the production VM is AMD64. Build and verify
the committed source for the production architecture before activating it. The
production cutover and requested `main`/`prod` merges remain pending.
