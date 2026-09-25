# Read-only Pi pilot — 2026-09-24

## Enabled for all existing user projects — 2026-09-24 18:17 UTC

At the owner's explicit request, Pi is on for all 34 projects with active human
membership. Main 38de76289 is deployed in release
`20260924T181249Z-38de7628-b78543a9330e`, image
`sha256:2557054df2f31a70619ee724959ce2cbf1a3dcddc77b0f326bc5cd4abaf9315e`.
The authenticated Agent sidebar, the Pi list API, public health and UI pass.

**What this evidence covers.** The checks after enablement ran only in the
service pilot project (`project_3b538…`: no human membership, shared
`fleet-cloudflare-canary` namespace) with the pilot actor token. The one fresh
turn completed at 18:18:23 UTC with the requested reply, "Pi is ready.", and it
was told not to use tools. No human project, no `merv-pi-*` namespace and no
native read tool was exercised. It is not acceptance for the other projects, nor
for API, UI or security.

**Provider scope gap, 18:17–19:33 UTC.** The 33 new `merv-pi-*` namespaces were
missing from the explicit namespace list of `cloudflare-fleet`, so a create from
any of those projects would have failed with `provider is not configured`. The
QA project's onboarding at 19:33 UTC added every `merv-pi-*` namespace and
verified that each one resolves the provider;
[`pi-connect-project.py`](../deploy/pi-connect-project.py) repeats that step.

**Wedged Fleet slot, 18:28 UTC.** An Agent message in the QA project, which had
no sandbox connection yet, created allocation `flt_480e9542…`. Its create failed
before any network call, and the row stayed `uncertain`. It held the only global
slot and blocked Pi in every project. It was released by hand at 18:31:52 UTC:
the column and `data_json` were both set to `released` with intent `stop`, and
`error` was left set. Fix f955c0010 refuses such requests at admission.

The 33 newly connected projects have separate namespaces and finite 30-day
consumer grants. The one earlier human connection still shares the pilot's
namespace, and probably its grant. Normal sign-in and project permissions remain
required, and new projects need the same connection onboarding. Grants must be
renewed by October 17. The founder must replace the Cloudflare native verification
credential before it expires on September 30. See
[Pi operations](../deploy/PI_OPERATIONS.md). The USD 100 all-time cap, accrued
accounting, concurrency 1/1/1 and native maximum 3 are unchanged. Workflow
dispatch remains off, and hosted Pi uses `gpt-6-luna`.

Hosted 1d823/application 13 and Sandboxes 32025 remain deployed. Full fresh
acceptance, cleanup of temporary diagnostic access and the previously disclosed
private-transcript credential incident remain outstanding. Owner-directed
enablement is not a Gate A/B verdict, and earlier failed evidence is retained.

## Worker burst candidate — 2026-09-24 16:51 UTC

The receipt-bound Stop continuation did not reach Stop: its third worker
interrupted before a live stream was available. The actual relay returned HTTP200
and recorded a client disconnect; this does not establish the worker exception.
Both failed receipts remain intact. The temporary source credential is revoked,
all runtimes are drained, and accrued infrastructure spend is0.13292461545792
with zero reservations under the unchanged USD100 all-time cap.

An offline pinned-SDK regression now proves a separate concrete defect:160 rapid
text deltas overflow the old64-event queue before its heartbeat flush. The narrow
fix coalesces queued text into the existing8192-character chunks while preserving
the64-event queue,32-event batch, cancellation and authority limits. Eight
relay/protocol cases,17 worker cases and typecheck pass. The fix is not yet
deployed, and the offline reproduction is not proof of the live interruption's
cause. A new hosted digest requires actual candidate Linux checks, guarded native
rollout and fresh image-bound security evidence before renewed Pi/UI acceptance;
the old Gate A/B verdicts cannot simply be copied. Main4b7ec0 and hosted8438
remain live; their source33d1e88ca CI is green. Normal human project onboarding
also remains outstanding.

## Current published release — 2026-09-24 16:42 UTC

Main33d1e88ca is on main and deployed as image4b7ec0cdef96, release
`20260924T163159Z-33d1e88c-d4431900f461`. Its full CI verification36027712527
passes, as do60/60 plugins, health, UI/assets and authentication/origin checks.
It adds only privacy-safe relay failure metadata to the previously published
runtime code. Hosted8438/application12 and Sandboxes32025 are unchanged.

Fresh production UI checks pass real project reads, visible streaming, forced
reconnect without duplication, idle release and replacement-runtime checkpoint
restore. The harness then correctly refused its third send because the second
runtime had not yet released its budget reservation. That failed full-run receipt
is retained; a separate, receipt-bound Stop-only continuation is being prepared
after drain, without repeating the two passing turns or relaxing the budget gate.
The earlier first-release worker interruption is not reproduced or explained by
these successful turns; it is not relabeled fixed.

The superseded expired consumer is revoked and removed from both allowlists.
The replacement expires2026-10-24T16:14:06Z; renew by2026-10-17T16:14:06Z.
Provider operator credentials have a separate September30 expiry. The USD100
all-time cap, accrued accounting, concurrency1/1/1 and native maximum3 are
unchanged; diagnostic SSH stays disabled. The pilot project has no human
membership, and human project selection/onboarding remains outstanding.

## Published production release — 2026-09-24 16:26 UTC

Main14656e830 is pushed and deployed as image8ef2027551fd, release
`20260924T161517Z-14656e83-56e6f2e1d51c`. Its health,60/60 plugins, public
UI/assets and authentication/origin checks pass. This includes the UI accumulator
simplification. Hosted8438/application12 and Sandboxes32025 remain unchanged,
with diagnostic SSH disabled and temporary administrator keys absent.

The first new-release browser turn reached working, then reported
`worker_interrupted` without assistant output. Its cause is not yet established;
this regression is **not accepted**, and health checks are not functional proof.
The failed evidence is retained, its temporary actor credential revoked, and all
allocations/native instances drained. The USD100 all-time cap, accounting and
concurrency limits remain unchanged. Four CI fixture failures are corrected in
aa065749a with focused tests passing; the new broad CI result is pending.

