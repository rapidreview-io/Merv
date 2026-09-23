# Knowledge

Knowledge provides current project research records and scoped reference
resolution. Tasks, Experiments, Artifacts, Reviews and Code continue to own their
source records. Research claims were retired: each one was converted into a
Markdown text artifact titled `Claim: …`, which resolves like any other artifact.

| Entrypoint              | Requires                                                   | Provides                                |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `@merv/knowledge`       | State, Scope, Tasks, Experiments, Artifacts, Reviews, Code | `knowledge` service                     |
| `@merv/knowledge/tools` | Knowledge, Tools                                           | `project.records`, `project.references` |
| `@merv/knowledge/ui`    | Knowledge, UI                                              | Research records page                   |

`project.records` returns the current Scope project record, including its
Introduction and all task/experiment metadata. It performs no
artifact-body reads, prompt rendering, session reconciliation, exit evaluation
or workflow mutation. Gate and next-action guidance stays in Workflows.

`project.references` resolves up to 200 input references in order. Supported
explicit forms are `task:ID`, `experiment:ID`, `artifact:ID`,
`review:ID`, `code-proposal:ID`, `code-commit:ID` and `session-final:ID`; supported
record-ID prefixes also work. Results distinguish resolved, missing, unsupported
and unpublished. No lookup falls back to another project. A resolved code
reference can describe a pending observation rather than ready Git evidence.

## Service

```ts
knowledge.records(caller, tx?);
knowledge.resolve(caller, refs, tx?);
```

Publication currently returns `status: "none"`, null reflection and an
empty lens list. This is explicit absence: the provider implements neither a
Reflection workflow nor a published baseline, coverage/debt rules or literature
maintenance. It does not assess claims or grant central Git publication.

## Retired corpus snapshots

The corpus capture that the retired `reflection@1` used (`knowledge.capture`,
`knowledge.get`, the selection behind them and `researchReferences`) is removed.
The `knowledge@2` migration deleted every `knowledge_snapshots` and
`knowledge_commands` row; nothing read them. The empty tables stay, because the
migration that created them is pinned.

```text
packages/knowledge/
├── package.json
├── README.md
└── src/
    ├── index.ts    # Transactional records and the exact resolver
    ├── types.ts    # Public contracts and Cordis capability
    ├── input.ts    # Bounded data-only inputs and canonical serialization
    ├── storage.ts  # Migrations of the retired snapshot tables
    ├── tools.ts   # Two metadata-read tools
    └── ui.ts      # Optional Research records registration
```

Unloading Knowledge withdraws its adapters; source services and retained State
records remain. Reads fail clearly while an injected provider is unavailable.
See [research inputs](../../docs/RESEARCH_INPUTS.md),
[Python correspondence](../../docs/CORPUS_PARITY_REFERENCE.md), and
[focused tests](../../tests/knowledge.test.ts).
