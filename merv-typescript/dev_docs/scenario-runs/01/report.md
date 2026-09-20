# Scenario run — Ledgerline

- Result: **DIVERGED**
- Brief: `/Users/guraltoo/Documents/dev/proj/experiments/Merv/Scenarios/briefs/01-finetune-or-keep-prompting.md` (sha256 `83a6787f6659d0a9…`)
- Project: `project_5381baa42a2d4840a1481c7f87d6f6e2`, cycle `wf_91a9b00c2dbb40ea934a684d8b7fd026`
- Server: https://experiments.rapidreview.io
- Ran 2026-09-18T10:14:18.131Z → 2026-09-18T10:14:26.880Z (9 s)
- Codex executions: 311 (311 runner-dispatched, 0 harness-leased)

## Divergence

**trajectory** on `eval-harness`: expected `in_review`, observed `done`.

eval-harness reached done at step 2 where the brief expects in_review: in_progress -> done

## Claims

- C1 → `claim_5a3c76c704ba40b88d902d4d7a0ea827`
- C2 → `claim_3ca7f1a63342498ab9f813444b025727`
- C3 → `claim_1cd40e2292e24660a83976e230d28e99`

## task `eval-harness` — `wf_9e0a8c88439c4a0da7e156ba27e2cedc`

Expected: in_progress → in_review → done
Observed: in_progress → done

