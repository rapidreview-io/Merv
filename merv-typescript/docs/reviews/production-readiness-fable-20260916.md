# Production readiness review — 2026-09-16

**Historical attempt: Fable consultation was blocked before execution.** A separately approved final v2 review has now completed successfully with the actual `claude-fable-5` model; see the [final review and provenance](production-readiness-fable-final-v2-20260916.md). The original blocked-attempt record below remains historical evidence.

**Subsequent implementation evidence:** the final native run passes **780 tests with zero failures and one optional external Nisa checkout skip** (781 total); deployment tests pass **9/9**. Backend/UI typechecks and builds pass; the production dependency audit reports zero advisories. The rebuilt immutable Linux image passed actual Azure PostgreSQL/R2 workflow, agent, reflection, download and restart acceptance. Isolated import/reconciliation also passed: 30 projects, 43 memberships, 200 claims, 3,224 readable artifact records, 54,314 preserved history rows and 2,961 verified byte objects. The exact documented metadata-only lineage remains explicit. Shared-account imported-project/history browser acceptance passed after the final packet was frozen. These are Codex/local/provider observations, not a Fable verdict. Active-work disposition, external review, a final writer pause/fresh import and public HTTPS acceptance still gate cutover. See [rehearsal evidence](../../deploy/REHEARSAL_2026-09-16.md).

**Subsequent final review payload:** a separate final v2 packet supersedes the original request without modifying it. The packet is 463,356 bytes, SHA-256 `aeaf7122d22ee7f5c1de38da5a7b05dbad59451ce6a146f877dd8e1bef338cca`; the separately reviewed fixed system prompt is 159 bytes, SHA-256 `8c41835c8b08ee2b76673e7f111a266b8db05a8dc787c063df3d829d6a4d197a`. Total approved-content request: 463,515 bytes, 51 source files/excerpts and 16 fingerprint-only paths. [Final manifest](production-readiness-fable-final-manifest-20260916.json). The exact packet, approval file list and neutral invocation plan are under `/private/tmp/merv-fable-readiness-final-20260916/v2/`. It includes no credentials, real record contents or raw production evidence. The user subsequently approved this exact payload and fixed system prompt, and its restricted, tool-free invocation completed successfully. The [final review](production-readiness-fable-final-v2-20260916.md) records the actual model and findings. Later operational checks remain local and did not change the frozen payload.

The user requested an independent Claude Fable consultation before completing the UI and replacing the legacy Azure deployment. A bounded source/evidence packet was prepared. Automatic approval review rejected its transmission before process creation; no source was sent, no alternate model was used, and there is no Fable response to attribute.

## Provenance and approval boundary

| Item | Evidence |
| --- | --- |
| Recorded UTC | 2026-09-16T07:25:07.881487+00:00 |
| Requested reviewer | `claude-fable-5`, explicitly pinned, high effort, no fallback |
| Observed substantive model | **None — invocation did not run** |
| CLI checked locally | `/Users/guraltoo/.local/bin/claude`, version `2.1.261` |
| Restrictions prepared | Safe and restricted modes; all tools disabled; strict empty MCP; no session persistence |
| Packet | 38 source files/excerpts and bounded test evidence, 299,109 bytes |
| Packet SHA-256 | `f14f1a09aec0be1de28826b57cd2a98da13e4f9c1b14fb093b85acfd29edbb50` |
| Private frozen packet | `/private/tmp/merv-fable-readiness-20260916/packet.md` |
| File/range/hash manifest | [manifest](production-readiness-fable-20260916-manifest.json) |
| Raw rejection/provenance | [provenance](production-readiness-fable-20260916-provenance.json) |

Automatic review's exact reason:

> This sends a large packet of private source code and internal test evidence to an external Claude service; although the user authorized a Fable readiness consultation, they did not specifically authorize this exact sensitive payload and file set for that destination.

The packet excludes credential files, environment files, real user records, runtime databases, private deployment state and raw agent transcripts. It includes numbered implementation excerpts for State, Blobs, API/authentication, Scope, Mounts, Sessions, Workflows, DomainEvents, UI, build/configuration and legacy deployment documentation. The manifest is the reviewable file set. Source can change while implementation continues; this packet remains frozen until its exact transmission is approved. The caller was informed immediately. No retry or indirect workaround was attempted.

