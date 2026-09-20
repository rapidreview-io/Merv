# Evidence lens — `public-receipt-prompting-pilot` (reflection, attempt 1)

Perspective: **evidence** (empirical evidence, controls, uncertainty, reproducibility).
I worked only from Merv-pinned records and artifact bytes, read the retained blobs read-only, and
recomputed the science with the frozen kit evaluator plus my own resampling/provenance scripts. I did not
consult any other reflection-lens output.

Live state at the time of writing (re-read last): the `prompt-generalization` experiment
`wf_81745bc7a920474dab27a0423ecdd8b0` is **terminal** (revision 6, verdict `pass`,
`review_1652f29f6cd94557bab696223516f4a0`); its results were published as paper `results` revision 1 via
`review_1652f29f...`; the only work in progress in the project is this reflection wave. Nothing in the
experiment is unfinished.

## Summary

Every scored number in the current research **reproduces exactly** from the pinned bytes. I reassembled
revision C of the evidence bundle (sha256 `798c00e0e8e785b54018f43263459473a9bb6e3fafaaa3017233f23712d6ce05`,
23 payload files, 23/23 internal `SHA256SUMS` OK), extracted the inherited kit
(`dataset_receipts.json` `3abff953…`, `evaluate.py` `7980231e…`), reran the frozen evaluator on the
retained predictions, and re-implemented the paired bootstrap, the company-cluster bootstrap, the
dominant-cluster sensitivity and the error audit myself: **0 disagreements** with `analysis.json`
(`art_7a3e316b670e44ad82e486350046d0fc`). The operator journal
(`art_18d638429e994c29ae7542d31cdbbb63`, gzip `72757dc6…`) records 237 attempts, 236 of which match the
producer run logs byte-for-byte on system and user messages; prompt and selection freezes genuinely precede
the first call and the first holdout call; the ≤4-concurrency constraint holds. The producer/paper verdict
(*not confirmed*) is honest and follows from the pre-registered rule.

The evidence nonetheless **does not support three things the current text asserts or implies**, and one of
them is a genuine measurement defect rather than a wording problem:

1. The pre-registered rule does not test the claim as written. The claim is a **≥ 3-point** improvement; the
   rule only requires *point estimate ≥ 3 points and both interval lower bounds > 0*. In my own resampling,
   **18.6 %** of receipt-level bootstrap draws fall **below** 3 points (one-sided 95 % lower bound
   **+1.56 points**), so the data are consistent with a sub-threshold effect even before clustering is
   considered.
2. The residual-error claim “**no residual error is attributable to BIO/OCR label artifacts**” is not
   supported by the test used, and is contradicted by direct inspection. The test used
   (`unsupported_gold = gold not literally present in the input`) can **never** fire: gold is a
   contiguous span of the same OCR tokens, so it is verbatim-in-input for **320/320** holdout cells and
   **464/464** cells across the whole kit. Using it, 13 of the 14 `model_miss` total cells were labelled
   model misses although their gold carries a currency token (`RM…`) and 12 of the 14 match the model modulo
   non-digits.
3. That currency artifact is **arm-asymmetric** and biases the reported per-field `total` result *against*
   the selected arm: on the 15 holdout receipts whose gold total carries `RM`, P2 is wrong 13 times (12 with
   the correct digits) while P0 is wrong 5 times; on the 65 un-prefixed totals P0 is wrong 9 times and P2
   twice. The three P2 worked examples all show un-prefixed totals, so P2 learned the demonstrated
   convention and was penalised for it.

Net reading: the **direction** (worked-example prompt beats a plain instruction) is consistent across every
convention I tried, and the producer correctly refuses to confirm it. The **magnitude**, the
*merchant-population* generality (40 % of the net gain comes from one 15-receipt cluster) and the current
**error-attribution sentence** are not established.

## 1. Evidence I actually examined

