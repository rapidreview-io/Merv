# Fixed execution policy — Fable design review

Claude Fable reviewed a separately approved 3,374-byte generic design question.
No repository source, credentials or project data were sent. Tools and MCP were
disabled, with safe/restricted mode and no session persistence. The source-free
prompt and response are retained under
`/private/tmp/workflow-execution-fable-20260915/`.

| Finding                                                           | Disposition                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical hashing and input equality must agree.                  | Strict finite JSON and whole-value equality are required. Unknown policy fields are refused. Declaration ordering has explicit deterministic semantics.                                                                 |
| Binding alternatives must not be mixed or shallow-merged.         | Each complete alternative is evaluated independently. Conflicts and ambiguous missing-value expansion must fail.                                                                                                        |
| Resolver facts must share the checked snapshot.                   | Admission, revision and reference resolution run in one transaction. The metadata path does not render context or read artifact bytes.                                                                                  |
| An ID must identify pinned content.                               | Artifacts already makes metadata and content-addressed references immutable. Task authority excludes arbitrary checkpoint or rendered-context references.                                                               |
| An uncommitted handle could survive rollback.                     | This API performs a fresh check on every call; its output is not a grant. A future lease must persist its facts and ownership in the committing offer transaction.                                                      |
| Generation fencing must survive unload and restart.               | Each registration gets a globally unique ID. Old IDs fail after reload and restart; identical policy hashes do not revive them. A persisted counter is unnecessary for this property.                                   |
| Absent policy, empty policy and unavailable program must differ.  | Absence supplies no dispatch authority, an empty installed policy admits no tool, and an unavailable registration cannot authorize a check. Absence is durably pinned too.                                              |
| Captured authority must bind the principal and source credential. | Required for the next session slice. The present request contains a policy/version fence and independently rechecks the supplied trusted caller. It is explicitly not a principal-bound bearer.                         |
| Policy and tool schemas can drift independently.                  | Registry uniqueness and strict current input validation remain in force. Future session integration must apply bindings before parsing and recheck afterward; a policy hash does not pin tool implementation semantics. |

Fable explicitly advised keeping bearer/session enforcement outside this bounded
foundation. The next slice still needs real credential issuance, source-authority
checks, native transaction guards, mounted-dispatch checks and claim succession.
This consultation does not stand in for the earlier private-source audit, which
was not retried.
