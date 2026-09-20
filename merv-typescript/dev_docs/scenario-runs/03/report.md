# Scenario run — Parlay

- Result: **DIVERGED**
- Brief: `/Users/guraltoo/Documents/dev/proj/experiments/Merv/Scenarios/briefs/03-cut-serving-cost-without-losing-the-tail.md` (sha256 `64a7ff2086fcdef2…`)
- Project: `project_3f1ccc3d2f5246dd954bfacbe07c8f5e`, cycle `wf_5b0f12c750964d2b992463451f292ddd`
- Server: https://experiments.rapidreview.io
- Ran 2026-09-18T11:07:46.871Z → 2026-09-18T12:28:47.639Z (4861 s)
- Codex executions: 133 (133 runner-dispatched, 0 harness-leased)

## Divergence

**trajectory** on `awq-70b`: expected `design_review`, observed `complete`.

awq-70b reached complete at step 2 where the brief expects design_review: planned -> complete

## Claims

- C1 → `claim_a45125e5d6254043a16dd22ac6b2b1d0`
- C2 → `claim_9e82fa19620d4a958c37670d39962c4c`
- C3 → `claim_8de0725b5dc740e0a382e133eeeabf46`

## task `slice-evals` — `wf_e672d32c0a1e4b1f94f6879dc334440f`

Expected: in_progress → in_review → in_progress → in_review → done
Observed: done

