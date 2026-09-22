# Knowledge

Knowledge provides current project research records, scoped reference resolution
and immutable corpus snapshots for an owning program. Tasks, Experiments,
Artifacts, Reviews and Code continue to own their source records. A saved corpus
is not a published Reflection. Research claims were retired: each one was
converted into a Markdown text artifact titled `Claim: …`, which resolves like any
other artifact.

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

## Service-only corpus creation

```ts
knowledge.capture(caller, { requestId }, tx?);
knowledge.get(caller, snapshotId, tx?);
knowledge.records(caller, tx?);
knowledge.resolve(caller, refs, tx?);
```

Capture requires current project write authority and selects all
terminal tasks (`done`/`failed`) and terminal experiments
(`complete`/`abandoned`/`failed`) in one transaction. It retains exact project
facts, domain metadata, associated artifact metadata and referenced assessments.
Experiment submissions may declare exact Code capture references; their
project/instance/worker/session/revision provenance is checked. It does not
select arbitrary latest workspace heads or every unrelated project upload.

Task review coverage is explicitly `current-record-references`. Missing source
records remain explicit. Artifact metadata retention does not certify current
blob availability, and capture does not read file bodies. Provider outages and
inconsistent source provenance abort rather than silently shrinking the corpus.

The format-1 content hash is SHA-256 over canonical
`{formatVersion, selection}` with locale-independent key ordering. The snapshot
also records its creator/time and source event head. Snapshot, event and request
receipt are atomic; SQL triggers refuse update/delete. An identical request
replays the original snapshot under current authority, including any pending
capture status saved at that time. Later source changes require a new capture.
There is no agent-facing capture tool.

Publication currently returns `status: "none"`, null reflection and an
empty lens list. This is explicit absence: the provider implements neither a
Reflection workflow nor a published baseline, coverage/debt rules or literature
maintenance. It does not assess claims or grant central Git publication.

```text
packages/knowledge/
├── package.json
├── README.md
└── src/
    ├── index.ts    # Transactional assembly, exact resolver, snapshot service
    ├── types.ts    # Public contracts and Cordis capability
    ├── input.ts    # Bounded data-only inputs and canonical serialization
    ├── storage.ts  # Owned immutable snapshots and request receipts
    ├── tools.ts   # Two metadata-read tools
    └── ui.ts      # Optional Research records registration
```

Unloading Knowledge withdraws its adapters; source services and retained State
records remain. Reads fail clearly while an injected provider is unavailable.
See [research inputs](../../docs/RESEARCH_INPUTS.md),
[Python correspondence](../../docs/CORPUS_PARITY_REFERENCE.md), and
[focused tests](../../tests/knowledge.test.ts). Synthetic capture-service fixtures
and actual local Git object tests prove different boundaries; native Git
acceptance is pending at this documentation checkpoint.