Prepared invocation, **not executed**:

```sh
/Users/guraltoo/.local/bin/claude --print --model claude-fable-5 --effort high \
  --safe-mode --restricted --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --tools '' \
  --no-session-persistence --output-format json \
  < /private/tmp/merv-fable-readiness-20260916/packet.md \
  > /private/tmp/merv-fable-readiness-20260916/response.json \
  2> /private/tmp/merv-fable-readiness-20260916/stderr.log
```

## Independent Codex assessment

**Do not cut over this snapshot.** The core storage and plugin foundations have meaningful acceptance evidence, but the complete build/regression gate and actual production composition/cutover have not been established. This assessment is bounded to the source and evidence inspected; it is not an infrastructure audit or a Fable verdict.

### Confirmed release blockers or missing acceptance

1. **The broad build/regression gate is red during the async migration.** `/private/tmp/merv-production-storage-suite.log` records 720 tests: 569 pass, 138 fail, 1 cancelled, 12 skipped. The captured global typecheck also fails. Some failures are stale synchronous test expectations; others include migration-sensitive transforms, concurrency and initialization. They must be resolved and rerun on one final source snapshot, not dismissed from targeted successes. These counts are historical work-in-progress evidence, not a forecast of the final result.
2. **The sample production config disables shared login.** [production.example.json](../../config/production.example.json:196) supplies Identity with `{}`; [identity/src/index.ts](../../packages/identity/src/index.ts:160) returns disabled configuration for the empty object. A release promising the shared Merv/Nisa account needs the real issuer/audience/JWKS or explicitly chosen HS256 mode and browser publishable-key configuration, plus real sign-in, expiry and membership acceptance. Shared account identity alone does not configure per-user upstream tool credentials.
3. **HTTPS browser requests need explicit origin configuration.** [api/src/http.ts](../../packages/api/src/http.ts:502) accepts the request Origin only as `http://Host` or a configured allowlist entry. [production.example.json](../../config/production.example.json:120) specifies only host/port. A TLS-terminating Azure proxy that preserves the browser's HTTPS Origin will reject same-site POSTs unless the exact public HTTPS origin is configured. Verify through the actual browser-facing proxy; local HTTP tests do not cover this.
4. **Provider selection is not legacy-data migration.** [PRODUCTION_STORAGE.md](../PRODUCTION_STORAGE.md:70) explicitly says existing Python/SQLite/disk data is not imported. PostgreSQL creates the selected `merv` schema in [state/src/postgres.ts](../../packages/state/src/postgres.ts:108); R2 blob keys use configured prefix/project/hash in [blobs/src/s3.ts](../../packages/blobs/src/s3.ts:105). A rollback-safe cutover must decide which existing records/accounts/evidence are retained, verify their IDs and blob keys, and prove backup restore or preserve the old application independently. Merely pausing the old UI does not stop old agents or API clients from continuing to write.
5. **The TypeScript release artifact and reverse-proxy switch are not yet proven.** At inspection, the repository deployment Dockerfile was the legacy Python image (`../merv/deploy/Dockerfile`), using `merv-control` and `/api/meta`. The legacy Caddy template serves `/merv/` from a separate static directory; the TypeScript UI serves `/ui/` ([ui/src/static.ts](../../packages/ui/src/static.ts:18)). A cutover must switch the intended routes, health check and rollback target together. `npm start` uses `tsx` from devDependencies; a runtime that omits devDependencies without a replacement compiled launch path will not start. An immutable Linux artifact must be booted and smoke-tested before routing traffic to it.
6. **Real external dependencies remain acceptance work.** Local PostgreSQL and signed local S3-fixture tests prove implementation behavior, not production database TLS/permissions, R2 account permissions, actual Supabase login or actual Nisa/sandbox mount grants. Enable only verified mounts. Current mounts use explicit actor/project/mount bindings to `env:NAME` secrets ([mounts/src/credentials.ts](../../packages/mounts/src/credentials.ts:103)); no shared-login-to-upstream-credential provisioning follows automatically.

