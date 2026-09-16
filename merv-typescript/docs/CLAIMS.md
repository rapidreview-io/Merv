# Claims

Claims is integrated as an independent provider with tools and a plugin UI. It
stores research statements, their scope, status and confidence. A claim is a
research fact, not a workflow program: creating one does not start an experiment,
launch an agent, or assess evidence.

The provider requires only **State and Scope**. Its tool adapter requires Claims
and Tools; its optional UI adapter requires Claims and UI. Feed can display its
committed events without Claims depending on Feed. See the
[package and directory inventory](../packages/claims/README.md).

## Records and tools

A claim contains ID/project, statement, scope, status, confidence, revision,
original creator, latest updater and creation/update timestamps. `scope` is
ordinary prose, not an object or an access-control rule. Statement and scope are
trimmed strings, each limited to 16,000 characters; statement must be nonempty.
Duplicate statements can be separate claims.

| Tool           | Input and result                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `claim.create` | `statement`, optional `scope`/`confidence`, `requestId`; returns the created claim                             |
| `claim.list`   | Empty object; returns all current-project claims as an array, ascending by creation time and ID                |
| `claim.update` | `claimId`, `expectedRevision`, `requestId`, and at least one of `status`/`confidence`; returns the saved claim |

Initial status is `active`, confidence defaults to `medium`, and revision starts
at zero. Status values are `draft`, `active`, `supported`, `weakened`,
`contradicted`, `abandoned`; confidence is `low`, `medium`, `high`. Any allowed
status can replace another. No automatic scientific gate or confidence score is
implied. Lists include all statuses and have no silent result cap.

**Ordinary public updates cannot change statement or scope.** Unknown fields,
null updates, malformed IDs and empty updates are refused. `claims.get` is a
project-scoped in-process service method, not an additional MCP tool. HTTP and
MCP reuse the shared tool schemas; there is no separate legacy `/claims` REST
contract.

## Permissions, revisions and retries

Operators and producers may create/update. Reviewers and readers may read.
These rules apply to the current project role, including shared users and
user-owned keys. Leased workers additionally need the exact tools and argument
bindings in their fixed assignment policy. Every service operation checks current
Scope authority; revocation, expiry or membership loss also blocks request replay.
Clients cannot select their own actor or credential through claim inputs.

Each new update compares `expectedRevision` with the stored revision. A stale
edit fails with `claim_revision_conflict`; the caller must read and reconsider
the current values. Every accepted new update advances revision and emits an
event, **including an update to the same status/confidence values**.

Mutation receipts are scoped to project, actor and request ID. The same normalized
operation/input returns its original committed response, even after another
update or a restart. It does not return a newer claim in place of that receipt.
Changed input under the same ID fails with `request_conflict`. Authorization
precedes receipt lookup; receipt lookup precedes current-revision comparison.

The claim, event and request receipt commit in one synchronous State transaction.
The service accepts a borrowed active transaction for future domain composition.
Any failure rolls back all three. Events record actual new fields, previous
status/confidence/revision and authenticated actor/source provenance. Creator
identity remains unchanged; updater identity is separate. Identity and receipt
triggers prevent rewriting their history, and there is no claim deletion API.

## UI and plugin lifecycle

The Claims page lists the actual records, including statement, scope, status,
confidence, revision and update time. Writers can create a claim or edit status
and confidence; reader/reviewer views expose no mutation controls. The server
remains authoritative if a role changes while the page is open.

An edit keeps the revision observed when editing began. A concurrent change
causes a visible conflict and a fresh read; the UI does not silently rebase it.
An ambiguous network/server result retains the exact submitted values and
request ID for **Retry same request**, with those fields locked. A later refusal
(such as 404, 403 or 409) does not resolve an earlier unknown result or replace
that original request. This pending request lives in the mounted view's memory, not a durable browser outbox. Project,
identity and role changes remount/fence the view so old responses do not populate
the new scope.

Removing the provider withdraws its tools and sidebar row while retaining the
data; re-enabling restores them. Removing the UI adapter does not remove the
service or tools. Claims neither depends on nor creates Workflows, Artifacts,
Reviews or Sessions instances.

## Python distinctions and remaining research work

The Python reference has the same defaults and public status/confidence update
boundary, but no claim-specific text bounds, revision CAS or request deduplication.
Its `claim.list` is internal to external MCP; TypeScript deliberately exposes a
read-only list. Python accepts null as omission for optional update fields;
TypeScript requires omitted fields instead. Its desktop lacked a status/confidence
editor; TypeScript supplies one. See the [source-backed reference](CLAIMS_PARITY_REFERENCE.md).

This slice does not yet provide linked experiment evidence, a claim belief-history
view or reviewed statement changes. It retains the
records and events those integrations need. A completed experiment must not
automatically mark its claims supported.

Future reflection publication needs a trusted transaction-taking writer for
reviewed statement/scope/status/confidence changes, with publication identity and
rationale. The owning reflection program must validate and pin those changes and
atomically apply claims, provenance and experiment associations. That writer is
not implemented or exposed as a public bypass here; Claims must not depend back
on Reflections. The next program is the
[complete Experiment lifecycle](RESEARCH_PROGRAM_PARITY_PLAN.md).

## Verification checkpoint

The final integration suite passed **566 tests** after the UI retry fix, including
**13 Claims tests**
across [core](../tests/claims.test.ts) and [HTTP/MCP](../tests/claims-api.test.ts).
These cover normalized replay, concurrent SQLite writers, authority loss,
rollback, tenant boundaries, strict inputs, session grants and provider unload.
An independent source audit identified and verified the fix for getter evaluation
on a malformed `claims.get` ID.

The [native Claims fixture](../scripts/live-claims.ts) completed with two fresh
agents, nine successful MCP calls and zero failures. It checks creation/update,
retained identity and independent readback through the actual tools. The fixture
is interface validation on synthetic data, not scientific review or an Experiment
program.

Browser verification also passed against the actual production bundle and API
through a disposable loopback proxy. Visually checked cases covered:

- Owner creation with high confidence and a scope containing literal
  `<img src=x>` text, displayed as text.
- A committed creation whose response was replaced by a 500, followed by a
  refused 404 retry and then successful receipt recovery. All three attempts
  retained identical input/request IDs, locked fields, and only one created claim.
- A normal revision 0→1 edit; then a concurrent fixture edit to revision 2 and a
  stale browser revision-1 submission returning 409, preserving the newer values.
- In-app project switching without a hard reload, discarding an unsaved draft
  and showing the other project's empty inventory.
- A synthetically signed reader seeing its project's claim with no Create/Edit
  controls and no access to another project.

The sticky-uncertainty fix was identified by independent source review and also
checked red→green with a temporary harness exercising the actual React hook.
That mock harness is separate from the browser verification. An initial blank
fixture page was corrected by fixing the temporary proxy's Host/Origin setup;
no production guard was relaxed. This used local synthetic credentials, not a
real shared-provider login. Execution records are maintained separately in
[VERIFICATION.md](../VERIFICATION.md).
