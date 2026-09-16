# Living paper

Paper stores the project definition, literature and citations, Methods/Results sections, immutable revisions, proposed edits and accepted publication records. It creates no workflow, context recipe, agent identity or lease. Its required providers are State, Scope and Artifacts.

`paper.read` returns documents, citations and retained proposals; `kind` selects a document and `history: true` its revisions. `paper.patch` edits problem/literature sections with expectedRevision and a stable requestId. `paper.cite` maintains the bibliographic ledger and links existing literature sections or project-scoped `artifact:<id>` evidence. Historical claim/experiment citation references remain readable and can be preserved when editing; new scientific source relationships are recorded by workflow-owned proposals rather than resolved through Knowledge.

## Paper edits are scientific deliverables

The existing experiment execution agent prepares Methods/Results changes with its results. The reflection synthesis agent prepares changes across experiments with its synthesis. Both receive relevant paper sections through their existing context recipes and keep their current assignment and identity.

Create an immutable `application/json` artifact containing:

```json
{
  "documents": [
    {
      "kind": "results",
      "expectedRevision": 0,
      "changes": [
        {"id": "comparison", "title": "Comparison", "content": "The supported finding and limitations."}
      ]
    }
  ]
}
```

`kind` is `methods` or `results`. A proposal can update both, once each. Section changes support title/content, ordering (`afterId`) and removal, as with `paper.patch`. New sections need a title and content.

Pass the artifact ID as `paperChangesArtifactId` on `experiment.transition` with `submit_results`, or on `reflection.submit`. If no document change is warranted, omit it and explain why in the scientific report. There is no separate paper submission tool or writing assignment.

The owning program validates its producer/assignment and scientific evidence, then calls Paper.propose in the submission transaction. Paper validates the author's exact execution, project-scoped evidence, JSON edits, document revisions and size limits. It pins the original text, proposed edits, artifact hashes and the exact experiment/reflection submission identity. The scientific review includes that artifact and an explicit paper criterion; its context includes the proposal and original text.

On pass, the existing review handler calls Paper.accept in the same transaction as the verdict and workflow transition. Methods/Results become the accepted revisions. A rejection preserves the proposed edits without applying them. Concurrent accepted edits cause `paper_revision_conflict`; the reviewer returns the scientific submission for revision, and the producer submits a fresh proposal against current document revisions. No edits are silently overwritten, and a conflict in either document rolls back both edits and the verdict.

Paper.propose/accept are trusted in-process owner APIs, not public tools. Paper does not independently infer scientific approval or query other domains. Publication records carry the source submission, exact independent review ID, author, and evidence hashes. Freshness/coverage reasoning belongs to the originating scientific workflows; `paper.read` does not claim global corpus freshness.

## Retained history

The migration keeps existing document, citation and publication history. Previous standalone writing inputs/leases remain in their legacy tables for audit; their removed tools and workflow registration cannot create or execute new writing assignments. Existing document text is preserved. The UI identifies historical publications that predate independent scientific review. New edits use the experiment/reflection submission path.
