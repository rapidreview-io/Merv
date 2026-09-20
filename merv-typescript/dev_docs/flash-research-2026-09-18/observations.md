# Operational observations

These are findings from the real Flash research run, separate from its scientific results.
No Merv application source was changed during this run.

## Evidence transfer requires an adapter

The first producer acquired the real data and wrote a working evaluator, but spent
substantial time arranging base64 bundles for native `artifact.create` calls.
The operator stopped that session, retained its transcript and workspace, added a
local file-transfer MCP adapter around Merv's existing uploader, and resumed with
a fresh Flash session. The resumed session independently checked the retained work.
This operator intervention must be counted when evaluating autonomy.

The adapter invokes the same upstream tools with the same scoped session token.
It does not use the source/operator credential for worker file transfers and does
not waive any workflow/review gate. Reviewer tools only inspect immutable bytes.

## Advertised artifact size differs from the scoped-call limit

`packages/artifacts/src/tools.ts` advertises 2 MB, and the service accepts up to
2,000,000 decoded bytes. However, `packages/workflows/src/execution.ts:271` sends
the complete tool input through the JSON validator, whose canonical JSON limit
is 256,000 characters at line 147. A base64 artifact therefore has an effective
maximum of approximately 192,000 decoded bytes, less its other arguments.

The resumed Flash producer observed this without being told the cause. It probed
different file sizes, found successful smaller uploads and rejected larger ones,
and split its retained raw data accordingly. Examples include success for a
46,190-byte dataset bundle and failure for a 341,115-byte raw-response bundle;
the artifact upload helper surfaced only a generic refusal. Exact calls and
receipts remain in the worker transcript.

This affects legitimate, advertised-size uploads by scoped agents. The independent
review must still confirm the split files reconstruct the source evidence.

## Setup failures retained

The first launch failed before model execution because the wrapper and controller
both specified `--model`. A second launch found that the runner ledger binds its
server address, while the local server had been assigned a new random port.
Removing the duplicate flag and selecting a fixed loopback port corrected these
test-controller problems. They are not scientific failures or successful sessions.

## Automatic attempt review exceeds its context budget

The experiment entered `experiment_review` successfully, but the machine runner
could not construct the review assignment: `context_too_large`. The immutable
submission included both superseded and authoritative evidence partitions, plus a
67 KB generated exhibit. Required sections exceeded the experiment review recipe's
160,000-character budget. A submitted review that cannot be dispatched is an
operational failure, even though the evidence remains available.

The operator paused dispatch for this new local project and launched a distinct
Flash Codex session through Merv's ordinary interactive reviewer API. The reviewer
claimed the same exact review and read its pinned artifacts incrementally, with a
read-only filesystem and a project-bound reviewer credential. It chose its own
verdict and returned the experiment to execution for report/evidence corrections.
The temporary credential was revoked and normal dispatch restored afterward.
No workflow gate, source code, database state, or verdict was overridden.

## Independent review found real documentation defects

The first attempt reviewer reproduced the development and holdout scores, both
bootstrap intervals, token counts, prompt/input hashes, selection timing, and
full gateway records. It returned `needs_changes`: a paper sentence claimed all
237 attempts were in the producer logs, which actually contained 236. The missing
smoke call was present in the operator gateway journal. It also identified stale
bundle/exhibit hashes and inconsistent counts in the report. A fresh producing
Flash session received that feedback through the normal workflow.

## Scientific interpretation requires an additional caveat

The operator independently recomputed all 232 scored calls directly from the
retained provider responses, without importing the producer's evaluator. Results
and intervals match. The audit is in `independent-audit.json` and retained in Merv.
However, the producer's `model_miss` category is based on finding the gold string
in OCR. That test cannot establish whether the string was assigned the correct
semantic BIO field. The first independent attempt reviewer did not flag the
report's claim that annotation artifacts were thereby excluded; the operator
flagged it separately in the project feed. Count this as operator oversight,
not a demonstrated autonomous reviewer success.

## Paper proposal duplication rejects an otherwise valid submission

During rework the producer attached its proposed paper edits as a result artifact
and also supplied that same artifact as `paperChangesArtifactId`. Submission then
failed with `invalid_artifacts: A review requires a nonempty list of distinct
artifacts`. In `packages/experiments/src/index.ts`, the evidence/figure list is
deduplicated before the paper proposal is appended, leaving the proposal duplicate
in the review request. The producer worked around this by creating another artifact
with identical bytes and using its different ID for the proposal. This duplicates
evidence and increases context pressure. The original API and application code
remain unchanged; both failed calls and the workaround are in the rework transcript.

## Reflection provides a distinct scientific check

