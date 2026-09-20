# Synthesis report — `public-receipt-prompting-pilot` (reflection, attempt 1, revision 4)

Reflection `wf_8a158ccef3a64865af0da3d15643bc6c`, now at revision 7 (state `synthesizing`).
Project `project_245947d7687247819a19330e3c09e916` (Ledgerline Flash Lab — prompting before fine-tuning).
Perspective: **synthesis**. I read all five independent lens reports in full (evidence, theory, methods,
synthesis, next_steps), the live research records, and the prior synthesis submission; I recomputed the
load-bearing quantities I could reach and hand-audited the specific cells the previous review contested.
I edited no lens report and changed no shared artifact.

## 0. This is the fourth submission of this reflection — what changed and why

Submission 1 (report `art_6ae939b9d84d47449785882f0cf6df53`, change specification
`art_fb5a5ef5887142fb8ca8394f91322d63`, machine-readable edits `art_282970780fd74965988ac1e5931bbe7f`) was
returned `needs_changes` by `review_d8a0b1347b984a8abeb4d7f4a9b45934` on criterion 5. Submission 2 (report
`art_e4849c2cd5784eb382c4bf1f8d49e7d7`, change specification `art_5fb6c8920f0e4d0f804cda58bfd2f94c`,
machine-readable edits `art_fae1dcec42b5443a9485ec1f9005b87f`) was returned `needs_changes` by
`review_95996dc9d5664ef0a08f1714e47222e0` on criteria 1 and 5. Submission 3 (report
`art_75eb7600f89248c19a18fddcfae73591`, change specification `art_04e8505153a94f9c884f49a4ef4193d9`,
machine-readable edits `art_0dd1d8e797bf415dbd68003a9edab674`) was returned `needs_changes` by
`review_826b6307aa87413095ef904b04fbc48a` on **criterion 1 only**, for one factual-evidence defect in this
report's account of the contested cluster tail count. Criteria 2, 3, 4 and 5 were met; that review independently
reassembled revision C, re-ran the frozen evaluator and both bootstraps, and reproduced every scored figure,
every audit and every proposed paper edit. All of that is carried forward unchanged.

