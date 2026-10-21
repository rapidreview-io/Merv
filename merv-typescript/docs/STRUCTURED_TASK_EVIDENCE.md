# Structured task evidence

Tasks now owns a versioned evidence contract alongside its existing workflow.
No plugin or tool is added. Workflows computes guidance and enforces the registered
checks; Tasks defines what a task submission means. Artifacts retains the brief,
submitted files and server-rendered assessment. Reviews pins all of them, and
Context Builder supplies the same facts to the assigned agent.

## Creating and delivering work

`task.create` accepts a title, goal and distinct acceptance checks. When `briefId`
is omitted, Merv renders and pins the immutable brief in the creation transaction.
The optional existing `briefId` input remains compatible: it must be a producer-owned
UTF-8 text artifact containing the stated goal and checks. Supplying a brief does
not opt out of structured delivery.

Every new task has `evidenceVersion: 2` and `acceptanceChecks` with stable, one-based
numbers derived from its immutable check list. A submission looks like:

```json
{
  "taskId": "wf_example",
  "expectedRevision": 0,
  "requestId": "delivery-1",
  "artifactIds": ["art_results"],
  "confirmations": [
    {
      "checkNumber": 1,
      "status": "met",
      "evidenceIds": ["art_results"],
      "notes": "Recomputed the four values and verified their sum is 20."
    },
    {
      "checkNumber": 2,
      "status": "not_met",
      "evidenceIds": [],
      "notes": "The requested cross-platform check has not been performed."
    }
  ]
}
```

There must be exactly one confirmation per check, with no duplicate or unknown
numbers. Each has a `met`/`not_met` claim and nonblank verification notes. A `met`
claim that cites no file is backed by the delivered commit (below). Referenced IDs must be distinct within
each confirmation and included in the producer-owned, same-project submitted
artifacts. An honest `not_met` claim may have no evidence. There is no exact-text
copy requirement for version 2 deliveries, and binary evidence is permitted.

These are producer declarations. Structural validity does not establish their
truth, and an unmet confirmation does not bypass the independent verdict. A
reviewer may return the work for changes or fail it after inspecting the evidence.

Merv renders a separate immutable assessment from the validated confirmations.
`deliveryIds` contains the submitted files followed by that assessment;
`deliveryAssessmentId` identifies it and `deliveryConfirmations` exposes the
structured claims. The review snapshot includes the brief and every delivery ID.
The workflow transition, assessment metadata, review, task update, events and
replay receipt commit together. Failed commands leave no committed partial state.
Content-addressed blob bytes written before a later SQL failure can remain
unreferenced, as with existing artifact writes; they are not accessible as artifacts.

## Submitting code

Every new task has a runner-prepared Git checkout. Code derives its pinned base from the durable accepted references of `dependsOn` prerequisites and project main. The worker may commit and push with ordinary Git, but submission does not require a commit. Older records keep their original evidence shapes. See [workspaces](WORKSPACES.md).

```json
{
  "taskId": "…",
  "artifactIds": [],
  "confirmations": [{ "checkNumber": 1, "status": "met", "evidenceIds": [], "notes": "…" }],
  "expectedRevision": 0,
  "requestId": "…"
}
```

- The actual leased producer submits its own checkout at the current task revision. An interactive actor has no checkout and cannot substitute another session's work.
- `artifactIds` may be empty. `evidenceIds` remain artifact IDs; a `met` confirmation with none is backed by Merv's rendered **Submitted code** record.
- That record identifies the immutable submission, producing actor and revision. `deliveryCode` contains its submission `ref`, `sessionId` and `revision`, while `deliveryCodeArtifactId` identifies the pinned record. OIDs are resolved from the frozen submission receipt, not copied from the producer's initial attachment. Historical `code-commit` deliveries keep their recorded OIDs.
- `deliveryIds` holds the submitted files, the code record and the confirmation assessment. Reviews pins all these artifacts. Neither rendered record may be resubmitted as evidence in a later round.
- After handoff the runner confirms the producer has stopped, retains its exact Git tree and parent, and seals the submission receipt. This creates no preapproval commit. Review dispatch waits for that receipt.
- The leased reviewer receives exactly the submitted tree with its parent as HEAD, in an isolated read-only checkout. Tasks resolves the immutable receipt on assignment and verdict, using the stored producing revision. Code Work verifies the reviewer's attachment and independent review authority.
- A passing verdict journals the approved milestone. Code creates a commit only when that reviewed tree needs one; acceptance and dependent code remain unavailable until the result is durable. Failed or retried materialization cannot substitute later producer edits.

