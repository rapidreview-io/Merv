# Methods lens report — `public-receipt-prompting-pilot`

Project `project_245947d7687247819a19330e3c09e916`, reflection `wf_8a158ccef3a64865af0da3d15643bc6c`,
lens `wf_c05f6d58e8044398832f7c1d8f8987fa` (perspective: methods). Prepared independently; no other lens
output was consulted. All findings below are things I read or recomputed from Merv-pinned bytes.

## Summary

The measurement chain is unusually well built and, where I recomputed it, reproducible to the digit; the
honesty of the headline verdict is not in question. Frozen evaluator (`sha256 7980231e…e10755`) and dataset
(`3abff953…0eea15`) are the pre-registered ones; the revision-C evidence bundle reassembles to
`798c00e0…6ce05` with all 23 payload files matching its internal `SHA256SUMS`; my own rerun of the evaluator
returns dev P0/P1/P2 `0.7396/0.8333/0.8438` (71/80/81 of 96 cells) and holdout P0 `264/320` (`0.8250`) vs P2
`279/320` (`0.8719`), and I reproduce the paired delta `+0.046875`, the receipt-level interval
`[0.009375, 0.084375]`, the dominant-cluster sensitivity `+0.034615` and the 19/10/51 whole-receipt split
exactly. The pre-registered "≥3 points" claim is correctly left **not confirmed**, because the
company-cluster interval includes zero.

Four methodological weaknesses materially narrow what may be concluded, however:

1. **The contrast confounds content with prompt length.** P2 is 2602 chars vs P0's 519 (2.76× tokens:
   486.2 → 1343.2). There is no length-matched control, so the gain cannot be attributed to worked examples
   rather than to a five-fold longer instruction; the design itself lists this as a limitation.
2. **The "selection" step carries essentially no information.** P2 beat P1 on development by exactly one
   cell (81 vs 80 of 96), entirely in `total`; P1 was never run on holdout. The experiment therefore does not
   test a selection *procedure* — it tests one demonstration-derived prompt against a plain instruction, and
   the near-tie on development means the winner is not distinguishable from an equally plausible alternative.
3. **The metric measures exact label-string/span agreement, not field-value correctness.** Of the 41 wrong
   selected-arm cells, I judge ~13 of 15 `total` errors to be currency-prefix/spacing only (`11.90` vs
   `RM11.90`, `30.00` vs `RM 30.00`, `24.40` vs `24. 40`), 6 `company` errors to be brand-vs-registered-entity
   (`McDonald's` vs `Gerbang Alaf Restaurants Sdn Bhd`), and most of the 6 `address` and 3 `date` errors to be
   span-boundary or reformatting differences (`IKEA Cheras No 2A …` vs `No 2A …`; `2018-04-06` vs
   `06/04/18 17:36`). Only about two wrong cells are plainly wrong values (`112.46` vs `112.45`,
   `24.00` vs `RM22.65`). This is a documented design choice (the evaluator explicitly refuses currency
   normalization), so the claim's wording "normalized exact field accuracy" survives — but "the prompt
   extracts better" does not follow.
4. **The holdout is string-disjoint, not corporate-family-disjoint, and the effect is cluster-concentrated.**
   The same retailer appears as `mr d.i.y. (johor) son bhd` (development) and
   `mr. d.i.y. (kuchai) sdn bhd` / `mr. d.i.y. son bhd` (holdout) because the company key is normalized from
   OCR-garbled company spans. The largest holdout cluster (15 of 80 receipts,
   `gerbang alaf restaurants sdn bhd`) supplies +6 of the total +15-cell delta, and the second-largest
   (8 receipts) moves −3.

**Conclusions that survive:** the retained execution/evaluation is internally consistent, frozen-before-holdout,
and independently reproducible; on this 80-receipt sample a demonstration-derived prompt scored higher than the
plain instruction by 4.69 points; the ≥3-point improvement is *not* confirmed; the strict, pre-registered metric
shows no invalid outputs; and the 2.76× token cost is real.
**Conclusions that do not survive:** that "selection" contributed (the margin was one cell); that examples
rather than prompt length caused the gain; that the metric demonstrates better field-*value* extraction; and
that the holdout establishes generalization to unseen merchants independent of development. None of these are
misstated by the producer — the report's own Limitations section names most of them — but they bound every
downstream interpretation.