| state | entered | held |
| --- | --- | --- |
| done | 2026-09-18T11:07:47.988Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`

> The apparatus is implemented, but it is not ready to freeze: long-context has only one item without an authoritative count exception in the review context, and raw scores and timing cannot be independently checked through this lease. The declared model/data substitutions and human-label waiver are accepted.

- criterion 1: `not_met` — Decoded and parsed all five pinned JSONL files independently: English 300, non-English 300 (de/fr/es 100 each), long-context 1, tool-call 300, refusal 300; IDs unique within each slice, English/tool IDs disjoint. Checked all 900 MTOP gold trees against the actual recursive schema constraints; none invalid. Manifest and builder state and implement URL/email/IP/phone replacement and per-thread usern
- criterion 2: `waived` — Captured project context revision 1 explicitly waives human labels because no labeller is available and directs the reviewer to record check 2 as waived. Record that waiver for this demonstration only; calibrated human agreement is unnecessary under that explicit project scope, not demonstrated. Inspected run_eval.py: tool calls use JSON parsing, schema validation and recursive equality; four othe
- criterion 3: `not_verified` — Inspected harness implementation: 32 async logical sessions behind a shared barrier, TCP connection limit 32, round-robin closed-loop replay of recorded substitute inputs, warm-up before timing and judge calls afterwards; monotonic request-to-first-nonempty-SSE TTFT and linear-interpolated quantiles. Stated rate is $1.29/GPU-hour on one A10. Independently recomputed throughput 47294/406.707484406=
- criterion 4: `not_verified` — The Qwen2.5-7B-Instruct bf16/1xA10 fallback is explicitly authorized by captured project context; absence of a literal 70B run is not a defect for this demonstration. Submitted results.json covers all five slices, with correct totals 102/300, 75/300, 0/1, 4/300 and 237/300 and consistent percentage arithmetic. Inspected launch command and client: pinned model revision a09a35458c702b33eeacc393d1030
- criterion 5: `waived` — Waive the literal production-ticket requirement under captured project context revision 1: Parlay is fictional, no production tickets exist, and MTOP, original Ubuntu threads used by the v2 generator, and CoCoNot are the expressly named substitutes. Production data is unnecessary for this scoped workflow demonstration. Inspected manifest, all slice records, builder source and retained upstream doc

**Round 2** (revision 3) — verdict `needs_changes`

> Raw evidence is now readable and independently reproduces the baseline scores and 32-session latency results. The scored long-context slice still has only 1 of the required 300 items, with no authorized count exception. The apparatus cannot be frozen.

- criterion 1: `not_met` — Independently reconstructed the archive and parsed all five JSONL slices, verified their manifest hashes, unique IDs, language counts and all MTOP gold trees against the retained recursive schema. Counts are English 300, non-English 300 (de/fr/es 100 each), tool-call 300, refusal 300, long-context 1. Manifest and builder state deterministic URL/email/IP/phone redaction and per-thread username repl
- criterion 2: `waived` — Human calibration is explicitly waived by captured project context revision 1: no labeller is available, and the reviewer is directed to record check 2 as waived. This is necessary for the declared demonstration, not evidence of calibrated quality. Inspected protocol and scoring source; independently reproduced all 300 tool-call scores using strict JSON parsing, recursive schema validation and exa
- criterion 3: `met` — Under the captured demonstration's authorized recorded substitute inputs, inspected the complete latency client and independently checked all 1,201 raw request records against trace order and session assignment. Recomputed peak in-flight concurrency 32, closed-loop nonoverlap within each session, warm-up before replay and judges after replay. Recomputed 47,294 completion tokens, p50/p95 TTFT 0.737
- criterion 4: `met` — Met for the explicitly authorized Qwen2.5-7B-Instruct bf16/one-A10 fallback in captured project context revision 1, not literal 70B/H100. Independently verified all 19 transport-part hashes, reconstructed the 1,352,617-byte storage archive obj_j9dv6sxsqurvk6vu with SHA256 5c69110a311146aedee675242248184aeca2c1d3bffd86c7ac7f9a84a268f147, and checked every one of 2,143 indexed member hashes/sizes. V
- criterion 5: `waived` — Captured project context revision 1 expressly states that Parlay is fictional, no production tickets or support-QA labels exist, and MTOP, Ubuntu original threads and CoCoNot are the authorized substitutes. Literal production provenance is therefore unnecessary for this demonstration and explicitly waived. Inspected corpus identities, versions/hashes, manifest, builder and actual retained records;

**Round 3** (revision 5) — verdict `needs_changes`

> Freeze approval is blocked: the long-context slice has 1 of 300 required scored items. Raw outputs, scores and 32-session latency metrics verify under the declared model/data substitutions. Human calibration and production provenance are explicitly waived; item counts are not.

- criterion 1: `not_met` — Counted retained JSONL records and verified slice SHA256 values against the corrected manifest: English 300, non-English 300 (de/fr/es 100 each), tool-call 300, refusal 300, long-context 1. All 300 tool gold trees satisfy the declared recursive schema. Manifest and builder state deterministic URL/email/IP/phone replacement and per-thread username pseudonyms; corpora and revisions/licenses are decl
- criterion 2: `waived` — Captured project context revision 2 explicitly directs waiver of human labels because no labeller is available in this fictional demonstration. This makes literal 100-label-per-slice calibration unnecessary for the authorized demonstration only; it does not establish calibrated correctness. Protocol and results correctly report labels=0, agreement=null/unknown, below-85% status unknown, and UNCALI
- criterion 3: `met` — Verified under the explicitly authorized recorded substitute-data context, not production arrival traces. Inspected scripts/run_eval.py: 32 persistent closed-loop sessions, round-robin interleaved recorded inputs, common start barrier, monotonic TTFT to first nonempty SSE content, warm-up excluded and judges after baseline. Checked all 1,201 trace assignments and per-session non-overlap, and compu
- criterion 4: `met` — Verified for the explicit captured Qwen2.5-7B-Instruct bf16 / one-A10 fallback, not literal 70B/H100. Runtime log shows pinned model/tokenizer revision a09a35458c702b33eeacc393d103063234e8bc28, torch.bfloat16, tensor parallel size 1, quantization=None and speculative_config=None. Every baseline payload uses temperature=0, top_p=1, seed=0, max_tokens=512 and the retained slice input; all 1,201 outp
- criterion 5: `waived` — Captured project context revision 2 contains the explicit operator note dated 2026-09-17: criterion 5, 'production tickets', is a transcription defect and reviewers record it as waived. The fictional demonstration has no production tickets or support-QA labels. MTOP, Ubuntu and CoCoNot are the declared substitutes, as reflected in the inspected manifest, builder and retained slice records. Product

**Round 4** (revision 7) — verdict `needs_changes`

> The retained baseline and latency results reproduce, but the long-context slice contains only 1 of 300 required items. Human calibration and production-ticket provenance are explicitly waived; the 7B/A10 substitution is authorized. The overall goal remains unmet and the apparatus must not be frozen.

- criterion 1: `not_met` — Independently reconstructed the pinned raw archive and counted actual slice JSONL records: English 300, non-English 300 (de/fr/es 100 each), tool-call 300, refusal 300, long-context 1. Slice hashes match the corrected manifest, IDs are unique, and all 900 MTOP gold trees validate against the retained recursive schema. The manifest states deterministic URL/email/IP/phone replacement and per-thread 
- criterion 2: `waived` — Captured project context revision 2 explicitly waives human labels because no labeller is available and instructs the reviewer to record check 2 as waived. This demonstration therefore does not require human agreement to proceed, but every judged score must remain UNCALIBRATED. Verified protocol and results report labels=0, agreement=null, below-85% status unknown, and the uncalibrated caveat on a
- criterion 3: `met` — Under the explicitly authorized recorded substitute-data scope, inspected the retained client: 32 barrier-started closed-loop logical sessions, deterministic interleaving, round-robin assignment, and no timed judge traffic. Independently checked all 1,201 trace assignments, no within-session overlap, peak in-flight concurrency 32, warm-up before baseline, and all judge requests after baseline. Raw
- criterion 4: `met` — Met for the explicitly authorized Qwen2.5-7B-Instruct bf16/one-A10 substitute, not as evidence of 70B/H100 behavior. Verified all 19 transport-part hashes and reconstructed the 1,352,617-byte archive with SHA256 5c69110a311146aedee675242248184aeca2c1d3bffd86c7ac7f9a84a268f147, identified by delivery as storage object obj_j9dv6sxsqurvk6vu; all 2,143 indexed member sizes/hashes match. All 1,201 base
- criterion 5: `waived` — The OPERATOR NOTE dated 2026-09-17 in captured project context revision 2 explicitly identifies the standalone words 'production tickets' as a transcription defect and waives criterion 5. The fictional demonstration has no production tickets or customers; MTOP, Ubuntu Dialogue Corpus and CoCoNot are the named substitutes throughout. Inspected manifest, protocol, provenance and captured context con

**Round 5** (revision 9) — verdict `needs_changes`

> The apparatus cannot be frozen: the scored long-context slice contains 1 of 300 required items, with no count waiver. Raw records support the historical substitute-model baseline and latency results. Human calibration and production-ticket wording are explicitly waived.

- criterion 1: `not_met` — Independently decoded and hash-verified the 19 raw parts and six audit parts, reconstructed both archives, verified 2,143 indexed raw members and all 15 embedded audit file hashes. Counted actual JSONL rows: English 300; non-English 300 (de/fr/es 100 each); tool-call 300; refusal 300; long-context 1. All 300 tool gold trees satisfy the retained recursive schema. Manifest states source versions and
- criterion 2: `waived` — Captured project context revision 2 explicitly waives human labels because no labeller is available and directs criterion 2 to be recorded waived. This is an authorized demonstration limitation, not evidence of calibration. Protocol defines exact recursive schema/JSON equality for tool calls and slice-specific resolution proxies for the other four slices. Inspected harness scoring implementation a
- criterion 3: `met` — Inspected retained run_eval.py: deterministic recorded substitute-input interleaving, round-robin assignment to 32 barrier-started closed-loop sessions, connector limit 32, untimed warmup and judging after timed replay. Verified all 1,201 trace assignments and no overlap within each session; independent interval sweep gives peak concurrency 32. Recomputed from raw records 47,294 server-reported ou
- criterion 4: `met` — Met for the historical five-slice run under the explicit Qwen2.5-7B-Instruct bf16/one-A10 substitution in captured project context, not evidence for 70B/H100 or approval of criterion 1. Reconstructed retained archive SHA256 5c69110a311146aedee675242248184aeca2c1d3bffd86c7ac7f9a84a268f147 and verified every indexed member. Counted all 1,201 baseline and 901 judge objects; baseline IDs exactly cover
- criterion 5: `waived` — Captured project context revision 2 includes the operator's explicit 2026-09-17 waiver: standalone 'production tickets' is a transcription defect. The company is fictional and no production tickets exist; MTOP, Ubuntu and CoCoNot are the authorized substitutes throughout. Inspected manifest/protocol source disclosures, consistent with the actual retained slice records. Waiver is necessary for the 

**Round 6** (revision 11) — verdict `needs_changes`

> The apparatus cannot be approved or frozen: the scored long-context slice contains 1 of 300 required items. The historical substitute baseline and 32-session replay check out. Human calibration and production-ticket wording are explicitly waived; the count minimum is not.

- criterion 1: `not_met` — Counted the actual hashed JSONL rows: English 300, non-English 300 (de/fr/es 100 each), tool-call 300, refusal 300, long-context 1. All 300 tool gold trees satisfy the submitted recursive schema. The manifest specifies source versions, licences and deterministic URL/email/IP/phone replacement plus per-thread speaker pseudonyms; inspected the corresponding builder/scan code. Public MTOP/Ubuntu/CoCo
- criterion 2: `waived` — Captured project context revision 3 explicitly directs check 2 to be waived because no human labeller is available. Applied that waiver only as authorized: this does not establish calibration. Protocol and harness define schema validation plus exact recursive JSON equality for tools, and slice-specific LLM judging for the other four slices. Recomputed all 1201 scores from raw outputs, including ju
- criterion 3: `met` — Met for the retained historical authorized substitute replay. Inspected run_eval.py and verified all 1201 trace assignments, 32 distinct barrier-started closed-loop sessions, no overlap within a session, peak concurrency 32 and warmup/judge timing exclusion. Recomputed p50 TTFT=0.737142055 s and p95=1.951155713 s from retained client observations. Summed 47294 completion tokens. At recorded elapse
- criterion 4: `met` — Met for the retained historical baseline under the explicit Qwen2.5-7B-Instruct bf16/one-A10 substitution; this is not 70B/H100 evidence and does not remedy criterion 1. Runtime log identifies pinned model revision, torch.bfloat16, quantization=None and one-way tensor parallelism. All 1201 baseline requests use temperature=0, top_p=1, seed=0, max_tokens=512 and align with the five submitted slices
- criterion 5: `waived` — Captured project context revision 3 contains the operator's explicit waiver: standalone 'production tickets' is a transcription defect. This fictional demonstration has no production tickets or customers; MTOP, Ubuntu Dialogue Corpus and CoCoNot are the authorized substitutes throughout. Production provenance is neither required under this waiver nor established by the evidence.

**Round 7** (revision 13) — verdict `needs_changes`

> The summary reports are internally consistent, and checks 2 and 5 are waived under the operator notes. But the slice files, the 1,500 raw baseline outputs, the 1,200 judge outputs and the latency timings exist only in an external sandboxes storage object. Its only Merv copy stops at part 23 of 63. I could not verify checks 1, 3 or 4 independently, so this baseline must not be frozen yet.

- criterion 1: `not_verified` — What I verified: manifest art_6666c8fc (sha256 84876631...301d) has the same hash as art_665cc621, and results.json manifest_sha256 matches it. The manifest states per-slice counts of 300. Non-English is split de/fr/es 100 each, which is at least 90 each. It also states per-slice hashes, source URLs, licences and the selection rule. The de-identification method is stated: regex replacement of URL/
- criterion 2: `waived` — Waived per project context revision 4 ('HUMAN LABELS: waived. No labeller is available for this run; the task reviewer records check 2 of eval-slices as waived'). The protocol (art_42a86c84) defines per-slice scoring. Tool calls are scored by JSON parse, schema validation and exact recursive equality to the gold tree. The other four slices use a slice-specific LLM judge at temperature 0. Results a
- criterion 3: `not_verified` — The report has every required field. The harness design (art_42a86c84) replays 1,500 recorded items round-robin across 32 closed-loop sessions, measures TTFT from request start including queueing, and uses (n-1)q quantiles. Results report 32 sessions, 1500 requests, 0 errors, p50 TTFT 1.436 s, p95 TTFT 15.70 s, 104.33 tok/s/GPU on 1 A10, and $0.0034346 per 1k output tokens at a stated $1.29/A10-ho
- criterion 4: `not_verified` — results.json was submitted (art_36f43846, sha256 8af962ff...611b). It covers all five slices under the declared Qwen2.5-7B-Instruct bf16 / 1xA10 substitute for 70B. Decoding is recorded as greedy: temperature 0, top_p 1, seed 0, max_tokens 512. Score percentages match the counts: 101, 76, 138, 4 and 235 out of 300. The substitution is authorised by project context and stated as a limitation. Not v
- criterion 5: `waived` — Waived per the operator note of 2026-09-17 in project context revision 4: criterion 5 ('production tickets') is a transcription defect, and the substitute corpora (MTOP, Ubuntu Dialogue Corpus, CoCoNot) stand in for production tickets. The manifest sets production_tickets=false and claims no production provenance.

**Round 8** (revision 15) — verdict `pass`

> The rev-13 blocker is fixed: the complete archive and readable copies are now in Merv, and the part hashes and sizes match Merv's records. Slice counts, scores, latency, throughput and cost are consistent, and the tool-call counts check out. Checks 2 and 5 are waived under the operator notes. The 7B/A10 substitute and the long-context redefinition are authorized in context rev 4.

- criterion 1: `met` — The manifest (art_fdc0ab4a) states 300 items for each of the five slices and non-English de/fr/es at 100 each. It gives sources, licences, the selection rule and the de-identification method: regex URL/email/IPv4/phone replacement plus per-thread speaker placeholders, with an explicit caveat that this is not a PII guarantee. The sha256 of each readable slice artifact, as recorded by Merv, equals t
- criterion 2: `waived` — Waived. Project context rev 4 says HUMAN LABELS are waived because no labeller is available, and tells the reviewer to record this check as waived. The rest of the protocol is present. Protocol v2 defines exact recursive schema/gold equality for tool calls and slice-specific temperature-0 LLM-judge rubrics for the other four slices. results.json reports labels=0, agreement=null and flag UNCALIBRAT
- criterion 3: `met` — The protocol describes a 32-session closed-loop replay of the recorded substitute traces, with TTFT measured to the first content chunk including queueing and (n-1)q quantiles. results.json reports 32 sessions, 1500 requests, 0 errors, p50 TTFT 1.436 s, p95 TTFT 15.70 s, 104,508 output tokens over 1001.711 s, and $1.29/A10-hour on 1 GPU. I recomputed throughput: 104508/1001.711 = 104.33 tok/s/GPU,
- criterion 4: `met` — This resolves the rev-13 blocker. Merv holds all 25 archive parts. The per-part sha256 in the transport manifest matches Merv's recorded hash for each part I checked, e.g. part 1 c95819a0 and part 25 0f3780be. The part sizes, 24x180000+177772, total exactly the stated 4,497,772-byte archive. The partial 23/63 upload is marked superseded. results.json was submitted with greedy decoding: temperature
- criterion 5: `waived` — Waived under OPERATOR NOTE (2026-09-17) in project context rev 4. The standalone criterion 'production tickets' is a transcription defect that the operator has waived, and the substitute corpora stand in for production tickets. The manifest declares production_tickets=false and claims no production provenance.

## experiment `awq-70b` — `wf_5c7a7a6b6d18436294c06cff6ad4f524`

Expected: planned → design_review → planned → design_review → running → experiment_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:07:48.234Z | 2 s |
| complete | 2026-09-18T11:07:49.830Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The design cannot answer the assigned question: it replaces the frozen baseline with unmatched published numbers, leaves decoding unspecified, and provides no calibration overlap check. Restore the matched comparison and leakage controls before execution.

- criterion 1: `not_met` — Objective & hypothesis states measurable per-slice and speed thresholds, but Evaluation explicitly substitutes unspecified published bf16 values and acknowledges that the design cannot isolate quantization or adjudicate C1. Dataset, decoding, hardware and workload differences are alternative explanations for any observed deltas or speedup. An honest descriptive comparison still cannot answer the a
- criterion 2: `not_met` — Comparison baseline and controls and Outputs require published values instead of the frozen task baseline. Serving-stack defaults do not specify greedy decoding or establish identical configurations. Calibration names substitute corpora but provides no sampling split or disjointness procedure against all five slices, retained check output, or overlap invalidation. The invalidation list also omits 
- criterion 3: `not_verified` — Resources and execution boundary appropriately declares the 7B/A10 fallback, prohibits simulation, notes that 32-session workload fit remains unproven, accounts for 70B weight storage/transfer and sets spending caps. Fictional-company and substitute-data limitations are clear. However, the approved delivery, exact checkpoint/harness configuration and p95 SLO are unverified, and no basis for the fi

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `planned`

> The 7B fallback has a testable hypothesis and sound prospective leakage and per-slice rules, but the exact comparison is not ready for approval. Pin the approved frozen delivery, resolve both arms' full decoding configuration and numeric SLO, and ground workload feasibility in those inputs before resubmission.

- criterion 1: `met` — Objective & hypothesis and Decision rule define H7 for the explicitly authorized Qwen2.5-7B-Instruct/A10 fallback: every slice delta >= -1.0, throughput/GPU ratio >= 2.2, and satisfaction of the delivered p95 SLO. A single slice failure defeats the joint hypothesis; aggregate summaries are prohibited. Quantization alone is the intervention, and valid speed/SLO failures also defeat H7. The plan cor
- criterion 2: `not_met` — The plan now correctly requires the frozen slice-evals bf16 control, prohibits publications and baseline rescoring, and provides a substantive prospective calibration procedure covering all five slices via source/group IDs, raw/normalized hashes, containment and final truncated-input checks with retained output and overlap invalidation. It preserves the 32-session harness, individual slice decisio
- criterion 3: `not_verified` — Feasibility and execution boundary appropriately declares the 7B/A10 fallback before review, separates weight estimates from workload fit, includes transfer/storage and spending caps, specifies an unchanged 32-session preflight with long contexts and explicit OOM/kernel/funding stop conditions, and prohibits simulation or protocol relaxation. Scope limitations are clear. Feasibility nevertheless r

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `planned`

> The 7B/A10 fallback plan keeps a sound per-slice hypothesis, a greedy-only rule and a concrete calibration-overlap check. It is still not an approvable design: by its own account the frozen control, the full decoding values, the numeric SLO, the baseline throughput and workload fit are all unresolved. slice-evals is not yet approved and no delivery is pinned. It also uses a stale long-context slice definition.

- criterion 1: `met` — The Objective & hypothesis and Decision rule sections define H7 for the declared Qwen2.5-7B-Instruct bf16 vs AWQ-4bit fallback on an A10. H7 requires every delta_s >= -1.0 (unrounded), R >= 2.2 against the frozen matched baseline rate at 32 sessions, and meeting the p95 SLO. A single slice below -1.0 refutes it whatever the other slices or throughput show. An aggregate or mean across slices is exp
- criterion 2: `not_met` — Correctly specified: comparison only against the frozen slice-evals bf16 7B control, with no publications and no re-scoring. Greedy decoding on both arms, with temperature 0.7 prohibited. A concrete, prospective, executable calibration-disjointness procedure against all five slices, covering IDs, source groups, raw and normalized hashes, containment and a final recheck, with its output retained an
- criterion 3: `not_verified` — The plan names the 7B/A10 fallback before review and restates the model size as a limitation. It keeps weight-only estimates separate from workload fit, and gives the correct KV-cache formula, noting that AWQ does not shrink the KV cache. It budgets disk, time, egress and storage against the $200 project budget and the $60 operational cap. It specifies an unchanged 32-session preflight that includ

**Round 4** (revision 7) — verdict `pass`

> Attempt 4 fixes the attempt-3 blockers. It binds to the approved slice-evals delivery, and its scores, latency and hashes match that delivery. It states full greedy decoding on both arms and uses the operator's long-context definition. It pre-registers an SLO, computes memory, time and cost fit, and applies the rule to each slice with no aggregate. The calibration-overlap check is executable. Limits are disclosed.

- criterion 1: `met` — H (7B/A10) is a conjunction of three conditions. First, every one of the five delta_s ≥ −1.0, each computed against the frozen B_s. Second, R = T_cand/104.3295 ≥ 2.2 at 32 sessions. Third, candidate p95 TTFT ≤ 15.6995 s. The decision rule makes any single slice below −1.0 contradictory, whatever the other slices, the throughput or an aggregate show. The alternatives are explicitly separable: quali
- criterion 2: `met` — Baseline. The only comparator is the approved, frozen slice-evals bf16 Qwen2.5-7B record. I read the cited results.json (art_40be1e74), protocol_v2 (art_086dd732), manifest_v2 (art_fdc0ab4a) and delivery index (art_c6bada52). The plan's IDs, hashes, per-slice B_s and latency figures match them exactly. The baseline is never regenerated, re-scored or compared with publications. Decoding. Both arms 
- criterion 3: `met` — The 7B/A10 fallback is declared before review, uses the validated A10, and the model size is restated as a limitation. Workload fit is now computed from the pinned architecture (28 layers, 4 KV heads, head dim 128, 57,344 B/token bf16 KV). I checked the arithmetic: about 99k KV tokens for bf16 and about 270k for AWQ. The longest request of 13,426+512 tokens is below max_model_len 20000, and the fr

**Round 5** (revision 9) — verdict `pass`

> Attempt 4 was run on the approved 7B/A10 stand-in and reported slice by slice under the pre-registered rule. From the retained numbers, english-general is at −2.0 points (95 vs 101 of 300), which alone contradicts H. R = 1.063 is also below 2.2. The p95 SLO is met. The record is valid and consistent with itself, no aggregate is used, and the paper edits match the evidence. This is a sound negative result.

- criterion 1: `met` — Execution matches the approved plan. - Frozen archive: re-hashed to 5f251b81…, matching the approved delivery. - Calibration: the check ran before fitting and passed with 0 final matches on each slice. - AWQ settings: w4, g128, zero-point, GEMM. - Serving: awq_marlin kernel, with bf16 activations and KV cache. - Decoding: all 1,500 request bodies are byte-identical on both arms. - bf16 replay cont
- criterion 2: `met` — I recomputed the report's numbers from the retained JSON and they match; the exhibit pins all 7 result files with the same values. - Deltas: −2.000, +0.333, +1.667, 0.000, −0.333. - Throughput: R = 1.0629. The cost figure matches the retained formula. - Diff totals: 150 identical, and 1,089 identical on the bf16 replay. - Per-language counts sum to the slice counts. - McNemar discordant counts rec
- criterion 3: `met` — The conclusion applies the per-slice rule. english-general at −2.0 < −1.0 contradicts H on its own, and R = 1.063 < 2.2 also fails; the p95 SLO passes. No aggregate across slices is computed. The report explicitly refused a launch instruction to use a mean delta. The paired stats are presented as descriptive: they neither overturn nor strengthen the verdict. Limitations are stated: 7B/A10 not 70B,
- criterion 4: `met` — The Methods edit accurately describes the checkpoint, the AWQ settings, identical greedy decoding, calibration (320 records, 15,155 tokens, 0 overlap), the judge caveat, 32-session throughput and the per-slice rule. The Results edit lists all five slices with correct counts and deltas. It also gives R = 1.063, the p95 values of 6.23 s vs 15.70 s, McNemar p = 0.53 with CI [−7.33, +3.33], es −4 and 

## experiment `dense-32b` — `wf_be882939226c4243808bf220dc6b2e0a`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:07:48.324Z | 2 s |
| complete | 2026-09-18T11:07:49.917Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `pass`

> The plan tests C2 at a declared 3B-vs-7B stand-in on one A10, stated before review. It uses the frozen baseline unchanged, identical greedy decoding checked byte by byte, a verdict per slice with correct bounds, a replay control and retained raw outputs. The known weaknesses (judge self-preference, the tool-call floor, 300-item noise) are acknowledged and do not make the design unsound.

- criterion 1: `met` — H is stated as falsifiable per-slice inequalities on unrounded deltas: delta ≥ −1.0 on each of english-general, tool-call, long-context and refusal, AND delta_non-english < −1.0. The non-English regression is correctly treated as a prediction, not a refutation. The rule is one-sided on the named slices. The boundary cases are handled explicitly, and I checked the item-count bounds (98/135/1/232 an
- criterion 2: `met` — Control and data: - The control is the frozen slice-evals 7B bf16 delivery, bound by artifact ID and hash, and never re-scored. Its figures match results.json. The slices are unchanged at 300 items each. - Only the model changes. The same serve.sh and served-model-name are used, and all 1,500 request bodies are checked byte-identical. - The tokenizer and chat template have identical hashes across 
- criterion 3: `met` — Memory fits: - 3B bf16 weights are about 5.75 GiB. KV at 36,864 B/token (arithmetic verified) gives about 400k tokens of capacity, against the about 99k tokens the frozen 7B completed the same workload with. - The longest request is 13,426+512 tokens, below max_model_len 20000. Time and money are realistic: about 2.3 h (4 h with contingency) and about $5, with a hard stop at $15, under the $60 cap

**Round 2** (revision 3) — verdict `pass`

> The run followed the approved 3B-vs-7B A10 stand-in plan, and every figure reconciles with the retained results and the exhibit. C2 is contradicted: english-general fell 16.7 points and long-context fell 1.333, one item past the boundary and flagged near-boundary. Non-English regressed 6.3 points as predicted. Deviations are disclosed and harmless, and the paper edits are accurate.

- criterion 1: `met` — The run used the planned 3B bf16 candidate at aa8e7253 against the frozen 7B at a09a3545, one A10 each. Shard hashes match the plan. All 1,500 request bodies are byte-identical to the frozen run, offline and as sent, and the configuration check PASSes with no disallowed server differences. Nothing was quantized. Concurrency was 32 over 1,500 requests with 0 errors. The bf16 replay control ran with
- criterion 2: `met` — All per-slice counts reconcile with the paired discordant counts: 51, 57, 134, 10 and 250. The per-language counts sum to the non-English totals. Deltas and distances are correct. The tool-call McNemar p recomputes to 0.0703. R = 2.197, cost $0.0015636 per 1,000 tokens and D_T −1.84% all recompute correctly. Diff totals are 46 identical and 1,060 replay-identical. The exhibit pins the same six res
- criterion 3: `met` — The verdict CONTRADICTED follows mechanically from the pre-registered rule. english-general fails decisively (CI entirely below −10) and long-context fails by one item. Long-context is correctly labelled near boundary (d = −0.333; CI [−6.67, +4.00]; p = 0.72); I agree that a second judge pass is warranted before relying on that slice, though the verdict does not depend on it. It is the only near-b
- criterion 4: `met` — The edits add new sections, dense-32b-method and dense-32b-results, at expectedRevision 1 for both documents; the current revisions are 1, and the awq-70b sections are untouched. The Methods section correctly states the stand-in, the checkpoints, the decoding (including --generation-config vllm, which corrects the plan's prose), the judge caveat and the decision rule. Every Results number, CI, p-v

## experiment `specdec-70b` — `wf_23e0bb2c904c4b0390c5a7a39d3bc2a3`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → running → experiment_review → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:07:48.412Z | 2 s |
| running | 2026-09-18T11:07:50.006Z | 4566 s |
| experiment_review | 2026-09-18T12:23:56.129Z | 290 s |
| complete | 2026-09-18T12:28:46.192Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `pass`

> The plan can answer C3 at the declared 7B/0.5B A10 stand-in. The primary check is a byte diff against the frozen retained outputs. The unavoidable vLLM 0.15.1 deviation is disclosed and controlled by a matched non-speculative arm, with frozen-stack replays as the nondeterminism floor. Both halves have strict separate rules, k is fixed, cost is small and limitations are stated.

- criterion 1: `met` — There are two falsifiable hypotheses. H_id: 300/300 byte-identical in every B1 run. H_tp: R_spec and R_frozen both ≥ 1.6 at 32 sessions. Each has explicit support and contradiction outcomes, reported separately, and neither stands in for the other. The A, B0 and B1 arms separate speculation effects from version effects and from nondeterminism. So the evaluation can distinguish H from its alternati
- criterion 2: `met` — The baseline is the frozen retained raw outputs from the hash-pinned archive; the tool-call slice art_6c76492e hash matches (checked). B0 is a matched control on the same version, flags and machine. A config check runs before any timed run and verifies request bodies, the server's effective arguments, the tokenizer and template, and the draft hashes. Throughput uses the harness formula at 32 sessi
- criterion 3: `met` — Feasibility: - It runs on the same validated A10 shape as the baseline, at $1.29/h. - Estimated cost is $4–6 with a $15 hard stop, within the $60 cap. - The memory arithmetic leaves about 72k KV tokens against about 65k needed for the claim runs. B1_full risk is disclosed with a stated fallback. - A crash or OOM counts as non-execution, and nothing is simulated. Limitations cover scale (14:1 vs 70

**Round 2** (revision 3) — verdict `pass`

> The attempt ran the approved 7B/0.5B A10 stand-in protocol and was reported honestly. C3 is contradicted on both halves: B1 matched frozen tool-call outputs on 250, 247, 247 and 246 of 300 items, and R_spec was 0.971 and R_frozen 1.000 against 1.6. The numbers recompute from the retained files, the deviations are disclosed and change no verdict, and the paper edits match the evidence.

- criterion 1: `met` — The arms A, B0 and B1 ran with the planned flags, k=4, the padded draft, the 12 planned runs at 32 sessions, and the frozen harness and serve.sh hashes. config_check shows the only differences are speculative_config and the version-logged api_server_count. Deviations are disclosed with causes: the run-order bug, the async-scheduling asymmetry, the torch cu130 build, the post-check analysis-script 
- criterion 2: `met` — I recomputed from the result files: identical counts 250/247/247/246; list lengths and S-label counts; the 57 distinct and 46 always-different items; 19/53 items diverging at token 0; the D_S bounds; per-run T, the medians, R_spec 0.971 and R_frozen 1.000; acceptance 0.560 and mean length 3.24; the mixed-workload ratios. All agree with the report, and the exhibit pins the five result files. The re
- criterion 3: `met` — Both halves are applied separately under the pre-registered rule and both are contradicted. The report states that attribution cannot rescue the claim. It discloses the baseline's own nondeterminism, the untested 70B/1B scale, the version confound and the uncalibrated judge. The mechanism explanation is correctly labelled as plausible, not demonstrated. The Conclusion restates the fictional-Parlay
- criterion 4: `met` — The new specdec-70b-method and specdec-70b-results sections target methods and results revision 3 and leave existing sections untouched. Every number in them matches the result files. Two minor wording points do not block: 'near-tie flips' is stated as fact although no logits were recorded, and 'about 279/300' for A understates A_tc3's 284.

## experiment `slices-in-repo` — `wf_4130585030c647a59c83b9c85a3e9c72`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → experiment_review → running → experiment_review → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:07:48.494Z | 2 s |
| experiment_review | 2026-09-18T11:07:50.233Z | 341 s |
| running | 2026-09-18T11:13:31.213Z | 199 s |
| experiment_review | 2026-09-18T11:16:50.631Z | 147 s |
| complete | 2026-09-18T11:19:17.462Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `pass`

> The plan turns each of the five slice definitions into a pure filter over one record and tests each one with boundary-probing positive and negative cases, purity checks and a deliberate-fault check. I checked its cited numbers against the slice-evals manifest and protocol, and they match. Its ambiguity resolutions are explicit and defensible. The remaining risks are acknowledged and do not block the design.

- criterion 1: `met` — The hypothesis is stated and testable: each definition can be written as a deterministic single-record predicate that accepts members and rejects non-members. The evaluation can tell a correct implementation from a wrong one. Boundary-probing negatives (3902 tokens, lang=hi/en, subset=contrast, root SL:, unbalanced frame) and a deliberate-fault check that must make the suite fail catch definition 
- criterion 2: `met` — The data and definitions were checked against manifest art_6666c8fc… (min 3903, inclusive; de/fr/es 100 each; CoCoNot original; tool-call is a disjoint English draw) and protocol art_42a86c84…, and they match. The negatives are matched controls. The ambiguity resolutions (a)–(d) are explicit and defensible. The decision rule requires both commands to exit 0, at least 2 positive and 2 negative case
- criterion 3: `met` — The work is feasible: CPU-only Python with no network or data download, runnable under pytest and a stdlib runner, with every step frozen via code.commit. The limitations are addressed: the substitute model sizes are restated, the uncalibrated judge is noted, and the plan names that slice-evals is not yet approved and that the implementation must be revised if its definitions change, tying the con

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `running`

> The code, tests, results and report at cbe49ff are correct and match the approved plan, and the PASS stands. The paper proposal cannot be applied because it targets methods and results revision 1, and both are now at revision 2 after the dense-32b publication. Resubmit the same two sections against revision 2. No code or measurement changes are needed.

- criterion 1: `met` — The code at cbe49ff implements plan §1–§5: the record contract, five pure filters with resolutions (a)–(d), a README, and the coverage, runtime purity, AST purity and overlap tests plus a stdlib runner. The fault check was run and not committed. The deviations (normalize, extra frame rules, git commit in place of the unavailable code.commit, extra tests, report-only fetch) are declared with reason
- criterion 2: `met` — results.json and the exhibit agree: 8/8 tests, 26 records, per-slice counts 2/2, 3/2, 2/4, 2/5, 2/2, both purity tests passed, and fault failures of 2/2/2/1. I independently counted the CASES and test_* functions in the code, and they match. The fault failure sets follow from the code. The rework is disclosed.
- criterion 3: `met` — The PASS conclusion correctly applies the pre-registered four-part rule, and all four conditions are consistent with the code. The limitations are stated: eligibility is not membership, slice-evals is unapproved, the constant is pinned to the manifest hash, the data is substitute data, and purity coverage is limited. The conformance check is kept out of the decision.
- criterion 4: `not_met` — The content is accurate: the Methods definitions match filters.py and the Results numbers match results.json. The proposal cannot be applied, though. It declares expectedRevision 1 for methods and results, both documents are now at revision 2 (dense-32b publication), and the server rejected the pass with paper_revision_conflict. Required correction: resubmit the same sections ('slice-definitions',

**Round 3** (revision 5) — verdict `pass`

> At commit cbe49ff the slices package matches the approved plan. The 8 tests and 26 case records (2/2, 3/2, 2/4, 2/5, 2/2) agree with results.json and the exhibit, and the PASS follows from the pre-registered rule. The only earlier defect, the stale paper revision, is fixed: paper changes v3 target methods and results revision 2, which are the current revisions, and the content is accurate.

- criterion 1: `met` — The code at cbe49ff implements the plan: the record contract, five pure filters with resolutions (a)–(d), a README, and the coverage, runtime purity, AST purity and overlap tests, plus a stdlib runner. The deliberate faults were run and not committed. The deviations are declared, give reasons, and do not affect the decision rule.
- criterion 2: `met` — results.json and the exhibit agree: 8/8 tests, 26 records, per-slice counts 2/2, 3/2, 2/4, 2/5 and 2/2, both purity tests passed, and 2 failing tests for each planned fault. I counted CASES and the test_* functions in the code myself, and they match. The fault failure sets follow from the code. Report v4 discloses all rework and separates the re-verified items from the carried ones.
- criterion 3: `met` — The PASS correctly applies the four-part pre-registered rule, and no invalidation condition applies. The limitations are stated: eligibility is not membership, slice-evals is unapproved and the constant is pinned to the manifest hash, the data is substitute data, and purity coverage is limited.
- criterion 4: `met` — The proposal targets methods and results at expectedRevision 2, which matches the current documents. It adds new sections 'slice-definitions' and 'slices-in-repo-results' with no collisions. The Methods definitions match filters.py, including the inclusive 3903 bound, de/fr/es, the well-formed frame check and CoCoNot original. The Results numbers match results.json: 8/8, 26 records, the per-slice 

## Limits

Trajectories and verdicts are asserted after the fact; no verdict text reaches any worker.

A stage carrying a planted defect is launched by this harness, not the runner: the runner builds its child stdin from the frozen assignment and has no per-assignment prompt hook.

The production feed has no voices: each brief post is written by the source credential with its named role as a body prefix.

Reflection, consolidation and post-wave claim updates are outside this harness slice.

| The scenario says | On this server | Stand-in |
| --- | --- | --- |
| Parlay, de-identified production tickets in de/fr/es with tool-call gold answers and QA-labelled refusals | None of it exists | A named public multilingual support/dialog corpus plus a named tool-call schema set covers four slices. The **refusal slice has no public equivalent** and is the slice the scenario's own post-mortem cares about most — name a substitute, produce one by hand, or waive the slice explicitly on the record. |
| **100 human labels per slice, 500 total, calibrating the LLM judge** | No agent substitute is honest: an agent labelling its own calibration set destroys the deliverable | Either a person does the labels, or the task reviewer records that criterion `status: "waived"` with notes, and the Introduction says out loud that the judge is uncalibrated. **With the waiver, scenario 3 no longer demonstrates the mechanism it exists to demonstrate** — the post-mortem's central action item was that someone other than the author checks the numbers against human judgement. |
| A frozen bf16 70B baseline on 2×H100, and 2×H100 speculative-decoding runs | No 80 GB card has ever been rented live by the sandboxes service; the only validated GPU is a Lambda A10 24 GB. The catalogue's validated H100 shapes are 1× and 8×, not 2× | Declared fallback, stated in each plan *before* design review: run the identical protocol at model sizes that fit the hardware actually available, with the sizes restated as a limitation. Failing that: do not run, do not simulate. Note also the hidden line the scenario omits — roughly 140 GB of weights to download per machine per rental plus a roughly 40 GB quantized artifact, with egress and storage billed separately. If only 1× and 8× shapes exist, the scenario's ≈$81 wave becomes several hundred dollars. |
| `sandbox.options`, `sandbox.request`, `sandbox.run`, `sandbox.pull_outputs`; three leases with stated hours | Do not exist; Merv exposes only `sandbox.extend` and `sandbox.release`, and the sandboxes plugin is not composed in production | Compute driven beside Merv against the sandboxes service or the operator's machines; evidence returns as artifacts. Set a spend cap before the first rental — a create whose full lease would cross the cap is refused, which is the behaviour you want. |
| Each agent **registers a feed voice** | No `feed.register`, no voices | Role prefix in the post body, a text convention only. |
| **The QA lead replies on the feed** and the reply lives in the record next to the agent's response | **No replies, no threads, no reactions.** This is the scenario's central human moment and it has no mechanism | Feed posts 3 and 4 in §6 are written as two independent posts in sequence by two different authors, which is the closest the server allows. A human with project access can post; the adjacency is chronological, not structural. If the human intervention must be verifiable, the alternative is a new task or an Introduction edit, which is heavier and slower than the scenario's lightweight moment. |
| Feed `table` and `stat` blocks | None; a post is body + ≤10 artifact ids, ≤8,000 chars | Tables as plain text in the body or as an attached artifact. |
| Reflection lenses `cost-model` and `safety-regressions` | Roster fixed at `evidence`, `theory`, `methods`, `synthesis`, `next_steps`; `reflection.create` takes only `title` and `requestId` | Questions and the traffic-mix assumptions they need go into a pre-wave artifact + feed post + wave title, read by lens agents as live project research. They are not lens records. |
| The traffic mix (88% English-dominant, 12% non-English, 31% of output tokens are tool calls) feeding a cost model | This project has no traffic | Label them in the reflection-questions artifact as the scenario's stated assumptions, not as measurements. A cost-per-1,000-tickets figure derived from them is an illustration, and the synthesis must say so. |
| Code consolidation compare-and-swappe