The production consumer is now finite30days, expiring2026-10-24T16:14:06Z;
renew by2026-10-17T16:14:06Z through the existing scoped path. There is no
automatic renewal. Superseded-grant cleanup is pending. Provider operator
credentials have their separate September30 expiry; this consumer lifetime does
not extend them. The pilot project still has no human membership, so normal
human onboarding remains unverified. See [Pi operations](../deploy/PI_OPERATIONS.md).

The following entries are historical; their earlier image/expiry statements do
not describe this new release.

## Main publication — 2026-09-24 16:09 UTC

The approved Fleet/Pi changes and post-verification UI simplification are being
published with the current main-branch simplifications, including removal of the
legacy importer. Independent Lean work is excluded and preserved in its original
checkout. Reconciled typechecks, builds, focused Fleet/Pi and managed-runner tests,
and migration tests pass. Production readback independently confirms the exact
published `fleet@1`, `pi@1` and `sessions@8` hashes; none is rewritten.

This publication is not yet a new deployment. The previously accepted Main51bc
remains healthy. Its finite pilot consumer expired; normal browser authentication
does not depend on the canary actor token, but the configured pilot project has
no human membership. Do not claim user onboarding or sustained availability from
health checks. See [Pi operations](../deploy/PI_OPERATIONS.md) for the scoped
consumer rotation and verified-human access requirements. The USD100 all-time
cap and accrued accounting are verified unchanged.

Status (2026-09-24, 11:06 UTC): **The bounded production pilot is verified and cleanup is complete.** Live API/UI tests pass read queries, streaming, reconnect, idle release, replacement checkpoint restore and working-stream Stop, creating zero tasks. Independent review covers514 assembled sources; full scans pass ten Merv-controlled and four available-provider surfaces with no secret matches. Provider-internal visibility remains explicitly unproven. Earlier failed runs remain retained.

Cloudflare application12 is the verified same-image SSH-only cleanup of tested application11: authorized keys removed, SSH disabled, no live native instances. Both temporary private-key copies and the matching agent identity are absent. Main remains healthy on image51bc, Pi on/workflow off, original environment/catalog restored. Public HTTPS health, actor, conversation and UI readbacks all return200. The100USD/all-time cap, accrued0.126239318147920000, zero reservations, accounting and concurrency1/1/1 remain intact. Original Caddy configuration is restored; all diagnostic observers and sidecars are terminal.

After verification, duplicated UI text/progress accumulation was simplified, retaining command/scope/sequence guards and memory bounds. Twelve focused UI tests, UI typecheck and scoped formatting pass. **This refactor is local only, not deployed**; the verified production image is unchanged. See the Fleet handoff and root closeout5419a1e201fd5de861a3b848be1c417818a2d6aad00f1b61924524665d0f76cd for exact evidence.

**Finite pilot, not permanent availability:** source/consumer credentials expire2026-09-24 around11:35UTC. Continued operation thereafter needs normal scoped renewal or an established rotation policy; no permanent credential fallback was introduced.

## Fresh Gate B Accepted — 2026-09-24 08:01 UTC

Independent review rehashed257 assembled sources and45 original witnesses; the final scan passes all ten Merv-controlled and four available-provider surfaces with no matches. The available-response count/row reconciliation retains both distinct records sharing one provider ID and the original incomplete collector status. Provider-internal emission/loss remains explicitly unobservable. Parent reverified actual A/B originals and their distinct reviewers. Pi enablement/API/sidebar tests and temporary-access cleanup remain next; product code simplification follows verified production operation. A timestamp-ordering bug in the proof-staging helper failed before mutation and is receiving a narrow fix/regression review; the100USD/all-time cap and accrued accounting are freshly verified unchanged. Exact evidence hashes and active sidecars are in the Fleet handoff.

## Fresh Gate A Accepted — 2026-09-24 07:35 UTC

The independently reviewed round16 fixed-worker terminal path is accepted at07:33:53UTC on application11/current images; parent rehashed the root-private review and evidence. Its actual isolation/protocol checks, root capture, managed release, native absence and backend purge are bound to this run. The absent DELETE-hold fixture remains explicitly failed, not fabricated. Fresh Gate B still needs complete controlled-source and available-provider scans; Pi API/sidebar live acceptance and temporary-access cleanup remain outstanding. The provider ID collision has a separately reviewed, count-backed available-response reconciliation path using existing originals, with no claim of unique provider IDs or inaccessible provider completeness. See the Fleet handoff for exact hashes and current parallel work.

## Fresh Complete Native Capture — 2026-09-24 07:28 UTC

Round16 on the deployed application11 completed all20 reported isolation outcomes and actual restart/retry/replay protocol checks. Independently launch-bound diagnostic SSH obtained88 controlled files, five database inventories and complete writer EOF; both post-close provider inventories show zero physical instances and the target Durable Object unbound. The fixed worker ended without entering the DELETE-hold fixture: its recorded watcher failure remains intact, while the previously approved terminal-capture alternative is undergoing fresh independent review. Do not repeat a paid workflow just to manufacture a hold.

Both host collectors completed. Available Worker telemetry retains31 records and consistent bounded count witnesses, but one Worker/DO pair shares a provider ID; both distinct bodies remain preserved. Independent reconciliation must prove available-source coverage and scan every original, explicitly retaining the provider identity/internal-visibility limitation. No new Gate A/B acceptance is claimed yet. Pi API/sidebar sources are prepared; neither live phase is enabled or accepted. Finite grants were renewed through normal scoped paths until09:06UTC; the verified100USD/all-time cap, accrued accounting and concurrency remain unchanged.

After actual production operation and cleanup of temporary diagnostic access are verified, the user requests simplifying overengineered code while preserving security checks, acceptance evidence and unrelated peer work. This follow-up cleanup is remaining scope, not a substitute for live acceptance. Exact source hashes and active work are in `output/fleet-cloudflare-canary/API_CLI_HANDOFF.md`.

## Fresh Live Workflow — 2026-09-24 03:21 UTC