1. **The cluster `P(delta < 0.03)` dispute is settled, and my earlier account of it was wrong.** Submission 2
   stated the value as 0.243; submission 3 replaced it with 0.2386 and asserted that the returning review's
   0.2392 was "not reproducible at the last digit". The review was right and that assertion was wrong. This
   revision I reassembled the revision-C bundle myself (sha256
   `798c00e0e8e785b54018f43263459473a9bb6e3fafaaa3017233f23712d6ce05`, 23/23 `SHA256SUMS`), read the frozen
   `code/analyze.py`, and re-implemented the cluster bootstrap exactly as written there: groups keyed by the
   evaluator normalization of the gold company, `gkeys = sorted(groups)`, `rng2 = random.Random(20260918)`,
   `drawn = [rng2.choice(gkeys) for _ in range(len(gkeys))]`, 10,000 draws, index-based percentiles. It
   reproduces the recorded `analysis.json` cluster interval `[-0.003424657534246589, 0.08974358974358965]` and
   the recorded 5th percentile `0.005747` exactly; over that identical frozen draw sequence the count of draws
   below 3 points is a **boundary convention**, not a disagreement about the data:
   - **exact rational arithmetic** (comparing `Fraction(correct_cells_P2 - correct_cells_P0, 4 x drawn
     receipts)` against `3/100`): **2386 of 10,000 = 0.2386**, the count of draws that fall short of the
     ">= 3 points" claim by a strict margin;
   - **the literal floating-point comparison `delta < 0.03`**, which is what the disputed replications ran:
     **2392 of 10,000 = 0.2392**.
   The two differ by exactly the **six** draws whose delta is mathematically exactly 3.0 points but evaluates to
   `0.029999999999999916` in IEEE-754 double arithmetic, so the literal `<` counts them as sub-threshold. Seven
   further draws also land mathematically exactly on 3.0 points and evaluate to `0.030000000000000027`, so
   **13 draws in all sit exactly on the threshold** and the fully boundary-inclusive count `P(delta <= 0.03)` is
   2399/10,000 = 0.2399. All three readings agree that roughly a quarter of clustered bootstrap mass lies at or
   below the claimed threshold, and the two central readings both round to **0.239**, the figure the proposed
   paper texts state; exact arithmetic makes **0.2386** the cleanest single value, because a draw landing
   exactly on 3.0 points satisfies the ">= 3 points" claim and therefore does not belong to
   `P(delta < 0.03)`. The 0.243 of submission 2 arises only if the 44 groups are enumerated in first-appearance
   order instead of sorted keys; I reproduced that variant too this revision and it gives **2432/10,000 =
   0.2432** (submission 2's "2431" was off by one) together with a different cluster interval
   `[-0.003676, 0.090278]` that does **not** reproduce the recorded `analysis.json` interval — a further reason
   to treat sorted keys as the frozen procedure. The paper texts now disclose the boundary explicitly rather
   than picking a winner, and the report, this item and the change specification all record the retraction.
2. **The proposed `methods`/`design` replacement retained "no development or holdout gold reached a
   prompt".** That is not literally true. Scanning `prompts_frozen.json` against the frozen kit dataset under
   the evaluator normalization, I find exactly **four** development/holdout gold strings inside the P2 prompt
   text and none in P0 or P1: totals `5.90`, `9.90`, `50.00` and date `27/06/18`. Each occurs only because it
   is inside a demonstration receipt OCR text or a demonstration gold value (`50.00` is a substring of the
   demonstration gold total `750.00`; `27/06/18` is the gold date of demonstration receipt `X51007579725`,
   which is also the gold date of one holdout receipt; `5.90` and `9.90` are substrings of demonstration OCR
   numerals). None was selected as candidate material from a development or holdout record, and the producer
   self-check reported two of the four. The replacement is narrowed accordingly, and the change
   specification no longer implies that this residual lives only in producer artifacts.
3. Nothing else changed. The measurements, the intervals, the verdict, the remaining proposed edits and the
   "changes explicitly NOT proposed" list were verified by the returning reviews and are carried forward
   unchanged.

## 1. Bottom line

Every scored number in this corpus reproduces — under the reviewer byte-level replication, under all five
lenses, and under this synthesis own checks. The pre-registered verdict (**not confirmed**) is correct and
should stand. The problems are not in the arithmetic; they are in what the paper says the arithmetic means.

- The **magnitude in the claim is not demonstrated.** The pre-registered rule confirms only if the point
  estimate reaches 3 points *and both interval lower bounds exceed zero*; it never tests the effect against 3
  points from below. `P(delta < 0.03)` is 0.186 (receipt-level) and 0.239 (company-cluster; 0.2386 by exact arithmetic, 0.2392 by the literal floating-point comparison, both rounding to 0.239); one-sided 95
  percent lower bounds are `+0.0156` and `+0.0057`.
- The **mechanism is unidentified.** P2 is a three-shot prompt with gold exemplars at 2 602 characters against
  P0 at 519; exemplar content, exemplar count, prompt family and prompt length are completely confounded, and
  the frozen rules-only arm P1 was never run on the holdout.
- The **selection claim is untested.** P2 beat P1 by one cell of 96 on development; the tie-break cascade would
  have preferred the cheaper P1 on a one-cell swing.
- The **residual-error sentence in `results` is unsupported and should be withdrawn.** The `unsupported_gold`
  audit class cannot fire by construction, and direct inspection shows a material share of the wrong cells is a
  label and currency-format convention mismatch.
- Nothing here justifies a **>= 3-point** effect, a **procedure-level** claim about prompt selection, or
  **generalisation to unseen merchants**. The honest summary is a directional, single-field, convention-level
  pilot whose pre-registered clustered criterion had about 50 percent power against the observed effect.

## 2. Research coverage: completed, in progress, rework

**Completed and independently reviewed.**
- Kit task `wf_c948778f526349d798d656d07b98ed33` (`data-and-evaluator`): terminal, verdict `pass`,
  `review_2773ccf6af6d48cea7ac5a79df167e63`.
- Experiment `wf_81745bc7a920474dab27a0423ecdd8b0` (`prompt-generalization`): `complete`, revision 6, verdict
  `pass`, `review_1652f29f6cd94557bab696223516f4a0`; its publications created paper `methods` revision 1 and
  paper `results` revision 1.
- Paper: `problem` revision 1, `methods` revision 1, `results` revision 1, `literature` revision 0 with **zero
  sections**. Publication status: none. Claim `claim_b5d14a2303a94336a86154cd5feccc4d` remains `active`,
  confidence `low`, revision 0 — never adjusted after the result.

**In progress.** Only this reflection wave; no other project work is in flight. I re-read the live records
immediately before writing (paper revisions unchanged at 1; experiment terminal; literature still empty).
No new results appeared during the wave.

**Rework and dead ends (recorded, not hidden).**
- This reflection has now been returned `needs_changes` three times: submission 1 on criterion 5; submission 2 on criteria 1 and 5; and submission 3 (`art_75eb7600f89248c19a18fddcfae73591` report, `art_04e8505153a94f9c884f49a4ef4193d9` change specification, `art_0dd1d8e797bf415dbd68003a9edab674` edits) on criterion 1 alone for the tail-count attribution described in section 0, with criteria 2 to 5 met. This revision corrects that item; the superseded reports, change specifications and paper-change artifacts remain in the record.
- An earlier attempt-1 review of the experiment, `review_7bd7b9552303402789145b90f6879f44`, also returned
  `needs_changes`, for reporting fidelity only (superseded bundle hashes; one paper sentence not backed by the
  logs); every measurement already reproduced. A superseded evidence bundle and a superseded report
  (`art_cab87395a62142059d8284fb27220220`) remain in the record.
- The **P1 (field rules) arm was written, hashed and frozen but never run on the holdout** — a stopped arm, and
  the single highest-information missing contrast.
- The plan worked-example assembly was under-specified (doubled newline tokens); the unique variant
  reproducing the frozen hash was recovered by exhaustive search before execution.
- Metadata residuals still open in producer artifacts: the contamination self-check reports 2 gold strings in
  prompt text where a normalized substring scan finds 4; the producer report cites a superseded exhibit
  (`art_09aad815c8274f4a819c43273bcb3f1b`, 20 files) instead of the pinned exhibit
  (`art_f1d4adec8ce64f04a1961f1d9dfb19af`, 23 files); `ARTIFACT_MANIFEST.json` carries a stale `report.md` row
  (`86b64db9…`) against the pinned report (`e813ae25…`); `prompts_frozen.json` stores `user_message_template`
  with a literal backslash-n that does not byte-match the message actually sent; and the four non-scored smoke
  rows are labelled `unparseable_json:AttributeError` although their `raw_content` is valid four-key JSON. None
  of these move a scored number; all were recorded by the final experiment review.

## 3. Verification performed for this synthesis

The loads this rework had to carry were the flagged counts and the live state, so I verified those directly
and relied on already-replicated results elsewhere (labelled below).

- **Verified by hand here:** the 15 wrong `total` cells and their `RM` and modulo-non-digits status, from
  `art_0d78e149d33a48979585578ffa63b459` (also consistent with its own `by_class_field` counts). Current paper
  text of all six sections at revision 1 (`paper.read`), so every proposed "before" block is verbatim. Claim,
  task, experiment, publication and literature state (`project.records`). The prior synthesis artifacts and the
  returning review, including its full replication record.
- **Verified by me this revision (fourth submission):** the revision-C bundle reassembles to `798c00e0…`
  with 23/23 `SHA256SUMS`; re-implementing the frozen `code/analyze.py` cluster bootstrap (`gkeys = sorted(groups)`,
  `random.Random(20260918)`, 10,000 draws, index percentiles) reproduces the recorded cluster interval
  `[-0.003424657534246589, 0.08974358974358965]` and 5th percentile `0.005747` exactly, and over the identical
  draw sequence gives `P(delta < 0.03)` = 2386/10,000 by exact rational arithmetic and 2392/10,000 by the literal
  floating-point comparison, the difference being the six draws whose delta is mathematically exactly 3.0 points
  but evaluates to 0.029999999999999916 (13 draws in all land exactly on 3 points; boundary-inclusive
  2399/10,000). The first-appearance group enumeration instead gives 2432/10,000 with interval
  `[-0.003676, 0.090278]`, confirming both that the withdrawn 0.243 came from a non-frozen enumeration and that
  submission 2 said 2431 where the count is 2432. I also reconfirmed the receipt-level tail 1857/10,000 = 0.1857
  with interval `[0.009375, 0.084375]` and 5th percentile `0.015625`, the 44-cluster geometry (largest 15; sum of
  squared weights 0.06125), the point estimate `+0.046875` and dominant-cluster-removed `+0.034615`. I also
  scanned `prompts_frozen.json` against the frozen kit dataset (`3abff953…`) under the evaluator normalization
  and found exactly four development/holdout gold strings in P2 and none in P0 or P1: `5.90`, `9.90`, `50.00`,
  `27/06/18`, each inside demonstration OCR or demonstration gold. My script is `audit/audit_tail.py` and the
  reassembled bundle is under `audit/bundle/` in this lease workspace; nothing else was touched.
- **Verified by the returning review (byte-level, independent of me):** bundle sha256 `798c00e0…` with 23/23
  `SHA256SUMS`; re-scored holdout 264/320 = 0.8250 and 279/320 = 0.871875, delta `+0.046875`; receipt interval
  `[0.009375, 0.084375]`; cluster interval `[-0.0034247, 0.0897436]` with 5th percentiles 0.015625 and
  0.005747; `P(delta < 0.03)` 0.1857 (receipt) and 0.2392 (cluster, the review value, which I now reproduce exactly); dominant cluster removed `+0.034615`; 44 clusters with sizes
  `15, 8, 4, 4, 3, 3, 2 x 5, 1 x 33`; sum of squared weights 0.06125 (16.33 effective clusters); sign test
  25 up and 10 down, `p = 0.01667`; whole-receipt `+0.1125` with an interval including zero; prompt lengths
  519, 1674, 2602; four P2 contamination strings; four mislabelled smoke rows; the literal backslash-n
  template; the exhibit-pointer and stale-manifest defects; and the error-audit breakdown (39 `model_miss`
  plus 2 `near_miss`, with 18 of 39 `model_miss` cells having the output as a normalized substring of a longer
  gold span).
- **Verified by the five lenses (independently of each other and of me):** evaluator and dataset hashes, the
  development accuracies 71, 80 and 81 of 96, per-receipt input identity across arms, the 237-attempt
  execution record, and the canonical-key cross-check ratios.
- **Not verified by me:** the operator journal timestamps and concurrency, the provider-side settings, the
  bundle reassembly itself, the next_steps power calculation beyond its inputs, and the prompt-cache token
  breakdown (reported by one lens only). These are labelled as such wherever they appear.

## 4. Established results (consensus of all five lenses and the reviews)

- The measurement chain is frozen, hash-pinned and reproducible: evaluator `7980231e…`, dataset `3abff953…`,
  revision-C bundle `798c00e0…` with 23/23 payload files verified.
- Primary contrast, 80 company-string-disjoint holdout receipts, paired: **P0 0.8250 (264/320) vs P2 0.8719
  (279/320), delta `+0.046875`.** Receipt-level bootstrap 95 percent interval `[0.009375, 0.084375]`, excluding
  zero; company-cluster bootstrap `[-0.003425, 0.089744]`, including zero; dominant 15-receipt cluster removed
  `+0.034615`. Verdict `supported_but_not_cluster_robust`; the pre-registered **>= 3 point claim is not
  confirmed**.
- The gain is **one field**: company `0.5625 -> 0.7875` (net +18 cells), date flat at 0.9625, address
  `0.9500 -> 0.9250` (-2 cells), total `0.8250 -> 0.8125` (-1 cell). Development shows the same single-field
  pattern (company 0.5417 -> 0.7917).
- Whole-receipt exactness `35/80 -> 44/80` (19 fixed, 10 broken, 51 tied), delta `+0.1125`, interval includes
  zero.
- Execution: 237 attempts, 0 retries, 0 failures, 0 unscored receipts, **0 invalid outputs in either arm**;
  232 scored calls; per-receipt user messages byte-identical across arms; prompts, template and kit hashes
  frozen before the first call and the selection checkpoint attached before the first holdout call;
  concurrency <= 4; one `system_fingerprint` throughout.
- Cost: prompt lengths 519, 1674, 2602 characters; mean tokens per call 486 -> 1343 (**2.76x**); 2 083 extra
  characters.
- Cluster geometry: 44 normalized-company groups, very unequal (largest 15 receipts; sum of squared weights
  about 0.0612; about 16.3 effective clusters).
- Error audit (P2 holdout): 41 wrong cells = 39 `model_miss` (company 16, total 14, address 6, date 3) plus 2
  `near_miss`, 0 `format`, 0 `unsupported_gold`. Gold is recoverable verbatim from the normalized input for
  464/464 kit cells and 320/320 holdout cells.

## 5. Tensions and disagreements preserved

| # | Question | Positions | How this synthesis reads it |
|---|---|---|---|
| T1 | Is the residual-error sentence defensible? | **methods**: yes, in the narrow form (0 `unsupported_gold` of 41 wrong cells), listed under conclusions that survive. **evidence** and **theory**: no — the class is structurally unreachable and direct inspection contradicts it. **synthesis lens**: unsupported, near-tautological check. | Genuine disagreement, and the sharpest one in the wave. The methods lens own text concedes that about 13 of 41 wrong cells are currency-format differences, which is hard to square with its survives verdict. I keep the narrow, true reading (no wrong cell was scored against gold absent from the input) and withdraw the broad claim (section 6 item 2). Both readings are recorded rather than averaged away. |
| T2 | How uncertain is the clustered interval? | producer and reviewer `[-0.003425, 0.089744]`; methods and theory `[-0.003425, 0.089623]`; an earlier synthesis `[-0.003676, 0.090278]`. | Two separate causes, both reproduced by me. The small differences are summation/index conventions on the same sorted-key procedure; the `[-0.003676, 0.090278]` pair comes from enumerating groups in first-appearance order rather than `sorted(groups)` and does not reproduce the recorded `analysis.json` interval. The substantive fact — includes zero — is invariant across all of them. Treated as a range, not an exact figure. |
| T3 | What does the prompt cost? | Majority (evidence, methods, synthesis): 2.76x tokens. **next_steps**: prompt-cache hits make the marginal input ratio about 1.18x. | The 2.76x gross token figure is verified; the cache breakdown is reported by one lens and was not verified by this synthesis, so it is labelled lens-reported and deliberately excluded from the proposed paper text. Cost sensitivity remains an open reporting item. |
| T4 | How much information does not-confirmed carry? | Producer and final review: honest and conservative. **next_steps**: the pre-registered clustered test had about 50 percent power, so not-confirmed is close to a coin flip. Prior synthesis: power about 0.5, not independently recomputed. | Accepted as a reflection finding with the power figure labelled lens-reported; its inputs (44 clusters, sizes, delta) do reproduce. This is the strongest single reason not to read not-confirmed as evidence of absence. |
| T5 | Is the effect significant? | **theory**: receipt-level sign test significant (25 up and 10 down, `p = 0.0167`); whole-receipt exactness not (19 and 10, `p = 0.136`); design-based cluster SE includes zero. **evidence** and **synthesis**: `P(delta < 0.03)` is 0.19 and 0.24. | No contradiction: two different estimands plus a power problem. The consequence is that directional is estimator-dependent, and any downstream citation must name the estimand. |
| T6 | How many gold strings leak into prompt text? | The report says 2; **evidence**, **synthesis lens** and **next_steps** independently find 4 (`5.90`, `9.90`, `50.00`, `27/06/18`, all coincidental substrings of demonstration OCR numerals, P2 only). | Four. No holdout label entered a prompt, so invalidation condition 3 is not triggered; the reported count is simply wrong. |
| T7 | Did prompt *selection* contribute? | **methods**: selection carries essentially no information (one-cell margin; P1 never on holdout). **theory**: partially excluded for P2 vs P0, live for the procedure-level claim. **next_steps**: same one-cell margin. | Consensus that the procedure-level claim is untested and must not be asserted; the P2-vs-P0 contrast itself is not shown to be a selection artifact. |
| T8 | Are the broker settings safe? | **evidence** and **methods**: inferred, never echoed by the provider. **theory**: excluded as a drift confound on one `system_fingerprint`, all HTTP 200, frozen hashes, byte-identical inputs. | Reasonable for within-run drift; still an inference about provider-side settings, stated as inferred. |
| T9 | Which cluster `P(delta < 0.03)` is correct? | returning review 0.2392 (literal floating-point count); evidence lens 0.239; superseded submission 2 0.243; my exact-arithmetic count 0.2386; my literal floating-point count 0.2392; first-appearance enumeration 0.2432. | Resolved this revision as a boundary convention, not a disagreement about the data. The frozen procedure sorts group keys and reproduces the recorded interval exactly; over its 10,000 draws 2386 fall strictly below 3 points by exact arithmetic and 2392 by the literal floating-point comparison, the gap being exactly the six draws that sit on 3.0 points and evaluate to 0.029999999999999916 (13 draws in all sit exactly on the threshold; boundary-inclusive 2399). Every central reading rounds to the 0.239 the paper states. The 0.243 of submission 2 is withdrawn: it needs a first-appearance enumeration, gives 2432 not 2431, and does not reproduce the recorded interval. |

## 6. Statements in the current paper (revision 1) that the evidence does not support

Each line is a sentence or implication in the paper, with the evidence that fails to support it. Replacements
are in the companion change specification.

1. **`methods`/design: "so the contrast isolates extraction guidance."** False as written. P0 already carries
   the identical JSON output-format contract; P2 adds three gold-labelled exemplars and 2 083 extra characters.
   The contrast confounds exemplar content, exemplar count, prompt family and length, and the length-matched
   control the design names was never run. The `results` section already concedes the confound, so design and
   results currently contradict each other.
2. **`results`/secondary: "every wrong gold string was recoverable verbatim from the input, so no residual
   error is attributable to BIO/OCR label artifacts."** Not supported. The test cannot fire (464/464 kit and
   320/320 holdout cells are verbatim-in-input by construction). Direct inspection shows that **15 of the 41
   wrong cells are totals, 13 of those 15 carry a printed `RM` token in the gold, and 13 of the 15 agree with
   the model modulo non-digits**; 18 of 39 `model_miss` cells have the model output as a substring of a longer
   gold span; and the kit own canonical-key cross-check disagrees with gold on about 43 percent of addresses
   and 21 percent of companies.
