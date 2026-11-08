# Adversarial review — November 7, 2026

Baseline: `aaf68f373`. The [product function table](product-map-2026-11-07.md) was completed and shown before this review began. The follow-up implements the ten confirmed fixes in their owning plugins and reduces the test suite by the requested minimum of 60% of executed test cases. All changes remain local; nothing was deployed.

## Confirmed findings

These findings had executable reproductions before repair. The descriptions below record the original failures. Each now has a focused regression in the retained suite; final verification is recorded below.

The highest-priority finding is **#9: Fleet can free capacity while a replaced machine is still live**. The remaining nine findings are P2 correctness failures.

### 1. Owner approval of a native Git task cannot succeed (P2)

Locations: [Tasks approval](../../packages/tasks/src/commands.ts), [Code Work approval](../../packages/code-work/src/submissions.ts).

For a current version-46 task with a retained Git submission, use the existing “Decide as owner” review override. The owner can claim the review and `Reviews.guide` advertises `pass`, `needs_changes`, and `fail`. Submitting `pass` fails with `409 code_review_unattached`, leaving the task `in_review` and the review `started`.

Tasks explicitly permits the override without a reviewer lease (`packages/tasks/src/index.ts:194–201`), but passes `reviewSessionId: null` into Code Work, which unconditionally requires a review session. Reproduced with the real application, PostgreSQL and a native Git submission. Repair must preserve the ordinary independent-review checkout requirement while implementing the explicitly authorized owner path consistently.

**Fix:** Code Work honors the trusted override recorded by Reviews. Ordinary independent review still requires the exact isolated checkout. Generalized coverage exercises owner approval for Tasks and Experiments, machine override rejection, and missing-checkout refusal.

### 2. Concurrent uploads bypass the 1 TB request limit (P2)

Location: [FilesService.createUpload](../../packages/customer-experiments/src/files.ts).

The storage listing is captured before provider I/O; the later transaction combines that old listing with current pending reservations. Completing another upload between these operations moves bytes from pending reservations to stored objects, so neither side counts those bytes.

Deterministic reproduction: reserve upload A for 600 GB; start B for 600 GB and pause it after its empty listing; complete A, which removes its reservation; resume and complete B. Both operations succeed and `list().totalBytes` becomes **1,200,000,000,000**, above the **1,000,000,000,000** limit. The proof uses real PostgreSQL and fake storage metadata, with no large buffers or provider calls. Admission needs an accounting state that cannot lose bytes during the pending-to-completed transition.

**Fix:** Customer Files orders request mutations through one per-request queue, so its storage listing and pending reservations cannot observe different concurrent mutations. Completion and abort coordination also preserves reservations while provider completion is in flight. The second review simplified the original revision fence into this shared queue; migration 2 retains only the durable completion receipt. The retained regression uses metadata-only 600 GB objects and deterministic interleavings; expired reservations cannot later bypass admission.

### 3. A lost upload-completion response becomes a permanent UI failure (P2)

Location: [FilesService.complete](../../packages/customer-experiments/src/files.ts).

Complete one valid multipart upload, discard the successful response, and repeat the identical upload ID, key and part list. The second call returns `404 not_found` because completion deleted the only receipt; the stored object still exists.

This is a reachable retry path: `packages/ui/web/customer/uploads.ts:226–237` retries network/server failures, and line 284 uses it for completion. The resulting 404 is permanent to the uploader, which marks the uploaded file failed and starts a new transfer on manual retry. Retain/replay completion identity and result rather than deleting all evidence of success. Reproduced with real PostgreSQL and metadata-only storage.

**Fix:** Customer Files retains the completion input and result and replays the same response across service restart and plan freezing; changed parts conflict. Successful completion no longer deletes its only receipt.

### 4. Concurrent Board outcome edits corrupt another author's text (P2)

Location: [Outcome rebase](../../packages/ui/web/views/board-outcome-text.ts).

The exported function reproduces the corruption directly:

```ts
rebased(
  'Heading\noriginal text\nEnd',
  'Heading\nmy replacement\nEnd',
  'Heading\ntheir replacement\nEnd',
);
// Actual: 'Heading\ntmy replacement\n\nheir replacement\nEnd'
```

The conflict fallback advances two characters after the preceding line, even when there is only one newline. It splits `their` into `t` and `heir`. `board-outcome.tsx:304–309` displays this result and schedules a save, making it a persistent document corruption path. Locate the actual line boundary and preserve both complete conflicting texts.

**Fix:** The UI rebase finds unique intact line anchors and preserves complete conflicting text. A generalized test covers newline styles, spacing and changed preceding headings.