One application11/new-image workflow completed with all20 reported isolation outcomes and the intended lost-response/restart/retry/replay/negative-enrollment checks. It is **not accepted**: native capture failed because its observer rejected legitimate task revision0, then the held-stop allocation lifecycle. The bounded DELETE hold expired normally; no native administrator SSH/bootstrap occurred. Parent closed the test topology, restored healthy disabled main/Sandboxes services and retained the original workflow, failure and source evidence. Sol sidecars fix/review the observer, collect/scan available failed-run bytes with the gap explicit, and prepare a separate fresh run—not relabeled evidence or a duplicate live task. Pi API/sidebar acceptance and final temporary-access cleanup remain outstanding. See the latest Fleet handoff for exact identities, hashes and active handles; the03:01 accounting value below is historical, not a post-run readback.

## Compatibility Rollout — 2026-09-24 03:01 UTC

Guarded rollout completed: main `51bcfd…`, Cloudflare application11/immutable hosted digest `8438a2…`, release `rt1_c1b413ffe16933bef9f36f9c7a68ee42ee1bc1fca9f10c69250dc539d8a831d4`. Both Sandboxes services retain their previous image. Exact activation, source, native verification, stopped-log retention and accounting hashes are in the newest Fleet handoff. The cap remains USD100/all_time, accrued0.101687566042400000/reserved0 with complete accounting. Source proof has no reused old acceptance. Fresh round15 preparation is local only; diagnostic key-trust verification remains before paid testing. API/UI acceptance and final temporary-access cleanup are still required.

## Compatibility Publication — 2026-09-24 02:52 UTC

The minimal compatibility candidate now passes its protected Linux launch/isolation checks, including actual independently bound host-root inspection of the worker environment without extra container capabilities. Its hosted image is published and registry-verified at `sha256:8438a21f10755fa3d175bb485004764b552d2af7bdfd04cc0daad57b784919a3`; temporary Docker registry-auth files are removed. Publication receipt SHA256 `40ff4bf6fcbbe69a7c87a18322667308a5e1e85524307733cf86baea8c551b7b`. **Not deployed yet; no live API/sidebar acceptance.** Guarded coordinated activation and independent review are in progress, followed by fresh image-bound security gates. The USD100/all_time cap, accounting, concurrency and final temporary-access cleanup remain mandatory. See the newest Fleet handoff for authoritative baseline hashes and active sidecars.

## Compatibility Candidate — 2026-09-24 02:43 UTC

Real provider-response replay exposes a reproducible SDK/relay mismatch: encrypted reasoning items include an empty `content` array rejected by the relay. The candidate accepts only that empty array, retains strict nonempty-content/credential/tool restrictions, and corrects model metadata so thinking-off actually sends reasoning effort `none`. Thirty-three focused worker/relay tests pass locally and on Linux; the same retained provider responses now replay successfully with a synthetic final answer. This is not proof of the old live interruption's exact cause. Minimal main/hosted candidates are built but not published/deployed; a separate protected-launch fixture fails identically on base/candidate and is under investigation. New images still need their own applicable security evidence and live API/sidebar acceptance. The failed first API attempt is fully retained and archived, with its missing receipt/coverage explicitly preserved. See the latest Fleet handoff for hashes, active sidecars, and unchanged live deployment/cleanup obligations.

## First Real Turn — 2026-09-24 02:32 UTC

The first actual Pi command reached working, then interrupted without a saved answer. Its bounded driver exited124 before emitting a complete API capture receipt;335 original body files and the valid held-stop native diagnostic capture are retained, not relabeled acceptance. Automatic recovery closed the topology, restored healthy baseline3081, and two independent native snapshots verify no running instance. A collector sidecar is retaining/scanning available failed-attempt evidence with explicit gaps. Separate API-billed Sol sidecars investigate real provider-wire replay and narrow diagnostic capture. The deployed worker bundle matches the local source build, and a trusted-parent direct Luna request with all five SDK tools succeeds, which narrows but does not establish the live cause. Latest accounting remains100USD/all_time, accrued0.101687566042400000/reserved0; source/consumer grants expire03:58UTC. Full API/sidebar acceptance and removal of temporary diagnostic administrator access remain mandatory.

## Streaming Correction — 2026-09-24 02:12 UTC

The first live API attempt created/listed an empty conversation but timed out before any model send. Same-body direct/public Node probes identified Caddy gzip buffering: first decompressed bytes arrived in75ms directly versus20seconds publicly. A guarded, independently reviewed proxy-only change excludes Pi event/model-relay paths from compression, preserving auth/routing, the other site, images and environment. Public initial snapshot now arrives in77ms; unauthorized event/relay requests remain401 and UI HTML remains200/gzip. Failed originals are preserved, the empty phase is closed, and fresh API then real browser sidebar acceptance remain required. Temporary diagnostic SSH cleanup is still pending. See the latest Fleet handoff for exact receipts and finite-grant limits.

## Live Readiness — 2026-09-24 02:04 UTC

Fresh scoped source/consumer grants expire03:58UTC. Same-image Pi enablement retained and verified a full PostgreSQL backup and exactsessions@8/pi@1 ledgers; local and HTTPS readiness passed. The first API capture topology is opening before any paid Pi turn. Browser sidebar acceptance follows sequentially.100USD/all_time, accrued0.099937502070320000, zero reservations and unchanged concurrency are retained. Native diagnostic SSH remains installed pending final cleanup. See the newest Fleet handoff for actual receipts and active work; earlier disabled/expired/cleanup checkpoints are historical.

## Current Checkpoint — 2026-09-24 01:45 UTC

Update01:46UTC: Gate B independently accepted at01:45:53UTC; parent rehashed both accepted A/B reviews and evidence with identical round14 release/version pins. Pi enablement and live API/browser acceptance still remain, following fresh finite-authority renewal. Provider-internal completeness remains explicitly unclaimed.

The acceptance owner approved complete Merv-controlled capture/scans plus all available Cloudflare logs with explicit provider-internal visibility limits. The earlier provider-completeness blocker below is superseded, not silently waived. Round14 on application10 completed the corrected88-file/141-entry native capture, all20 isolation checks and protocol recovery sequence; independent Gate A accepted its unchanged evidence. Independent Gate B assembly/scanning reports complete ten controlled surfaces and four available-provider surfaces with no secret matches; final independent acceptance is still pending. No provider-internal completeness is claimed.