3. **`results`/primary: the ">= 3 points" framing.** The rule tests the point estimate and both lower bounds
   against zero; it does not bound the effect below 3 points. `P(delta < 0.03)` is 0.186 (receipt) and 0.239
   (cluster; 0.2386 by exact arithmetic and 0.2392 by the literal floating-point comparison, of which the paper
   states the common rounding 0.239); the one-sided 95 percent lower bounds are `+0.0156` and `+0.0057`. Reading four-field accuracy as
   whole-receipt exactness gives `+0.1125` with an interval that includes zero.
4. **`results`/primary: the company-cluster interval as the whole uncertainty statement.** It is the honest
   primary interval, but it understates the problem: the pre-registered criterion had roughly 0.50 power
   against the observed effect, so not-confirmed carries little information about whether the effect exists.
5. **`results`/interpretation: "80 company-disjoint receipts."** Accurate only at the normalized-string level;
   corporate families recur across splits (MR D.I.Y. under several spellings; the 15-receipt `gerbang alaf
   restaurants sdn bhd` cluster is one fast-food operator).
6. **`results`/interpretation: selection noise mentioned only in passing.** P2 won by one cell of 96 over P1,
   which was never run on the holdout, and 7 of 24 development receipts flipped between the two arms.
7. **Metadata: contamination count of two.** Four is correct, and the same residual makes the `methods`/`design` sentence "no development or holdout gold reached a prompt" false as written; change **M1** now narrows that sentence as well as the isolation claim.
8. **Metadata: stale exhibit pointer.** The producer report names `art_09aad815c8274f4a819c43273bcb3f1b`
   (20 files); the pinned exhibit for the submission is `art_f1d4adec8ce64f04a1961f1d9dfb19af` (23 files).