## Evidence actually examined

Read directly and independently recomputed by me:

- Approved plan `art_96374c8145464f25a11fb4e7760b8eaa` (`6885f227…b2ae`): two-stage design, decision rules,
  invalidation conditions, frozen prompt hashes.
- Evaluator `evaluate.py` from work bundle `art_012fe4e3451f4824bf7de23c2bbe55f0` (`9aceaaa0…a56a`) —
  read in full, including normalization and invalid-output logic; I ran it.
- Kit dataset `art_e70f750a8bc64b66804ebef8dbe78260` (`83aadff3…db9d`): `dataset_receipts.json`
  (`3abff953…0eea15`), `canonical_key_crosscheck.json` (`84c51b33…e3c0`).
- Split manifest `art_a1df7c94a71349939c00f76b2d59e044` (`66ce2b0b…f1ca`).
- Revision-C evidence bundle reassembled from the six pinned parts
  (`art_2bfaa9d2…`, `art_e6744177…`, `art_e51cda8d…`, `art_f01356…`, `art_5467a6ad…`, `art_9fabda16…`) →
  `evidence_bundle.tar.gz`, `sha256 798c00e0…6ce05`; members `analysis.json`, `holdout_per_receipt.json`,
  `error_audit.jsonl`, `prompts_frozen.json`, `selection_checkpoint.json`, `code/evaluate.py`.
- Producer report `art_171188f3da2a4e5f8d04dd41742278e3` (`e813ae25…58cf`); metrics exhibit
  `art_f1d4adec8ce64f04a1961f1d9dfb19af` (`b7d503c7…95a`).
- Reviews `review_1652f29f6cd94557bab696223516f4a0` (final, verdict `pass`);
  `review_7bd7b9552303402789145b90f6879f44` (earlier `needs_changes`); experiment state
  `wf_81745bc7a920474dab27a0423ecdd8b0` (`complete`, `verdict: pass`).
- Paper `methods`/`results` revision 1 and the claim `claim_b5d14a2303a94336a86154cd5feccc4d`.

**Completed vs in progress.** The data/evaluator task `wf_c948778f526349d798d656d07b98ed33` and the
experiment `wf_81745bc7a920474dab27a0423ecdd8b0` are complete and reviewed. The parent research workflow and
this reflection wave are in progress; the claim remains `active`, confidence `low`, not confirmed.

## Design audit

Strengths: pre-registered H1, decision rule and invalidation conditions; holdout frozen and untouched before
selection; three-arm exploratory development stage followed by a two-arm confirmatory stage; paired arms on the
same receipts; byte-identical user messages per receipt and a byte-identical shared output-format paragraph;
candidate material drawn only from the 12 demonstration rows; interleaved scheduling; explicit
intention-to-evaluate handling; receipt (not field) as the resampling unit; both a receipt-level and a
company-cluster interval plus a dominant-cluster sensitivity.

Weaknesses, in order of materiality:

- **Length/content confound.** P0 519 → P2 2602 chars. No length-matched control was run (a P0-length prompt
  with padding, or a rules prompt of P2 length, would have separated the two). Everything downstream inherits
  this ambiguity.
- **Selection power.** The selection margin was one cell on 96. With one sample per (arm, receipt) there is no
  estimate of within-condition variance, so the development ranking is a single draw; P1 is statistically
  indistinguishable from P2 and was never evaluated on holdout. The design cannot distinguish "this prompt is
  better" from "this prompt is the one whose single sample came out ahead".
- **No sampling variance.** temperature 0, one sample per cell. Even with pairing, the study cannot say how
  much the +4.69 points would move on a re-run; the paired interval measures across-receipt heterogeneity of
  the difference, not run-to-run noise.
- **Cluster structure.** 44 holdout clusters, very unequal (sizes 15, 8, 4, 4, 3, 3, 2, 2, …). The cluster
  bootstrap resamples 44 units dominated by one 15-receipt group; the dominant-cluster-removed delta (+3.46,
  barely above the 3-point threshold) shows the point estimate is not robust to that group.