| state | entered | held |
| --- | --- | --- |
| in_progress | 2026-09-18T10:14:18.725Z | 4 s |
| done | 2026-09-18T10:14:22.711Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`

> The split, scorer and README satisfy their criteria under the documented slice limitations. Independent reconstruction and scorer checks passed. The required current prompt baseline, retained raw responses and measured results are missing, so the overall goal is incomplete and the harness must remain unfrozen.

- criterion 1: `met` — Verified the committed build_splits.py and manifest, then audited actual split bytes. SHA-256 matches: heldout ba8caba3c2dfdd70f1e77a4441e6089877770d6c42b375291925c0b041b60062; train ac7f2840e3bdb84eb47316524963aed41f0102f9cee6ff454e27e2fb2e201b1a. Recomputed 258 heldout receipts/71 vendors and 693 training receipts/245 vendors, with zero normalized-company overlap and no retained duplicate vendor
- criterion 2: `met` — Inspected score.py/common.py and verified their SHA-256 against results provenance. Executed committed scoring functions entirely in memory, passed all six committed unit tests plus independent mixed TP/FP/FN, Unicode normalization, invalid-input and slice checks. Recomputed the submitted empty-predictions diagnostic exactly excluding provenance, and perfect predictions yielded F1=1. Overall/per-f
- criterion 3: `not_met` — Inspected the complete committed file tree: baseline contains only status.json; no baseline predictions or raw responses are present. status.json explicitly records unavailable prompt/configuration/raw outputs and null baseline F1. The only submitted results.json has zero prediction documents and 258 missing documents, and its prediction hash is SHA-256 of empty input; I reproduced that diagnostic
- criterion 4: `met` — Read the compact committed harness/README.md and verified its hash matches the separately pinned README. It supplies a single Python 3.9+ scoring command, predictions JSONL schema, heldout-ID requirements, strict metric and error rules, slice limits and freeze policy. Inspected CLI implementation: its gold/manifest paths resolve relative to score.py, matching the documented ability to invoke it fr

**Round 2** (revision 3) — verdict `pass`

> Verified all four criteria from the pinned Git bundle: 258 vendor-disjoint heldout receipts, reproducible split and scorer, retained three-shot baseline responses and measured F1 0.64438, and a working one-command README. Accept the explicitly declared substitute baseline; freeze the evaluation contract with its documented slice limitations.

- criterion 1: `met` — Inspected committed build_splits.py, common.py and splits/manifest.json. Independently reconstructed vendor normalization, digit-masked ordered-OCR template hashes, smallest-ID deduplication and seeded whole-vendor assignment from all 1,946 retained source OCR/entity files. Verified 973 sources, two invalid-gold exclusions, 20 duplicates, 693 train receipts/245 vendors and 258 heldout receipts/71 
- criterion 2: `met` — Inspected and executed the scorer; all six committed tests and additional perfect/empty/full-corpus and mixed-outcome diagnostics passed. Independently recomputed every overall, per-field and per-slice TP/FP/FN, precision, recall and F1 and all member/nonmember/unknown counts; all equal submitted results. Overall TP=665, FP=367, FN=367, F1=0.6443798449612403. Tax proxy: 255 members, F1=0.644117647
- criterion 3: `met` — Accept sroie-qwen2.5-7b-3shot-v1 as the expressly declared current substitute baseline under the reproducible-run correction; no recovery/equivalence to the unavailable historical hosted baseline is claimed. Independently verified the deterministic three-example selection from distinct training-only vendors, zero heldout-vendor overlap, exact OCR-only inputs, all 258 request messages and rendered 
- criterion 4: `met` — Read the concise harness README and verified its committed bytes against SHA-256 4e714bdcf709c6aa004963049cbd3091f9d346119b95c9e997847153d906343f. It documents Python 3.9+ standard-library-only one-command scoring, predictions JSONL schema, missing/invalid-input rules, normalization and micro-F1, slice limits, provenance and freeze policy. Executed the same score.py main/argument path with absolut

## experiment `lora-vs-prompt` — `wf_3316f7fc5b694da7ad2cfa26de3fc9f9`

Expected: planned → design_review → planned → design_review → running → experiment_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T10:14:18.808Z | 4 s |
| complete | 2026-09-18T10:14:22.809Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The pinned design cannot establish the required improvement over the harness baseline: it substitutes historical 91.0 F1, leaves the model and harness inputs unresolved, and gives no learning-rate justification. Revise the design with verified, pinned inputs before execution.

- criterion 1: `not_met` — Objective defines a testable C1 and Evaluation measures mean overall harness F1 across seeds 17 and 29, but its operative B=91.0 is explicitly historical and not read from results.json. Therefore an observed M satisfying this rule cannot establish the required >=2.0 improvement over the re-scored control; the plan itself concedes that C1 remains unresolved. Replace B with the exact approved delive
- criterion 2: `not_met` — The proposed matched checkpoint/prompt settings, training-only demonstrations, held-out isolation, frozen scorer and vendor-overlap invalidation are appropriate controls in principle. They are not established for this exact submission: the approved split/scorer/results, company-disjoint audit, three slice definitions and baseline control configuration remain unverified and unpinned. The historical
- criterion 3: `not_met` — The plan honestly limits conclusions to SROIE, bounds spending, declares QLoRA before review, requires stopping without affordable hardware, and retains failures and seed-level evidence. However it omits the required staging model repository and immutable revision, leaves tokenizer/context limits and software versions unresolved, and cannot yet establish that module targets, sequence lengths and w

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `planned`

> The plan improves learning-rate justification and evaluation discipline, but cannot yet answer the pinned research question: the exact harness baseline, matched model and frozen inputs are missing, and feasibility remains conditional. Revise with readable, pinned harness evidence before execution.

- criterion 1: `not_met` — The hypothesis is testable in principle. The plan fixes a primary learning rate before held-out scoring, measures mean overall harness F1 over seeds 17 and 29, and correctly distinguishes point-threshold decisions from significance. However, Evaluation explicitly supplies no exact baseline B or source artifact/hash, contrary to the required numerical preregistration. The symbolic inequalities woul
- criterion 2: `not_met` — The two-value learning-rate sweep with two seeds per rate resolves the learning-rate requirement; the remaining fixed optimization choices have stated experimental rationales and need not be proven optimal. Matched prompts/checkpoints, training-only demonstrations, final-only evaluation, unchanged scoring and overlap invalidation are appropriate intended controls. Yet this submission contains neit
- criterion 3: `not_met` — The plan addresses scope limits, failed-run retention, spending caps, no-GPU stopping, and a predeclared QLoRA fallback with a concrete training-only validation rule. It appropriately states that the fallback comparison includes quantization and cannot isolate pure bf16 adapter effects. Its workload formula is coherent, but feasibility remains conditional: the required staging repository and immut

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `planned`

> The pinned plan has sound evaluation safeguards but is not execution-ready: the exact baseline, model and frozen harness inputs are missing, and resource feasibility is ungrounded. Supply readable pinned evidence and revise the design before execution.

- criterion 1: `not_met` — Objective and Evaluation define a testable hypothesis in principle, a fixed primary configuration and mean overall harness F1 over seeds 17 and 29. The plan appropriately distinguishes a point-estimate threshold decision from significance and reports both threshold truth values rather than treating the mandated residual label as proof. However, Evaluation explicitly leaves B, its immutable source 
- criterion 2: `not_met` — The two-rate sweep satisfies the learning-rate requirement; fixed optimization and adapter settings have reasonable stated rationales and need not be proven optimal. Proposed unchanged prompts, demonstrations, decoding and scoring, training-only data use and overlap invalidation are appropriate safeguards. Their actual applicability is unverified: the submission lacks the approved harness evidence
- criterion 3: `not_met` — The plan addresses scope limits, two-seed completion, failure retention, budget exhaustion, no-GPU stopping and a predeclared QLoRA fallback, correctly acknowledging that quantization changes the intervention. Total-device memory validation and the exact fallback hourly budget bound are sensible. Yet the staging checkpoint is unnamed, target modules and environment compatibility remain provisional

**Round 4** (revision 7) — verdict `needs_changes`, returnTo `planned`

> The hypothesis and decision rule are testable, but the pinned design cannot yet establish a defensible comparison or feasible execution. Verify and pin the harness baseline and controls, name the exact model, and ground the resource estimates before approval.

- criterion 1: `met` — Objective and Evaluation define a falsifiable, corpus-limited hypothesis and a decidable point-estimate rule from mean overall harness F1 over seeds 17 and 29. The primary rate and final checkpoint are fixed, sensitivity results cannot replace the primary result, and all aggregate tables use identical seed sets within configuration. At the stated B=64.438, support requires M>=94.0, weakening requi
- criterion 2: `not_met` — The proposed safeguards are sensible: training-only targets and demonstrations, deterministic replacement excluding the target, unchanged inference/scoring controls, full held-out coverage, no held-out selection, and explicit overlap/scorer/seed invalidation. The two-rate sweep satisfies the learning-rate contract, and fixed adapter/optimizer settings have reasonable stated experimental rationales
- criterion 3: `not_met` — The plan honestly addresses scope, failure retention, two-seed completion, budget exhaustion, no-GPU stopping and a predeclared QLoRA fallback, including the fallback's quantization confound. Its workload arithmetic and conditional budget ceilings are sound. Feasibility is nevertheless expressly unresolved: the unnamed model prevents architecture/module and environment checks; the 2048-token limit

**Round 5** (revision 9) — verdict `needs_changes`, returnTo `planned`

> The hypothesis and decision rule are testable, but the pinned design leaves the baseline, model and controls unverified and execution feasibility unresolved. Pin readable harness evidence, specify the exact model and inputs, and ground resource estimates before approval.

- criterion 1: `met` — Objective and Evaluation define a falsifiable hypothesis limited to SROIE and a decidable point-estimate rule using mean overall harness F1 over seeds 17 and 29. The primary learning rate and final checkpoint are fixed before evaluation; sensitivity results cannot replace the primary result. Overall, per-field and per-slice aggregates use the same seeds within each configuration. At the stated bas
- criterion 2: `not_met` — The planned controls are sensible: training-only targets and demonstrations, deterministic replacement that excludes the target, frozen inference and scoring, all held-out IDs, no held-out selection and explicit leakage invalidation. The two-rate sweep meets the learning-rate requirement; adapter and optimizer settings have stated capacity, stability and bounded-search rationales without requiring
- criterion 3: `not_met` — The plan addresses failure retention, budget exhaustion, no-GPU stopping and the predeclared QLoRA fallback, and correctly limits fallback attribution because quantization may differ from the baseline. Its workload identities and conditional hourly caps are sound. Feasibility remains unresolved in the pinned submission: actual N, training lengths including three demonstrations, inference limits, m

**Round 6** (revision 11) — verdict `needs_changes`, returnTo `planned`

> The hypothesis and decision rule are testable, but the pinned plan lacks verified harness evidence, the exact model and matched inputs, and grounded resource estimates. Resolve those design inputs and pin readable evidence for independent review before execution.

- criterion 1: `met` — Objective and Evaluation define a falsifiable corpus-limited hypothesis and a decidable point-estimate test using mean overall harness F1 over seeds 17 and 29. The primary rate is fixed at 1e-4 and the final checkpoint is predetermined; the 2e-4 sensitivity results cannot replace the primary conclusion. Overall, per-field and per-slice tables use identical seeds within each configuration. At the s
- criterion 2: `not_met` — The proposed controls are scientifically sensible: training-only targets and demonstrations, deterministic exclusion of a training target from its own demonstrations, unchanged inference/parser/scorer, all held-out IDs, no held-out configuration selection, and explicit overlap/scorer/seed invalidation. The two-rate sweep satisfies the learning-rate contract; adapter and optimization settings have 
- criterion 3: `not_met` — The plan addresses failure retention, insufficient seeds, budget exhaustion, no-GPU stopping and a predeclared QLoRA fallback; it correctly restricts fallback attribution because quantization can differ from the baseline. Workload formulas and conditional budget ceilings are sound, and the revised microstep estimate includes amortized optimizer overhead. Nevertheless, actual training counts and le

**Round 7** (revision 13) — verdict `needs_changes`, returnTo `planned`

> The hypothesis and decision logic are testable, but the pinned design lacks the exact model, verified harness baseline and matched inputs, and grounded resource estimates. Make the harness evidence readable and pinned, then resolve those design inputs before execution.

- criterion 1: `met` — Objective and Evaluation define a falsifiable SROIE-limited hypothesis and a decidable point-estimate comparison using mean overall harness F1 over seeds 17 and 29. The primary learning rate is fixed at 1e-4, sensitivity at 2e-4 cannot replace it, and final checkpoints prevent held-out selection. All aggregate tables use the same seeds within each configuration. At the stated baseline, support req
- criterion 2: `not_met` — The proposed controls address training-only targets and demonstrations, deterministic exclusion of the target from its own demonstrations, held-out isolation, unchanged parser/scorer/decoding, and complete evaluation IDs. The two-rate sweep satisfies the learning-rate contract, and adapter/optimizer settings have bounded-search, capacity and stability rationales. However, the plan explicitly omits
- criterion 3: `not_met` — Failure retention, budget exhaustion, insufficient seeds, no-GPU stopping, and a predeclared QLoRA fallback are addressed; fallback attribution correctly includes quantization effects and prohibits pooling branches. Workload formulas and conditional budget ceilings are internally sound. Nevertheless, actual N, training lengths including three demonstrations, output limits, target-module compatibil

**Round 8** (revision 15) — verdict `needs_changes`, returnTo `planned`

> The hypothesis and decision rules are testable, but the pinned plan omits the exact model, verified harness baseline and comparison inputs, and grounded resource estimates. Expose and pin the harness evidence, resolve those inputs, and revise the design before execution.

- criterion 1: `met` — Objective and Evaluation define a falsifiable SROIE-limited hypothesis using mean overall harness F1 over seeds 17 and 29. The primary learning rate is fixed at 1e-4; the 2e-4 sensitivity configuration cannot replace it after evaluation. Final checkpoints and consistent seed sets across overall, field and slice tables prevent selective reporting. Given the stated baseline, support requires M>=94.0
- criterion 2: `not_met` — The proposed controls are sensible: training-only targets and demonstrations, deterministic exclusion of a target from its own demonstrations, final-only held-out access, unchanged prompt/parser/scorer/decoding, and scoring all frozen IDs. The two-rate sweep satisfies the learning-rate requirement; other adapter and optimizer settings have capacity, stability and limited-search rationales. However
- criterion 3: `not_met` — The plan addresses failed-run retention, no-GPU stopping, budget exhaustion and insufficient seeds. It predeclares QLoRA, chooses one branch before all four main runs, prohibits pooling branches, and acknowledges that fallback attribution includes quantization effects. Workload formulas and conditional price ceilings are internally coherent. Nevertheless, actual training count, sequence lengths in

**Round 9** (revision 17) — verdict `pass`

> The pinned design can test the bounded SROIE comparison. Its exact baseline and controls match the retained harness evidence, and its fixed configurations, seed aggregation and decision rules are defensible. Execution remains subject to the plan's mandatory resource and compatibility gates; this approval establishes neither a training result nor production value.

- criterion 1: `met` — The Objective and Evaluation specify a falsifiable, corpus-limited comparison of the fixed primary 1e-4 configuration against the verified fixed prompt baseline. Seeds 17 and 29, final checkpoints, overall harness F1 and identical seed sets for every field/slice aggregate make the decision observable without post-hoc model selection. The 2e-4 sensitivity configuration cannot replace the primary re
- criterion 2: `met` — Directly read results.json confirms the exact quoted baseline 0.6443798449612403 and all slice figures. Configuration and metadata confirm Qwen/Qwen2.5-7B-Instruct at a09a35458c702b33eeacc393d103063234e8bc28, bf16, deterministic decoding, batch 8, 384 generated tokens and the three stated training demonstrations. The frozen split/scorer/common hashes match delivered provenance; the retained approv
- criterion 3: `met` — The proposed small-corpus four-run protocol is sufficiently specified and plausibly feasible as a staged, abortable experiment. The actual 693-example workload, pinned model and reference environment, explicit 8192-token ceiling, microbatch 1, accumulation, checkpointing and retained baseline inference timing replace the predecessor's unspecified inputs. Resource arithmetic is correct. The plan do

**Round 10** (revision 19) — verdict `pass`

> All four approved bf16 LoRA runs completed. The primary mean F1 is 85.61 against a baseline of 64.44 (+21.17). That clears the 2-point bar but not the 94.0 bar, so the pre-registered label is comparative half holds, threshold half fails, and C1 is not supported. I recomputed every aggregate from the per-run files and they match.

- criterion 1: `met` — The configuration in every run JSON matches the plan exactly: - bf16 Qwen2.5-7B-Instruct at revision a09a3545 - rank 16, alpha 32, dropout 0.05 on 7 projections (196 modules) - 3 epochs, microbatch 1, accumulation 16, 132 updates - AdamW with weight decay 0.01, clipping 1.0 and 7 warmup updates, then constant - no packing, 8192 ceiling, final checkpoint only - rates 1e-4 and 2e-4 with seeds 17 and
- criterion 2: `met` — I recomputed every value from the run files. Overall means: - 1e-4: 85.61047, which is 21.17248 above the baseline. - 2e-4: 83.23643, which is 18.79845 above the baseline. Per-field means: - 1e-4: 90.12 / 98.26 / 60.66 / 93.41 - 2e-4: 90.50 / 98.64 / 50.00 / 93.80 Per-slice means: - 1e-4: 85.64 and 86.63 - 2e-4: 83.19 and 85.88 These all match the report's tables and are aggregated over the same t
- criterion 3: `met` — The decision follows the pre-registered rule. M = 85.61 lies in [66.438, 94.0), so the outcome is comparative half holds, threshold half fails, and C1 is not supported. The negative result is stated plainly. The sensitivity rate is classified separately. The limitation claims check out: - The 2.37-point gap between rates is smaller than the primary rate's 6.69 seed range. - The address seed gap (5
- criterion 4: `met` — The Methods edit accurately describes the following, all consistent with the plan, the preflight record and the run configurations: - corpus, split and vendor counts - baseline controls - LoRA configuration and schedule - maximum sequence length of 2723 - rates and seeds - the locked-adapter evaluation order - the decision rule The Results edit quotes only figures I recomputed: seed values, means,

## experiment `data-scaling` — `wf_c5dd0ce5abb7431e8c4ad3c6e502e614`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T10:14:19.220Z | 4 s |
| complete | 2026-09-18T10:14:22.902Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The pinned design cannot answer C2: the declared corpus has only 973 receipts, so none of the required training sizes is possible. The statistical protocol is clear, but the corpus/claim mismatch and unresolved harness and configuration inputs require a revised design before execution.

- criterion 1: `not_met` — Objective & hypothesis and Evaluation define a precise local estimand, paired two-seed means/ranges, and correct support/contradiction/undetermined boundaries. However, the evaluation in this exact submission cannot produce either primary arm from the allowed corpus, so it cannot distinguish the hypothesis from alternatives in practice. A small delta also cannot establish the broader claim that la
- criterion 2: `not_met` — The proposed controls are sound in principle: training-only deterministic nested prefixes, identical seed pairs, independent checkpoint initialization, fixed rank 16, constant learning rate, matched per-example exposure, final-checkpoint evaluation, company/source disjointness checks, unchanged scorer, and no selective retries. Increasing absolute steps is explicitly prescribed and does not change
- criterion 3: `not_met` — The plan candidly addresses fictional data, leakage, incomplete seeds, failed-run retention, budget caps, QLoRA fallback and the prohibition on simulated outcomes. Nevertheless execution is mathematically impossible: the entire 973-receipt corpus is smaller than every required training arm, and reserving evaluation data only worsens the deficit. Completing the harness or renting a GPU cannot repai

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `planned`

> The pinned design cannot answer C2: the 973-receipt corpus cannot supply any required training arm, even before holding out evaluation data. The protocol is clear, but the corpus/claim mismatch, unverified harness inputs and incomplete configuration require correction before execution. C2 remains untested.

- criterion 1: `not_met` — Objective & hypothesis and Evaluation precisely define the local saturation contrast, mandatory six runs, two-seed means/ranges and correct decision boundaries. They appropriately limit small-delta interpretation: optimization failure, model limits or evaluation ceilings could also explain it, and two seeds are descriptive rather than a reliable confidence interval. Nevertheless, this exact evalua
- criterion 2: `not_met` — Controls are defensible in principle: deterministic training-only nested prefixes, fresh adapters from one base, paired seeds, rank 16, fixed batch/epochs/constant learning rate, final-checkpoint scoring, unchanged harness, source/company disjointness checks, and no selective retries. The larger absolute step count is the prescribed consequence of constant per-example exposure, with no schedule-sh
- criterion 3: `not_met` — The plan candidly addresses fictional proprietary data, leakage, invalidation, incomplete seeds, failed-run retention, resource caps and the declared QLoRA fallback; its stop-before-rental gate is appropriate. Execution is still mathematically impossible: only 973 total receipts exist under the declared contract, or at most 715 outside the reported holdout, versus required arms of 1000, 2500 and 5

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `planned`

> The pinned design cannot answer C2: SROIE has only 973 receipts, fewer than every required training arm. The conditional protocol is clear, but the data contract, unverified harness inputs, incomplete configuration and compute feasibility remain unresolved. C2 remains untested.

- criterion 1: `not_met` — Objective & hypothesis and Evaluation clearly define the local F1 saturation contrast, six runs, two-seed means/ranges and correct decision boundaries. The plan correctly recognizes that a small delta cannot distinguish general labeling sufficiency from optimization failure, model limits or evaluation ceilings, and limits inference to one subset draw and split. However, neither primary arm can be 
- criterion 2: `not_met` — The conditional controls are sound in principle: deterministic nested training-only prefixes; paired seeds and fresh adapters; rank 16, fixed effective batch, epochs and constant learning rate; final-checkpoint evaluation; unchanged scorer and holdout; source/company disjointness checks; and no score-driven retries. Increased total steps are the prescribed consequence of constant per-example expos
- criterion 3: `not_met` — The plan honestly discloses fictional proprietary data, identifies leakage and invalidation risks, retains failed runs, declares the QLoRA fallback and appropriately stops before rental. Nevertheless, execution is mathematically impossible with 973 total receipts, at most 715 outside the reported holdout, against required arms of 1000,2500,5200. Ten A100 hours and approximately thirty fallback hou

**Round 4** (revision 7) — verdict `needs_changes`, returnTo `planned`

> The pinned design cannot answer C2: the entire SROIE corpus has fewer receipts than any required training arm. Its conditional controls and decision rules are coherent, but the data contract, harness verification, fixed configuration and compute feasibility remain unresolved. C2 remains untested.

- criterion 1: `not_met` — Objective & hypothesis and Evaluation specify an interpretable local saturation contrast, two-seed means and ranges, correct strict support/contradiction thresholds and inclusive undetermined boundaries. Limitations on broader labeling-bottleneck inference are explicit. Nevertheless, neither primary arm can be formed from the permitted corpus, so the exact design cannot test even the narrow 2500-t
- criterion 2: `not_met` — Conditional controls are reasonable: deterministic nested training prefixes, paired seeds, independent fresh initialization, fixed rank/batch/epochs/constant learning rate, frozen source-disjoint evaluation, final checkpoints and no score-driven retries. Greater total steps follow the registered constant-per-example exposure policy and are disclosed. But required distinct data are unavailable; lea
- criterion 3: `not_met` — The submission honestly identifies fictional proprietary data, sets stop conditions, declares the QLoRA fallback and specifies invalidation and failure retention. These safeguards do not make execution feasible: 973 total receipts, at most 715 outside the reported holdout, cannot supply the 1000/2500/5200 arms. Ten A100 hours and approximately thirty fallback hours remain estimates without substan

**Round 5** (revision 9) — verdict `pass`

> The attempt-5 design can answer a clearly labelled proxy of C2 on SROIE. It uses nested hash-ordered subsets of 128, 336 and 688 receipts at one fixed 2e-4 rank-16 bf16 LoRA configuration, with two seeds per size. The cited baseline, harness and configuration hashes check out, and the arithmetic, controls, decision rule and compute are sound. The literal 2,500→5,200 claim stays untested, and the plan says so.

- criterion 1: `met` — The hypothesis is operationalized as C2-proxy: Δ = M(688) − M(336) < 1.0 point, with M the mean of seeds 17 and 29. The pre-registered alternatives are Δ > 2.0 (contradicted) and 1.0 ≤ Δ ≤ 2.0 (undetermined). Exact boundaries are called undetermined, and a negative Δ is reported as a decrease. 336→688 (2.05×) mirrors 2,500→5,200 (2.08×) on a doubling scale. The plan states the limits on inference:
- criterion 2: `met` — Subsets are deterministic, salted-SHA-256 hash-ordered prefixes of the verified 693-record train.jsonl (ac7f2840…). Nesting is asserted, the subsets are training-only, and membership does not depend on seed or labels. Held-out data is untouched until all six adapters are hash-locked. Every configuration element is inherited verbatim from the executed lora-vs-prompt 2e-4 run, and I verified it by r
- criterion 3: `met` — The compute estimate comes from measured throughput: 1,984.63 s per 2,079 sequences, 0.955 s per sequence, so 6,912 sequences take about 1.83 h. Inference adds about 0.42 h, and the reservation is about 3.8 h, within one 6-hour lease and far below the $40 and $100 caps given about $3.75 already spent. Memory fit comes from the same model, rank and maximum sequence length. The run JSON shows a 30,9

**Round 6** (revision 11) — verdict `pass`

> All six planned runs completed under the approved plan, and their retained files agree with the metrics exhibit. Recomputing from TP counts gives Δ = M(688) − M(336) = −55/2064 = −2.6647 points, so under the pre-registered rule C2-proxy is supported, as a decrease. The report correctly says the decrease is not robust, and that the literal 2,500→5,200 claim was not tested. The paper edits are accurate.

- criterion 1: `met` — All six planned runs (N 128/336/688 × seeds 17/29) are retained as JSON under 16 KB with status completed. They follow the approved configuration: bf16 LoRA of Qwen2.5-7B-Instruct @ a09a3545, lr 2e-4, rank 16, alpha 32, the same optimizer, and 3 epochs. Frozen input hashes match the plan (train ac7f2840, heldout ba8caba3, scorer 8c278eb4, parser c6bfabaf, infer 9c39d158). U = 3N/16 and W = round_h
- criterion 2: `met` — The exhibit lists exactly the six result artifacts, with the same hashes, subset hashes and overall_f1 values, and its verdict block says resultFiles: 6. I recomputed from TP/1032: F = 84.6899/86.6279, 87.0155/86.6279 and 82.0736/86.2403. The means are 85.6589, 86.8217 and 84.1570, and Δ = −1375/516 = −2.6647. The paired differences (−4.9419, −0.3876), seed ranges, gains over baseline, gain fracti
- criterion 3: `met` — Δ < 1.0 and is not on a boundary, so 'C2-proxy supported, reported as a decrease' applies the pre-registered rule correctly. The Conclusion states that Ledgerline is fictional, that everything was measured on SROIE, and that the literal 2,500→5,200 claim was not tested. It says the size of the decrease is unreliable because the seed range exceeds |Δ|. It lists the alternative explanations the plan
- criterion 4: `met` — The paper edits add new sections, data-scaling-methods and data-scaling-results, at expectedRevision 1 and leave the lora-vs-prompt sections untouched. The Methods section describes the approved design accurately: proportional nested prefixes by salted SHA-256, subset hashes and vendor counts, the 2e-4 recipe, U = 24/63/129, W = 1/3/6, constant exposure per example, and the Δ rule with its boundar

## experiment `scorer-in-repo` — `wf_9b053baf351c41ba9749e6689906ec89`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T10:14:19.306Z | 4 s |
| complete | 2026-09-18T10:14:23.269Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `pass`

> The plan is sound. Every pinned hash matches the delivery index, the artifact metadata or the verification record. The check calls the unedited delivered score.score() and blocks reads outside the repository with an audit hook. It pre-registers 0.64438 at 5 decimals on 258 receipts, and two negative controls show the guards can fire.

- criterion 1: `met` — H1 is testable. `python harness/check.py` at the evaluated commit must print F1 that rounds to 0.64438, with documents, prediction_documents and missing_prediction_documents equal to 258, 258 and 0. H0 covers any other value, a crash or a wrong count. The negative controls and the key-for-key results.json comparison separate true reproduction from alternatives: a tampered file, altered scorer logi
- criterion 2: `met` — I verified the plan's file hashes against the index provenance, the artifact metadata for config, results and README, and the verification artifact's file list. All match. The baseline F1 of 0.6443798449612403 (tp 665, fp 367, fn 367, 258 documents) matches the index and the confirmations. The control is the delivered result at commit 53488918, built from the same bytes. The metric is the unchange
- criterion 3: `met` — The plan is feasible: standard-library Python, no compute, a documented acquisition path with the 15-part artifact fallback, and a replication already run in scratch space. Failure modes are handled: - existing harness/ means stop, not overwrite; - a hash mismatch between the artifact and the bundle copy stops the attempt; - the bundle is never committed; - bytecode writes are suppressed. The limi

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `running`

> The experiment itself is sound: the repository harness reproduces baseline F1 0.64438 on 258/258 receipts via the unchanged score.score(), and the deviations are disclosed and harmless. It cannot pass yet because the paper proposal targets Methods revision 1, and that document has since changed. Please resubmit the same Methods section against the current revision; no other change is needed.

- criterion 1: `met` — The checkout at C follows the plan's files, check.py behaviour and commits. Three deviations are disclosed with reasons: the pre-existing byte-identical harness/ files were left untouched, the extra commit B2 fixes a pycache false positive, and local commits replace code.commit. None touches the scorer, split or predictions. I verified by inspection and hash cross-reference, not by execution.
- criterion 2: `met` — results.json, the exhibit and the report agree: F1 0.6443798449612403, 258/258/0, tp 665, fp 367, fn 367, exit 0, reproduces true. The arithmetic confirms the F1. Hashes match the plan, the index and the artifact metadata, and row counts match the manifest. Rework (the B2 commit and three rejected report submissions) is disclosed.
- criterion 3: `met` — The one-sentence Conclusion follows from the pre-registered rule. The negative controls show the guards fire, and the limits (transplant fidelity only; the split cannot be rebuilt from the repo) are stated.
- criterion 4: `not_met` — The content is accurate and supported. However, the proposal targets Methods expectedRevision 1, and the server rejected applying it (paper_revision_conflict) because the document has since changed. Resubmit the same section as a new proposal against the current Methods revision.

**Round 3** (revision 5) — verdict `pass`

> The repository harness reproduces the accepted baseline: harness/check.py recomputes overall F1 0.6443798449612403 (0.64438) on 258/258 held-out receipts using the unchanged score.score(). The deviations are disclosed and harmless. The only defect last round was a stale paper revision, and it is now fixed: the identical Methods section targets the current Methods revision 2.

- criterion 1: `met` — The checkout at C matches the plan's files, check.py behaviour and commit sequence. Deviations are disclosed and harmless: pre-existing byte-identical harness/ files were left untouched; extra commit B2 makes a narrow pycache .pyc allowance; local commits were used instead of code.commit; extra controls and checks were added; and this round re-ran only negative control (a). None touches the scorer
- criterion 2: `met` — results.json (in the repo and as the artifact), the exhibit and report v5 agree: F1 0.6443798449612403, 258/258/0, tp 665, fp 367, fn 367, exit 0, reproduces true. 1330/2064 confirms the F1. The rework (B2, the rejected report versions and the stale paper proposal) is disclosed.
- criterion 3: `met` — The one-sentence Conclusion follows from the pre-registered rule, and no invalidation condition holds. The limits are stated: the experiment shows transplant fidelity only, and the repository cannot rebuild the split or rerun inference.
- criterion 4: `met` — The proposal targets Methods expectedRevision 2, which is current. Its new section eval-harness-in-repository accurately states the hashes, row counts, bundle and commit, what check.py guards, and the printed F1, all matching SOURCES.json, check.py and results.json. No Results change is proposed, which is appropriate.

## Limits

Trajectories and verdicts are asserted after the fact; no verdict text reaches any worker.

A stage carrying a planted defect is launched by this harness, not the runner: the runner builds its child stdin from the frozen assignment and has no per-assignment prompt hook.

The production feed has no voices: each brief post is written by the source credential with its named role as a body prefix.

Reflection, consolidation and post-wave claim updates are outside this harness slice.

| The scenario says | On this server | Stand-in |
| --- | --- | --- |
| Ledgerline, and 5,200 proprietary labeled invoices | Neither exists | A named public receipt/invoice corpus, declared in the Introduction, split source-disjointly. **A synthetic invoice generator is not acceptable**: a LoRA learns the generator's grammar and the F1 measures the generator, not extraction. If no corpus is chosen, the project is fiction and should not be run. |
| Thresholds 94.0 F1 and +2.0 | Derived against data that does not exist | Re-derive both against the substitute corpus's own re-scored baseline after `eval-harness` completes, or declare in the Introduction that they are inherited and uncalibrated. |
| The "91.2 → 90.9" re-scoring story | Depends on a prior contaminated number that will not exist here | The planted defect in §4 recreates the *mechanism* (a plan quoting a pre-harness number) without needing the original: the round-1 plan author is told to quote the team's older Slack figure. |
| `sandbox.options`, `sandbox.request`, `sandbox.run`, `sandbox.pull_outputs` | Do not exist. Merv exposes only `sandbox.extend` and `sandbox.release`, and the sandboxes plugin is not composed in production at all | Compute is driven **beside** Merv, against the sandboxes service's own MCP or the operator's machines. Merv holds the evidence, not the machines. |
| An A100 80 GB | No 80 GB card has ever been rented live by the sandboxes service; the only validated GPU is a Lambda A10 24 GB | 4-bit QLoRA on the A10, roughly 3× slower, declared in the plan *before* design review. If no GPU is available at all: do not run, do not simulate. |
| Feed threads, `chart` / `stat` blocks, a `status` thread | None exist. A post is body + ≤10 artifact ids, ≤8,000 chars | Role prefix in the body text; charts as attached PNG artifacts; stats as text. §6 is written this way. |
| Reflection lenses `serving-economics` and `label-quality` | The roster is fixed at `evidence`, `theory`, `methods`, `synthesis`, `next_steps`; `reflection.create` takes only `title` and `requestId` | The two questions go into a pre-wave artifact + feed post + the wave title, so every lens agent reads them as live project research. They are not lens records and will not appear as such. |
| "the labeler, who does not read Python, follows the feed" | Real, but thinner than written: no threads, no replies, no reactions | The feed carries the narrative; a human's response has no in-record mechanism (see scenario 3, where this bites harder). |
| The out-of-memory crash at epoch 3 | Real if it happens | **Do not stage it.** `retry_running` exists for genuine infrastructure failure and records a reason. Feed post 4 in §6 is written for the case where it occurs; drop it if it does not. |
| The agent "posts to the feed" as a registered voice | No `feed.register`, no voices | Text convention only. |
| Every scripted `needs_changes` | Must be earned | Defects are planted in the producer's prompt (§3, §4). A scripted verdict would make the review gate theatre. Expect a meaningful fraction of the scripted rejections not to occur; each non-occurrence is a finding about the gate, and unscripted rejections should be budgeted for. |
| Champion/candidate promotion | No such record type (and this scenario does not use it) | n/a |
| Raw model outputs "retained as a storage object" | Merv artifacts cap at 2,000,000 bytes | Bulk in sandboxes storage; Merv holds the manifest, the hashes and the storage ids. |
