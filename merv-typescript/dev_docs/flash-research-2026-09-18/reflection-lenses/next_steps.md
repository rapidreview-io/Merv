# Reflection lens report — perspective: `next_steps`

Project `project_245947d7687247819a19330e3c09e916` (Ledgerline Flash Lab — prompting before fine-tuning).
Lens `wf_cae42ddf8ec34e32b632f1b122f2b191`, attempt 1, revision 0.
I worked only from live project records and pinned artifacts, and I did not read any other lens report.

## Summary

The pilot's quantitative result reproduces exactly, but its decisive weakness is not the effect size —
it is statistical power. My own recomputation of the 80 held-out receipts puts the **power of the
pre-registered cluster-robust test at about 50%** against the observed +4.69-point effect, so
"not confirmed" was close to a coin flip rather than evidence against the prompt. The holdout gives
15 of 80 receipts (18.75%) to a single merchant and 47 of 80 (59%) to just 11 of its 44 companies, so
the effective number of independent clusters is about 16.3 and the cluster-robust standard error is
24% wider than the receipt-level one. The highest-information next step is therefore a **design**
change, not simply "more data": a confirmation holdout with one receipt per company reaches ~80% power
by adding only ~63 new receipts (~126 scored calls) to the already-frozen 80, whereas spending the same
63 receipts inside companies already in the holdout buys only ~60% power, and keeping the current
merchant mix would need ~161 receipts total. Three cheap experiments should ride along: a length-matched
control (the 2.76× token cost is entirely extra input context — completion tokens are unchanged, and
prompt-cache hits make the marginal input ratio ~1.18×, not 2.76×); running the never-holdout-tested
field-rules prompt P1 on the frozen holdout (P2 beat P1 on development by 1 cell of 96); and a
merchant-name/total-targeted arm, because the residual company errors sit in 4–6 word names. Three
scope changes are also justified: raise the 400-attempt ceiling (a cluster-robust test of the
pre-registered 3-point threshold needs ~448–528 calls), add a per-company cap to the split procedure,
and re-anchor both the claim and its cost basis. No proposal below changes a completed measurement or
the recorded `supported_but_not_cluster_robust` verdict.

## Evidence I actually examined

Completed work. Experiment `wf_81745bc7a920474dab27a0423ecdd8b0` (`prompt-generalization`, attempt 1,
state `complete`, verdict `pass`); review `review_1652f29f6cd94557bab696223516f4a0`; task
`wf_c948778f526349d798d656d07b98ed33` (`data-and-evaluator`, verdict `pass`); claim
`claim_b5d14a2303a94336a86154cd5feccc4d`; paper `problem` (rev 1), `methods` (rev 1), `results` (rev 0),
`literature` (rev 0, **no sections**). Work in progress: the sibling reflection lenses `evidence`,
`theory` and `synthesis` are `complete` and `methods` is `reflecting`; I read none of their outputs.

Artifacts I opened and recomputed from: the revision C evidence bundle reassembled from six pinned
base64 parts (`art_2bfaa9d24bda4430ac24ce27f0cd893b`, `art_e6744177cc14449fa5f60c055850e4e0`,
`art_e51cda8d03b043c4b13a633d66a1f417`, `art_f01356ede02f42818c1d8a270fd1b09d`,
`art_5467a6ad85fb413da7edf7139ac70c96`, `art_9fabda1650734abc9432959352478ef2`), whose concatenated
text hashes to `55ca18bf…c81e9` and whose decoded archive hashes to
`798c00e0e8e785b54018f43263459473a9bb6e3fafaaa3017233f23712d6ce05` exactly as `PARTS_README.txt`
declares; all **23/23** payload files match the bundle's internal `SHA256SUMS`. `analysis.json`
(`art_7a3e316b670e44ad82e486350046d0fc`), `holdout_per_receipt.json`
(`art_b7a060078d0c492cacbc56e23714c98c`), `prompts_frozen.json`
(`art_c0487fb5d1944ed69564a66a89315a95`), `selection_checkpoint.json`
(`art_00dfad5ea74c44d59d50d56ecc7df4ec`), `run_logs/`, `predictions/` and the unmodified evaluator
`code/evaluate.py` (`7980231e…e10755`) from the bundle; the kit dataset
(`art_e70f750a8bc64b66804ebef8dbe78260` -> `kit/dataset_receipts.json`, recomputed
`3abff953f55889495cb541f4f4151c3b9f91afc4c4ceb6b839cd3406110eea15`, matching the pre-registered
value); the split manifest (`art_a1df7c94a71349939c00f76b2d59e044`); the producer report
(`art_171188f3da2a4e5f8d04dd41742278e3`); the metrics exhibit
(`art_f1d4adec8ce64f04a1961f1d9dfb19af`); `ARTIFACT_MANIFEST.json`
(`art_b8bdc008a90b4c80b2986cf750fc996f`); and the smoke supplement
(`art_ad7fc871cddd460e9f6695ddf5cb398e`).

