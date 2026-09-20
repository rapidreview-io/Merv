# Reflection lens report — perspective: synthesis

Project: `project_245947d7687247819a19330e3c09e916` (Ledgerline Flash Lab — prompting before fine-tuning)
Lens: `wf_bf6d15714ace4ab9b9ba57a787d6a9b2` (perspective `synthesis`, attempt 1, revision 0)
Independence: written from my own reading of the live records and pinned evidence only; I did not open or
consult any other lens output. Every number below marked "recomputed" was recomputed by me from
hash-verified blobs; items I did not recompute myself are labelled with their source.

## Summary

The corpus is one small pilot, and within it the project's single active claim is **directionally supported
but not confirmed**. Claim `claim_b5d14a2303a94336a86154cd5feccc4d` (active, low confidence, rev 0) asserts a
>= 3 percentage-point held-out gain from a development-selected prompt. The experiment
`wf_81745bc7a920474dab27a0423ecdd8b0` (complete, rev 6, final verdict pass) measured +4.69 points
(0.8250 -> 0.871875 on 80 company-disjoint receipts; recomputed), with a receipt-level paired bootstrap
95% interval [0.009375, 0.084375] that excludes zero and a company-cluster bootstrap
[-0.0034247, 0.0897436] that includes zero; dropping the single largest cluster (15 receipts) leaves
+0.034615. Under the pre-registered rule this is `supported_but_not_cluster_robust`, so the >= 3-point claim
stays unconfirmed.

My independent recomputation from the pinned `analysis.json` (`art_7a3e316b670e44ad82e486350046d0fc`,
sha256 `349701c9…`), `holdout_per_receipt.json` (`art_b7a060078d0c492cacbc56e23714c98c`, sha256 `c44ec7a7…`)
and `error_audit.json` (`art_0d78e149d33a48979585578ffa63b459`, sha256 `395bf0df…`) reproduced, cell for
cell: the delta and both accuracies; the receipt and cluster intervals under `random.Random(20260918)` with
10,000 draws; the dominant-cluster sensitivity; the per-receipt delta distribution {-2:1, -1:9, 0:45, 1:24,
2:1}; whole-receipt exactness 35 -> 44 with 19 fixed / 10 broken / 51 tied; invalid-output rate 0/80 in both
arms; the 41-cell error audit (39 `model_miss` — company 16, total 14, address 6, date 3 — plus 2
`near_miss`, 0 `unsupported_gold`, 0 `format`); the three frozen prompt hashes and their lengths
(P0 `3de152a6…`/519 chars, P1 `06ebd802…`/1674, P2 `fc04c0cd…`/2602); the byte-identical shared
output-format paragraph; and the kit dataset member `sha256 3abff953…` inside
`art_e70f750a8bc64b66804ebef8dbe78260`. The arithmetic, the provenance chain and the not-confirmed verdict
are therefore sound as reported.

The most synthesis-relevant finding is that the *pattern behind* the gain is better supported than the
aggregate claim: the improvement replicates across dev and holdout **only** in the merchant-name field
(company 0.5417 -> 0.7917 dev; 0.5625 -> 0.7875 holdout), while date is at ceiling and never moves in either
split, and the address/total directions **disagree** between the two splits. Two tensions I found
independently are unresolved in the current paper text: (1) the Results sentence that attributes zero
residual error to BIO/OCR label artifacts rests on a near-tautological check, because kit gold is
reconstructed from the same OCR token stream, so that check cannot detect label noise; (2) the
contamination self-check undercounts — I find four dev/holdout gold strings inside the prompt text, not the
two the report states. Three further residuals (stale exhibit pointer, P1-left-untested specificity,
content-vs-length confound) and the usual one-model/one-sample limits bound what can be generalized.

## Corpus and what is actually settled

`workflow_status_and_next` on the parent research cycle `wf_fde9a71152ca42b182d96e202c33b766` shows exactly
two settled dependencies: the kit task `wf_c948778f526349d798d656d07b98ed33` (done, verdict pass,
`review_2773ccf6af6d48cea7ac5a79df167e63`) and the experiment `wf_81745bc7a920474dab27a0423ecdd8b0`
(complete, verdict pass, `review_1652f29f6cd94557bab696223516f4a0`). There is one claim and no second
experiment, so "cross-corpus" synthesis here means dev-vs-holdout replication inside a single study plus the
data-integrity substrate it rests on. I state that plainly rather than dressing one pilot as a literature.

Claim lifecycle, as recorded:

- `claim_b5d14a2303a94336a86154cd5feccc4d`, status `active`, confidence `low`, revision 0, scope text-only
  public SROIE, DeepSeek Flash, fixed non-thinking settings — never raised or lowered after the result.
- Plan `art_96374c8145464f25a11fb4e7760b8eaa` (sha256 `6885f227…`) passed independent review
  `review_c4b320f2cf584037ac1eef4cfd09a79f` before execution.