### 5. Moving a shape outside its frame leaves it invisible (P2)

Location: [Drawing move](../../packages/board/src/elements.ts).

Create a frame, create a red box with `in` naming the frame, then move the box to `at: [2000, 2000]`. Coordinates change but the old `frameId` remains. `place()` calculates a null frame for this absolute placement, but `move` applies the result only when `op.in` is supplied. The API has no separate detach operation.

An isolated rendering of an out-of-frame red box through the real Excalidraw renderer produced **zero red pixels** with stale membership, versus **3,782 red pixels** with its `frameId` cleared. The renderer clips members at the frame edge. Apply the placement's membership consistently, including removal from a frame, while preserving the membership of children when moving an entire frame.

**Fix:** Board moves apply the destination frame to moved roots, including detachment, while keeping children within a frame carried by the same move.

### 6. Atomic shape replacement fails on a full board (P2)

Location: [Board live-shape limit](../../packages/board/src/index.ts).

Populate a board with 5,000 live shapes. Save a batch deleting one of them and adding one new shape. The service returns `409 board_full`, even though the resulting live count would remain 5,000.

The admission calculation adds newly live shapes but does not subtract accepted deletions from the same batch. Reproduced through the real Board service and PostgreSQL. Evaluate the net post-merge live count, respecting which shape versions actually win.

**Fix:** Board evaluates the net live-shape change from accepted winning versions, including deletions and restorations.

### 7. Inquiry IDs can silently consume an ordinary worker message (P2)

Locations: [Message replay lookup](../../packages/sessions/src/messages.ts), [Inquiry message key](../../packages/sessions/src/inquiries.ts).

Create an inquiry with request ID `one`, then send an ordinary operator message to the same thread with the same body and request ID `inquiry:one`. Both IDs are valid inputs. The ordinary call returns the inquiry message's ID without inserting a work-directed message. Worker delivery excludes `inquiry_role = 'question'`, so the operator message never reaches the worker.

The inverse ordering makes a fresh inquiry fail with `409 state_conflict`. Both paths share a unique `(project_id, sender_actor_id, request_id)` namespace, while ordinary replay does not check message kind. Reproduced with real State, Scope, Workflows and Sessions. Separate the namespaces or enforce reserved keys and message kind in replay validation.

**Fix:** Sessions migration 27 scopes replay uniqueness by inquiry role, and ordinary-message lookup excludes inquiry messages. Existing rows and identifiers survive migration. Both collision orders and existing-row replay are covered.

### 8. Optional email failure reports an already-completed signup as failed (P2)

Location: [Early-access confirmation](../../../website/api/early-access.ts), awaited at line 51.

Let both Attio writes succeed, then make Resend's fetch reject with a network error. `POST()` rejects instead of returning its success response, although the person has already been added to the CRM. The current website form calls this route (`website/src/App.tsx:891`), so this is a live application path, not an unused handler.

The handler documents confirmation as optional and tolerates HTTP rejection responses, but it does not catch network rejection. A mocked-fetch reproduction recorded two successful CRM writes followed by `network disconnected`; no external message was sent. Isolate optional confirmation failure from the committed signup result.

**Fix:** The website catches optional confirmation failures after successful CRM writes. One generalized test covers network, HTTP and response-body failures while preserving failures of either required CRM write.

### 9. Fleet forgets replaced machines before deletion is confirmed (P1)

Location: [Unready-machine replacement](../../packages/fleet/src/index.ts).

When an unready machine is replaced, `runtime.stop()` may return `deleting`. Fleet ignores that returned state, clears the old runtime handle, and rents a replacement. It never reconciles the earlier machine again. Once the replacement stops, Fleet releases the allocation and its capacity even if the original rental remains live.

A real State/Scope/Fleet reproduction with the repository's deterministic runtime fixture used both global and project capacity of one. At **00:02:02**, the allocation was `released` and `free(project)` was **1**, while the original `sbx_1` was still `deleting` with its lease valid until **00:10:00**. This permits additional rentals beyond the intended capacity and loses the old machine from Fleet's allocation tracking. Retain and count retiring runtimes until deletion is confirmed or their original lease is safely exhausted.

**Fix:** Fleet retains the old runtime and capacity until stop confirmation or a safe lease deadline, then continues its existing bounded replacement sequence. A late ready signal cannot launch a retiring machine.

### 10. Shortening a profile can free an older, longer lease early (P2)

Location: [Fleet.waitOutLease](../../packages/fleet/src/index.ts).

Provision with a 600-second lease, restart Fleet with a 60-second profile, and make provider inspection unavailable. The stale profile correctly causes a stop intent, but the fallback release deadline uses the new configured lease plus 60 seconds rather than the retained machine's expiration.

