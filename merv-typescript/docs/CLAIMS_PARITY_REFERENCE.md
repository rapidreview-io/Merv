# Claims: Python reference and TypeScript boundary

Source audit: 2026-09-15. Claims is a small project-scoped record service. It does
not own experiments, assess evidence automatically, or require a new workflow.
This document distinguishes existing Python behavior from recommended changes.

## Existing contract

| Field              | Python behavior                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `id`, `project_id` | Server-owned identity; every lookup/update is project-scoped                                               |
| `statement`        | Required string, trimmed, must remain nonempty                                                             |
| `scope`            | Optional **string of prose**, default `""`, trimmed; not an object or authorization scope                  |
| `status`           | Initially `active`; allowed values `draft`, `active`, `supported`, `weakened`, `contradicted`, `abandoned` |
| `confidence`       | Initially `medium`; allowed values `low`, `medium`, `high`                                                 |
| `created_at`       | Server timestamp, preserved on update                                                                      |

There is no claim-specific maximum string length, statement uniqueness, owner
field, revision, updated timestamp, deletion API or state-transition graph.
Duplicate statements create distinct records. Any allowed status may replace
any other. The service does not require evidence before changing confidence or
status. Completion of an experiment does not automatically change its claims.

The public `claim.create` input is `statement`, optional `scope` and
`confidence`. It does not accept initial status. It returns the full row.
`claim.update` accepts `claim_id`, optional `status` and `confidence`; at least
one non-null update field is required. Omitted/null fields preserve their old
values. Public statement/scope changes are rejected by the closed input schema.
The shared model trims input strings and rejects unknown fields.

`claim.list` returns `{claims: [...]}`, includes every status and orders by
`created_at, id` ascending. It has no filtering, pagination or silent cap. It is
**internal** in the Python tool manifest: HTTP uses it, while external agents
read the full claim inventory through `project(action="records")`. Exposing
`claim.list` in TypeScript is a deliberate small surface change.

Sources: [record writer](../../merv/src/merv/brain/research_core/research.py),
[schemas/tools](../../merv/src/merv/brain/research_core/tools.py),
[shared input model](../../merv/src/merv/brain/kernel/tools.py),
[vocabulary](../../merv/src/merv/brain/workflows/definitions/research_contracts.py),
[storage](../../merv/src/merv/brain/research_core/persistence.py).

## Authorization and transport

Python claims have no per-record owner or claim-specific administrator check.
Ordinary project members and their valid machine keys can create/update them.
The gateway enforces current membership and exact project-key scope. A foreign
claim/project is not found. Local composition is trusted; the record service
itself does not authenticate a human.

Leased agents also need the tool in their fixed execution allowlist. The old
`read_only` flag selects the smaller baseline; it does not universally prohibit
explicitly listed mutating tools, since review submissions are intentional
exceptions. Actual reviewer policies omit claim creation/update. TypeScript
should use its existing Scope read/write permissions and fixed Sessions grants,
rather than import Python's lack of member roles or invent a claim-specific
admin gate.

| HTTP route                                               | Response                                |
| -------------------------------------------------------- | --------------------------------------- |
| `GET /api/projects/:projectId/claims`                    | `{claims}`                              |
| `GET /api/projects/:projectId/claims/:claimId`           | Full row, or 404; Python scans the list |
| `POST /api/projects/:projectId/claims`                   | 201 and full created row                |
| `PATCH` / `PUT /api/projects/:projectId/claims/:claimId` | Full updated row                        |

Route/body project or claim ID conflicts are rejected before dispatch. Requests
use the common tool contract, not independent endpoint validation. No claim
route is human-only. TypeScript can reuse its existing tool HTTP transport and
plugin UI rather than duplicate these legacy URLs.

Sources: [claim routes](../../merv/src/merv/brain/surface/transport/api/claims.py),
[gateway](../../merv/src/merv/brain/surface/transport/api/gateway.py),
[path binding](../../merv/src/merv/brain/surface/transport/api/shared.py),
[session policy](../../merv/src/merv/brain/surface/transport/http_policy.py).