Pi/API/browser sidebar live acceptance has not run; Pi/workflow remain disabled and no turn is active. Source/consumer01:06UTC grants have now expired; a dedicated API-billed GPT-6 Sol sidecar prepares normal scoped renewal, while others finish independent review and prospective Pi capture integration. The verified100USD/all_time cap, accrued accounting and concurrency remain unchanged. Temporary diagnostic SSH/key is currently installed on app10 and cleanup is pending. The version9 cleanup and expired-grant descriptions below are historical. See the newest Fleet handoff for exact evidence and active sidecars.

## Current Safe Checkpoint — 2026-09-23 22:32 UTC

Gate A and the actual recovery/purge observations below are retained; **Gate B and Pi/API/UI live acceptance remain incomplete**. The verified external evidence boundary is provider-controlled/platform-generated log completeness, not credentials or UI scope. A provider-backed completeness witness or an explicit acceptance-owner decision is required; no check was waived. The corrected exact-schema collector passes30 local/Linux tests but still requires fresh live capture after the evidence path is resolved. Independent analyses and all run-specific limitations are in the latest `output/fleet-cloudflare-canary/API_CLI_HANDOFF.md` checkpoint.

Cleanup is verified: Cloudflare version9 keeps the same image/capacity with administrator SSH disabled and zero authorized keys/CA keys; drained rollout verification completed and maintenance resumed. Temporary diagnostic/TLS private keys are deleted, fault proxies removed, canary source/consumer revoked and test capacity released. Main/Sandboxes images and main environment are unchanged, services healthy/running, Pi/workflow off. Version8 acceptance observations are not relabeled as a version9 live test. All Sol/API sidecars are finished.

At22:31:57UTC the Fleet account cap remains **$100/all_time**, accrued$0.08477241874608, reserved0, with complete accounting and all six drains0. This is not total OpenAI API billing. Historical checkpoints below do not override this state.

## Current acceptance checkpoint — 2026-09-23 22:09 UTC

Update22:28UTC: round11 independently repeats Gate A successfully. Actual launch-response loss automatically retries with the same receipt; enrollment-response loss survives SIGKILL/restart with the same control identity. Exchange-response loss reconciles through Fleet's consumed-state inspection, and a separately labeled parent-driven exact POST replay returns the same consumed receipt. Both fresh negative-enrollment expiry and revocation scenarios reach the expected terminal state, purge encrypted material, deny exchange and preserve terminal replay identity. Original cleanup-harness failures remain recorded; separate parent reconciliation verifies stopped sandboxes, empty complete native inventory, zero provider activity and zero accounting reservations. These are partial protocol results, not valid-enrollment or Pi turns.

Round11's23 captured host/API/diagnostic/provider files scan clean; expiry52 and revocation33 captured API/host files plus24 provider responses also scan clean. Complete coverage remains false. Precise Codex schema gaps are identified, and a pinned-binary-derived collector now passes30 local and Linux tests, but withheld historical bytes cannot be recovered; fresh full diagnostic capture remains required. The independent provider review confirms that app-owned journals cannot establish completeness of platform-generated logs outside application control. No missing permission or repeated query fixes that evidence boundary; no gate was waived.

At22:27:07UTC the cap remains$100/all_time, accrued$0.08477241874608, reserved0, accounting complete, all six drains0. Source credential is revoked with actual401 verification. Guarded temporary administrator SSH removal is in progress, targeting Cloudflare version9 on the unchanged image; do not redeploy blindly. Pi/UI are still disabled. Latest cleanup state and exact independent evidence are in `output/fleet-cloudflare-canary/API_CLI_HANDOFF.md`.

Independent review accepts Gate A for the round8 protected execution: all twenty assignment isolation outcomes plus initial-namespace root ownership, inode/device and content binding. Cloudflare is now version8 on the same pinned41d820 image, with temporary diagnostic SSH that must be removed after testing. Actual enrollment-response loss, same-container SIGKILL/restart, identical retry identity, changed-nonce409 and legacy-empty400 were observed. See `output/fleet-cloudflare-canary/pi-gate-a-review-20260923.md`.

Gate B is **not accepted**. Captured files scan clean against nine credential roles, but complete source/loss coverage is still unverified. Stored telemetry enumeration cannot prove no ingestion loss or separate container stdout/stderr completeness. The private-copy SQLite collector fix passes28 Linux tests but needs fresh live capture. Launch/exchange response-loss and pending expiry/revocation acceptance remain in progress; a fault-proxy discovery-response assertion prevented round10 from reaching runtime binding. That topology is closed and main restored; API-billed GPT-6 Sol sidecars own focused debugging/review while the parent owns integration.

Pi backend and sidebar UI are implemented and compiled; live API/send/stream/stop/reconnect acceptance has not run and must wait for full gates. `pi@1` remains unapplied. At22:08:45UTC the effective pilot cap is **$100/all_time**, accrued$0.08178254567456, reserved0, with complete accounting and all six drains0. Older configuration/access/budget statements below are historical, not current instructions.

Budget update20:55:27UTC: the user authorized **$100USD total**, replacing$0.10. The existing account policy is verified at cap100 with `all_time` window (no monthly reset), accrued$0.07426394093504 unchanged, reserved0 and available$99.92573605906496. Accounting, concurrency, security gates and finite credentials are unchanged. No service/agent restart or duplicate acceptance run occurred. Evidence: `output/fleet-cloudflare-canary/pi-candidate-evidence/budget-cap-100-20260923.json`. Older cap figures below are historical.

## Coordinated rollout and diagnostic coverage — 2026-09-23 20:44 UTC onward

Main `sha256:0bf6be67e558eea97b98068966b504b05c530204b04ba5559105a664172566a4` and Sandboxes `sha256:32025c65ddd1f2d08392cec1dbf3da5b9508fec5d58e0c92a35dfd9fde1e8c56` are healthy. Guarded Cloudflare rollout verified version **6**, manifest `sha256:41d820f3f35ba601d88ea4e6165c28bf07cffddf8901714a72d10638cecad383`, capacity three and a drained inventory before resuming maintenance. New release `rt1_00213dc552528fb3c1d5483f0b4bdcfa775a6f9ea429850b7626d0db65657115` is an additive fifth catalog entry. Actual production ledger readback confirms exact `sessions@8`; its publication fixture is now true. `pi@1` is not applied. The migration-compatible rollback remains an offline artifact, not permission to expose the legacy enrollment protocol.

