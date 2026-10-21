# Living paper

Personal agents use noun tools with `{"action":"x","x":{...}}` and a top-level
`projectId` when selecting a project. Leased workers keep the alias names and flat
inputs granted by their pinned workflows. See the [tool overview](../README.md#agent-tools).

Paper stores four living documents: Problem, Literature, Methods and Results, plus citations and immutable revision history. It creates no workflow, assignment or lease. Its required providers remain State, Scope and Artifacts.

## Two editing paths

The user's main agent or an authorized human can call `paper.write` (`patch`) to edit any document at any time. Problem retains its four fixed sections: problem, scope, goals and constraints. Literature, Methods and Results have ordered editable sections. Direct edits require project write permission, the current document revision and a stable request ID. Assigned worker sessions cannot call this direct editing path.

Experiment design reviewers, experiment results reviewers and reflection reviewers own Methods/Results maintenance as part of their existing review. Read the current paper and the scientific evidence, then supply reviewer-authored `paperChanges` to `review.write` (`submit`):

```json
{
  "paperChanges": {
    "documents": [
      {
        "kind": "methods",
        "expectedRevision": 3,
        "changes": [
          {
            "id": "comparison",
            "title": "Controlled comparison",
            "content": "We are testing hypothesis XYZ in experiment ABC; results are pending."
          }
        ]
      }
    ]
  }
}
```

The example is the paper portion of the usual verdict payload, alongside reviewId, claimId, verdict, expectedRevision, notes, synopsis, findings and requestId. Each document appears at most once. A change can insert, revise, reorder or remove a section using the same shape as `paper.write` (`patch`). A change to an existing section may give `edits: [{"find": "…", "replace": "…"}]` in place of `content`: the edits are made in turn, each replacing its find, which must occur exactly once in the section as the edits before it left it. A sentence added to a long shared section is then sent alone, not the whole section again; to add one, find the end of the paragraph it follows and replace that with itself plus the sentence. `PAPER_EDITS_INSTRUCTION` (`@merv/paper/rules`) says this to a reviewer in the guidance `review.write` (`start`) and `review.read` (`get`) return; the pinned `PAPER_REVIEWER_INSTRUCTION` still names whole-section changes. Only Methods and Results are accepted here. Task and consolidation reviews reject paperChanges.

## Events and responsibility

- **Direct edit saved:** the chosen document changes immediately. This is the main agent's editing path and requires no scientific review.
- **Research cycle starts:** the cycle retains the current complete Problem definition. Later edits do not rewrite that captured definition.
- **Plan review submitted:** the reviewer briefly describes the hypothesis, proposed approach and purpose, usually in one or two sentences, clearly distinguishing planned or rejected work from completed findings.
- **Results review submitted:** the reviewer records what was done and learned, replaces outdated planned text, and retains negative findings, uncertainty and limitations. Comprehensive methods, results and interpretation are welcome when they help explain the project’s trajectory and inform what comes next.
- **Reflection review submitted:** the reviewer integrates evidence across experiments, reconciles contradictions and revises the overall narrative rather than appending the synthesis report. Comprehensive detail is welcome when it explains the project’s trajectory, how understanding has changed and what comes next.

Reviewer edits apply with any valid verdict, including needs_changes and fail. An edit accompanying rejection must describe that rejection accurately, not portray rejected evidence as an accepted result. If no change is warranted, reviewer instructions require an explanation in the review notes; the API does not force a cosmetic edit or separately validate that explanation.

The producer supplies the plan, results and report; synthesis supplies its report and change specification. Producer submissions no longer accept paperChangesArtifactId. They do not prepare a paper proposal for another agent to approve. Existing reviewer grants suffice: paper changes travel with the already authorized review submission (workers keep the `review.submit` alias), without giving reviewers a general-purpose write tool.

## Atomicity, attribution and history

The owning scientific workflow validates the live independent reviewer, claim, submission, verdict and state transition. Paper revisions, review publication records and the verdict save in one transaction. Invalid edits, conflicting paper edits or any failed review check roll everything back. An edit made against an earlier revision is applied to the current one when it does not touch what changed since: a section nobody else changed takes it as written, and a section somebody else changed takes it merged line by line (paragraph by paragraph) with theirs, as Git merges; two paragraphs inserted at the same place are both kept, the later writer's first. Edits apply to the section as it is now wherever each find still occurs once there. Changing the same or neighbouring lines, quoting in an edit's find text that changed since, or removing, moving or creating a section that changed since, is refused with `paper_revision_conflict`, which names each section to read again with `paper.read` and the current revision to resend at. The same applies to `paper.write` (`patch`). Retrying the same successful verdict returns its receipt without another paper revision.

New revisions name the reviewer as author and retain the review ID, source experiment/reflection revision and verdict. Publication records retain the source evidence hashes and changed section IDs. Later main-agent edits retain the previous review revision and are attributed as direct edits, without inheriting its review attribution.

Old producer proposals stay stored in `paper_proposals` but nothing reads them: they do not overlay the current paper or apply when a review completes. Accepted publications and standalone-writing history remain readable. A publication from that time names no sections, so the UI shows it behind every section it still holds word for word.

`paper.read` action `get` returns current documents and citations. Action `document` selects one by `kind`; `outline` lists its sections and lengths without content; `section` reads one section (optionally by `offset` and `length`); `history` returns its revisions. Pass each action’s fields under its name, for example `{"action":"document","document":{"kind":"methods"}}`. An agent is shown a published section that reads as the current one by its id and title only, since a reviewed document is most often published at its current revision; Merv's pages receive both whole. `paper.write` (`cite`) maintains the bibliographic ledger independently; citation changes do not rewrite Literature prose. Neither paper reads nor publication records claim that all project evidence has been incorporated.

## Experiment references

The paper is the authoritative narrative for hypotheses and conclusions; there is
no separately maintained research-claim status or confidence. Cite experiments as
`[Experiment name](/experiments/EXPERIMENT_ID)`, with their actual names as visible
labels and stable identifiers only in link destinations. Reviewers add these links
where the experiment supports, qualifies or contradicts the prose. The UI resolves
known experiment references to names, including older references written as IDs.
These are ordinary document links, not a new relationship registry.

Research claims are retired: each existing claim was converted into a Markdown
text artifact titled `Claim: …`, which keeps its statement, status, confidence,
scope, author and edit history. Experiments and reflection plans do not accept
`testedClaimIds`. The reviewer `claimId` still identifies a review assignment lock.
