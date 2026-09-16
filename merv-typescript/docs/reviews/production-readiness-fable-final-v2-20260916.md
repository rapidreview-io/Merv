# Final v2 Claude Fable readiness review — 2026-09-16

**Completed review.** The actual substantive model was `claude-fable-5`, high effort, one turn, no tools or web requests, and no fallback. It found no blocking defect in the reviewed paths and recommended a **conditional go** for public cutover.

This is a read-only review of the exact explicitly approved frozen packet: 463,356 bytes, SHA-256 `aeaf7122d22ee7f5c1de38da5a7b05dbad59451ce6a146f877dd8e1bef338cca`, plus the fixed 159-byte system prompt, SHA-256 `8c41835c8b08ee2b76673e7f111a266b8db05a8dc787c063df3d829d6a4d197a`. The neutral working directory, empty tools/MCP, restricted settings, disabled dynamic context and exact argv are recorded in the [invocation provenance](production-readiness-fable-final-v2-20260916-provenance.json). The [source manifest](production-readiness-fable-final-manifest-20260916.json) identifies the approved excerpts. No implementation changes were made in response to this review.

Fable did not run tests or inspect Azure. It treats the packet's 780 passing native tests, 9 deployment tests and real-provider evidence as reported evidence. Its request to approve the packet is an already-fulfilled administrative condition: the packet was frozen before the user approved this invocation. Later operational evidence was not appended to the approved packet. In particular, the real shared-account imported-project/history browser acceptance passed after the packet freeze; see the locally observed [rehearsal evidence](../../deploy/REHEARSAL_2026-09-16.md).

The original blocked attempt and both earlier frozen payloads remain unchanged. See the [historical review record](production-readiness-fable-20260916.md).

**Local disposition of F1 after review:** the deployment owner queried the accepted private staging schema read-only: maximum native artifacts in one project **566**, projects above 1,000 **0**, total native artifacts **3,224**. Thus the current imported collection is not truncated by the cap. Pagination remains a future data-visibility improvement; the cap itself is unchanged. This aggregate observation was not sent to Fable.

**Operational corrections and constraints from the deployment owners:** Fable's phrase "30 non-resumable in-flight legacy instances" is not the authoritative active-work inventory. The recorded snapshot has **78 nonterminal instances across workflow types**, including **23 synthesis-waiting idle instances**; their disposition still requires the cutover decision. A production cutover must pause legacy writers and then take a **fresh consistent export/import and reconcile it**. The earlier rehearsal snapshot cannot be chosen as final while the legacy service continues to accept writes. Final public HTTPS/origin and OAuth acceptance remain required. The later shared-account imported-project/history browser check passed. These facts and constraints are local follow-up, not additions to the approved Fable payload.

**Post-review source changes:** project chooser search/ID subtitles and archive focus/navigation fixes are a separate subsequent UI wave. They were not in this frozen-source review and need their own focused validation.

The following review text is reproduced without edits from the successful response.

---

# Independent readiness review — Merv TypeScript frozen v2 packet

**Reviewer basis.** This review covers only the packet supplied on stdin. I ran no tools, no tests, and inspected no infrastructure. Test results, acceptance runs, and reconciliation outcomes below are treated as *reported evidence*, not verified by me.

---

## 1. Overall assessment

The reviewed excerpts are unusually defensive and internally consistent. The release-critical invariants the packet asks about — transactional scoping, re-authorization after awaited callbacks, resource drain on unload, trusted offline import provenance, no fabricated downloads, and compiled packaging — are all visibly implemented in the shown code, not merely asserted. I found **no blocking defect** in the reviewed paths. I found several minor confirmed issues and a small set of evidence gaps.

---

## 2. Confirmed findings (defects and risks in the shown code)

**F1 — `artifact.list` hard 1000-row cap with no pagination or truncation signal.**
`packages/artifacts/src/index.ts:193` (`LIMIT 1000`) and `packages/artifacts/src/tools.ts:49–55`. The UI list (`packages/ui/web/views/artifacts.tsx:140–150`) renders whatever comes back with no "more" affordance. The import evidence reports 3,224 readable files across 30 projects; if any single project holds >1000 native artifacts, the list silently omits records (they remain reachable by ID and via the history view). **Action:** confirm the maximum per-project native artifact count in the imported data, or accept/patch. Severity: low–medium (data-visibility, not integrity).