The approved host-bound observability credential works. Verified queries require separate Worker/DO and container datasets, with container `$metadata.service` equal to the **application ID**, not its name. A deliberately small live page limit exposed inclusive cursors stalling on tied timestamps; `events.count` also reported page length rather than the independent total. The collector now uses independent count aggregates, bounded time partitions, exact source/ID checks and a final count reconciliation instead of trusting that cursor. Counts and logs do not by themselves establish complete source/loss coverage.

The remaining diagnostic gap is real per-run `stdout.log`/`stderr.log` and possible Codex-home diagnostics, which are not container stdout/stderr. Source review and the actual deployed config show no existing authorized administrator key/CA for Cloudflare's supported private SSH channel. Ordinary Sandboxes SSH correctly refuses protected runtimes and remains unchanged. Temporary Cloudflare-admin diagnostic access was requested; no key was added, no fault proxy was installed, no new acceptance VM was launched, and Pi/UI remain gated. See `output/fleet-cloudflare-canary/pi-diagnostic-sinks.md` and the latest handoff for the collection boundary and finite grant expiries. The $0.10 cap is unchanged.

## Previous checkpoints (historical)

Latest candidate pair: `merv-typescript:pi-shutdown-candidate-20260923` (image index `sha256:3c5b42a2c86eb8cb925f731d35d1a373eea39c51278d7fcc0fa1ffae37b96a96`) and `merv-hosted-pi:peer-shutdown-candidate-20260923` (index `sha256:5a82e254179419e8ff43b0a7daafcf8edf7d4f003066e0e4816c7b199343bf8d`, amd64 manifest `sha256:8a8696f56afc778329bf11d7018f5e18f917a3f3ce2905cc3d86b9afcd2e48d5`). The main image is now deployed and healthy. The independently fetched registry manifest matches that amd64 digest; Cloudflare application version 5 uses it at capacity three. The runtime bundle is compiled from the peer-preserving merged source, including the shutdown fix. Both Linux probes pass, but full actual-provider acceptance remains incomplete.

## Latest continuation: candidate and collection preparation

The preserved-peer main, hosted runtime and Sandboxes security candidates now build on the existing control host; no dependency reinstall or production deployment occurred. Image IDs, source manifest and unchanged Pi worker/dispatcher hashes are recorded in `output/fleet-cloudflare-canary/pi-candidate-evidence/gates-build-20260923.json`. A separate migration-only rollback image is built from old functional source plus exact `sessions@8` registration. Real compiled-image checks on isolated disposable PostgreSQL establish candidate v8 initialization, old-image `migration_ahead`, and rollback initialization with preserved data/ledger. Only registration/new migration compiled files differ. This is an offline recovery artifact: legacy managed ingress must remain independently fenced, not merely assumed safe because migration succeeds.

One new PostgreSQL rollback test, five private evidence-scanner tests and three real-HTTP response-loss mechanism tests pass. The newly built hosted image passes the synthetic-ancestry fixture's twenty denial outcomes. Main/UI and rollback compilation and CLI checks pass. Existing passing suites were not broadly duplicated. None of this is new actual-provider acceptance.

`pi-log-coverage.md` documents why supported Worker/DO tail does not establish complete container stdout/stderr, diagnostic sink or historical/reconnect coverage. No equivalent full path was verified, no repeated 403 was attempted, and re-login is not proposed. The exact missing telemetry-query permission remains **Workers Observability Write**, or a verified supported equivalent. `pi-gates-collector.md` and its bounded scanner/response-loss helpers prepare the fresh run, but provider capture, protected-seam fault routing and live lifecycle evidence remain pending. Coverage declarations require independent witnesses; helpers never mark Gate B accepted.

Final readback keeps the $0.10 cap, $0.07426394093504 accrued, zero reserved, all six drain counts zero and Cloudflare version 5 with zero instances. Pi/workflow remain off. Next is full fresh Gates A/B with complete collection access, then the approved optional Pi UI acceptance; no further UI scope question is needed. See the latest `API_CLI_HANDOFF.md` checkpoint and `pi-gates-rollback.md` for exact artifacts and safeguards.

## Previous continuation: local security hardening

No new deployment or hosted Pi turn occurred. The existing OAuth still permits deployment, but both that credential and the server-native read token return HTTP 403/code 10000 for the documented Cloudflare telemetry-query API. Its required Workers Observability Write permission is missing from the current OAuth scope list. Complete live secret-canary log evidence is blocked pending a suitably scoped credential supplied through a private file path. Existing live state, disabled Pi/workflow flags and the $0.10 cap remain unchanged.

The next candidate replaces process-name discovery with a fixed pre-harness probe: exact root ancestry and guardian socket ownership, stable PID/start-time rechecks, a child using the real assignment identity drop, strict denial errors, and a root-owned read-only report. Missing processes/sockets remain failures. A synthetic-ancestry Linux fixture passes with no network or additional capabilities; it is not an actual workflow or Cloudflare acceptance. The suspected namespace explanation for the old shell's missing root processes remains unverified until the v2 shell probe runs on the new pinned release.

Managed enrollment now requires a stable HEX64 worker nonce, rejects changed retries, and preserves the same control identity across server restart. This adds unpublished `sessions@8` without changing published SQL. The protected runtime service gains a scoped, exact-binding exchange acknowledgement; Fleet calls it only after a trusted owner reports running, allowing encrypted-bootstrap purge before stop. Finished/failed startup alone is not handshake proof. These coordinated server/service/image changes are local only; deploying them requires a new pin, a drained rollout and a migration-compatible rollback plan.

Current focused validation: **200 passes** (113 Merv/Pi/UI, 61 Sandboxes boundary/store/transport/API, 24 launcher unit, two packaging), one macOS/Linux-only skip, both typechecks, and the synthetic Linux probe. These results do not replace the earlier full suite or the missing live gates. The UI's eleven behavioral tests pass, but production enablement remains gated. Evidence, private credential references, preserved peer-source archives and exact next steps are in the latest `output/fleet-cloudflare-canary/API_CLI_HANDOFF.md` section.

## Latest live gate

