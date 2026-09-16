# Claims

Claims retains project research statements, their prose scope, status and
confidence. It depends only on **State and Scope**. Claim status describes what
the project believes; it is not an execution workflow. Experiments, evidence
assessment and reviewed reflection publication remain separate domain work.

| Entrypoint           | Requires      | Exposes                                      |
| -------------------- | ------------- | -------------------------------------------- |
| `@merv/claims`       | State, Scope  | `claims` service: create, update, get, list  |
| `@merv/claims/tools` | Claims, Tools | `claim.create`, `claim.list`, `claim.update` |
| `@merv/claims/ui`    | Claims, UI    | Claims page                                  |

Producers and operators may create/update; readers and reviewers may read.
Every request checks current credentials, membership or session authority.
Session tools must also be allowed by the assigned workflow policy. Claims
creates no workflow or process and grants no additional tool authority.

Creation takes `statement`, optional `scope`, optional `confidence`, and
`requestId`. Statement/scope are trimmed prose strings of at most 16,000
characters; statement must be nonempty. Initial status is `active`, confidence
defaults to `medium`, and revision starts at zero. Duplicate statements may be
separate claims.

Updates take `claimId`, `expectedRevision`, `requestId` and at least one of
`status`/`confidence`. Status values are `draft`, `active`, `supported`,
`weakened`, `contradicted`, `abandoned`; confidence is `low`, `medium`, `high`.
Any status may change to another. Ordinary commands cannot edit statement or
scope. Every accepted new update, including the same values, advances revision
and records an event. A new request with a stale revision conflicts.

Request receipts are scoped to project and actor. The same normalized operation
and input return the original response before checking the claim's newer
revision; changed input conflicts. Current authorization is still required.
The row, attributed event and receipt commit together, including when called
inside another service's transaction. Creator identity is retained, updater
identity is separate, and claims/receipts cannot be deleted. Listing includes
all statuses in ascending creation-time/ID order without a silent cap.

Removing Claims withdraws its tool/UI adapters while keeping unrelated services
available. Re-enabling it restores the retained records. The provider does not
depend on Feed; Feed can display the committed domain events when present.

```text
packages/claims/
├── package.json
├── README.md
└── src/
    ├── index.ts    # Service, migrations, transactions and Cordis provider
    ├── input.ts    # Shared strict schemas and scalar input validation
    ├── types.ts    # Public service/DTO contracts
    ├── tools.ts    # Three tool registrations
    └── ui.ts       # Optional UI registration
```

Python's `claim.list` was internal to its transport and public updates had no
CAS or request deduplication. The TypeScript surface deliberately exposes a
read-only list and adds both safeguards. A future reviewed publication writer
must preserve transaction composition and explicit provenance without exposing
unreviewed text changes through ordinary tools. See the
[reference audit](../../docs/CLAIMS_PARITY_REFERENCE.md) and
[research-program order](../../docs/RESEARCH_PROGRAM_PARITY_PLAN.md).