**F2 — Cursor/ID length mismatch between UI adapter and reader.**
`src/legacy-history-ui.ts:22,27` accepts `after`/`id` up to 4096 chars; `src/legacy-history.ts:1254,1259` caps them at 2000. Real source keys are bounded at 2000 (`legacy-history.ts:902–906`), so this is unreachable in practice; a hostile 2001–4096-char input yields a clean `invalid_legacy_history_query`. Cosmetic.

**F3 — `S3Blobs.put` error masking is inconsistent with `consume`.**
`packages/blobs/src/s3.ts:169–175` converts every non-412 failure (including any `MervError`) into `blob_unavailable` 503, whereas `consume` (line 253) preserves `MervError`. Safe direction (sanitizing), but it can hide `blob_size`/`blob_corrupt` diagnostics from the 412-recheck path. Cosmetic.

**F4 — `S3Blobs.download` throws synchronously for an invalid `expectedSize`.**
`s3.ts:267–270` calls `transferSize(expectedSize)` before entering `operations.run`, so an invalid size throws rather than rejects. All shown callers `await` inside async functions, so behavior is identical in practice. Negligible.

**F5 — PostgreSQL `run()` always reports `lastInsertRowid: 0`.**
`packages/state/src/postgres.ts:180–183`. Every shown consumer uses `RETURNING id` or explicit IDs (e.g., `base.ts:274–284`), so no current defect — but this is a latent trap for any future component ported from the SQLite path. Recommend a comment or a thrown sentinel.

**F6 — Signed-download revocation window.**
`s3.ts:284–296` plus `artifacts/src/index.ts:167–170`: revocation is rechecked *after* signing (good), but an already-issued URL remains usable ≤60 s post-revocation, exactly as the packet discloses. Confirmed as designed; acceptable.

**F7 — Bearer tokens in `sessionStorage`.**
`packages/ui/web/api.ts:14–29` and `auth.ts:11–35`. Tab-scoped, and the bundle is first-party only, but any XSS yields the token. Accepted residual risk; note it in the operational threat model.

---

## 3. Invariants I could positively confirm from the excerpts

- **Transaction isolation and scope invalidation:** `base.ts:55–124` invalidates a scope before COMMIT and on any error path; `assertTransaction` (176–183) binds a `Transaction` to the live AsyncLocalStorage context, blocking cross-request reuse. Committed-event wakeups fire only post-commit via `queueMicrotask` (99–111) and cannot roll back the transaction.
- **Writer serialization / event ordering on PG:** advisory xact lock keyed by schema (`postgres.ts:206–213`), with the scale limitation candidly disclosed. `COMMIT` result verification (188–196) catches silently-aborted transactions.
- **Durable event handlers:** handler effects and cursor commit in one transaction (`domain-events/src/index.ts:171–187`); retry state is recorded in a *separate* transaction after rollback (198–219); `close()` drains subscriptions and the running loop (240–253).
- **Drain on withdrawal:** tool registry catalog replace publishes atomically with no awaits between withdraw and publish (`registry.ts:276–284`), and `drain`/`close` (395–406) wait for admitted generations. `app.ts` serializes admin enable/disable and blocks stop until draining completes (109–163).
- **Session authority:** worker actors are only usable with live session authority (`scope/src/index.ts:684–697`); delegation sources are pinned to credential lifetime (`369–376`); nested sessions are rejected (277–283, 360); invocation IDs are single-use and fenced per-transaction (`sessions/src/index.ts:400–423, 1356–1412`). SQLite triggers make assignment/delegation and agent attribution immutable (190–211).
- **Workflows recheck after every yield:** `checkContext` canonical-snapshot compare (`workflows/src/index.ts:1706–1719`), `requireActive` after awaited guards (e.g., 279, 711, 735, 797, 1386, 1420), read providers restricted to extending declared resource arrays (286–300).
- **Blob integrity:** disk and S3 reads verify content hash and size against metadata (`disk.ts:69–94`, `s3.ts:208–246`); `copyVerifiedFrom` verifies source *and* destination bytes with ETag pinning and R2/S3 immutable-destination conditions (341–404); endpoints must match; keys derive only from validated namespace/hash.
- **Import provenance:** metadata-only classification is possible only through the pinned audit SHA-256 (`legacy-rehearsal.mjs:404–411` → `legacy-media.ts:73–121`), with hard failures for submitted/pinned evidence, figure parents, submission joins, and any exempted hash also required by a retained file (`legacy-media.ts:124–196, 297–302`). Verified originals must keep their source IDs (`legacy-history.ts:1094–1100`). Import receipts and history rows are trigger-immutable in both dialects.
- **No fabricated downloads:** the history UI renders "Metadata only"/"Not verified" without a link (`legacy-history.tsx:65–83, 190–203`); the reader is restricted to verified human members and cannot widen agent authority (`legacy-history.ts:1266–1280`).
- **Identity boundary:** JWKS fetches are bounded, redirect-free, private-key-field-rejecting, with cooldown (`identity/src/index.ts:63–144`); HS256 secrets ≥32 bytes; anon-key classification cannot leak a service-role JWT (45–61).
- **Packaging:** compiled JS + copied UI assets, rewritten export manifests refusing non-`./src/*.ts` exports (`prepare-runtime.mjs:8–15`), pruned dev deps, unprivileged `node` user, mode-0600 rendered config, prefix/schema fencing (`render-config.mjs:20–35`, `schema.mjs`), and acceptance asserting no mount/runner/dispatch/legacy plugins in the smoke composition (`runtime-acceptance.mjs:374–377`).