## 7. Negative results, stopped runs and dead ends

- **Nulls that matter.** Date never moves on either split (0.9625 in both arms, both splits: ceiling); address
  regresses by 2 cells and total by 1 on holdout; the pre-registered clustered criterion is not confirmed; the
  whole-receipt reading is not significant; and the pre-registered criterion is under-powered (about 0.50), so
  the null is weak evidence rather than a refutation.
- **Stopped arm.** P1 (field rules, 1 674 characters, no labelled exemplars) was frozen but never run on the
  holdout; the confirmatory stage therefore cannot separate rules from worked examples.
- **Dead ends and superseded material.** A superseded evidence bundle and report; an attempt-1 review that
  returned `needs_changes` on reporting fidelity only; a mis-specified worked-example assembly recovered by
  exhaustive search before any call; four non-scored smoke rows whose `parse_result` labels are wrong.
- **Genuine gap not yet filled.** The `literature` document is empty (revision 0, zero sections). Nothing in
  the record anchors "three percentage points" or "worked examples" in prior work. This is a work item, not a
  defect in the measured result, and it is why no literature edit is proposed here.

## 8. Uncertainty statement

On 80 holdout receipts whose normalized company strings are disjoint from development, a three-shot
worked-example prompt (2 602 characters) scored **+4.7 points** of normalized exact field-cell accuracy above a
plain JSON instruction (519 characters), paired, on the same receipts. The receipt-level interval excludes
zero; the company-cluster interval spans zero; about 19 percent of receipt-level bootstrap mass and about 24 percent
of clustered mass (0.2386 by exact arithmetic, 0.2392 by the literal floating-point comparison) lie **below** the claimed 3-point threshold; the one-sided 95 percent lower bound is `+1.6`
points (receipt) and `+0.6` points (cluster); 40 percent of the net cell gain comes from one 15-receipt merchant
cluster; the magnitude moves between `+3.75` and `+5.31` points depending on the label convention; and the
pre-registered clustered criterion had roughly 50 percent power against the observed effect. The gain is almost
entirely a `company`-field rendering convention (brand plus registration token versus registered legal name),
offset by a currency-prefix convention regression on `total` that penalises the selected arm. The prompt-length
and exemplar-content explanations are observationally indistinguishable in this design. Nothing here
establishes a **>= 3-point** effect, a **selection procedure** effect, or generalisation to unseen merchants.

