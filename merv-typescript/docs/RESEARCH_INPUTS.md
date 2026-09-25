# Research inputs and exact code captures

Scope supplies current project intent. Knowledge assembles project records from
the existing domain services. Code resolves exact machine observations. These are
working prerequisites for Reflection; they do not create a reflection wave or a
published research baseline.

## Current intent and frozen agent context

`project.get` returns Scope's project record, including `summary` (the
Introduction) and `contextRevision`. `project.context.update` accepts
`{summary, expectedSummary, requestId}`. Ordinary operators and producers may
edit it; worker sessions and credentialless worker actors cannot. An empty
Introduction is allowed and creates no workflow gate.

The Problem is the one source of what the project is. When a research cycle
leaves `defining`, Research rewrites the Introduction from the Problem it pins:
its four sections under Markdown headings, cut to fit with a note pointing at
`paper.read` when longer than 16,000 bytes. The rewrite is an ordinary
`project.context.update` in the advance's transaction, by the advancing
caller, and is skipped when the text would not change. An operator's edit lasts
until the next cycle starts; agents are told not to write it.

New text is trimmed and bounded to 16,000 UTF-8 bytes. `expectedSummary` must
match the exact stored text, including existing whitespace. An accepted new
command advances `contextRevision`, even if its text is unchanged. Repeating
identical normalized input with the same project/actor/request ID returns the
original receipt. Changed input conflicts, and current write authority is
required before replay. Project text, its event and immutable request receipt
commit together.

New Task and Experiment lease offers capture the project Introduction in their
server-owned context inputs. An already offered worker keeps that input across
refreshes and reloads; a later edit becomes input to a later offer. Existing
frozen packets that lack the new field remain unchanged. Experiment uses its
existing `experiment` JSON context section, so the four recipe definitions keep
version 1. The recipe hash identifies the registered formula, not a promise
that every future offer contains the same project facts.

Implementation: [Scope](../packages/scope/src/project-context.ts),
[Task context](../packages/tasks/src/index.ts),
[Experiment context](../packages/experiments/src/program.ts).

## Live inventory and exact reference reads

Knowledge exposes two read-only tools:

| Tool                 | Result                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `project.records`    | Current project metadata, all task records and all experiments, plus explicit publication availability |
| `project.references` | Up to 200 references resolved in input order to project-scoped metadata                                |

Inventory includes active and terminal work. It does not render prompts, read
artifact bodies, reconcile sessions, evaluate exit gates or advance workflows.
`workflow.status_and_next` remains the source of current gates, blockers and
next actions. Domain services retain ownership of their records; Knowledge
passes one State transaction through their public read contracts.

Reference input supports record IDs and explicit `task:`, `experiment:`,
`artifact:`, `review:`, `code-proposal:`, `code-commit:` and `session-final:`
prefixes. The resolver distinguishes `resolved`, `missing`,
`unsupported` and `unpublished`. A foreign-project ID is missing in this
project. Unsupported services are not fabricated. A resolved code-capture
reference can still have a `pending` capture status: resolving the identity
does not imply that final code has been reported.

The optional Knowledge UI is the **Research records** page. Its data comes from
these live reads. Introduction editing remains a Scope operation, separate from
research publication.

Research claims are retired: each existing claim was converted into a Markdown text artifact titled `Claim: …`, which resolves like any other artifact. A `claim:` reference is now an unknown kind and resolves as `unsupported`.

## Retired corpus snapshots

`Knowledge.capture` and `Knowledge.get` froze a corpus for the retired
`reflection@1` and are removed. Reflection waves read live research instead. The
`knowledge@2` migration deleted every saved snapshot and its request receipt;
nothing read them.

## Exact Code observation identities

`Code.capture(caller, ref, tx?)` provides a historical metadata read with one of
two identities:

```ts
{ kind: 'session-final', sessionId: 'session_…' }
{ kind: 'code-commit', commandId: 'codecmd_…' }
```

A branch or workspace name may be reused, so neither is a capture identity.
The result pins project, instance and workflow revision; workflow name/version,
state, policy hash and original registration ID; actual producing actor/session;
delegation source; runner/host identity; and read-only policy. A ready result
contains the exact repository/workspace, mode/branch, base/head OIDs and stats.
Commit receipts also include the exact parent and tree OIDs. New Runner
snapshots report the tree observed for their exact head; older snapshots retain
an absent `treeOid` rather than acquiring an invented value.

Capture statuses are `none` for a session without Git intent, `pending` before
the exact observation or command receipt exists, `ready` for a final result or
successful commit receipt, and `failed` for a failed/cancelled Code command.
Closing or revoking a producer without a final report does not justify guessing
its head; its final observation can remain pending.

