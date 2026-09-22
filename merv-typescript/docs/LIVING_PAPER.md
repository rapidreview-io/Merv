# Living paper

Paper stores four living documents: Problem, Literature, Methods and Results, plus citations and immutable revision history. It creates no workflow, assignment or lease. Its required providers remain State, Scope and Artifacts.

## Two editing paths

The user's main agent or an authorized human can call `paper.patch` to edit any document at any time. Problem retains its four fixed sections: problem, scope, goals and constraints. Literature, Methods and Results have ordered editable sections. Direct edits require project write permission, the current document revision and a stable request ID. Assigned worker sessions cannot call this direct editing path.

Experiment design reviewers, experiment results reviewers and reflection reviewers own Methods/Results maintenance as part of their existing review. Read the current paper and the scientific evidence, then supply reviewer-authored `paperChanges` to `review.submit`:

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

The example is the paper portion of the usual verdict payload, alongside reviewId, claimId, verdict, expectedRevision, notes, synopsis, findings and requestId. Each document appears at most once. A change can insert, revise, reorder or remove a section using the same shape as `paper.patch`. Only Methods and Results are accepted here. Task and consolidation reviews reject paperChanges.

## Events and responsibility

- **Direct edit saved:** the chosen document changes immediately. This is the main agent's editing path and requires no scientific review.
- **Research cycle starts:** the cycle retains the current complete Problem definition. Later edits do not rewrite that captured definition.
- **Plan review submitted:** the reviewer briefly describes the hypothesis, proposed approach and purpose, usually in one or two sentences, clearly distinguishing planned or rejected work from completed findings.
- **Results review submitted:** the reviewer records what was done and learned, replaces outdated planned text, and retains negative findings, uncertainty and limitations. Comprehensive methods, results and interpretation are welcome when they help explain the project’s trajectory and inform what comes next.
- **Reflection review submitted:** the reviewer integrates evidence across experiments, reconciles contradictions and revises the overall narrative rather than appending the synthesis report. Comprehensive detail is welcome when it explains the project’s trajectory, how understanding has changed and what comes next.

Reviewer edits apply with any valid verdict, including needs_changes and fail. An edit accompanying rejection must describe that rejection accurately, not portray rejected evidence as an accepted result. If no change is warranted, reviewer instructions require an explanation in the review notes; the API does not force a cosmetic edit or separately validate that explanation.

The producer supplies the plan, results and report; synthesis supplies its report and change specification. Producer submissions no longer accept paperChangesArtifactId. They do not prepare a paper proposal for another agent to approve. Existing reviewer grants suffice: paper changes travel with the already authorized review.submit, without giving reviewers a general-purpose write tool.

## Atomicity, attribution and history

The owning scientific workflow validates the live independent reviewer, claim, submission, verdict and state transition. Paper revisions, review publication records and the verdict save in one transaction. Invalid edits, stale paper revisions or any failed review check roll everything back. The reviewer reads the current paper, revises the edits and retries; unrelated later edits also require refreshing the document revision. Retrying the same successful verdict returns its receipt without another paper revision.

New revisions name the reviewer as author and retain the review ID, source experiment/reflection revision and verdict. Publication records retain the source evidence hashes and changed section IDs. Later main-agent edits retain the previous review revision and are attributed as direct edits, without inheriting its review attribution.

Old producer proposals, accepted publications and standalone-writing history remain readable. Unaccepted historical proposals do not overlay the current paper or apply automatically when a review completes. The UI displays current text and retains links to earlier proposal sources and review history.

`paper.read` returns current documents, citations and retained historical proposals; kind selects a document and history returns its revisions. `paper.cite` maintains the bibliographic ledger independently; citation changes do not rewrite Literature prose. Neither paper reads nor publication records claim that all project evidence has been incorporated.

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
