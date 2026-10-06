# Code and research ownership

Code manages Git repositories and workspaces across machines. Code Work decides how
those capabilities participate in research. A fresh standalone Code installation creates
no task, experiment, acceptance, review, research-base or publication records.

| Owner     | Responsibilities                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code      | Project repository bindings; workspace starting commits and writer generations; Git objects and refs; transfer receipts and recovery; opaque commit-retention obligations; repository holds; admission limits; optional GitHub transport. |
| Code Work | Workflow-to-workspace mapping; dependency and base selection; submission and review provenance; acceptance; research merge checks and their machine settings; publication approval and integration.                                       |

Code Work composes the Code storage API. It does not inherit its storage implementation.
Research types live in explicit research contract modules. The research-local records class
remains an implementation detail of the adapter.

## Records and operations

Code's `code_workspaces` records contain technical writer state. Research's `code_units`
records contain workflow identity, the reason a starting commit was selected, and acceptance
facts. An opaque identifier connects the two; Code does not interpret it as a workflow.

Research records an acceptance and requests commit retention in the same State transaction.
Code journals the requested Git ref separately from the SQL record because Git and PostgreSQL
cannot commit together. The executor verifies that the requested object is a commit before
creating the retained ref. A retention record is an obligation, not by itself proof that the
Git operation has completed. Existing admission receipts and research publication gates still
determine when a result is usable.

Retention uses an opaque key, so separate review rounds of one work item cannot overwrite
each other's commits. Its default refs use `refs/merv/retained/`. A consumer can supply a
validated technical ref name; Code Work supplies the existing `refs/merv/accepted/`
destination for final acceptance, preserving local and mirrored branch names. Historical
`accept-ref` journals are all complete, and so are the `mirror-accepted` rows they queued.

Unfinished research merges and publications project persistent repository holds through
Code's transactional hold API. Research-owned SQL triggers maintain those projections in
the same transaction as the research state change. Each obligation has its own key. Disabling
the research plugin does not remove the holds. Likewise, research projects mirror eligibility;
Code consumes an explicit technical permission and never queries research base health.

Repository admission configuration belongs to Code. The check command, timeout and machine
selection belong to Code Work. The existing public configuration request still commits
both atomically and keeps one replayable request receipt with its original input semantics.
That receipt, like those of the base controls, is Code Work's own (`code_work_receipts`, in
its `code_commands` storage); `code_commands@3` copied the ones Code's operation journal held,
so an old request id still replays, and Code Work writes none to Code any more.

## Upgrade behavior

The Code storage migration created the technical tables alongside existing research records
and, on an older installation, held its repositories until the research adapter had copied
writer ownership, starting commits, retained results and review rounds into them. Every
deployment has completed that one-time copy, and the copy and its hold checks have been
removed. The migration text, which still places that hold where `code_units` exists before
Code's storage, is published and unchanged; Code initializes its storage before Code Work
creates `code_units`, so a fresh installation never reaches it.

The pre-boundary `code_units` component (v1–v4) is retired: nothing registers it any more,
and its `component_migrations` rows stay so that an older image can still start. Code Work's
`code_research_records@2` drops the writer columns and the generation guard that installation
left on `code_units`, so an existing database ends with the same unit table as a fresh one. A
binary that still reads those columns from `code_units` is not a rollback target.

## Enforcement

`code-work-boundary.test.ts` rejects core imports of research policy, SQL access to research
tables, and research inheritance from Code implementation classes. Runtime tests cover fresh
standalone Code, durable holds after adapter closure, and unchanged configuration authorization and replay semantics.
Git transfer, writer recovery, merge resolution and reviewed publication remain covered by
their existing integration suites.