Only the leased reviewer of the current review can pass. A reviewer without the exact attachment is refused with `task_commit_unfetched`. A claim before the available review rounds are exhausted requires a review lease (`leased_review_required`). After those rounds are exhausted, an interactive reviewer may claim and fail the task; the claim must be released before a newly permitted worker can take it.

Provenance failures use `task_commit_provenance`; the name also covers modern submissions. Missing durable code and unresolved bases block review or lease admission. Historical command-receipt errors remain meaningful for old records, but new deliveries neither require `commandId` nor poll `code.operation`.

With Code unloaded, stored task and delivery records remain readable. New Git work cannot be created, leased, submitted or approved through an unavailable Code service.

## Guidance, context and UI

`workflow.status_and_next` requests both `artifactIds` and `confirmations` for a
new task's delivery. Input preflight and the actual command enforce the same
validation and prerequisite checks. Workflow policies can compute their required
input fields from the immutable evaluation context; invalid callback results fail
closed. The browser task view shows each producer claim, explanation and evidence
links beside the independent review.

Version 2 review and checkpoint evidence uses Context Builder's explicit `auto`
artifact mode: readable text is included, and binary evidence is represented by
its retained ID, hash, media type and size with an instruction to inspect the bytes.
The source manifest retains these references. `text` remains the default strict
UTF-8 mode for other recipes; `references` mode includes metadata only. Budgets
count the rendered representation. This does not invent a binary analysis tool or
claim that a reviewer inspected bytes merely because their metadata was included.

Context requests replay their original immutable package after Tasks rechecks the
current actor, assignment, revision, dependencies and review claim. The owning
recipe handle checks the request's subject and recipe identity before returning a
saved package. This preserves requests created before a deployment changed the
shape of the task view. A new request ID builds fresh context with newer progress.
The lower-level `build` operation still rejects changed explicit inputs under an
existing request ID. Unloaded recipes cannot build or replay assignment requests.

## Compatibility and remaining work

Every task carries `evidenceVersion: 2`. Version 1, the former text-coverage gate that a
migration assigned to tasks saved before structured evidence, was retired on 2026-09-22:
tasks migration 8 deleted its tasks (none were expected) and fails closed if one remains.
The evidence contract is immutable and separate from the task graph version: neither
workflow definitions nor completed review snapshots are rewritten.

Python likewise rendered briefs and required one numbered delivery confirmation
per deliverable. Its check was structural and allowed unmet items. TypeScript's
new contract additionally requires explicit retained evidence references for met
claims. It rejects duplicate numbers instead of copying the Python parser's
last-entry-wins behavior. The two stacks retain different size/name limits; this
slice does not claim identical wire formats or all task-program parity.

Structured per-check reviewer findings, synopsis and observations have since been integrated; see [review assessments](REVIEW_ASSESSMENTS.md). Assignment/begin clocks, sessions and runner programs remain subsequent work. The experiment/reflection/consolidation programs are not implemented by
this task evidence change. See the [broader audit](BACKEND_PARITY_AUDIT.md).

## Verification

The full suite passes 236 tests, including actual local HTTP/MCP and the prepared
Nisa fixture. Backend/UI builds and typechecks pass. Independent local review
reproduced the binary-context and deployment-replay bugs; both now have passing
regressions. A fresh three-agent run completed structured creation, work context,
delivery, review context and independent acceptance across two server restarts,
then verified retained evidence with a read-only observer. It observed 35 calls,
32 successes, three expected role denials and no transport errors.

[Deterministic checkpoint](../verification/structured-task-evidence.json) and
[live acceptance](../verification/structured-task-evidence-live.json). Fable
export and browser sign-in remain pending their earlier specific approvals;
this checkpoint does not claim either was completed.