- Attempt 1 review `review_7bd7b9552303402789145b90f6879f44` returned `needs_changes` for
  reporting-fidelity defects only (superseded bundle hashes, one paper sentence not backed by the logs), with
  every measurement already reproducing.
- A verification pass produced the corrected report `art_171188f3da2a4e5f8d04dd41742278e3`
  (sha256 `e813ae25…`) and producer recomputation `art_a2326681879145e3b557e5115db477b1`
  (sha256 `5a9c3019…`); final review `review_1652f29f6cd94557bab696223516f4a0` passed with three
  non-blocking residuals still open.

A pattern worth recording: two independent reviews reproduced every scored number exactly, and the only
rework ever required was in prose and metadata, not in the science. The corollary is that the *reported
interpretation* is the weakest link in this corpus, which is where the two tensions below bite.

## Supported patterns

- **Field-level effect replicates; aggregate effect does not clear the gate.** Company rises sharply in both
  splits (dev P0 0.5417 -> P2 0.7917; holdout 0.5625 -> 0.7875), which is the single most reproducible signal
  in the corpus and the bulk of the aggregate delta. Source: `analysis.json` (recomputed against
  `error_audit.json`, which is internally consistent with P2's per-field counts — company 63/80, total 65/80,
  address 74/80, date 77/80).
- **Date is insensitive to this intervention.** 0.9583 in all three dev arms and 0.9625 in both holdout arms
  — a ceiling, not a treatment effect.
- **Format compliance is saturated.** Invalid-output rate is 0.0000 in every arm and both splits
  (recomputed), so the arms differ in extraction guidance, not in the ability to emit parseable JSON.
- **Provenance and freeze ordering are real, not narrated.** Prompt hashes match the plan's frozen values
  (recomputed); the shared output-format paragraph is byte-identical across arms (recomputed); and the
  metrics exhibit `art_f1d4adec8ce64f04a1961f1d9dfb19af` (sha256 `b7d503c7…`) pins `prompts_frozen.json`
  at 02:43:45.914Z and `selection_checkpoint.json` at 02:44:50.729Z. The claim that freezing preceded the
  confirmatory calls was independently checked against the 237-row operator journal
  `art_18d638429e994c29ae7542d31cdbbb63` (sha256 `72757dc6…`) by both reviewers; I did not re-parse the
  journal, so I attribute that check to `review_7bd7b955…` and `review_1652f29f…`.

## Negative results

- **The pre-registered claim is not confirmed.** Company-cluster interval [-0.0034247, 0.0897436] spans
  zero; the plan's own gate requires both lower bounds above zero. Directional pilot, not a confirmed effect.
- **Address and total go the wrong way under P2 on holdout.** Address 0.9500 -> 0.9250 and total
  0.8250 -> 0.8125 (recomputed via the error audit and `analysis.json`), contradicting the plan's expectation
  that address would dominate the error budget.
- **The selection stage picked between near-ties.** Dev overall accuracy was P0 71/96, P1 80/96, P2 81/96
  (`analysis.json`, recomputed structure). P2's entire margin over P1 is one cell out of 96, decided by the
  first tie-break; P1 was then dropped and never run on holdout, so "worked examples beat field rules" is
  untested out of sample.
- **No failure signal to explain away.** 237 attempts, 0 retries, 0 failures, 0 unscored receipts
  (consistent across `analysis.json` and both reviews) — there is no null result to attribute to
  infrastructure.

## Unresolved tensions

1. **Zero-label-artifact attribution is vacuous as stated.** The Results section (`paper.read`, results rev 1)
   says "0 are `unsupported_gold` … every wrong gold string was recoverable verbatim from the input, so no
   residual error is attributable to BIO/OCR label artifacts." Kit gold is reconstructed as space-joined
   maximal BIO runs *of the same `ocr_words`*, so gold being a substring of the normalized OCR input is
   guaranteed by construction. I confirmed this empirically: all 41 wrong cells pass the substring test, and
   the test would have to fail for the check to carry information. It cannot distinguish a correct extraction
   from a correctly-extracted but *wrong label*. The kit's own canonical-key cross-check
   (`art_381f40f2701842d9b5332377302c69a6`, sha256 `46e66472…`) reports address 356/626, company 492/626,
   total 562/626, date 610/626 — real label disagreement that this audit class cannot see. The measured
   numbers are unaffected; the *interpretation* that residual error is not label-related is unsupported.
2. **Contamination self-check undercounts.** The report (`art_171188f3…`) states only two dev/holdout gold
   strings appear in prompt text (27/06/18 and 50.00). My normalized substring scan of
   `prompts_frozen.json` against the full dataset finds **four**: 27/06/18, 50.00, 5.90 and 9.90, each inside
   P2 only and each a coincidental substring of a demonstration-OCR numeral (55.90, 750.00, 49.90,
   49.90). No holdout label entered the prompt, so invalidation condition 3 is not triggered — the reviewers
   reached the same substance (this count mismatch is exactly the residual they recorded) — but the reported
   check is inaccurate and remains uncorrected in the paper text.