## 9. Follow-up queue and consolidation decisions (proposals, clearly separated)

These are **proposals** derived from the next_steps lens, with inputs checked against the established results
above; they are not findings. Nothing below changes a completed measurement, a per-receipt cell, an interval,
or the recorded `supported_but_not_cluster_robust` verdict.

Highest information per API call, in order:
1. **Run P1 (field rules) against P0 on the frozen holdout** — 80 calls. P2 beat P1 by one cell of 96; if P1
   matches P2 at roughly 40 percent fewer tokens, the project actual decision (is more prompt work worth
   funding?) changes immediately.
2. **Length-matched padding control** — pad P0 with content-free text to P2 length on the same receipts. Until
   this exists, "worked examples help" and "more in-context text helps" are observationally identical.
3. **Power-calibrated confirmation holdout** — add about 63 receipts drawn one per unused company to the frozen
   80 under a pooling rule pre-registered before any new call (about 126 scored calls, roughly 80 percent power
   at the observed effect; the power figure is lens-reported).
4. **Do not buy the clustered interval with repeat receipts** — re-sampling inside companies already in the
   holdout leaves about 60 percent power, and at temperature 0 repeated calls are near-duplicates. The
   producer closing suggestion of "more samples per receipt" is the weaker half of that sentence and should be
   dropped.