Five separately authored Flash lens reports were completed and reconciled by a
different Flash synthesis session. The proposed synthesis withdraws the earlier
claim that all residual errors are model failures, examines currency-prefix and
span-boundary conventions, distinguishes normalized company strings from corporate
families, and notes that the pre-registered rule cannot establish a lower bound of
three percentage points. These are substantive qualifications beyond reproducing
the primary numbers. The final independent reflection review remains authoritative
for whether the proposed corrections and added analyses are acceptable.

## The timed-out reflection review resumed from saved state

The controller's 70-minute resumed-run allowance expired at 03:33:46 UTC while the
reflection reviewer was working. All five lens reports and the submitted synthesis
were already retained; no verdict was invented or marked successful. The user then
asked to continue. At 05:07 UTC the same local server and machine ledger restarted
with a fresh 40-minute allowance. Merv launched a new Flash reviewer session for the
unfinished review without repeating data preparation, experiment calls, or lenses.
The unsuccessful controller report is preserved as
`run/report-before-final-review-resume.json`. This is successful recovery behavior,
not evidence that the original time-bounded run completed.

## Reflection review returned a quantitative error for correction

The recovered final reviewer independently reconstructed the bundle, scored the
holdout, reproduced the bootstrap quantities and checked the exact proposed paper
edits against their original text. It returned the synthesis to `synthesizing`
while retaining all five completed lenses. The proposed paper said 15 wrong totals
carried an RM prefix; the raw error rows show 15 total-field errors, of which 13
carry RM. It also found an inconsistent one-sided percentile in a change-spec
evidence note (0.004098 versus the reproducible approximately 0.005747). This is a
real, agent-chosen `needs_changes` verdict, with no measurement rerun or prescribed
outcome. The revision stays within the existing reflection workflow.

## A second reflection review found residual wording and resampling discrepancies

After those corrections, another fresh Flash reviewer returned the revised
reflection to synthesis. The proposed paper retained 0.243 for a post-hoc cluster
bootstrap fraction below three points, while the cited retained calculation and
the reviewer gave 0.2392. It also required narrowing the sentence "no development
or holdout gold reached a prompt": some short amounts/dates occur coincidentally
in demonstration material and also match holdout gold. The relevant provenance
claim is that holdout records were not used to construct the prompts; that should
not be conflated with zero textual overlap.

The operator separately checked threshold arithmetic in `threshold-sensitivity.json`:
the frozen 10,000 sorted-group draws give 2,392 draws below the threshold when
subtracting floating-point accuracies, or 2,386 under exact integer comparison,
with 13 exact ties at three points. The tie behavior alone does not explain 0.243.
A separate comparison using first-appearance group order instead of the frozen
sorted order produces approximately 0.243 and the earlier 0.004098 percentile.
These are calculation-order differences in added analyses; they do not alter the
primary point estimate or reported intervals. A bootstrap fraction is also not a
posterior probability of the true effect. The original experiment's metrics remain
unchanged throughout these reflection corrections.

The third reflection review verified all proposed paper edits but returned one
remaining attribution error in the supporting report. Both calculation conventions
round to the paper's 0.239, but the report called 2,386 the literal frozen-code
count and called 2,392 irreproducible. The reviewer identified the six boundary
draws at floating value 0.029999999999999916, reproducing the operator diagnostic.
It required distinguishing the two calculations instead of denying the earlier
review's result. This extra return concerns provenance precision, not the
experiment's accuracy, interval or substantive conclusion.

## Final outcome

The fourth reflection submission passed independent review
(`review_f405ffcc87be473c98d0b7623be24ecf`). The reviewer reproduced the scored
figures, corrected bootstrap-tail conventions, overlap provenance, currency audit
and proposed paper edits. Merv applied Methods/Results revision 2 through that
review. The controller reached its deadline immediately after observing approval
and before its closing transition; the approved state remained durable. A brief
final resume advanced the research cycle to `complete` and exported the paper at
05:48:03 UTC without launching another model session.

The cumulative ledger contains 25 real Flash CLI sessions, including interrupted
sessions and rework; the inference journal still contains exactly the original
237 extraction calls. Eight review verdicts are retained (four pass, four
needs_changes). Both temporary interactive-review credentials were revoked.
Merv application source and the original live-scenario script have no Git diff
from this work. The unrelated release-document edit was left untouched.

This is an assisted successful pilot. Evidence retention, independent review,
revision routing, paper gating and restart recovery worked. Automatic attempt
review context construction, effective upload limits and duplicate proposal IDs
needed workarounds. Agent-authored reporting also required repeated substantive
corrections, so completion should not be presented as unattended reliability.
