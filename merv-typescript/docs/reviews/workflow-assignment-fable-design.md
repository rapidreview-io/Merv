# Workflow assignment — Fable design consultation

Fable reviewed a standalone generic workflow design question without repository
files, source excerpts, credentials or project-specific data. This was a design
consultation, not a source audit. The earlier separately blocked private-source
packet was not sent or retried.

Invocation: `claude-fable-5`, safe/restricted mode, tools and MCP disabled, no
session persistence. The main model completed successfully in 66.288 seconds;
the CLI also reported its Haiku helper. Total reported cost: $0.228904.
The exact question and response are retained locally at
`/private/tmp/workflow-activation-design-question.txt` and
`/private/tmp/workflow-activation-design-fable-20260915/response.json`.

| Concern                                                                              | Checked implementation and disposition                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion could act on an old revision after begin.                                 | Existing workflow/domain commands recheck expectedRevision, actor, claim and evidence in their transaction. Guidance preflight also rejects stale revisions. No additional duplicated guard was added.                                                                                                                                         |
| Two first begins could race.                                                         | The key is unique and State starts with BEGIN IMMEDIATE before admission reads, plus a busy timeout. Concurrent workers must serialize and the follower reads the existing marker. Node need not be added to the key: every state transition and version upgrade increments revision.                                                          |
| Begin must not be called read-only.                                                  | The adapter marks assignment readOnly=true and begin readOnly=false. Repeat begin preserves ledger identity but may return newer context. No response-cache equivalence is promised.                                                                                                                                                           |
| Rendering holds the writer lock.                                                     | Accepted operational tradeoff for this synchronous local stack: bounded artifact reads, no network/model calls. We retain atomic marker/context failure. Committing before context renders would record a start for a packet the caller never received and break the chosen contract. Async storage/concurrency expansion remains future work. |
| Submissions without begin or replacement reviewers make the start ledger incomplete. | The ledger explicitly records first activation, not all worker participation. Existing submission compatibility remains; absence means unrecorded. Review claim history and recovery retain replacement ownership. We do not fabricate timestamps or expand this slice into sessions.                                                          |
| Advisory execution declarations could be mistaken for enforcement.                   | Documentation and contract explicitly identify hints; tool authorization remains authoritative. The packet includes authorized handoff/context/checkpoint bindings. Operator assistance does not declare producer-only submission.                                                                                                             |

Local review also caught two concrete integration issues: the initial suggested
tool list omitted handoff bindings, and recipe removal made guidance fail instead
of exposing a blocked begin. Both were corrected and covered by regressions.