| Independent check | Result |
|---|---|
| Holdout point estimate and both intervals, `random.Random(20260918)`, 10,000 draws, receipt- and company-cluster resampling as written in `code/analyze.py` | +0.046875; [0.009375, 0.084375]; [-0.0034247, 0.0897436] — reproduces |
| Development and holdout accuracies re-scored with the frozen evaluator against the recomputed kit dataset | dev 0.739583 / 0.833333 / 0.843750; holdout 0.8250 / 0.871875 — reproduces |
| Per-field holdout, invalid rate, whole-receipt counts, token sums | reproduce |
| Company gold recoverable as a contiguous span of the normalized OCR input | **80/80** — corroborates the "0 `unsupported_gold`" error attribution |

## Established findings that constrain the next steps

- **The cluster-robust test is under-powered, not merely inconclusive.** Using the empirical 44-cluster
  distribution, the delta-method standard error of the paired difference at K=44 is 0.024365 against the
  observed bootstrap SE of 0.023767 (2.5% agreement). At the observed +0.046875 that implies power
  **≈0.505**. The pre-registered rule therefore asked a question this design could not answer.
- **The holdout is badly unbalanced.** Cluster sizes are 15×1, 8×1, 4×2, 3×2, 2×5, 1×33;
  `sum(w_g^2)=0.0612`, i.e. ≈16.3 effective clusters rather than 44. The single 15-receipt company is
  18.75% of receipts and contributes 6 of the 15 net gained cells (40%), yet removing it still leaves
  +0.034615 — the effect is not a single-merchant artifact, but the interval is.
- **The gain is field-specific.** Company 0.5625 -> 0.7875 (+18 cells) while address 0.9500 -> 0.9250 and
  total 0.8250 -> 0.8125 each slip by 1–2 cells. Of the 41 wrong selected-arm cells, 16 are company and
  14 are total `model_miss`.
- **The remaining company errors sit in long merchant names.** P2 company accuracy by gold token count is
  0.857 (2 words, n=7), 0.900 (3, n=10), 0.909 (4, n=22), 0.706 (5, n=34), 0.333 (6, n=3); 13 of the 17
  residual company errors are in 5–6 word names. Indicative only — those buckets are small.
- **The token cost is input context, not output.** Holdout prompt tokens 411.8 -> 1270.8 (P2 hits the
  prompt cache on 784.0 of them) while completion tokens are 74.4 -> 72.5. Gross prompt ratio 3.09×,
  cache-miss ratio 1.18×, reported total-token ratio 2.76×. The paper reports only the gross figure.
- **Selection between P1 and P2 was not statistically meaningful.** On the 24 development receipts P2 led
  P1 by +0.010417 (81 vs 80 of 96 cells), paired bootstrap CI [-0.0417, +0.0625], spanning zero; the two
  arms disagree on only 7 of 24 receipts. P1 (field rules, 814 tokens/call) was never run on the holdout.

## Proposals, ranked by information per unit of budget

1. **Re-run the contrast on a company-balanced confirmation holdout (highest value).** Add ~63 receipts
   drawn one-per-unused-company and pool them with the frozen 80 under a pre-registered pooling rule:
   ≈80% power at the observed effect, 126 new scored calls, ≈115k incremental tokens. A fresh
   singleton design without pooling costs 216 calls. Keep a deliberate minority at 2 receipts per company
   (e.g. 20 companies) so the ICC stays estimable; the two-equation calibration that drives these numbers
   gives `sigma2_within = 2.578e-2`, `sigma2_between = 4.430e-3` (fraction-of-4-cells units, ICC ≈0.147)
   and reproduces both observed SEs.
2. **Do not buy the clustered interval with repeat receipts.** Spending the same 63 receipts inside
   companies already in the holdout (weights unchanged) leaves ~60% power; concentrating them on the
   largest company leaves ~22% (a model extrapolation, but the mechanism is exact:
   `SE^2 = sigma2_w/N + sigma2_b*sum(w_g^2)`, and the second term does not shrink when a company is
   re-sampled; at temperature 0 repeated calls are also near-duplicates). The producer's closing
   suggestion of "more samples per receipt" is the weaker half of that sentence and should be dropped.