- **Independence key.** The company key is a normalized OCR string. It yields 70 groups overall and no
  string overlap, but corporate families do overlap: MR D.I.Y. is present in both development and holdout under
  three spellings, and the `gerbang alaf` cluster is McDonald's Malaysia. So "company-disjoint" is accurate only
  at the string level; the Results sentence "80 company-disjoint receipts" should be read that way.
- **Error-budget prior wrong.** The plan expected `address` to dominate errors (canonical agreement ≈57%);
  empirically `company` did (0.5625), while `address` scored 0.95 and `date` 0.9625. The report discloses this
  reversal. It is a useful signal that the canonical-key cross-check is a poor proxy for BIO-gold noise.

## Implementation audit

- Evaluator, dataset, prompt hashes and freeze ordering are all consistent. `prompts_frozen.json` hashes match
  the plan exactly (P0 `3de152a6…`, P1 `06ebd802…`, P2 `fc04c0cd…`, lengths 519/1674/2602), and the shared
  format paragraph is byte-identical across arms.
- Run logs contain 72 dev + 160 holdout + 4 smoke = 236 rows, all HTTP 200, balanced across arms, no retries;
  the 237th attempt is the operator-retained smoke call (review confirmed it field-for-field). Per-arm token
  means reproduce exactly (dev 516.58/814.17/1374.75; holdout 486.16/1343.24).
- **Deviation with residual risk:** the plan's literal worked-example assembly did not hash to its own declared
  `fc04c0cd…` (doubled-newline ambiguity); the executor recovered the unique matching variant by search before
  any call. The run therefore matches the *hash*, not the prose. The plan alone is not sufficient to
  reconstruct P2; the frozen file is. Review confirmed the variant and the ordering.
- **Settings are only indirectly verified.** The broker does not echo temperature/thinking/max_tokens; those
  are inferred from a stable `system_fingerprint`, valid JSON-object output and no truncation. I did not open
  the operator journal, so I take the settings claim from the two reviews rather than from my own check.
- **Reporting fidelity was defective and then repaired.** The earlier revision cited a superseded bundle
  (`05461a27…`) and exhibit hash, said "24 payload files", and claimed "165 responses" where 237 attempts
  exist; one earlier paper sentence asserted that all 237 attempts were in the producer logs when one was only
  in the operator journal. Revision 5 corrects all of these. The defects were documentation, not measurements —
  every number reproduced in both reviews and in my own recomputation — but the paper trail initially
  overstated its own completeness.
- **Two non-scoring kit hash mismatches** (`kit/README.md`, `kit/observed_check_outputs.txt`) exist in the
  kit's own `SHA256SUMS`; they never feed scoring. The experiment's dataset/evaluator hashes match the
  pre-registered values.
- Four retained smoke rows are labelled `unparseable_json` although their raw content is valid four-key JSON.
  They are non-scored, and the reviewer verified scored predictions equal run-log raw outputs, so this does not
  touch the metrics; it is evidence of a labelling bug on the non-scored path worth fixing before reuse.

## Evaluation and measurement audit

- **Normalization and invalid handling** (I read the code and ran it): `casefold(NFKC(s))`, whitespace runs
  collapsed, stripped, exact equality; no punctuation/currency/numeric normalization. Malformed, missing,
  duplicate, non-string, non-object, missing-field or extra-field outputs count as invalid (four wrong cells)
  and are reported separately; invalid receipts still enter the per-field denominator. Observed invalid rate
  was `0.0000` in both arms on 232 scored calls, so invalidation condition (8) is not triggered. Correctly not
  called F1.
- **Reproduction.** My independent rerun of the evaluator reproduces all published per-field, overall and
  whole-receipt numbers, and my independent reimplementation of the pre-registered bootstrap reproduces the
  point estimate and the receipt interval exactly. For the company-cluster interval I obtain
  `[-0.003425, 0.089623]` against the retained `[-0.003425, 0.089744]`; the third-decimal difference is a
  resample-ordering detail of the same procedure, and the substantive fact — the interval includes zero — is
  unchanged.
