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
claim requires at least one evidence ID. Referenced IDs must be distinct within
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

## Delivering a commit

A task whose product is a code repository should not be cut into 2 MB artifacts.
`task.create` with `workspace: "git"` (default none; requires Code) gives the
producing worker a runner-prepared private Git checkout and the `code.commit` and
`code.operation` tools. The choice is carried by the task's workflow version
(`task@3`, or `task@4` with `baseTaskId`), so it is fixed at creation; tasks created
without it are unchanged. See [workspaces](WORKSPACES.md) for the checkouts and for
building later work on the delivered commit.

```json
{
  "taskId": "…",
  "artifactIds": [],
  "commandId": "the worker's own succeeded code.commit operation",
  "confirmations": [{ "checkNumber": 1, "status": "met", "evidenceIds": [], "notes": "…" }],
  "expectedRevision": 0,
  "requestId": "…"
}
```

- A Git task always delivers a commit; files are optional alongside it, so
  `artifactIds` may be empty. Every other task still requires at least one artifact
  and takes no `commandId`.
- The commit must be the leased worker's own, made in this assignment at this task
  revision, and already receipted by the runner. A successor never delivers its
  predecessor's commit: it commits again, which succeeds on an unchanged tree. An
  interactive producer holds no checkout and cannot deliver a Git task.
- `evidenceIds` remain artifact IDs only; a `commandId` is never an evidence ID. A
  `met` confirmation that cites nothing is recorded against the commit record below.
- Merv renders an immutable **Delivered commit** artifact (commit, tree, parent and
  base OIDs, repository, workspace, operation, session and statistics).
  `deliveryIds` holds the submitted files, then that record, then the assessment, so
  the review snapshot pins the commit like any other evidence and findings cite the
  record's ID. `deliveryCode` (`ref`, `sessionId`, `revision`, `headOid`, `treeOid`)
  and `deliveryCodeArtifactId` are exposed on the task. Neither rendered record may
  be resubmitted as evidence in a later round.
- A leased reviewer's read-only checkout is frozen to `deliveryCode.headOid`
  (`references.code`). On every reviewer assignment and every proposed verdict, Tasks
  re-reads the receipt from Code and requires it to match the sealed delivery and the
  review to pin the rendered record. The comparison uses the stored producing
  revision, so `task.reissue_review` does not strand the task.
- **Only that leased review, attached at the delivered commit, can pass a Git task.**
  A verdict of `pass` must come from the session holding the current review lease, and
  Sessions must already hold that session's workspace attachment with a base equal to
  `deliveryCode.headOid`. Sessions refuses any other base, and a runner without the
  commit's objects fails at launch and never attaches, so the attachment is the
  server-side record that the reviewer's runner held the commit. Anything else —
  an interactive reviewer, or a leased one whose runner has not attached — is refused
  with `task_commit_unfetched`. Merv does not itself fetch or verify Git objects: the
  attachment is a source-authenticated runner report, and the review must run on the
  machine that holds the objects.
- **Do not claim a Git task's review interactively.** Reviews admits `review.start`
  from any eligible reviewer without asking Tasks. Such a reviewer may still return
  or fail the task, but can never pass it, and once the review is claimed no review
  worker can lease it (`review_unavailable`). The `start_review` guidance and the
  reviewer assignment say so before the claim. If it has happened, the producer or
  an admin replaces the review with `task.reissue_review`; the fresh review is
  unclaimed, pins the same delivered commit, and can be leased.

| Code                     | Meaning                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `invalid_workspace`      | Unknown workspace, or `baseTaskId` without `workspace: "git"`.                             |
| `invalid_workspace_base` | The base is not a non-failed Git task of this project, or is not among `dependsOn`.        |
| `code_unavailable` (503) | Code is unloaded: a Git task cannot be created, assigned, delivered or reviewed.           |
| `task_commit_required`   | A Git delivery without its worker's `commandId`, or a `commandId` on a scratch task.       |
| `task_commit_pending`    | The operation has no receipt yet; wait for `code.operation` to report `succeeded`.         |
| `task_commit_failed`     | The operation failed or was cancelled; commit again and deliver that operation.            |
| `task_commit_provenance` | The commit is not this worker's for this task revision, or no longer matches its delivery. |
| `task_commit_unfetched`  | A `pass` not from the leased review attached at the delivered commit; reissue if claimed.  |
| `task_base_unavailable`  | A based task's prerequisite has not been accepted with a delivered commit.                 |

With Code unloaded, Git task records stay readable (`deliveryCode` is stored data)
and artifact-only tasks are unaffected.

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

A migration marks previously saved tasks `evidenceVersion: 1`; their delivery
contract remains the former text-coverage gate. New task creation explicitly writes
version 2. The evidence contract is immutable and separate from the task graph
version: neither old workflow definitions nor completed review snapshots are rewritten.

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