5. **Field-targeted arm for company and total**, built only from the 12 demonstration rows, plus a zero-cost
   demonstration-only company heuristic evaluated once on the frozen holdout as a ceiling reference.
6. **Reporting**: state cost per gross and per cache-miss token; report the power analysis in `methods` so the
   honest limitation reads "the pre-registered criterion had about 50 percent power" rather than "n = 80 is
   small".

Scope decisions these imply (proposals only):
- **Raise or reframe the 400-attempt ceiling** — a cluster-robust test of the pre-registered 3-point threshold
  needs roughly 448 to 528 calls, over one cycle ceiling and 90-minute limit.
- **Add a per-company cap** to the split procedure for confirmation holdouts (841 unused eligible rows and 372
  source company groups exist to draw on); this changes the kit design, not any measurement.
- **Re-anchor or keep the claim with a resolution path.** `claim_b5d14a2303a94336a86154cd5feccc4d` is left
  **unchanged by this submission** (active, low, revision 0); the paper edits below do not touch it. My
  recommendation to the owners is to keep the cluster-robust criterion and attach the balanced confirmation
  holdout as its pre-registered resolution path with a stop rule (if the balanced confirmation lands below the
  threshold, close the prompting line and move budget to the fine-tuning comparison). That is a claim-workflow
  decision and is explicitly **not** proposed as a paper edit here.