3. **Content is confounded with length.** P2 costs 2.76x tokens (486 -> 1343 mean; recomputed), and no
   length-matched control was run, so "worked examples help" is not separated from "longer prompt helps".
4. **Dev error profile is not representative.** For P0, address is the worst dev field (0.625) but nearly the
   best holdout field (0.95), while holdout sweeps errors into company/total. A 24-receipt selection split
   that is this unrepresentative on the plan's own focal field makes the selection stage — and any future
   selection-based claim — noisy in a way the single reported point estimate does not convey.
5. **Reporting residuals still open.** The report points at a superseded exhibit (`art_09aad815c8274f4a819c43273bcb3f1b`,
   sha256 `598c078a…`, 20 files) while the pinned exhibit for the submission is `art_f1d4adec8ce64f04a1961f1d9dfb19af`
   (sha256 `b7d503c7…`, 23 files). Non-blocking, but it means the paper's cited provenance can mislead a
   reader who follows it literally.
6. **Settings are only indirectly assured.** The broker did not echo temperature/thinking/max_tokens, so those
   fixed settings are inferred from stable `system_fingerprint`, valid JSON-object output and absence of
   truncation (producer's own disclosure, endorsed by `review_1652f29f…`). I could not strengthen this beyond
   what is retained.

## Limits of generalization

- One model (`deepseek-flash`), one temperature, one sample per cell, one prompt instance per arm: the
  measured difference belongs to these two strings, not to "prompt selection" or "worked examples" as
  procedures.
- 80 holdout receipts in 44 very unequal clusters (largest 15; recomputed), so the cluster interval is the
  honest uncertainty statement and the receipt-level interval is optimistic.
- Gold is BIO-reconstructed, and absolute accuracies are not comparable to SROIE leaderboard figures; the
  benchmark is 116 text-only Malaysian receipts with one template family per merchant.
- Company grouping is a normalized-string heuristic, so "company-disjoint" is not corporate-family
  independence (kit README, `art_381f40f2…`).
- This cycle tests prompting only. Nothing here settles the untested fine-tuning comparison, and the project
  problem statement explicitly forbids reading it that way.

## What would move the claim

- More holdout receipts, or repeated samples per receipt, to tighten the company-cluster interval rather than
  the optimistic receipt-level one.
- A length-matched padding-only control to separate example content from prompt length.
- Running P1 (field rules) on the same holdout to test whether the gain is specific to worked examples.
- Replacing the unsupported "no label artifacts" sentence with an error audit against the canonical key where
  it exists, or with an explicit statement that BIO-derived label noise is unmeasured here.
- Correcting the contamination count from two to four and the stale exhibit pointer.

## Evidence examined

Pinned and read directly: `analysis.json` `art_7a3e316b670e44ad82e486350046d0fc`; `holdout_per_receipt.json`
`art_b7a060078d0c492cacbc56e23714c98c`; `error_audit.json` `art_0d78e149d33a48979585578ffa63b459`;
`prompts_frozen.json` `art_c0487fb5d1944ed69564a66a89315a95`; `selection_checkpoint.json`
`art_00dfad5ea74c44d59d50d56ecc7df4ec`; metrics exhibit `art_f1d4adec8ce64f04a1961f1d9dfb19af`;
superseded exhibit `art_09aad815c8274f4a819c43273bcb3f1b`; corrected report
`art_171188f3da2a4e5f8d04dd41742278e3`; superseded report `art_cab87395a62142059d8284fb27220220`;
kit dataset bundle `art_e70f750a8bc64b66804ebef8dbe78260` (member `kit/dataset_receipts.json`,
sha256 `3abff953f55889495cb541f4f4151c3b9f91afc4c4ceb6b839cd3406110eea15`); kit README
`art_381f40f2701842d9b5332377302c69a6`; plan `art_96374c8145464f25a11fb4e7760b8eaa`; producer verification
`art_a2326681879145e3b557e5115db477b1`; operator journal metadata `art_18d638429e994c29ae7542d31cdbbb63`.

Reviews read: `review_c4b320f2cf584037ac1eef4cfd09a79f` (plan, pass), `review_7bd7b9552303402789145b90f6879f44`
(needs_changes), `review_1652f29f6cd94557bab696223516f4a0` (final, pass). Paper documents read at the current
revisions (problem rev 1, methods rev 1, results rev 1) with their revision history.

Recomputed by me, not taken on trust: accuracies and delta; both bootstrap intervals and the dominant-cluster
sensitivity; per-receipt delta distribution and whole-receipt outcomes; invalid rates; error-audit class and
field counts and their consistency with P2 per-field accuracy; prompt hashes/lengths and the shared
format-paragraph identity; dataset member hash; and the contamination substring scan. Not recomputed by me:
raw prediction files and run logs (the reviewers re-ran the frozen evaluator on them and matched byte-for-byte),
journal timestamps and concurrency, and the canonical-key cross-check ratios (quoted from the kit README).
