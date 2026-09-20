# Change specification — `public-receipt-prompting-pilot` reflection (attempt 1, revision 4)

Reflection `wf_8a158ccef3a64865af0da3d15643bc6c`, revision 7, project
`project_245947d7687247819a19330e3c09e916`.

This specification states exactly what paper text should change and why. The machine-readable form is the
companion `application/json` artifact, which carries `documents` for `methods` (expectedRevision 1, sections
`design` and `evaluation`) and `results` (expectedRevision 1, sections `primary`, `secondary` and
`interpretation`). Section identifiers are preserved so the edits apply as revisions of the existing sections
rather than as new sections. Every "before" block equals the current paper text at revision 1 verbatim, which
I re-read from `paper.read` while preparing this revision.

This revision supersedes all three earlier change specifications: `art_fb5a5ef5887142fb8ca8394f91322d63`
(returned `needs_changes` by `review_d8a0b1347b984a8abeb4d7f4a9b45934` on criterion 5),
`art_5fb6c8920f0e4d0f804cda58bfd2f94c` (returned `needs_changes` by
`review_95996dc9d5664ef0a08f1714e47222e0` on criteria 1 and 5) and
`art_04e8505153a94f9c884f49a4ef4193d9` (returned `needs_changes` by
`review_826b6307aa87413095ef904b04fbc48a` on criterion 1 only, for the report's tail-count attribution;
criteria 2 to 5 were met there and that review reproduced every proposed edit). Four corrections are carried
here and are noted inline: the currency sentence in **R2** (first rework), the contested cluster
`P(delta < 0.03)` in **M1** and **M2/R1** plus the prompt-contamination sentence in **M1** (second rework),
and the same cluster tail count in **M2/R1** again (this revision), which now states the floating-point
boundary explicitly in the proposed paper text instead of asserting a single figure.

## Scope and status

- **Edits are needed.** The current `methods` and `results` revisions contain one false isolation claim, one
  unsupported residual-error claim, an incomplete uncertainty statement, and several metadata errors.
- **No measurement changes.** No edit below alters a scored number, a per-receipt cell, an interval, an
  accuracy, a token count, the error-audit counts as recorded, or the verdict
  `supported_but_not_cluster_robust`. The edits narrow interpretation, add labelled post-hoc quantities, and
  correct metadata.
- **Provenance of the new numbers.** Everything newly asserted is either (a) recomputed by this synthesis or by
  the returning review from the pinned revision-C bundle and frozen kit, (b) explicitly labelled as post-hoc
  reflection analysis, or (c) explicitly labelled as reported by one lens and not independently verified here.

## Change M1 — `methods` / `design`

**Defect.** The sentence "All arms received byte-identical user messages per receipt [...] and a byte-identical
shared output-format paragraph, so the contrast isolates extraction guidance" is false as written. P0 already
contains the same JSON output-format contract and the same task sentence; P2 adds three gold-labelled exemplars
and 2 083 extra characters. The `results` section already concedes the length confound, so design and results
currently contradict each other.

**Proposed replacement (full section content).**

