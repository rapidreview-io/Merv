# Explicit review return paths

`review.submit` accepts an optional `returnTo` alongside its verdict. The program
that owns the review decides whether a route is required and which destinations
are valid for that verdict and current state. Reviews retains the selected route
with the immutable assessment; Workflows still owns the actual state transition.
No new plugin or tool is added.

This supplies a prerequisite for the real Experiment program. In Python, both
`needs_changes` and `fail` on an experiment result must choose between revising
the plan and repairing execution. A failed review does not necessarily end the
experiment. See the [research implementation order](RESEARCH_PROGRAM_PARITY_PLAN.md).

## Responsibility and atomicity

The generic tool validates the route's shape and passes it to `Reviews.apply`.
The selected registered owner validates its meaning and uses the same transaction
to apply the assessment, domain changes, workflow transition, events and command
receipt. A rejected route cannot leave a submitted assessment behind.

`Reviews.submit` is the lower-level assessment writer used by that owner. It
stores the exact supplied route without choosing a workflow state or interpreting
reviewer prose. A domain must reject missing, invalid or inappropriate routes
before committing its changes. Registration ownership and current authorization
remain checked during application.

`returnTo` is a 1–128 character identifier, starting with an ASCII letter and
continuing with letters, digits, underscore, dot or hyphen. It uses the existing
workflow-state identifier syntax. Null, whitespace and object values are refused.
Omission, including an explicit `undefined` in an in-process call, preserves the
old contract. The route is not an arbitrary callback, URL or command.
In-process inputs must be ordinary records, with `Object.prototype` or a null
prototype. A supplied route must be an own data property; validation refuses
proxies and accessors without executing them.

## Compatibility and replay

Tasks retains its fixed mapping:

| Verdict         | Task destination |
| --------------- | ---------------- |
| `pass`          | `done`           |
| `needs_changes` | `in_progress`    |
| `fail`          | `failed`         |

Task preflight and command application reject a supplied `returnTo`; it cannot
override these routes or be silently ignored. Old Task input and result shapes
remain supported.

The nullable storage column leaves previous requests, snapshot hashes and command
receipts unchanged. Responses omit the field when there is no selected route.
The choice belongs to the reviewer's submitted assessment, not the producer's
original evidence snapshot. Submitted-verdict immutability also protects it.
Submitted reviews cannot be reissued. The owning program checks whether an
unsubmitted request is current and eligible for reissue. A later domain submission
creates a separate request with no previous verdict or selected route.

Request hashes include a supplied route. An identical authorized retry returns
the original receipt; changing the destination under the same successful request
ID conflicts. Current authority is checked before replay. A domain's successful
command receipt can replay after transition without requiring the old claim to
be open again.

## Read surfaces

`review.get` and `review.list` expose a recorded route. The Reviews UI displays
it beside the assessment. Its generic list/detail identify the reviewed work
item without assuming that every subject belongs to Tasks. Pinned artifacts,
findings and review links remain available.

Programs must supply allowed destinations and the decision rule in their own
guidance and context. Adding this field does not install an Experiment program,
create a new attempt or implement execution repair. Those effects belong to the
next [Experiment integration](RESEARCH_PROGRAM_PARITY_PLAN.md).

Verification evidence is recorded separately in [VERIFICATION.md](../VERIFICATION.md).