Local Wrangler OAuth successfully authenticated with the expected account and Workers/Containers/Cloudchamber write scopes. A fresh 15-minute registry credential published the existing tested image and was deleted. The maintenance guard held admission stopped through Cloudflare's asynchronous transition, independently verified the pinned version/image and stable drained inventory, then resumed. The four-entry catalog preserves all three previous releases. The new release is `rt1_c5aae9ebdac331960e0dd4879d0ddbfa3804d32330ac3a6fc2c54cd21676d77b`; Sandboxes service images remain unchanged.

A real `gpt-6-luna` protected workflow enrolled, delivered evidence, entered review, released automatically and reached provider-confirmed native absence. The eleven-line UID/capability/private-path subset passed. **Expanded Gate A did not pass:** the fixed probe found no root-owned process named `node` visible from the assignment shell and exited at `assert roots`, before its process/socket JSON report. The producer correctly reported that check unmet. The task was marked failed rather than accepted. Investigate actual supervisor visibility; neither infer an escape nor weaken the missing tests. The older collector's subset `localChecksPassed:true` is not full security acceptance.

Historical exact launch replay/discarded-response retry returned one stable receipt. Changed bootstrap returned 409, enrollment after stop 401, and protected snapshot creation 403. Zero ordinary job/snapshot rows and purged bootstrap material were verified. Live exchange-loss/restart and Cloudflare log/diagnostic scans still remain. No hosted Pi turn has run.

After cleanup, Pi and Fleet workflow are both disabled, project dispatch is off, and the temporary source/consumer credentials are revoked. All VMs from this canary are gone. Current main environment hash is `6d97bd4cc7adf8daea6e70a8560a74264cff85022fa35fed4f2fcb71d3c94c67`. Budget remains $0.10, accrued $0.07426394093504, reserved zero, available $0.02573605906496. Sanitized evidence and the explicit incomplete verdict are under `output/fleet-cloudflare-canary/pi-candidate-evidence/`; the handoff identifies current Compose, rollback records and private credential locations without values.

The corrected Linux broad run completed 1,679 tests: 1,677 passed, one skipped, and one exposed a real worker shutdown race. Cancelling an in-flight `/next` request could reject a normal shutdown; the worker now returns normally on an explicit stop without weakening post-enrollment authority failures. Two deterministic subcases fail before the fix; all 31 worker/service tests pass after it. The fresh full rerun passes **1,681 tests, zero failures, one optional Nisa cross-repository skip** (1,682 total, 509.75 seconds), including all six formerly disk-blocked regressions. It uses `merv-typescript:pi-shutdown-tests-20260923` from `/opt/merv-typescript/releases/20260923-pi-shutdown-candidate`, preserving peer source and excluding unrelated local Lean work. The disposable test containers and internal network are confirmed removed. Sanitized logs, source hashes, overlays and probe results are retained under `output/fleet-cloudflare-canary/pi-candidate-evidence/`.

## Implemented

- Optional `@merv/pi` server, tools, API, UI and sandbox-worker entries. Pi requires Fleet; ordinary external runners and clients require neither. Creating a conversation does not allocate capacity or create a task. Sending atomically records a command and requests generic Fleet capacity.
- One active turn per conversation, and one machine per person per project (2026-09-24) shared by all of their conversations there: a v2 worker runs up to the machine's slots of turns at once, and a move starts the new machine before the old one stops. Stable command IDs, worker nonce, source/project/conversation/epoch/runtime/expiry checks, ambiguous-begin interruption, and cancellation fences.
- Separate Scope conversation authority and ToolRegistry conversation policy. Session authority remains separate. Native handlers are admitted through the existing registry, reads including post-snapshot authorization, and every permission is the person's live one (2026-09-25, below). Missing authority fails closed; mounted tools, shell/filesystem tools and nested delegation are excluded.
- Two tables: conversations and commands/outcomes. Full Pi session trees and active leaf are retained in the existing immutable Blobs storage used by Artifacts, with digest/readback verification, compare-and-swap publication and a previous pointer. No synthetic artifact authorship or task is invented. Canonical results survive checkpoint-storage failure.
- Bounded memory-only SSE tails, canonical reconnect, a new stream generation after tail eviction, and no token/progress persistence. The Agent UI supports creation/selection, stable send retries, streaming, stop, reconnect and operational states. `MERV_UI_PI=omit npm run build --workspace @merv/ui` excludes the Pi renderer from an optional distribution; ordinary disabled builds retain an inert renderer.
- A fixed protected dispatcher supports both the existing workflow Codex supervisor and the new Pi worker. It validates the root/tmpfs bootstrap, feeds private stdin, clears the bootstrap, scrubs environment, drops identity/capabilities and supervises shutdown. Only the sandbox worker imports the Pi SDK.

## Answer length and streaming (2026-09-25)

The founder ruled out any word limit per answer. Nothing sends an output cap: the model's own maximum (gpt-6-luna: 128,000 tokens, about 500,000 characters of prose or code) is the only thing that ends an answer early, and the worker says so in the answer when it does. Every other bound is a safety bound far beyond that:

| Bound                                                                              | Value                                  | Where                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------ |
| One answer's text (stored, streamed, kept when stopped)                            | 2,000,000 characters                   | `packages/pi/src/limits.ts` `messageChars` |
| A claimed turn's ceiling                                                           | 3 hours; a stall ends it sooner        | `limits.ts` `turnCeilingMs`                |
| A turn without progress (claim, streamed word, tool call; heartbeats do not count) | `turnTimeoutSeconds`, 300 s            | `schema.ts`, enforced by `settle`          |
| A model call without upstream bytes                                                | 20 s                                   | `relay.ts` `idleTimeoutMs`                 |
| A model call's request; any one text in it                                         | 8 MiB                                  | `relay-schema.ts` `relayRequestBytes`      |
| A model call's event stream; any one frame                                         | 256 MiB; 16 MiB                        | `relay.ts`                                 |
| A worker request body (a completion)                                               | 16 MB                                  | `api.ts` `bodyBytes`                       |
| Unsent words the worker holds                                                      | one whole answer                       | `worker.ts` `enqueue`                      |
| A snapshot frame the page reads                                                    | 32 M characters (a whole conversation) | `pi-stream.ts`                             |