> Two-stage pre-registered pilot on text-only SROIE receipt OCR. Stage 1 (exploratory) scored three prompts on
> 24 development receipts: P0 a plain JSON extraction instruction, P1 field rules distilled from the 12
> demonstration receipts, P2 three worked examples drawn from those same demonstrations. A fixed rule
> (development overall field accuracy, then whole-receipt exactness, then lower invalid rate, then lower mean
> total tokens, then arm id) selected P2 (0.8438 vs P1 0.8333 vs P0 0.7396) before any holdout call. Stage 2
> (confirmatory) ran P0 and P2 only, on 80 holdout receipts whose normalized company strings are disjoint from
> development. Prompts, template and kit hashes were frozen in an attached checkpoint before the first model
> call, and the selection checkpoint was attached before the first holdout call; both are pinned in the metrics
> exhibit with their submission timestamps.
>
> All arms received byte-identical user messages per receipt (the fixed prefix Receipt OCR text: followed by a
> newline and the flat OCR token order in reading order) and a byte-identical shared output-format paragraph.
> The two confirmatory arms are **not** matched for prompt content or length: P0 is a plain instruction (519
> characters) that already contains the same JSON output-format contract, while P2 is a three-shot
> in-context-learning prompt (2602 characters) that embeds three demonstration OCR texts with their full gold
> JSON. The contrast therefore confounds exemplar content, exemplar count, prompt family and prompt length (P2
> costs 2.76x tokens, 486 -> 1343 mean); it does not isolate extraction guidance. P1 (field rules, 1674
> characters, no labelled exemplars) was written and frozen but never run on the holdout, so the confirmatory
> stage cannot separate rules from worked examples. The company key is a normalized OCR string, so
> company-disjoint is string-disjoint only; corporate families recur across splits (for example MR D.I.Y.
> appears in both development and holdout under different spellings). Candidate material came only from the 12
> demonstration rows, and no prompt was edited after a development score was seen. One caveat is recorded
> rather than omitted: a normalized substring screen finds four development/holdout gold strings inside the
> P2 prompt text (totals `5.90`, `9.90`, `50.00` and date `27/06/18`), each present only as part of a
> demonstration receipt OCR text or of a demonstration gold value (for example `50.00` inside the
> demonstration total `750.00`, and `27/06/18` as the gold date of demonstration receipt `X51007579725`,
> which is also the gold date of one holdout receipt). None was drawn from a development or holdout record,
> and the producer self-check reported two of the four; the stronger statement that no development or
> holdout gold reached a prompt is not literally true and is not retained. Model deepseek-flash via the local broker, temperature 0, thinking disabled,
> max_tokens 768, JSON-object output, one sample per cell, interleaved receipt-major/arm-minor, concurrency <= 4.

**Evidence.** Prompt lengths and hashes recomputed from `prompts_frozen.json` (519 / 1674 / 2602); token means
recomputed from `analysis.json` (486.16 -> 1343.24); selection counts recomputed from the development
predictions (71 / 80 / 81 of 96); corporate-family recurrence documented in the kit README and reproduced by the
methods and next_steps lenses. The design defect (F1 of the theory lens; §1 of the evidence lens) is recorded
as contradiction C1.

The contamination residual is handled here rather than left implicit. `producer_verification.json` lists two development/holdout gold strings in prompt text; the evidence, synthesis and next_steps lenses independently find four; and my own normalized substring scan of `prompts_frozen.json` against the frozen kit dataset (`3abff953…`) under the evaluator normalization finds exactly the same four, all in P2 only and all inside demonstration OCR or demonstration gold. No holdout label was supplied as candidate material and invalidation condition 3 is not triggered; the point is only that the sentence as written is not literally true.

## Change M2 — `methods` / `evaluation`

**Defect.** The section records the pre-registered rule but does not say what the rule does and does not test.
As written, a reader can conclude that "not confirmed" is the only epistemic content. It is not: the design
could not have confirmed the claim at the observed effect, and the interval reading admits sub-threshold effects.

**Proposed change.** Keep the existing paragraph verbatim, then append:

> The pre-registered rule is a conjunction of a point-estimate threshold and two interval checks: it requires
> delta >= 0.03 and both interval lower bounds > 0. It does not bound the effect from below against 3 points,
> so it can pass a point estimate of +4.69 points from data that are also consistent with sub-threshold
> effects. Post-hoc resampling of the same frozen per-receipt cells during reflection (10,000 draws, seed
> 20260918) gives P(delta < 0.03) = 0.186 and a one-sided 95 percent lower bound of +0.0156 at the receipt
> level, and P(delta < 0.03) = 0.239 and +0.0057 under the company-cluster bootstrap, where 2386 of the 10,000
> draws fall below 3 points by exact arithmetic and the literal floating-point comparison counts 2392 because
> 13 draws land exactly on 3.0 points and six of those evaluate to 0.029999999999999916; the receipt-level
> interval admits effects as small as +1 point. A post-hoc delta-method power calculation on the empirical
> 44-cluster distribution puts the power of the pre-registered clustered criterion at approximately 0.50
> against the observed +0.046875, so the not-confirmed verdict carried little information about whether the
> effect exists. These post-hoc figures were not pre-registered and are reported as reflection findings.