| Evidence | Identifier / hash | What I did |
|---|---|---|
| Approved plan | `art_96374c8145464f25a11fb4e7760b8eaa` (`6885f227…`) | read for the pre-registered metric, rule, uncertainty plan and invalidation conditions |
| Frozen prompts + template | `art_c0487fb5d1944ed69564a66a89315a95` (`b534fecd…`) | recomputed sha256 of each `prompts[…].system`; compared with the plan hashes |
| Pre-holdout selection checkpoint | `art_00dfad5ea74c44d59d50d56ecc7df4ec` (`fe5f0dd9…`) | checked content, creation time, and that it precedes the first holdout call |
| Revision C bundle (6 parts) | `art_2bfaa9d24bda4430ac24ce27f0cd893b`, `art_e6744177cc14449fa5f60c055850e4e0`, `art_e51cda8d03b043c4b13a633d66a1f417`, `art_f01356ede02f42818c1d8a270fd1b09d`, `art_5467a6ad85fb413da7edf7139ac70c96`, `art_9fabda1650734abc9432959352478ef2` | reassembled → `evidence_bundle.tar.gz` `798c00e0…`; verified its `SHA256SUMS`; read `predictions/`, `run_logs/`, `code/`, `analysis.json`, `holdout_per_receipt.json`, `error_audit.jsonl`, `prompts_frozen.json`, `selection_checkpoint.json` |
| Metrics | `art_7a3e316b670e44ad82e486350046d0fc` (`349701c9…`) | target of independent recomputation |
| Per-receipt holdout cells | `art_b7a060078d0c492cacbc56e23714c98c` (`c44ec7a7…`) | recomputed delta counts, win/loss/tie |
| Error audit | `art_0d78e149d33a48979585578ffa63b459` (`395bf0df…`) | recomputed all 41 rows cell-by-cell, then re-examined each row by hand |
| Producer verification | `art_a2326681879145e3b557e5115db477b1` (`5a9c3019…`) | cross-checked its claims against my own numbers |
| Report (producer) | `art_171188f3da2a4e5f8d04dd41742278e3` (`e813ae25…`) | checked each assertion against evidence |
| Recovered smoke call | `art_ad7fc871cddd460e9f6695ddf5cb398e` (`83d8e80a…`) | matched against journal row 1 |
| Operator journal (all 237 requests) | `art_18d638429e994c29ae7542d31cdbbb63` (gzip `72757dc6…`, payload `c1c09ecd…`) | verified row count, settings, concurrency window, and 236/236 hash agreement with the run logs |
| Inherited kit | data task `wf_c948778f526349d798d656d07b98ed33` (review `review_2773ccf6af6d48cea7ac5a79df167e63`, `pass`); `source_manifest.json`, `splits_manifest.json`, `dataset_receipts.json` `3abff953…`, `evaluate.py` `7980231e…`, `canonical_key_crosscheck.json`, raw rows-API/parquet payloads | re-verified kit hashes and retained source schema/counts; used the canonical-key crosscheck for measurement-validity limits |

## 2. What reproduces exactly (independent verification)

- **Kit and bundle integrity.** Revision C reassembles to `798c00e0…` with 23 payload files and 23/23
  `SHA256SUMS` entries OK. Kit dataset `3abff953…`, evaluator `7980231e…`,
  `holdout_freeze.json` `52760593…`, `render_ocr.py` `6d4447e8…` match the pre-registered hashes.
- **Metrics.** Frozen evaluator on the retained prediction files: dev P0 `0.7396`, P1 `0.8333`, P2 `0.8438`;
  holdout P0 `264/320 = 0.8250`, P2 `279/320 = 0.871875`; whole-receipt exact `35/80 → 44/80`; invalid rate
  `0.0000` in both arms; every per-field value equal. **0 disagreements** with `analysis.json`.
- **Primary contrast and uncertainty.** `+0.046875`; receipt bootstrap `[0.009375, 0.084375]`; company-cluster
  bootstrap over 44 groups `[-0.003425, 0.089744]`; dominant cluster `gerbang alaf restaurants sdn bhd`
  (15 receipts) removed → `+0.034615`; per-receipt delta counts `{-2:1, -1:9, 0:45, 1:24, 2:1}`; whole-receipt
  outcomes `19 fixed / 10 broken / 51 tied`. Reproduced bit-for-bit; both intervals are also stable across
  five alternative bootstrap seeds (cluster low stays `-0.0039…-0.0031`).
- **Execution controls.** 236 logged rows (`72 dev + 160 holdout + 4 smoke`), all HTTP 200, all `attempt=1`,
  `error_class=None`, `provider_model=deepseek-flash`; **236/236** `system_sha256` values equal the frozen
  prompt for their arm; **236/236** user messages reproduce `"Receipt OCR text:\n" + flat OCR`; **0**
  cross-arm input-hash conflicts over 104 scored receipts; predictions equal the run-log `raw_content`
  **232/232**; token sums/means equal `analysis.json` (holdout `486.1625` vs `1343.2375`, 2.76×).