History fills the model's window but for its longest answer, at 3 bytes a token (gpt-6-luna: 432 KB, about 144,000 tokens; never over 1 MB), and drops whole exchanges oldest first, never the newest. One too long alone keeps its prompt, a note of the steps left out and its newest steps; a last step too long alone keeps each long text's start and end. The checkpoint holds exactly what the next turn sends, ending at the answer's last entry, and the worker checks it as Main will before sending it. A page opened mid-answer reads the whole answer so far from the snapshot, not only the stream's 64 KB tail.

Streaming: the worker sends words within 100 ms of the first unsent one, one request at a time (about nine a second while text flows, a heartbeat a second when silent). Main reads a streaming turn's authority, and a page's, at most once a second and writes nothing per word, so progress costs no database work beyond that: the latency test's 49 progress requests with their SSE delivery take 9 read transactions (203 before). The page spreads each burst over the next 250 ms with `requestAnimationFrame`, so a steady stream reads at its own pace and never lags 250 ms behind, shows each burst at once under `prefers-reduced-motion`, and swaps in the saved answer whole when the turn ends; Markdown is read in pieces, each once, so only the growing last piece is parsed per frame.

## The person's own agent (2026-09-25)

The founder asked for an agent "all capable (as much as the user) and all knowing (it can read through stuff to learn when needed)". Standing rulings: exactly the person's permissions, and no read constraints within the project.

- **Authority.** A conversation caller passes `Scope.require` for any permission through `requireDelegation(source, permission)`: the person's live role, and a key's own limits. `Scope.administer()` refuses a key's conversation as it refuses the key, and names the source credential in the self-revoke and self-rotate checks. `delegationSource` of a conversation is its stored source, so what the agent starts runs as the person. Events it causes carry `source: {kind: 'conversation', conversationId, commandId}`. The Pi host project has no conversations.
- **Offering.** Each tool's registration says how a conversation may use it (`ToolDefinition.conversation`): omitted runs it as the person; `'propose'` and `'secret'` only propose it; `'never'` (`code.commit`, `code.merge`) is not offered. The registry refuses proposed uses and withholds any result holding a bearer `token`. A turn is offered every other native tool its person may see (read-only ones for a reader), fixed on the command at its first serve; the relay grant, calls and outcomes name exactly that list (at most 128, 72 model calls a turn).
- **Hand-off.** About 30 tools (revocation, merges, repository and publication controls, Fleet and sandbox controls, budgets, dispatch and halt, limit extensions, review claims and verdicts, reflection waves and research advances, ending research, failing tasks, abandoning or failing experiments, automatic research, downloads) are proposed: Main keeps the parsed call on the turn, and the Agent page shows the tool, its input and Run as me. `pi.run` runs it once, as the person at the page; the page then tells the agent what happened. A secret result shows only in its card, which stays while the page is open, and is never kept.
- **Reading.** A result over 32,000 bytes comes back as artifact or paper-section text sliced with where to read on (`artifact.read`, and `paper.read` with a `section`, take `offset` and `length`), an index of every record's scalar fields (a paper document's index names the section read), the newest items of each list, or a prefix; base64 is never shown. The worker gives tool results a third of what the window leaves beside the longest answer and the turn's instructions and tools (at most 128,000 bytes); every result counts, only reads are cut. History clips earlier tool results and long call arguments before it leaves out an exchange. From the 64th call the model is asked to answer.
- **Instructions.** Main sends them with each turn: an opening (the person's own agent, Merv's agent, never ChatGPT), `mainAgentGuide` (shared with MCP clients) and a closing on proposals, tool names and answers. Each turn's notes name the person (actor id, role) and project it serves, today, the model and machine, empty Problem sections and Introduction for people who write, and what a stopped answer had made. Reasoning stays off in the worker.
- **Session controls.** `session.dispatch` and `session.halt` (proposed) and `session.observe` join the tools. Members, account keys, the GitHub connection, project creation and the runner protocol stay off-tool.
- **Rollout.** A new worker with an older Main behaves as before (no instructions: its old prompt; any tool names). An older worker refuses the new Main's work (its allowlist and 4-note limit), so release the hosted image first, then Main, and never roll the image back alone while the new Main runs.

## Credential and package decisions