The deterministic reproduction reported `released` and a free slot at **00:02:01**, with `releaseBy` **00:02:00**, although the persisted runtime still had `leaseExpiresAt` **00:10:00**. Persist the original possible lease bound, including uncertain create/renew replies, and never release earlier than the known existing lease. The proof uses real PostgreSQL and simulated provider responses; no cloud machine was rented.

**Fix:** Fleet persists the original lease duration, honors known expiry, and uses the retained duration for shutdown renewals. Legacy records without a retained duration conservatively use the provider maximum (one day), because a lost renewal response can outlive a previously observed expiry.

## Review coverage and limits

The review combined independent source inspection, focused executable adversarial cases, and the complete main/deployment test commands. Inspected paths included Board drawing/history/shares/outcomes/transcripts; Pi conversation, stream and screen integration; Tasks/Reviews/native Git approval; workflow/session authority, messaging and recovery; Research and experiment transitions; Code retention; Fleet/runner recovery; Identity/Scope/OAuth; API transport; customer intake/files/payment handling; artifact rendering; secrets proxy; deployment packaging; and website signup.

This is a broad codebase review, not a proof that every path is correct. Cloud provisioning, real payments and external mail delivery were not exercised. The subsequent read-only production check confirmed Metrics configuration, plugin activation and Trackio availability; it did not write training data or inspect authenticated graphs. The existing vendor submodule working-tree state was preserved. Detailed reproduction programs and run logs were retained locally under `/tmp/merv-review.b8OUQd` and their named `/tmp/merv-*-repro.*` files.

## Test reduction and verification

These measurements record the first completed review. The [second review](adversarial-review-round2-2026-11-07.md) records the additional fixes and final suite counts.

The initial environment required the documented Board renderer build. The earlier small cleanup repaired obsolete compatibility expectations and established a passing prepared baseline: 1,318 total cases (1,317 passed and one Linux-only skip), 1,156 top-level cases, 164 main-suite files and 65,062 test-source lines, in 130.61 seconds. This is the baseline for the user's subsequent 60% reduction request.

| Main suite                         |   Before |   After | Reduction |
| ---------------------------------- | -------: | ------: | --------: |
| Reported cases, including subtests |    1,318 |     388 | **70.6%** |
| Top-level cases                    |    1,156 |     370 |     68.0% |
| Test files                         |      164 |     127 |     22.6% |
| Test source lines                  |   65,062 |  29,138 |     55.2% |
| Local wall time                    | 130.61 s | 63.54 s | **51.4%** |

The final full run passed **388/388**, with no failures or skipped cases. The optional Linux mount gate was not exercised on macOS. The 60% requirement is exceeded for test-case count; runtime and source-line reductions are reported separately. Thirteen unused fixtures were removed, while manual acceptance fixtures remain. Total tracked and new work shrinks the repository by approximately **42,800 lines**, including the fixes and documentation.

`npm run test:deploy` passed 43 release tests plus 11 PostgreSQL staging-isolation tests and 12 Python tests in 20.03 seconds. Separate Python gates passed: recovery snapshots 9, predeployment replacement 4, prebuilt release 6, and staging ownership 4. The website signup test passed. Server/browser typechecks and builds, CI formatting, and diff whitespace checks passed. Regenerating the architecture map reconciled its existing omission of `board.share`; plugin dependencies are unchanged.

Local verification logs and the detailed count record are under `/tmp/merv-review.b8OUQd`. These measurements use Node 22.13.1 and PostgreSQL 17 on macOS, with the main test command measured alone and including npm pretest cleanup. They are not a CI runtime guarantee.

`npm test` still runs every remaining `tests/*.test.ts` file; the CI sharding mechanism is unchanged. No suites were hidden behind an opt-in command and no new skips were added. The reduction removes duplicate permutations, historical inventory snapshots, presentation-only checks and dead fixture branches. Generalized owning-layer tests retain authorization, immutable evidence, payment gates, quota boundaries, recovery, replacement leases and the ten confirmed regressions. This deliberately reduces exhaustive presentation and legacy-version coverage; it is not a claim that all prior assertions remain. See [the current test guide](../../tests/README.md).

All fixes stay with their existing responsibilities: Reviews authorizes overrides, Code Work enforces immutable code approval, Sessions owns message identity, Fleet owns runtime capacity and leases, Customer Files owns quota and upload receipts, Board owns drawing invariants, the UI owns text rebasing, and the website owns optional email handling. No new plugin or dependency was introduced. The fixes add Sessions migration 27 and Customer Files migration 2; production rollout was not performed.