---

## 4. Evidence gaps (unverified acceptance — request excerpts if a stricter bar is wanted)

1. **`packages/blobs/src/common.ts`** — `copyBytes`, `hashBytes`, `verifyBytes`, `MAX_BLOB_BYTES`, `BlobOperations`. The 2 MB inline cap and disk hash verification depend on it. High-value excerpt; currently inferred from call sites only.
2. **`src/config.ts` and `src/cli.ts`** — `${host}`/`${port}`/`${directory}` interpolation and precedence between rendered config and the entrypoint's `--host/--port` flags (`entrypoint.sh:5`). Low risk since render-config fully overwrites the `api` config, but precedence is unverified.
3. **Scope PostgreSQL migrations** — `reconcile` (`legacy-rehearsal.mjs:529–541`) digests `active: 1`; the reported reconciliation PASS implies integer storage on PG, but the migration text is absent from the packet.
4. Sessions dispatch, tasks/reviews/research programs, and the API HTTP lines 1–284/576–814 are outside the excerpt set; their invariants are relied upon via the reported 780/0 native suite and 9/9 deployment fixtures. I have not verified those results.
5. All operational evidence (Azure smoke pass, 2,961-object verified copy, zero unknown missing keys, reconciliation "matched") is owner-reported and sanitized; I accept it as attested, not confirmed.

---

## 5. Smallest ordered remaining release gates

1. **Approve this exact frozen payload** and disposition these findings (F1 is the only one needing a factual answer).
2. **Answer F1:** confirm no imported project exceeds 1,000 native artifacts, or accept/patch the `artifact.list` cap before users notice missing rows.
3. **Complete the pending real shared-account browser acceptance** against the imported 54-plugin staging: project selection, membership view, history browsing including at least one metadata-only artifact (no download link) and one verified original (working download).
4. **Make the explicit cutover decision:** legacy writer/client quiescence, disposition of the 30 non-resumable in-flight legacy instances as read-only history, and either a final delta export/import or acceptance of the current frozen import as final.
5. **Verify public HTTPS origin and OAuth callback:** `MERV_TS_PUBLIC_ORIGIN` matches the final route; Supabase redirect allowlist includes `${origin}/ui/` (per `session.tsx:99`); confirm the browser `Origin` sent through the TLS proxy is exactly the configured allowed origin (`http.ts:504–511`).
6. **Route flip as a routing-only change** with the documented rollback (no TS→Python backcopy), legacy stack retained through the agreed window.

---

## 6. Deploy / no-deploy view

**The candidate itself: fit to deploy.** In the reviewed code I found no integrity, authorization, or provenance defect; the design consistently rechecks authority after every yield point, and the import path cannot fabricate availability. The confirmed findings (F1–F5, F7) are minor and none is a cutover blocker on its own, though F1 deserves a factual answer given the real dataset.

**Public cutover: not yet.** Two of the packet's own conditions are open at freeze — the real shared-account imported-membership browser acceptance and the explicit legacy-quiescence/cutover decision — and OAuth callback behavior against the final origin is unverified. My recommendation: **conditional go** — proceed through gates 2–5 above, then flip routing. If gate 3 or 5 fails, hold; nothing else in this packet suggests the failure would be in the reviewed code rather than in configuration.