Sessions owns final attachment/result metadata. Code owns live commit commands
and receipts and composes this exact reader over both owners. The narrow
`Sessions.workspaceObservation` read uses current project authority, not the
original controller's source-owned `get`/`list` control path. It never activates,
reconciles or renders a session. Another currently authorized project member
can read a persisted observation after its source credential or actor is
revoked. This does not restore the old worker's access or authorize a new report.
`Code.operation` retains its existing worker-only boundary.

These are source-authenticated machine observations. The server does not inspect
Git objects, and the Runner repository ID identifies its private replica, not a
global repository authority. Object transport, access on another machine,
approval and permission to advance central are separate concerns.

## Git Experiments without rewriting version 1

This section records how Git experiments were introduced. Experiment@1–4 were
retired on 2026-09-22 together with their records; new experiments start on
experiment@5–8 as [Experiments](EXPERIMENTS.md) describes.

Omitting `workspace`, or explicitly selecting `"none"`, creates the original
`experiment@1` scratch program. An omitted field stays omitted in normalized
legacy command hashes. Existing records, submissions and frozen contexts retain
their old shapes. `workspace: "git"` explicitly selects `experiment@2`.

| Stage             | Version 2 declaration                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| planned           | Scratch                                                                                                                                              |
| design_review     | Scratch, read-only review                                                                                                                            |
| running           | Retained persistent private checkout, namespace `experiments`, explicit central base, shared across this instance's attempts, no central advancement |
| experiment_review | Ephemeral read-only checkout, namespace `experiment-reviews`, exact `reference:code` base, removed after release                                     |

The machine's trusted Runner configuration supplies the local repository; the
Experiment command supplies no host path or Git OID. The actual running worker
must have its Git workspace attached before submitting results. Submission
stores `{kind: "session-final", sessionId}` for that exact worker and revision
in its immutable evidence manifest, before final code is available.

After handoff, Runner stops the process, captures owned work-in-progress,
reports the final observation, and releases the checkout according to policy.
The result may arrive after the remote lease closes. Review dispatch and claim
acquisition wait for that exact submission's capture. When ready, the review
lease freezes `references.code` to its head OID and includes its provenance in
context. Another session's newer capture cannot substitute. A missing reference
or unavailable local object fails explicitly; there is no fallback to central.
Both versions use the same scientific gates and review independence rules.

This path captures code for evidence. It does not approve code publication,
create a consolidation proposal, merge branches or advance central. See
[Experiments](EXPERIMENTS.md), [workspace ownership](WORKSPACES.md),
[Code operations](CODE_OPERATIONS.md) and
[publication ordering](CODE_PUBLICATION_PLAN.md).

## Python correspondence and remaining work

Python separates current project facts, a reflection's frozen corpus and the
latest published wave's coverage. Its corpus selects all terminal work and all
claims, with smaller current-attempt report and task brief/delivery
references. Its Introduction is read separately, and its consolidation source
binding uses a mutable latest workspace row per project/instance.

The TypeScript implementation deliberately freezes project facts, richer domain
metadata and exact per-session/per-command code observations. It retains a
clear absence of published knowledge. These differences and source locations
are recorded in the [Python corpus reference](CORPUS_PARITY_REFERENCE.md).
No Reflection wave, five-lens ownership, synthesis/review cycle, coverage
delta, reflection-debt gate or literature-maintenance program is supplied
here. The existing Experiment cap is not the future
reflection scheduler's reserved-slot policy.

## Verification scope

Focused checks cover Scope Introduction authority/replay, frozen worker context,
complete metadata selection, immutable corpus receipts, missing/foreign refs,
borrowed-transaction rollback, exact command/final capture provenance and the
production Git Experiment handoff. Service capture fixtures use synthetic but
valid full OIDs; they do not prove object existence. Separate local Runner tests
create real disposable Git repositories and compare captured head/tree objects.
See [project context tests](../tests/project-context.test.ts),
[Knowledge tests](../tests/knowledge.test.ts),
[capture tests](../tests/code-captures.test.ts),
[Experiment assignments](../tests/experiment-assignments.test.ts), and
[real local Git tests](../tests/runner-workspaces.test.ts).

The earlier four-agent scratch acceptance remains historical evidence for
`experiment@1`. The new `scripts/live-experiments.ts --git` acceptance is running
at this documentation checkpoint; no successful native Git result is claimed
here. It is designed to check real producer files, stopped-worker capture,
independent pinned-checkout reexecution, unchanged source/central refs and
cleanup. Final results belong in the verification
record after independent inspection.
