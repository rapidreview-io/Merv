# Ledgerline Flash Lab — real research pilot

Status: **research cycle complete**, with the final reflection approved and reviewed Methods/Results applied to the living paper. Completed 2026-09-18 at 05:48 UTC.

The new local Merv project, **Ledgerline Flash Lab — prompting before fine-tuning**,
used **25 actual DeepSeek V4.1 Flash Codex CLI sessions**, including interrupted
sessions and revisions, for data preparation, planning,
execution, independent review and project reflection. The extraction experiment
also uses real `deepseek-flash` API responses. This is public-data research inspired
by scenario 1; it does not reuse the existing Ledgerline project's data or results.

Merv application source has not been changed. All additions for this pilot live in
this `dev_docs/flash-research-2026-09-18/` directory. Unrelated workspace changes are
left as found. No GPU was provisioned and no fine-tuning was performed.

## What the experiment measured

Agents acquired 973 public receipt rows from the
[SROIE mirror](https://huggingface.co/datasets/darentang/sroie), documented exclusions,
and froze 12 demonstration, 24 development and 80 holdout receipts. Normalized company
groups and duplicate OCR texts do not overlap across splits. Gold fields come from
the mirror's BIO tags; these are not canonical SROIE benchmark targets.

The plan compared a plain instruction, explicit field rules, and worked examples.
The worked-example prompt won on development and was frozen before holdout calls.
There were **237 real API calls: 232 scored calls and 5 smoke calls**, with no retries
or failed HTTP responses. Every provider request and full response is retained.

| Holdout metric | Plain instruction | Selected worked examples |
| --- | ---: | ---: |
| Correct fields | 264 / 320 (82.50%) | 279 / 320 (87.19%) |
| Entire receipt correct | 35 / 80 (43.75%) | 44 / 80 (55.00%) |
| Invalid output | 0 / 80 | 0 / 80 |
| Mean total tokens | 486.16 | 1,343.24 |

The gain is **4.69 percentage points**. A paired receipt bootstrap gives a 95%
interval of **+0.94 to +8.44 points**. Accounting for company groups gives **−0.34
to +8.97 points**, which includes no improvement. This pilot therefore does not
confirm the motivating claim of a gain of at least three points.

Most of the gain is in company names (56.25% → 78.75%). Date accuracy is unchanged;
address and total accuracy fall slightly. The selected prompt uses **2.76× the
tokens**; that ratio is not a measured billing-cost ratio because caching affects
pricing. The study cannot determine whether prompting beats fine-tuning.

## Verification and limitations

Independent Flash reviewers checked the data/splits/evaluator and reconstructed
the approved prompt strings. The first attempt reviewer reproduced all scored
metrics and both intervals, then returned the submission for corrections to its
evidence references and failure-accounting prose. The operator independently
matched every scored response to the gateway and recomputed the same metrics and
intervals without importing the producer's evaluator; see
[the audit](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/independent-audit.json).

The error classifier's `model_miss` label only establishes that the target string
is present in OCR. It cannot rule out incorrect BIO field assignments. The attempt
reviews missed an overstatement on this point, which the operator flagged
separately; the five-perspective reflection subsequently investigated it and
withdrew the overstatement in the approved paper. Absolute accuracy is specific to
this reconstructed-label task. The
80 holdout receipts span only 44 uneven company groups; one group contains 15
receipts. Corporate families can recur under different normalized names, so
string-disjoint groups do not establish unseen-family generalization.
Prompt content and length are confounded, only one model/sample per cell
was tested, and this public benchmark does not establish private-invoice performance.

## What this says about Merv and Flash agents

This run is assisted end-to-end research, not evidence of unattended reliability.
The Flash agents produced real code and measurements, and independent review
returned real defects. Operator help was needed for evidence transfer, preservation
of full gateway responses, and review launch after a context-size failure.

Three application issues were observed without patching Merv:

1. Scoped calls reject artifact uploads below the advertised 2 MB limit because
   the complete encoded input has a smaller limit.
2. Large retained evidence packages enter review but prevent automatic assignment
   construction with `context_too_large`. Separate Flash sessions used Merv's normal
   interactive review API to inspect the same immutable submission incrementally.
3. Supplying an already-attached result as the paper proposal duplicates its ID
   in the review manifest and rejects submission. The agent used a second artifact
   ID for the same proposal bytes to recover.

See [operational observations](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/observations.md) for evidence, interventions and
source locations. None of these workarounds changed a verdict, skipped review or
edited Merv's application code.

## Workflow outcomes

| Stage | Recorded outcome |
| --- | --- |
| Public data and evaluator | Complete; independent task review passed |
| Experiment design | Independent design review passed |
| Experiment execution | 237 retained API calls, including 232 scored calls |
| Experiment review | Returned for corrections, then passed |
| Reflection perspectives | Five completed reports from five distinct authors |
| Reflection review | Three returns for corrections, then passed on the fourth submission |
| Living paper and research cycle | Methods and Results revision 2 applied through the passing review; cycle complete |

The first controller run reached reflection review and stopped at its time limit.
After the user asked to continue, the final review resumed from persisted state.
No extraction calls, data preparation or lens reports were repeated for that resume.
The session ledger counts actual CLI sessions across resumes and manual review
launches; it is more complete than any one controller invocation's launch count.
The final approval landed at the controller time boundary; a brief final resume
closed the cycle and exported the paper without starting another model session.

Eight review verdicts are retained: four passes and four requests for changes.
No verdict was prescribed or overridden. This is a completed empirical prompting
pilot; no literature-review stage or fine-tuning comparison was performed.

## Read the results

- [Reviewed paper](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/paper.md)
- [Approved reflection synthesis](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/reflection-synthesis.md)
- [Complete review history](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/review-history.json)
- [Session ledger](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/session-ledger.json)
- [Hash-verified artifact index](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/artifact-index.json)

The scientific next step is to clarify label conventions and compare field rules
with worked examples under stronger controls and a better merchant split. Those
are follow-up proposals, not additional experiments already run.

## Saved project and evidence

- Project: `project_245947d7687247819a19330e3c09e916`
- Research cycle: `wf_fde9a71152ca42b182d96e202c33b766`
- Data task: `wf_c948778f526349d798d656d07b98ed33`
- Experiment: `wf_81745bc7a920474dab27a0423ecdd8b0`
- [Study brief](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/brief.md), [reproduction instructions](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/README.md),
  [independent audit](/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/dev_docs/flash-research-2026-09-18/independent-audit.json).
- Private Merv state, immutable blobs and transcripts are retained under `run/`.
  That directory is Git-ignored and includes the local server credential.

Local project feed updates used the installed
[Merv feed-posting skill](/Users/guraltoo/.codex/plugins/cache/rapidreview/merv/0.1.5/skills/feed-posting/SKILL.md).