**Evidence.** Receipt-level `P(delta < 0.03) = 0.1857` with 5th percentile `0.015625`; cluster-level `P(delta < 0.03) = 0.239` with 5th percentile `0.005747` — i.e. `+0.0156` and `+0.0057` after rounding. **(Corrected in this revision, superseding the account given in submission 3: the cluster count is a boundary convention, not a disagreement about the data. Re-implementing the frozen `code/analyze.py` cluster bootstrap — groups keyed by the evaluator normalization of the gold company, `gkeys = sorted(groups)`, `random.Random(20260918)`, 10,000 draws, index-based percentiles — reproduces the recorded cluster interval `[-0.003424657534246589, 0.08974358974358965]` and the recorded 5th percentile `0.005747` exactly, and over that identical frozen draw sequence the number of draws below 3 points is 2386/10000 = 0.2386 by exact rational arithmetic and 2392/10000 = 0.2392 by the literal floating-point comparison `delta < 0.03`. The two counts differ by exactly the six draws whose delta is mathematically exactly 3.0 points but evaluates to 0.029999999999999916 in IEEE-754 double arithmetic; 13 draws in all land mathematically exactly on the threshold (the other seven evaluating to 0.030000000000000027), so the boundary-inclusive count `P(delta <= 0.03)` is 2399/10000 = 0.2399. Exact arithmetic gives the cleanest single figure, because a draw at exactly 3.0 points satisfies the ">= 3 points" claim, but every central reading rounds to 0.239, the value the proposed paper texts state, and both paper texts now disclose the range as well. The 0.243 of submission 2 is withdrawn and is not reproducible as stated: it requires a first-appearance group enumeration, which gives 2432/10000 = 0.2432 rather than 2431, and whose cluster interval `[-0.003676, 0.090278]` does not reproduce the recorded one. The returning review's 0.2392 and its count of six boundary draws are confirmed, and the submission-3 assertion that 0.2392 was not reproducible at the last digit is retracted here and in the synthesis report.)** The power figure is reported by the next_steps lens and was not independently recomputed here; its inputs (44 clusters, sizes `15, 8, 4, 4, 3, 3, 2 x 5, 1 x 33`, delta `+0.046875`, 16.3 effective clusters) do reproduce.

## Change R1 — `results` / `primary`

**Defect.** The section reports the point estimate and the two intervals but not what the pre-registered rule
fails to test, and it presents the clustered interval as the whole uncertainty statement.

**Proposed replacement (full section content).**

> Selected prompt P2 (worked examples) versus control P0 (plain JSON instruction) on 80 held-out receipts.
> Overall field accuracy: P0 0.8250 (264/320 cells), P2 0.8719 (279/320); paired difference +0.0469, i.e.
> +4.69 percentage points. Receipt-level paired bootstrap 95 percent interval [0.0094, 0.0844], excluding zero.
> Company-cluster bootstrap over 44 groups [-0.0034, 0.0897], including zero; the groups are very unequal
> (largest 15 receipts, sum of squared weights 0.0612, about 16.3 effective clusters), and dropping the largest
> group leaves +0.0346. Code-computed verdict: supported on the paired estimate, not cluster-robust; the
> pre-registered claim of a >= 3 point improvement is therefore not confirmed.
>
> The pre-registered rule tests whether the point estimate reaches 3 points and whether both interval lower
> bounds exceed zero; it does not bound the effect from below against 3 points. Post-hoc reflection resampling
> of the same frozen cells shows the data remain consistent with sub-threshold effects: P(delta < 0.03) is
> 0.186 at the receipt level (one-sided 95 percent lower bound +0.0156) and 0.239 under the company-cluster
> bootstrap (0.2386 by exact arithmetic, 0.2392 by the literal floating-point comparison, whose difference is
> the six draws landing exactly on 3.0 points; one-sided 95 percent lower bound +0.0057). Reading the claim
> wording as whole-receipt exactness
> gives +0.1125 with a receipt-level interval that includes zero. A post-hoc power calculation puts the
> pre-registered clustered criterion at approximately 0.50 power against the observed effect, so the
> not-confirmed verdict carried little information about whether the effect exists. These post-hoc figures were
> not pre-registered and are reported as reflection findings.

**Evidence.** Accuracies, delta, both intervals and the dominant-cluster sensitivity recomputed from the
pinned bytes (and by the returning review); cluster sizes and the sum of squared weights recomputed from
`holdout_per_receipt.json`; whole-receipt +0.1125 = 9/80 recomputed; the post-hoc quantities as in M2.

## Change R2 — `results` / `secondary`

**Defect.** The sentence "every wrong gold string was recoverable verbatim from the input, so no residual error
is attributable to BIO/OCR label artifacts" is unsupported: the audit test cannot fire, and direct inspection
shows a material share of wrong cells are label/currency-convention mismatches. The section also omits the
arm-asymmetric currency convention and the convention sensitivity of the primary metric.

**Correction carried by this revision.** The first submitted version of this replacement said "15 are totals
whose gold carries a printed RM token". That is wrong: 15 of the wrong cells are totals, and 13 of those 15
carry a printed RM token. The replacement below states the two counts separately.

**Proposed replacement (full section content).**

> Whole-receipt exact accuracy rose from 0.4375 (35/80) to 0.5500 (44/80); 19 receipts were fixed by P2, 10 were
> broken, 51 tied. Invalid-output rate was 0.0000 in both arms (difference 0.0 points, so the pre-registered >10
> point inconclusive condition does not apply). Per-field holdout accuracy P0 -> P2: company 0.5625 -> 0.7875,
> date 0.9625 -> 0.9625, address 0.9500 -> 0.9250, total 0.8250 -> 0.8125. The gain is concentrated in the
> merchant-name field while address and total slip slightly, contrary to the planned expectation that address
> would dominate the error budget.
>
> Of 41 wrong selected-arm holdout cells, 39 are model_miss and 2 are near_miss (case, whitespace or punctuation
> only); no cell is classified format. The audit class unsupported_gold is unreachable by construction: gold is
> reconstructed as a contiguous span of the same OCR tokens used as input, so gold is verbatim-in-input for
> 464/464 kit cells and 320/320 holdout cells, and the test cannot detect a wrong or mis-bounded annotation.
> Direct inspection of the same 41 cells shows the residual errors are not all model failures: 15 of the wrong
> cells are totals, 13 of those 15 carry a printed RM token in the gold (for example gold RM11.90 against
> prediction 11.90) and 13 of the 15 agree with the model after removing non-digits; 18 of 39 model_miss cells
> have the model output as a substring of a longer gold span. The earlier claim that no residual error is
> attributable to BIO/OCR label artifacts is therefore withdrawn; what the audit supports is only that no wrong
> cell was scored against gold absent from the input, which is guaranteed by construction.
>
> The gold convention is arm-asymmetric on the total field. On the 15 holdout receipts whose gold total carries
> RM, P2 is wrong 13 times (12 with the correct digits) while P0 is wrong 5 times; on the 65 un-prefixed totals
> P0 is wrong 9 times and P2 twice. The three worked examples show un-prefixed totals, so P2 reproduced the
> demonstrated convention and was penalised for it. Post-hoc sensitivity of the primary metric to the scoring
> convention: +0.0469 as pre-registered, +0.0531 when only totals are compared modulo non-digits, and +0.0375
> under an alphanumeric-only convention for all fields. Direction is robust; magnitude is convention-sensitive
> and the loosest variant approaches the 3-point threshold.
>
> Mean tokens per call: P0 486, P2 1343 (2.76x). A gain also cannot be attributed to examples rather than prompt
> length, because the design has no length-matched control.

**Evidence.** Recomputed or reproduced from the pinned bytes: audit class and field counts; gold-in-input for
464/464 and 320/320 cells; the RM and un-prefixed wrong-cell tables; the substring count 18/39; and the
alphanumeric sensitivity +0.0375. The `total`-cell currency audit (15 totals; 13 with `RM` gold; 13 of 15
agreeing modulo non-digits) was hand-verified against `error_audit.jsonl`
(`art_0d78e149d33a48979585578ffa63b459`) for this revision and independently reproduced by the returning
review. The total-only sensitivity +0.0531 is taken from the evidence lens and is not independently verified
here.

## Change R3 — `results` / `interpretation`

**Defect.** The section attributes the verdict to the clustered interval alone, describes the design as
company-disjoint without qualification, and does not say what the metric actually measures.

**Proposed replacement (full section content).**

> The direction and the point estimate support the motivating claim, but the company-cluster interval spans
> zero, the receipt-level interval admits effects below the claimed threshold, and the post-hoc power of the
> pre-registered criterion is about 0.5. A reviewer should read this as a directional pilot rather than a
> confirmed effect, and should not read the not-confirmed verdict as evidence that the effect is absent. The
> primary metric is normalized exact agreement between the model output and a BIO-reconstructed gold span, so it
> is largely a span-boundary and convention-agreement score rather than a semantic field-value score: the
> company effect is substantially a rendering convention (brand versus registered entity plus registration
> token) and the total movement is driven by an inconsistent currency prefix in the gold. One model, one
> temperature, one sample per cell and one prompt instance per arm, so sampling variance is unmeasured; 80
> receipts spread over 44 very unequal normalized-company clusters, so the clustered interval partly reflects
> the variance of a ratio estimator with random denominators and not only identified within-family dependence;
> the 24-receipt development split makes the selection itself noisy (P2 led P1 by one cell of 96 and P1 was
> never run on the holdout); the holdout is string-disjoint rather than corporate-family-disjoint; absolute
> accuracy is not comparable to SROIE leaderboard figures because gold is reconstructed from BIO spans. This
> cycle tests prompting only and does not settle the untested fine-tuning comparison.

**Evidence.** Recomputed accuracies; cluster sizes, the sign-test and whole-receipt readings from the theory
lens; canonical-key disagreement from the kit; selection margin recomputed from the development predictions.

## Sections checked and deliberately left unchanged

- `methods` / `failure-accounting`: read at revision 1 and accurate as written (237 attempts, 0 retries, 0
  failures, 0 unscored receipts, 0 invalid outputs, freeze ordering, the recovered worked-example assembly). No
  change proposed. The open metadata residuals (smoke-row labels, template escaping, exhibit pointer, stale
  manifest row) live in producer artifacts and the report, not in this section; the contamination count is also
  recorded there, and the prompt-contamination sentence in `methods`/`design` is now corrected by **M1**.
- `problem` revision 1: still accurate. No change proposed.
- `literature` revision 0 (zero sections): a genuine gap, but filling it is a separate work item, not a
  correction of unsupported text.

## Changes explicitly NOT proposed

- **No change to the recorded verdict, the decision rule, or any measured quantity.** The pre-registered
  analysis stands.
- **No retroactive re-registration.** The post-hoc quantities are labelled post-hoc and are not dressed as
  pre-registered.
- **No claim that the effect is absent.** The recommendation is to state that the magnitude is not established,
  not that the effect is refuted.
- **No claim change.** `claim_b5d14a2303a94336a86154cd5feccc4d` is left untouched by this submission; the
  re-anchoring option in section 9 of the report is a recommendation for the claim workflow, not a paper edit.
- **No attribution of the failure to the executor.** Every measured number reproduced; the defects are prose
  and metadata.

## How the change set can be checked

1. `methods` and `results` section ids are unchanged (`design`, `evaluation`; `primary`, `secondary`,
   `interpretation`), so the revisions apply in place at expectedRevision 1.
2. Every numeric string in the proposed content is traceable to a recomputation listed in the synthesis report
   section 3, except the items explicitly labelled as lens-reported (power, total-only sensitivity) or
   lens-reported-and-unverified (prompt-cache breakdown).
3. Applying the change set leaves `analysis.json`, `error_audit.jsonl`, `holdout_per_receipt.json` and the
   recorded verdict untouched.