- **Journal.** 237 distinct attempts numbered 1–237, all status 200, request settings identical
  (`deepseek-flash`, `temperature 0`, `max_tokens 768`, `thinking disabled`, `response_format json_object`);
  dispatch-interval **max concurrency 4**; window `02:43:49.590Z–02:45:35.578Z`; 236 rows match the run logs on
  both message hashes; the single journal-only row is #1 and is preserved verbatim in
  `art_ad7fc871cddd460e9f6695ddf5cb398e`.
- **Freeze ordering.** `prompts_frozen.json` created `02:43:43.623Z` (submitted `02:43:45.914Z`) precedes the
  first call at `02:43:49.590Z`; `selection_checkpoint.json` created `02:44:48.213Z` (submitted `02:44:50.729Z`)
  precedes the first holdout call at `02:44:54.832Z`. The timing is independently attested by the
  operator-owned journal, not only by producer artifacts.
- **Prompts and provenance.** sha256 of the frozen `P0/P1/P2` system strings equals the plan hashes
  (`3de152a6…`, `06ebd802…`, `fc04c0cd…`). The three exemplars are exactly the three shortest demonstration
  receipts (set-equal; frozen order is id-sorted), and P1’s quoted example strings occur only in
  demonstration-split receipts.
- **Source authenticity (retained payloads).** The retained rows-API pages use the documented schema
  `(id, words, bboxes, ner_tags, image_path)`; the manifest records the HF datasets-server base,
  `X-Revision 2f8c28dfc9b70648bd6c6b04362324d158ebc8e7`, per-response sha256, fetch time `02:18Z`, counts
  `973 = 626 train + 347 test`, `372` company groups, `958` distinct normalized OCR texts, and licensing as
  **undeclared by the mirror** (ICDAR-2019 provenance noted). Gold reconstruction was re-derived
  independently by the data-task reviewer (116/116 records) and I found no basis to doubt it.

## 3. Findings — where the evidence is weaker than the text

### F1 (material). The decision rule does not test a ≥ 3-point effect
Claim `claim_b5d14a2303a94336a86154cd5feccc4d` states a **≥ 3 percentage-point** improvement. The
pre-registered rule confirms only if `delta ≥ 0.03` **and both interval lower bounds > 0**. My independent
resampling of the frozen per-receipt cells:

- receipt-level paired bootstrap: `P(delta < 0.03) = 0.186`; one-sided 95 % lower bound `+0.0156`;
- company-cluster bootstrap: `P(delta < 0.03) = 0.239`; one-sided 95 % lower bound `+0.0057`;
- receipt-level two-sided 95 % interval `[0.0094, 0.0844]` is consistent with +1-point effects.

So even the optimistic interval does not exclude sub-threshold improvements. “Not confirmed” is right, but
the reason is broader than the cluster interval spanning zero: **the magnitude in the claim is not
demonstrated at all.**

### F2 (material). The receipt-level reading of the claim is not significant even ignoring clustering
Claim wording refers to “four-field receipt extraction accuracy”. The pre-registered metric is field-cell
accuracy. On the coarser whole-receipt-exact metric I computed a paired delta of **+0.1125** with a
receipt-level paired bootstrap 95 % interval **[-0.0125, +0.2375]**, which includes zero. The two readings
of the claim therefore give different answers, and this should be stated rather than left ambiguous.

### F3 (material). The effect is concentrated in one merchant cluster
Of the 15 net cells gained, **6 come from the single dominant cluster** (15 of 80 receipts). Only
**16 of 44** clusters contribute positively (5 negative, 23 exactly zero); the cluster bootstrap puts
`P(delta ≤ 0) ≈ 0.036`. Removing the dominant cluster leaves `+0.0346`, just above threshold and with no
interval reported. “Imprecise” understates it: the point estimate leans heavily on one merchant.

### F4 (material, and a defect). The residual-error test cannot detect the risk it is used to rule out
`error_audit.jsonl` classifies a wrong cell as `unsupported_gold` only when the normalized gold is not a
substring of the normalized OCR input. Because gold is reconstructed from a contiguous span of those same
OCR tokens, gold is **always** a substring of the input — I verified **320/320** holdout cells and
**464/464** cells over all 116 kit records. `unsupported_gold ≡ 0` is therefore definitional, not
evidence. The class that could detect mis-tagged span boundaries or a wrong field assignment (gold present
in the text but attached to the wrong field/span) is never reachable.

Direct inspection of the 41 wrong cells confirms the gap rather than closing it:

- **13 of 14** `model_miss` **total** cells have gold beginning with `RM`; **12 of 14** agree with the model
  after removing non-digits (e.g. gold `RM11.90` vs pred `11.90`; gold `RM8.35` vs `8.35`).