- **Fill the empty `literature` document** as a separate work item.
- **Close the metadata residuals** listed in section 2 (contamination count, exhibit pointer, report row,
  template escaping, smoke-row labels).

## 10. Limits of this synthesis

My recomputation covers the frozen evaluation chain, not execution: I made no model call and cannot verify
provider-side `temperature`, `thinking` or `max_tokens`, which are attested only by the operator-written
journal and the run logs. I did not re-fetch the upstream dataset, but **this revision I reassembled the revision-C bundle myself** (`798c00e0…`, 23/23 `SHA256SUMS`), read `code/analyze.py`, and re-implemented the frozen cluster bootstrap to resolve the contested `P(delta < 0.03)`, counting the same frozen draw sequence in exact rational and in IEEE-754 arithmetic (2386 and 2392 of 10,000; six draws rest exactly on 3.0 points in floating point and 13 mathematically) and in the first-appearance enumeration variant (2432); I also re-ran the prompt-text substring screen against the frozen kit dataset. My audit script is `audit/audit_tail.py`; no lens report and no shared artifact was edited. I did not re-run the frozen evaluator end to end this revision; the scored metrics were reproduced by the returning reviewer and by all five lenses, and I relied on the frozen `holdout_per_receipt.json` counts, which agree with `analysis.json`. The `total`-cell currency audit was hand-verified in submission 2. The power figure, the prompt-cache
breakdown and the canonical-key ratios are lens- or kit-reported and labelled as such. The 80 receipts, 44
unequal clusters, one model, one temperature, one sample per cell and one prompt instance per arm bound every
generalisation claim in this report.

## 11. Paper edits

Paper edits **are** needed. The change specification accompanies this report as a separate immutable artifact;
the machine-readable Methods and Results edits are supplied as an `application/json` artifact with `documents`
entries for `methods` (expectedRevision 1, sections `design` and `evaluation`) and `results` (expectedRevision
1, sections `primary`, `secondary`, `interpretation`). No proposed edit changes a measurement, a per-receipt
cell, an interval or the recorded `supported_but_not_cluster_robust` verdict; the edits narrow interpretation,
add labelled post-hoc quantities, and correct metadata. `methods`/failure-accounting` was checked and is proposed for no change; the `methods`/design` replacement additionally narrows the prompt-contamination sentence (section 0 item 2). The post-hoc passages in `methods`/evaluation` and `results`/primary` now disclose the floating-point boundary in the cluster tail count (0.2386 by exact arithmetic, 0.2392 by the literal floating-point comparison) instead of asserting a single figure, so the defect raised against submission 3 cannot recur in the paper text.