- **Unit and weighting.** Cells are weighted equally across the four fields, so the overall metric is sensitive
  to which field has headroom. The result is a single-field story: company `0.5625 → 0.7875` (+18), address
  `0.9500 → 0.9250` (−2), total `0.8250 → 0.8125` (−1), date flat. The +15-cell delta is entirely company minus
  small regressions.
- **Metric validity.** Gold is reconstructed from BIO spans, not the canonical key. The kit's own cross-check
  (626 receipts) gives normalized-exact agreement 356/626 address, 492/626 company, 562/626 total, 610/626
  date. Yet model address accuracy was 0.95 while company was 0.56 — the opposite of what canonical agreement
  would predict — because both model gold and prediction are read off the same OCR text. The metric is
  therefore best understood as "did the model reproduce the annotated OCR span under light normalization",
  i.e. largely a span-boundary/segmentation task, not a semantic field-extraction task. The producer's error
  audit is the right instrument and it is honest (`39 model_miss, 2 near_miss, 0 unsupported_gold,
  0 format`), but `model_miss` as defined still includes currency-prefix and brand-vs-legal-name mismatches.
- **Reported sensitivity.** Complete-pairs delta `+0.046875` (all 80 receipts had both arms) equals the
  primary. Dominant-cluster removal `+0.034615`. Both are correct.

## Which conclusions survive, and which do not

Survive (robust to everything above):

- Execution integrity: frozen before holdout, hash-chain intact, no invalid outputs, no retries/failures, logs
  complete after the revision-5 fix, metrics independently reproduced three ways.
- The point estimate and its direction on this sample: a demonstration-derived prompt scored 4.69 points
  above the plain instruction on these 80 receipts, paired.
- The pre-registered verdict: **not confirmed** — the company-cluster interval spans zero. Reporting it this
  way is the correct, conservative outcome and the producer got it right.
- Cost accounting: 2.76× tokens.
- Residual-error attribution to model behaviour rather than demonstrable label artifacts in this sample
  (0 `unsupported_gold` of 41 wrong cells).

Do not survive as stated / need narrowing:

- Any attribution to *worked examples* specifically, or to *length-independent* prompt improvements.
- Any claim that *selection* works: the selection margin was one cell and the loser was never run on holdout.
- Any reading of "extraction accuracy" as semantic field-value correctness; it is normalized exact-span
  agreement, and ~13 of the 41 wrong cells are currency-format differences on `total`.
- Any generalization claim resting on "company-disjoint" independence: corporate families overlap across
  development and holdout (MR D.I.Y.), and 40% of the cell delta comes from one 15-receipt cluster.
- The address-noise premise used to plan error attribution (canonical agreement ≈57%): empirically
  unsupported as a proxy for BIO-gold difficulty.
- Anything about fine-tuning: correctly out of scope and not claimed.

## Methodological gaps worth fixing before any follow-up

- Add a length-matched and a content-matched control (padded plain instruction; rules prompt of equal length)
  to separate instruction content from prompt length.
- Take ≥3 samples per (arm, receipt) so within-condition variance is estimable and the selection margin is
  meaningful; or run both candidates plus P0 on holdout to test the selection procedure rather than one
  winner.
- Re-key company grouping with the canonical key or an explicit corporate-family/brand normalization
  (the observed `SON`/`SDN` and `(JOHOR)`/`(KUCHAI)` variants are exactly the failure mode), then re-run the
  cluster interval.
- Report a cluster-level randomization/permutation p-value in addition to the percentile bootstrap, given the
  44 unequal clusters.
- Report two metrics side by side: the pre-registered strict span metric (keep it for continuity) and a
  semantic-normalized metric that strips currency symbols/whitespace and treats brand-vs-registered-operator
  explicitly, so readers can see how much of the effect is convention-matching.
- Fix the non-scored smoke-row `parse_result` labelling and the two documentation-file hash mismatches.

## Scope and limits of this lens

I read and re-derived the retained evidence; I made no model calls and produced no new data. I did not open
the operator journal, so broker settings and the 237th attempt are taken from the two independent reviews
rather than from my own inspection. My error-class breakdown into "currency/format/span" versus "wrong value"
is my own reading of `error_audit.jsonl`; the `model_miss` label in the artifact is the producer's and is
broader than my colloquial category. Artifact IDs and sha256 prefixes above are the ones I actually touched.