3. **Add the length-matched control (cheapest decisive mechanism test).** P0 padded with content-free
   filler to P2's ~2600 characters, run on the same receipts. Until this exists, "worked examples help"
   and "more in-context text helps" are observationally identical, and the current evidence cannot
   separate them.
4. **Run P1 on the frozen holdout.** 80 calls, ~65k tokens. The selection margin was one cell; if P1
   matches P2 on the holdout at ~40% fewer tokens, the practical recommendation for this project's actual
   decision (worth more prompt work before fine-tuning?) changes immediately.
5. **Field-targeted arm for company + total, built only from demonstration rows.** Both are the fields
   with real error mass, and every one of the 80 company golds is recoverable verbatim from the input, so
   the information is present. A zero-cost companion analysis: define a company-name heuristic on the 12
   demonstration rows only, then evaluate it once on the frozen holdout as a ceiling reference.
6. **Report cost on a defensible basis.** Restate the accuracy gain per token and per cache-miss token,
   not only per gross token, and state the provider's cache pricing assumption.
7. **Report the power analysis in paper Methods.** The honest limitation is not "n=80 is small" but
   "the pre-registered cluster-robust criterion had ~50% power, so the not-confirmed verdict carries
   little information about the effect".

## Project-scope changes

- **Raise the 400-attempt ceiling.** A cluster-robust test of the *pre-registered* 3-point threshold
  needs ~448 new calls pooled (224 new receipts) or ~528 fresh — over one cycle's ceiling and its
  90-minute limit. Either raise the ceiling for a dedicated confirmation cycle or narrow the target to
  the observed ~4.7 points.
- **Amend the split procedure with a per-company cap** for confirmation holdouts. This is a change to
  the frozen kit design (`art_a1df7c94a71349939c00f76b2d59e044`), not to any measurement; the pool
  supports it (973 rows considered, 957 eligible, 116 selected, **841 unused eligible**, 372 source
  company groups).
- **Re-anchor the claim.** `claim_b5d14a2303a94336a86154cd5feccc4d` currently asserts a >=3-point
  improvement under a design whose clustered interval cannot support it. Either restate it around the
  paired receipt-level estimand with the cluster caveat made explicit, or keep the cluster-robust
  criterion and attach the larger holdout as its resolution path and a pre-registered stop rule (if the
  balanced confirmation lands below the threshold, close the prompting line and move the budget to the
  fine-tuning comparison).
- **State the pooling decision before collecting it.** Reusing the frozen 80 receipts is legitimate only
  if the pooled analysis is pre-registered before any new call.
- **Fill the empty `literature` document** (rev 0, zero sections). Nothing currently anchors "three
  percentage points" or "worked examples" in prior work, and the paper cannot be assembled without it.
- **Close the outstanding reporting residuals**, all of which I re-verified rather than taking on trust:
  the producer report cites the exhibit as `art_09aad815…/598c078a…` with 20 result files while the
  pinned exhibit is `art_f1d4adec8ce64f04a1961f1d9dfb19af` (`b7d503c7…`); `ARTIFACT_MANIFEST.json`
  still carries a stale `report.md` row (`86b64db9…`, 13205 bytes) against the pinned report
  (`e813ae25…`, 14578 bytes); the report states **two** development/holdout gold strings appear in prompt
  text where I find **four** (`5.90`, `9.90`, `50.00`, `27/06/18`, all coincidental substrings of
  demonstration OCR numerals — the no-leakage conclusion stands, the count does not); and the four
  non-scored smoke rows in `run_logs/run_log_smoke.jsonl` are labelled
  `unparseable_json:AttributeError` although each `raw_content` is valid four-key JSON.

## What would change these recommendations

The power figures assume the observed +4.6875 points is the true effect and rest on variance components
estimated from one 80-receipt sample; at a true +3 points the requirement roughly triples (224 pooled new
receipts, 448 calls), and the "spread it over existing companies" counterfactual extrapolates
`sum(w_g^2)` beyond its observed range. The company grouping is a normalized-string heuristic, so no
cluster analysis here proves corporate-family independence. Everything rests on one model, one
temperature, one sample per cell and one prompt instance per arm, and gold is a BIO reconstruction. This
cycle still says nothing about fine-tuning, and I found nothing in the live records that does.