### Important limits that need not block a deliberately reduced release

- The schema advisory lock serializes writer transactions ([state/src/postgres.ts](../../packages/state/src/postgres.ts:200)). This preserves current ordering invariants and is reasonable for an initial deployment; it is not a scale claim.
- Blobs is intentionally separate from metadata transactions. A failed metadata transaction can leave an unreferenced content-addressed object; deleting it as compensation would be unsafe. Backups must include both stores ([PRODUCTION_STORAGE.md](../PRODUCTION_STORAGE.md:68)).
- Agent tool telemetry records admitted Merv calls and estimates UTF-8 JSON payload bytes divided by four. It is not model context/reasoning/billing usage ([sessions/src/observations.ts](../../packages/sessions/src/observations.ts:5)). The UI already marks values with approximately signs and explains the limitation ([agent-sessions-panel.tsx](../../packages/ui/web/views/agent-sessions-panel.tsx:151)). Exact model-token accounting is not required to ship these honest estimates.
- Code stores commands/receipts/proposals; the Runner performs Git work. Central publication and cross-machine Git object transport remain separate gaps ([Code README](../../packages/code/README.md)). Cut-down release can omit Code/Consolidation and keep task/experiment/reflection research; enabling them must not promise automatic published central code.
- OAuth convenience, runner pairing, candidate promotion and fuller scientific/parity features can remain deferred if the enabled tools/UI accurately describe supported operations. The parity document still contains pre-storage-migration claims and old 695-test evidence; it must not be used as the release receipt.

### Positive evidence, with its limits

| Evidence | Result | Boundary |
| --- | --- | --- |
| Native PostgreSQL domain SQL migration test | All 49 explicit migrations accepted | Private PostgreSQL17; not production data import |
| Workflows callback/transaction acceptance | 11/11 with PostgreSQL enabled | `/private/tmp/merv-workflow-native-final.log`; unload rollback and stale provider replacement included |
| Four focused workflow suites | 23 pass, 2 optional PostgreSQL skipped | `/private/tmp/merv-workflow-final.log` |
| State/Sessions targeted suite | 49/49, no skips | `/private/tmp/merv-state-sessions-final.txt` |
| Native full app + continuing-agent PostgreSQL runtime | 2/2, no skips | `/private/tmp/merv-pg-runtime-final.txt` |
| Production storage + DomainEvents + S3/Blobs | 22/22, no skips | Reported by owning agent: 3 storage + 10 DomainEvents + 9 Blobs; no retained combined log |
| UI build/typecheck | Passed in parallel agent's report | Browser and focused UI verification still in progress at that report |

Storage tests cover native DB migrations, atomic records/events/replay, task/review transitions, restart, continuing agent identity and lease/tool telemetry. The S3 test uses the real AWS SDK against a controlled protocol fixture. None substitutes for one clean global release build plus authenticated acceptance on the actual deploy configuration.

### Small ordered release gate

1. Finish the async migration and obtain a clean backend typecheck/build, UI typecheck/build and complete relevant regression run on an identified source snapshot.
2. Freeze a minimal deployment manifest. Configure shared login, exact public origin, PostgreSQL/R2 and only required plugins/mounts. Build one reproducible Linux release artifact.
3. Boot that artifact separately from production with the intended proxy and storage configuration. Verify shared login, two-project isolation and revoked credentials; create/read an artifact, task/review loop, a research/reflection cycle, continuing agent assignment/tool activity, and enabled remote tool permissions. Restart and confirm retained records/bytes.
4. Prepare and verify legacy backup/restore and routing rollback. Resolve legacy data continuity explicitly; quiesce the legacy write paths required for the chosen cutover, not just its UI.
5. Reconsult Fable with an approved exact final packet and attach fresh evidence. Route production only after the concrete release passes; verify from the public URL and retain the previous release/backup.

No deployment was attempted by this review agent. The Fable portion remains blocked pending the exact source-packet approval required by automatic review.