- **18 of 39** `model_miss` cells have the model output as a *substring* of gold, i.e. gold carries extra
  adjacent tokens: date gold `#2 3 /04/2017`, `568019 05 02-18`, `06/04/18 17:36`; company gold
  `A04098 AEON CO. (M) BHD`, `POSTED BEMED (SP) SDN. BHD.`; address gold prefixed by the company name
  (`PAGOH REST AND SERVICE AREA LOT R1, …`), company gold `32 PUB & BISTRO own by CNU TRADING`.
- Kit-level measurement validity is already known to be limited: exact agreement with the canonical SROIE
  key after normalization is only `address 356/626`, `company 492/626`, `total 562/626`, `date 610/626`
  (`canonical_key_crosscheck.json`), with address explicitly the weakest field.

Consequently the published sentence in paper `results` revision 1 — *“every wrong gold string was
recoverable verbatim from the input, so no residual error is attributable to BIO/OCR label artifacts”* —
is **not supported**. A correct statement would be narrower: “the audit’s `unsupported_gold` test is
vacuous by construction; manual inspection shows a material share of residual cells is a label/format
convention mismatch, and the audit cannot rule out span-boundary artifacts.”

### F5 (material). A currency-convention artifact biases the `total` result against the selected arm
The BIO `TOTAL` span inconsistently includes the printed `RM` token: 15 of 80 holdout receipts have gold
totals beginning with `RM`, 65 do not. Behaviour is arm-dependent:

| holdout totals | P0 wrong | P2 wrong |
|---|---|---|
| gold carries `RM` (n=15) | 5 (4 with correct digits) | **13** (12 with correct digits) |
| gold un-prefixed (n=65) | 9 | 2 |

P2’s three worked examples all display un-prefixed totals (`750.00`, `58.70`, `22.60`), so P2 reproduces the
demonstrated convention and is penalised for it; P0 copies the `RM` token more often. This makes the
published “P0 → P2 total `0.8250 → 0.8125` regression” largely an artifact, and it means the headline
contrast *understates* P2 rather than flattering it. Post-hoc sensitivity of the primary metric (my own
computation, not pre-registered):

| scoring convention | P0 | P2 | delta |
|---|---|---|---|
| frozen (as pre-registered) | 0.8250 | 0.8719 | **+0.0469** |
| total compared modulo non-digits | 0.8594 | 0.9125 | **+0.0531** |
| alphanumeric-only for all fields | 0.8406 | 0.8781 | **+0.0375** |

Direction is robust; magnitude is convention-sensitive and approaches the 3-point threshold (3.75 points)
under the loosest variant.

### F6 (material). Selection is fragile and the tied arm was never evaluated confirmatorily
P2 beat P1 by **exactly 1 of 96** development cells (81 vs 80). Whole-receipt exactness was tied (`14/24`
each), so the rule’s own later tie-breakers (lower invalid rate, then **lower mean tokens** — P1 `814` vs
P2 `1375` — then arm id) would have selected the cheaper P1 on a one-cell swing. Only P0 and P2 ran on the
holdout, so the confirmatory stage cannot separate “worked-example content” from the field guidance P1 also
contained (on development both improved `company` identically, `0.5417 → 0.7917`). The `+4.69`-point figure
is the effect of **one selected string**, not of the selection procedure.

### F7 (known, still material). Length/richness confound
P2’s system prompt is **2602** chars vs P0’s **519** (5.0×); mean tokens `486 → 1343` (2.76×). There is no
length-matched control, and the natural intermediate control (P1, 1674 chars) was dropped before the
holdout. The producer discloses this, but it means the causal story is “this longer, richer string beat this
short string”, not “demonstrations teach extraction”.

### F8 (metadata/reporting residuals — cheap to fix)
1. **Contamination count is wrong.** The report and `producer_verification.json` say two dev/holdout gold
   strings appear in prompt text. A plain normalized substring screen finds **four**: `50.00`, `27/06/18`,
   `5.90`, `9.90`, all incidental substrings of demonstration OCR (e.g. `5.90` inside `55.90`, `9.90` inside
   `49.90`). No true leakage either way, but the reported check count is not reproducible as stated.
2. **Stale exhibit citation.** The report’s “Interpretation of the pinned metrics exhibit” paragraph still
   names `art_09aad815c8274f4a819c43273bcb3f1b` (`598c078a…`, 20 files) as *the* pinned exhibit; revision 5
   pins `art_f1d4adec8ce64f04a1961f1d9dfb19af` (`b7d503c7…`, 23 files).