## Mutation and publication invariants

Each ordinary create/update writes the row and its `claim.created` or
`claim.updated` event in one transaction. Events contain the complete new
statement/scope/status/confidence. There is no request deduplication or CAS.
Updating a field to its current value still executes an UPDATE and emits an
event. Two concurrent editors can overwrite each other without detection.

Reviewed reflection publication uses the same transaction-taking writer. It
may create claims or change statement, scope, status and confidence, preserving
omitted fields. It adds `source_reflection_id` and `rationale` to the event and
writes `reflection_claim_changes` associations. Spec-local creation keys resolve
to actual claim IDs before creating experiments. The claim writes, associations,
new experiments/tasks and dependency edges must commit or roll back together.

The reflection program owns validation of the reviewed change spec: rationale,
unique creation keys, no duplicate update of one claim, same-project existing
IDs, and experiment claim references. Claims should validate the resulting
record and transaction authority; it should not depend back on Reflections.
The shared internal writer is a trusted program API, not permission for a public
claim tool to accept arbitrary publication provenance or edit claim text.

Experiments validate linked claim IDs within their project and deduplicate
resolved IDs before inserting associations. Reflections freeze each claim's
ID, statement, scope, status and confidence in their corpus; subsequent changes
must not mutate that old corpus. Passing a review does not itself publish claim
changes; the publication transaction applies them later.

Sources: [publication writer and corpus](../../merv/src/merv/brain/research_core/reflections.py),
[change-spec validation](../../merv/src/merv/brain/workflows/definitions/documents.py),
[experiment associations](../../merv/src/merv/brain/research_core/experiments.py).

## UI and deliberate improvements

The old desktop creates claims and shows statement, scope, status, confidence,
linked experiments and belief history. Detail is read-only; there is no existing
status/confidence editor in its API client. Mobile is read-only. The creation
form does not implement a separate role gate. These are UI facts, not stronger
permissions than the server provides.

Do not copy the old history bug: `computeClaimShifts` initializes every creation
as active/medium instead of reading the event's actual values. A claim created
with high confidence can therefore display a false later confidence change.
Use actual before/after event facts, and show no inferred history if unavailable.
Do not invent experiment evidence while the Experiments provider is absent.

For TypeScript, add bounded strict strings, stable mutation request IDs, current
authorization before replay, and a revision/CAS for updates. Preserve the public
text-edit boundary. Define no-op handling explicitly; do not let a retried HTTP
request generate another event. If a new request makes no semantic change,
either retain the Python event behavior or return a no-change receipt, with
tests and documentation for the selected contract. Include actor/source
provenance and before/after values in real changes. Use one private writer for
ordinary commands and a later explicitly authorized publication method; do not
expose unreviewed statement edits as part of this slice.

Sources: [desktop list](../../research_state_ui/src/pages/Claims.jsx),
[detail](../../research_state_ui/src/pages/ClaimDetail.jsx),
[client](../../research_state_ui/src/api.js),
[history bug](../../research_state_ui/src/utils/claimShifts.js),
[mobile list](../../research_state_ui/src/mobile/MobileClaims.jsx).

## Reference verification

Twelve focused Python tests passed in 1.702 seconds on 2026-09-15. They cover
direct/reflection field and event equivalence, cross-project rollback, publication
rollback after claim creation/update, duplicate claim references, experiment
deduplication, full inventory, HTTP updates, membership, path/key scope and
internal-tool visibility. Log: `/private/tmp/merv-claims-reference-tests.log`.

The exact cases are in
[reflection tests](../../merv/tests/research_core/test_reflections.py),
[experiment tests](../../merv/tests/research_core/test_experiments.py),
[project tools](../../merv/tests/workflow/test_project_tools.py),
[HTTP tests](../../merv/tests/surface/test_http_api.py),
[auth tests](../../merv/tests/surface/test_auth.py), and
[key tests](../../merv/tests/surface/test_project_keys.py). These are reference
tests with local synthetic state, not live research MCP operations or proof of
the new TypeScript implementation.