The available operator credential is an API key, not a configured workload-identity federation mapping. The pilot therefore uses a narrow authenticated Responses streaming relay. This is not a claim that OpenAI lacks short-lived credentials: [workload identity federation](https://developers.openai.com/api/reference/workload-identity-federation) is a separate configured path.

The relay fixes the upstream origin and model, permits only bounded text/function/reasoning payloads, limits requests/concurrency/output/time, rechecks live authority, and suppresses provider errors and headers. Workers receive only allocation-bound worker authority and turn-bound relay credentials, never the long-lived provider key. Explicit SDK transport settings disable ambient credentials/resources, automatic retry, cache warming, extensions and built-in filesystem/shell tools. Native dotted tool names map to a fixed underscore-only model-facing allowlist.

Pinned packages: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-agent-core`, all `0.87.1`. The standalone worker lockfile is kept as source in `packages/pi/worker-runtime`. Published tarball integrity and npm provenance metadata were checked against upstream commit `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`. Subsequently, `npm audit signatures --omit=dev` in the merged Linux test image verified 333 registry signatures and 80 attestations with exit zero. The production dependency audit reported zero known vulnerabilities; this is not a guarantee against undiscovered issues. The worker requires Node 22.19 or newer. The candidate Linux image uses Node 22.19.0; the existing main service reports Node 22.23.2.

## Native read audit

| Tool            | Admitted arguments | Audited handler behavior                                                                                        |
| --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `project.get`   | `{}`               | Scope read authorization and project SELECT.                                                                    |
| `task.list`     | `{}`               | Task record reads; no transition, guidance generation or dispatch.                                              |
| `artifact.list` | `{}`               | Project-scoped immutable metadata SELECT, bounded by the native list limit.                                     |
| `artifact.get`  | `{artifactId}`     | Read authorization and project-scoped metadata lookup.                                                          |
| `artifact.read` | `{artifactId}`     | Immutable blob read with repeated access check; download/signing mode is excluded from admission and discovery. |

Schema limits, registry snapshots and final authority checks remain in force even when a tool advertises itself as read-only. This was the read-only pilot's allowlist; since 2026-09-25 the agent is offered every native tool its person may use (above).

## Evidence so far

- 74 focused Pi/Fleet tests pass on real PostgreSQL, including actual SDK → worker HTTP → relay → native project read → full checkpoint → replacement-runtime restore. Provider HTTP responses in that integration test are injected; it is not a live hosted-agent acceptance run.
- 34 boundary/Fleet-workflow tests pass, including independent plugin boot closures and SDK import isolation. Eight migration/retirement/SQL tests pass. Deployed `fleet@1` and `sessions@7` hashes were read from the live migration ledger and recorded without changing their SQL; `pi@1` is still marked unpublished.
- Fourteen worker tests include delayed protected enrollment, no re-enrollment after authority loss, fixed relay transport despite ambient credentials, bounded progress delivery, cancellation and exact completion retry. The service test sends 768 progress events with zero additional durable writes.
- Seven real-HTTP transport tests cover reconnect, transient-generation eviction, subscriber cleanup/capacity, bounded request bodies, model revocation and disconnect. A subscriber-limit failure now returns an error rather than an empty successful SSE response.
- UI typecheck and full/omitted production builds pass. Both built bundles were checked for absence of Pi SDK symbols. The full build contains the conversation UI; the omitted build does not.
- Seven dispatcher unit tests and two packaging tests pass. A real linux/amd64 candidate image builds with locked dependencies. `scripts/hosted-runner/linux-pi-gate.py` runs the actual SDK worker through the protected dispatcher in a disposable local Docker container on the control host: UID/GID 12001, no supplementary groups, zero capability sets, no-new-privileges, removed bootstrap, denied assignment reads of root material and parent environment. This is a Linux gate, **not** the Cloudflare gate.
- The extended Linux Pi probe also denies parent descriptor inspection, signal permission, ptrace, sudo and connection to a synthetic root-only control socket. `linux-workflow-gate.py` verifies that the combined image reaches managed enrollment through the original fixed supervisor after real Codex login with a synthetic key, with bootstrap removed and no credential in argv/environment. It uses only a loopback fake enrollment endpoint; it proves startup compatibility, not task execution or Cloudflare acceptance.
- `tests/pi-latency.test.ts` measures real native session leases and review submissions on the same PostgreSQL State while synthetic Pi progress streams over real HTTP/SSE. A repeated local sample measured dispatch 81.88 ms baseline / 103.70 ms streaming and review 3.33 / 3.92 ms, with unchanged native write counts (10 and 3). Two stages of 768 text deltas each caused zero progress/SSE writes and zero writer transactions; 194 read transactions were observed then, and 9 once progress and pages reuse an authority read for a second (2026-09-25). Async-local attribution separates unrelated background consumer writes. These are observed samples, not a production latency guarantee or a real-model throughput test.
- A small live Responses API request on the control host using its existing private canary key returned HTTP 200 from `gpt-6-luna`, called `project_get` with `{}`, and used 55 tokens. No key was exported or printed.
- An initial local broad suite ran 1,697 tests: 1,681 passed, 14 failed, two skipped. Eight failures were Fleet boundary/migration integration gaps subsequently fixed. Six Code/research/runner tests refused local writes because free disk was below Code's existing 2 GiB reserve. That safety reserve was not weakened; all six pass in the complete, clean Linux rerun recorded above.

## Earlier staging evidence

The live main image and environment hash were rechecked unchanged from the handoff. No Pi plugin was enabled, no Cloudflare image/application was changed, and no new cloud VM was rented. At 10:13 UTC the canary account still had cap $0.10, accrued $0.07290789560832, reserved $0, available $0.02709210439168, and zero active sandboxes. Do not raise the cap.

The earlier hosted image remains on `ResearchSuite_Control`, tagged `merv-hosted-pi:candidate-20260923`. Its Docker image index is `sha256:89bfcc06ddce347a218b48e735b0c7e639988f8f4a541ac19aa7a899d22bbaf3`; the platform manifest is `sha256:c569fd427821f916dd1d3fb9385d28135a903d70b5dc5eb2e755c48df8045c8d`. It is superseded by the peer/shutdown candidate above; none is an independently verified registry/release pin.

The initial main-service candidate at `/opt/merv-typescript/releases/20260923-pi-candidate` stopped during patch application. A subsequent three-way merge against local HEAD and the preserved live source resolved textual and semantic overlaps, retaining peer receipt helpers, authority/API fixes, the `fleetWorkflow` provider, published migration flags and the managed Code-attach fix. The new `/opt/merv-typescript/releases/20260923-pi-merged-candidate` builds and passes CLI startup as image `sha256:115f230dae806884872ce97a721cf765b3a9348a21c0def5798120a172868cac`. It is not deployed.

Test-only follow-ups (duplicate migration-fixture protection and the latency gate) were staged in `/opt/merv-typescript/releases/20260923-pi-verified-candidate`; the final shutdown candidate extends that source. Both server/UI typechecks pass. The first Linux broad attempt was invalidated by a missing PostgreSQL client and exhaustion of the disposable database's undersized tmpfs; it was stopped after confirming database termination. The corrected environment installs PostgreSQL 17 client binaries, bounds WAL, and uses a larger disposable database on an internal-only Docker network. No test container mounted production data or received production credentials. The final suite and cleanup pass. All six live drain counts were also zero on the read-only preflight, but must be rechecked immediately before rollout.

## Remaining gates

1. Resolve the actual-provider probe's supervisor-visibility assumption and obtain complete Gate A evidence without bypassing protected launch or relaxing the checks. Cloudflare deployment credentials are verified; no new Cloudflare token is requested.
2. Complete the remaining actual-provider Gate B checks. Publication, registry pin, guarded image rollout, additive catalog, workflow delivery/release and native cleanup are now verified; they do not establish the missing security evidence. Fresh scoped acceptance grants will be needed because this run's grants were deliberately revoked after cleanup.
3. Enable the optional Pi package/UI using the tested peer-preserving main image; run real hosted read, reconnect, cancel, revocation, idle release and checkpoint restore; confirm native VM cleanup and unchanged cloud cap. Retain the latency/write-count evidence and repeat measurement on the hosted path where practical.
4. Update release/handoff evidence and mark completion only when those gates are proven. This document does not substitute local tests for live acceptance.