3. **Mis-escaped frozen template.** `prompts_frozen.json` stores `user_message_template` as
   `"Receipt OCR text:\\n{flat_ocr}"` (literal backslash-n), which does **not** byte-match the message
   actually sent (`"Receipt OCR text:\n" + flat`). The run-log hashes match the real newline form; a reviewer
   trusting the template field would reconstruct nothing. Verified 236/236 against the real form.
4. **Mislabeled smoke rows.** The 4 non-scored smoke rows carry `parse_result`
   `"unparseable_json:AttributeError"` although their `raw_content` is valid four-key JSON. Non-scored, so
   science-neutral, but the label is wrong and mirrors the same defect the first review raised.

### F9 (boundary). What this evidence cannot speak to
Single model, single temperature, one sample per cell, one prompt instance per arm, no
paraphrase/replication study, so **sampling variance is unmeasured** and no result generalises beyond these
two exact strings on these 80 receipts. Generation is **not** independently reproducible (provider/broker
responses are opaque digests; provider-side `temperature`/`thinking`/`max_tokens` are attested only by the
operator-written request journal, never echoed by the provider). Absolute accuracy is not comparable to
SROIE leaderboards because gold is BIO-reconstructed. Invalid-output handling — a pre-registered reporting
duty — was exercised **0 times** at runtime (0 invalid in both arms); its correctness rests on the kit’s
fixtures (verified in `review_2773ccf6af6d48cea7ac5a79df167e63`), not on this run.

## 4. Uncertainty statement

The defensible summary is: on 80 company-disjoint holdout receipts the worked-example prompt scored higher
than the plain instruction by a paired **+4.7 points** of field-cell accuracy; the paired interval excludes
zero but admits effects below the claimed 3-point threshold (≈19 % of bootstrap mass) and below +1 point
(one-sided 95 % LCB ≈ +1.6 points); once receipts are clustered by merchant the interval **spans zero**;
40 % of the net gain comes from one 15-receipt cluster; and the magnitude moves between +3.75 and +5.31
points depending on label convention. Nothing in this run establishes a **≥ 3-point** effect, and nothing
establishes generalisation to unseen merchants.

## 5. Reproducibility assessment

- **Evaluation: fully reproducible.** Every metric, interval, sensitivity and error-audit row reproduced
  from pinned bytes with the frozen evaluator and stdlib Python only. My scripts and transcripts are in the
  lease workspace (`audit/audit.py`, `audit/integrity.py`, `audit/journal.py`, `audit/provenance.py`,
  `audit/gold_quality.py`, `audit/sensitivity.py`, `audit/threshold.py`, `audit/rm_balance.py`,
  `audit/rm_detail.py`).
- **Execution: auditable but not reproducible.** Calls are fully logged and independently journaled, but
  re-running would require the same broker, model snapshot and provider behaviour.
- **Provenance: auditable.** Kit hashes, bundle hashes, prompt hashes, freeze timestamps and journal
  agreement all check out; source payloads are retained and hash-pinned (upstream re-fetch was not possible
  in this lease because network is restricted, so I relied on the retained payloads plus the data-task
  reviewer’s independent re-derivation).

## 6. Boundaries of this audit

I did not consult other lens outputs (theory/methods/synthesis/next_steps), did not re-fetch the upstream
HF dataset, and did not attempt to verify the provider actually served `deepseek-flash` beyond the
self-consistent `system_fingerprint`, tokens and journal settings. I did not re-derive the whole 973-row
source corpus; I verified the retained slices and relied on the data-task review for full-corpus
reconstruction.

## 7. Recommended corrections (cheapest first)

1. Replace the residual-error sentence with the narrower, correct statement (F4), and re-run the error audit
   on the **digit/format-normalized** total convention and with an explicit span-boundary rule (F4, F5).
2. State the primary result against the claim explicitly: point estimate clears 3 points, but neither
   interval excludes sub-3-point effects; report the one-sided lower bounds (F1) and the whole-receipt
   interval (F2).
3. Report the dominant-cluster-removed estimate **with** an interval, and the per-cluster contribution
   counts, next to the point estimate (F3).
4. Fix the four metadata residues: contamination count (4, not 2), exhibit citation, the mis-escaped
   `user_message_template`, and the smoke-row `parse_result` label (F8).
5. Next design step should include a **length- and token-matched control** and either re-run P1 on the
   holdout or pre-register selection on a larger development split, so that “selection” rather than “one
   string” is being tested (F6, F7).
