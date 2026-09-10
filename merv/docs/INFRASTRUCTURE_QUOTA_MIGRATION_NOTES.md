# Legacy quota semantics verified from source

Implementation notes for the remaining quota migration. These are findings and
constraints, not a claim that the native quota implementation is complete.

The authoritative legacy implementation immediately before removal is available
with:

```sh
git show '7921ad92^:merv/src/merv/brain/sandbox/quotas.py'
git show '7921ad92^:merv/tests/sandbox/test_quotas.py'
git grep -n blob_bytes_budget '7921ad92^' -- merv/src
```

The exporter now converts cumulative USD, compute-hour and resource limits after
explicit full-scope mapping and preserves dormant blob quota values in its report.
Live resources need reviewed native mappings and lifetime reconciliation. Missing
or ambiguous mappings still block conversion. Do not infer quota semantics from
their names alone.

| Legacy field | Actual behavior | Native migration requirement |
| --- | --- | --- |
| `max_concurrent_sandboxes` | Counts tenant resources in provisioning, running, or cleanup_pending. Renewal skips the count check. | Account-scoped concurrent resource ceiling; new reservations count immediately, unconfirmed deletion remains counted, renewal does not add another resource. |
| `max_time_limit_seconds` | Caps initial time limit and the **total lifetime** requested by an extension. | Preserve a lifetime ceiling, rather than replacing it with a fresh per-renewal duration. Reconcile the lifetime origin of any adopted live resource. |
| `max_price_usd_per_hour` | Caps the resource's hourly price. Unknown-price rejection depends on a populated `price_unknown_reason`; legacy callers could omit it. | Generic native per-resource price ceiling with explicit currency. Price availability must come from the service, not a caller-supplied reason. |
| `gpu_hours_budget` | Despite the name, `tenant_spend` sums generation **wall-clock hours**, without multiplying by GPU count; the old ledger has no GPU count. | Migrate as cumulative compute hours, not accelerator-hours. Historical hours need explicit accounting alongside monetary opening entries. |
| `usd_budget` | Compares cumulative historical/live generation spend to a tenant ceiling. It is not a calendar allowance. | An all-time monetary limit sharing the native ledger, not a daily/monthly replacement. |
| `blob_bytes_budget` | Present in schema only. The legacy `TenantQuota`, setters and admission path omit it; the source-wide search finds only its schema declaration. | Preserve and report the dormant configured value explicitly. Do not invent an active storage policy or move Merv research artifacts to infrastructure storage to satisfy an unused field. |

The legacy cumulative checks gate on accrued usage. The target native engine
must also reserve new lease commitments, as required by the ownership plan.
Shadow comparison must identify and explain this intended tightening; identical
cap numbers do not imply identical admission decisions near a limit.
It must also explain rejection of unpriced requests previously admitted when
their caller omitted the unknown-price flag. Do not reproduce that bypass.

Quota ownership follows the full set of a tenant's projects/resources, not just
the projects selected for one export. An exporter must refuse incomplete scope
or a mapping that silently combines independent tenant ceilings. Account-wide
limits also govern future namespaces created in that account.

Keep the Merv side limited to export and explicit identity/scope mappings. The
native service must own all active quota storage, administration, accounting,
reservation and enforcement. Avoid reintroducing Merv quota claims, calculation,
or a special native branch for Merv's historically misleading field names.

The legacy `sandbox/core.py` extension path rereads the sandbox inside its
transaction, increments saved `time_limit` and `expires_at` by the same extension,
then supplies that total to `check_lifetime_extension`. Thus its origin is
`expires_at - time_limit`; generation accounting timestamps do not establish it.
Native imports preserve earlier origins with reviewed evidence and never advance
an existing origin. The exporter reports the stricter semantics when an existing
native origin is already earlier than the legacy one.

## Removed Merv key placeholders

`sandbox_seconds_ceiling` and `blob_bytes_ceiling` had schema/model/transport
plumbing but no enforcement consumer. Their key-model fields, creation/rotation
parameters, SQL writes, principal fields and OAuth/gateway propagation have been
removed. HTTP creation rejects even null or zero values with instructions to use
merv-sandboxes. Historical columns remain for recovery; existing rows authenticate
and rotate without copying the dormant values into new keys. Native account/member
policies remain the infrastructure authority.

The cumulative exporter now reads saved generation tenant attribution directly.
Legacy `tenant_spend` selected `sandbox_generations.tenant_id`, rather than joining
current projects. A current project-only inventory is insufficient to prove that
all historical tenant charges are included. Missing attribution, departed project
history and partial tenant scopes therefore block cumulative conversion.
