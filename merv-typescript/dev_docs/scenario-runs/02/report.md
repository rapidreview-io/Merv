# Scenario run — Fathom Signals

- Result: **DIVERGED**
- Brief: `/Users/guraltoo/Documents/dev/proj/experiments/Merv/Scenarios/briefs/02-proxy-scale-ablation-before-the-big-run.md` (sha256 `dafa2c8e820f1503…`)
- Project: `project_428987cf66df40ddb42a9b45343ee012`, cycle `wf_0f30148a13984091a41262c99d900548`
- Server: https://experiments.rapidreview.io
- Ran 2026-09-18T11:24:21.534Z → 2026-09-18T18:14:23.729Z (24602 s)
- Codex executions: 331 (329 runner-dispatched, 2 harness-leased)

## Divergence

**trajectory** on `proxy-harness-v2`: expected `in_review`, observed `done`.

proxy-harness-v2 reached done at step 2 where the brief expects in_review: in_progress -> done

## Claims

- C1 → `claim_674ec2680a68424d8a856684ae7ffd1b`
- C2 → `claim_ba9fc20d577a49daae6acb6b8a826514`
- C3 → `claim_049e1e1f27644766bfabe595070f82a2`

## task `proxy-harness` — `wf_120166b2dd774a8498b41e287b629749`

Expected: in_progress → in_review → done
Observed: done

| state | entered | held |
| --- | --- | --- |
| done | 2026-09-18T11:24:22.547Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`

> The candidate apparatus has consistent code and held-out data, but is not ready to freeze: training shards are not durably delivered, H100 throughput measurements are absent, and plant requirements remain unresolved. Configs and launch documentation are supported by direct inspection.

- criterion 1: `not_met` — Recomputed manifest SHA256 a23b9537f1941fa37f8165c3371acdf2441df43b9e62850f12d7974f1fc5edaf. Its 60 training entries sum to exactly 2,000,000,000 raw scalar observations and carry derived hashes, pinned upstream hashes/URLs and LOTSA source provenance. Independently checked provenance totals and nonoverlap. However the actual data archive contains only manifest plus three evaluation objects, and m
- criterion 2: `not_met` — Independently verified each packaged evaluation object's SHA256, little-endian float32 dtype, 256x256 shape and finite values: 65,536 observations each for australian_electricity_demand, pedestrian_counts and traffic_hourly. Manifest train/eval source sets are disjoint. Checked all 229,786 retained intervals for within-identity overlap and per-shard provenance totals. Inspected verify.py source/ha
- criterion 3: `met` — Directly compared both JSON configs: only width/depth differ, 640/12 versus 880/16; heads, context/window, patch size, optimizer settings, seed and cadence are identical. Inspected train.py flag choices for both sizes, quantile/patch and rotary/absolute. Traced model.py embedding/head branches and rotary Q/K versus learned absolute embeddings through the shared transformer. Implementation supports
- criterion 4: `not_met` — Inspected single train.py entry point: flushed metrics.jsonl includes tokens_seen, wall_clock_seconds and aggregate/per-source evaluation_nll. Independently executed the extracted next_batch_windows function over 2B observations and obtained all 20 exact 100M boundaries without overshoot. Code counts raw observations, including context, and documents that unit. Benchmark code exists but is not a m
- criterion 5: `met` — Read README and traced launch.py -> restore.py -> verify.py -> train.py. README documents artifact reassembly, pinned dependency installation, CUDA/BF16/network/storage prerequisites, and one launch command parameterized by size/tokenizer/position for all eight arms. Verified four part hashes and combined archive SHA256 e0d2067aef92155dd2f67d9c3d71cd836b5e683ea35a30e7e399b9e5c17be1df; verified REA
- criterion 6: `not_verified` — Pinned criterion is exactly 'plant', without a measurable predicate. It cannot be independently evaluated or counted as met. Captured project context declares LOTSA substitutes and no real industrial corpus. Replace or clarify this criterion through the authorized specification process, or explicitly justify a waiver; this review grants no implicit waiver.

**Round 2** (revision 3) — verdict `needs_changes`

> The apparatus supports the model, cadence, benchmark and launch requirements, but it cannot be approved against the pinned plant criteria. The delivered corpus uses LOTSA sources, and criterion 6 has no testable predicate. Reconcile the specification before freezing the apparatus.

- criterion 1: `not_met` — Recomputed storage-map totals: 60 training objects, 2,000,000,000 raw scalar observations and 8,000,007,680 bytes. All shard hashes/sizes agree across the pinned map, directory, available-object metadata and download records; the manifest hash is pinned in freeze.json. Every training source ID is era5_1989, which the README identifies as LOTSA weather reanalysis, not a plant. Therefore the require
- criterion 2: `not_met` — The inspected map names australian_electricity_demand, pedestrian_counts and traffic_hourly, with 65,536 observations each, disjoint from era5_1989. Read verify.py: it checks source disjointness, array hashes/shapes/finiteness/counts, split hash disjointness and overlapping source/item/channel intervals. Those are appropriate source-identity checks, but these are not three named plants. Bootstrap 
- criterion 3: `met` — Independently compared both complete config key sets: only width/depth differ (640/12 versus 880/16). Inspected model.py and CLI choices: quantile/patch and rotary/absolute are implemented and selectable. Eight heads and all remaining optimization/window settings match. Retained canonical parameter counts are 59,337,212 and 149,186,652. Static inspection and byte-hash verification support this con
- criterion 4: `met` — Read train.py: one training/benchmark implementation logs tokens_seen, wall_clock_seconds, aggregate evaluation_nll and per-source NLL to flushed metrics.jsonl. Independently executed its cadence helper to obtain exactly all 20 boundaries from 100M through 2B. Inspected retained one-H100 hardware record, successful job command/stdout, timings and benchmark code; matched both benchmark configs and 
- criterion 5: `met` — Read the complete README and traced launch.py -> restore.py -> verify.py -> train.py. README specifies data acquisition via immutable directory or checksum-documented multipart bootstrap, Python and pinned dependencies/CUDA prerequisites, and one launch command whose size/tokenizer/position choices cover all eight arms. New output directories are required. Retained benchmark job commands exercise 
- criterion 6: `not_met` — Current review.get confirms the criterion is exactly 'plant'. It specifies no measurable predicate. Inspected revision2/SPECIFICATION.md: it explicitly proposes reconciliation and does not enact an amendment or waiver. An authorized specification owner must replace this fragment with a testable requirement or remove it through the specification process. It cannot be marked met as written.

**Round 3** (revision 5) — verdict `pass`

> The pinned 2B-observation apparatus meets criteria 1–5: data integrity and source separation passed direct verification, and configs, logging, launch instructions and retained H100 measurements are supported. Criterion 6 is waived by the captured operator note.

- criterion 1: `met` — Directly ran the hash-pinned verify.py on the retained local full data: all hashes, byte sizes, float32 shapes, finiteness and counts passed. Manifest SHA256 a23b9537f1941fa37f8165c3371acdf2441df43b9e62850f12d7974f1fc5edaf identifies 60 training shards totaling exactly 2,000,000,000 raw observations from era5_1989. Compared all manifest shard fields with revision2/storage-map.json; map supplies im
- criterion 2: `met` — Direct full-data verifier execution checked three evaluation arrays, 65,536 observations each, from australian_electricity_demand, pedestrian_counts and traffic_hourly. All are absent from training source era5_1989. The unchanged verifier passed source and shard-hash disjointness plus zero overlapping (source,item,channel,offset) intervals; independently counted 229,780 training and 6 evaluation p
- criterion 3: `met` — Compared full configs: identical key sets and only width/depth differ, 640/12 versus 880/16. Read Model and CLI paths implementing quantile/patch and rotary/absolute with causal attention and common scored targets. Independently recomputed all eight parameter counts from architecture and actual manifest bin count, matching retained counts (approximately 59M and 149M). Read the existing four-test s
- criterion 4: `met` — Read train.py JSONL logging of tokens_seen, wall_clock_seconds and evaluation_nll; executed its actual next_batch_windows function for both configs over 2B and obtained all 20 exact 100M boundaries. Checked retained tiny smoke JSONL, increasing wall-clock, weighted per-source aggregate NLL and byte-identical copied entry points. Independently recomputed retained measured rates: 819200/2.9008675790
- criterion 5: `met` — Read README acquisition instructions, immutable storage IDs, Python/dependency/CUDA prerequisites and one-command launch.py example with flags covering all eight arms. Inspected launch.py -> restore.py -> verify.py -> train.py dispatch, hash checks and refusal to overwrite outputs. Cross-checked retained launcher smoke entry-point hashes and actual JSONL records against the submitted code. Fresh a
- criterion 6: `waived` — Pinned brief confirms the criterion is only 'plant'. Captured Project Introduction contextRevision 2 contains the explicit OPERATOR NOTE (2026-09-17): this bare word is a transcription defect and is waived; reviewers are to record it as waived with that note as the reason. It adds no measurable apparatus requirement and is unnecessary to the goal. This is the supplied operator waiver, not an infer

## task `proxy-harness-v2` — `wf_8b1945901c7149da8b38385440b2764c`

Expected: in_progress → in_review → done
Observed: in_progress → done

| state | entered | held |
| --- | --- | --- |
| in_progress | 2026-09-18T11:24:22.628Z | 2 s |
| done | 2026-09-18T11:24:24.407Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `pass`

> The frozen v2 apparatus meets all four criteria: configurable launch interface, unchanged v1 data references, four complete 200-step 60M H100 smoke runs, and reproducible launch/change documentation. Independent archive, code, parser and raw-log checks support acceptance.

- criterion 1: `met` — Inspected launch.py forwarding arguments to train.py, parser defaults, in-memory config resolution, seed initialization, AdamW and LR schedule. LR/seed remain 0.0003/1729 as independently confirmed in the accepted v1 configs; the formerly required size/arm flags now default to documented 60M/quantile/rotary. Isolated execution of actual shipped parser/resolver passed defaults, 24 override combinat
- criterion 2: `met` — Direct comparison against accepted v1 archive 3681946e996b6e23bd95ca1101051c79d3703114c0a98cf52298df8dec1eb79c confirms byte-identical revision2/storage-map.json, licenses, preparation/restoration code and retained baseline records. Manifest pin remains a23b9537f1941fa37f8165c3371acdf2441df43b9e62850f12d7974f1fc5edaf. Matched all 63 shard receipts to map object IDs, hashes and sizes, plus the orig
- criterion 3: `met` — Parsed all four raw JSONL files independently: each has exactly 200 consecutive finite training steps plus final evaluation covering all three held-out sources. Recomputed every step's observation count, learning-rate schedule and elapsed-time cost; verified increasing wall-clock values, 1,638,400 observations/run and final summary consistency. Each run metadata selects 60M width/depth 640/12, cor
- criterion 4: `met` — Read README and CHANGES and checked commands against shipped parser and launcher. README covers dependencies, immutable data acquisition, valid flag values/defaults, all arm choices, custom LR/seed, full-budget and bounded smoke commands, output-path requirements and verification. Direct v1/v2 archive comparison found exactly eight modified files, seven additions and no removals; independently val

## experiment `tokenizer-ab-60m` — `wf_abb6f0f69afd4ebe8d51fc36e1547794`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → experiment_review → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:24:22.726Z | 2 s |
| experiment_review | 2026-09-18T11:24:24.610Z | 349 s |
| complete | 2026-09-18T11:30:13.857Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The plan specifies fair run allocation and clear decision bands, but cannot yet establish the claimed effect: the common NLL, exact evaluation data, compatible harness and 2B-budget feasibility remain unresolved. Bind and review these prerequisites in a new pinned submission before approval.

- criterion 1: `not_met` — Objective & hypothesis clearly states directional C1 at 60M and limits claims about 150M. Evaluation correctly specifies three confirmation seeds, means/ranges, R=100*(muA-muB)/muA and all decision boundaries, including overlapping ranges and invalid denominators. However, the common forecast likelihood is explicitly deferred to a reviewed addendum: categorical cross entropy and an unspecified con
- criterion 2: `not_met` — Treatments and allocation prescribe the same three LRs (0.0001, 0.0003, 0.001) at seed 17, each arm's own selected LR at fresh seeds 101/202/303, and exactly 2B scalar-observation exposures per run. The scalar counter avoids crediting patches with sixteenfold data; tokenizer/head, sequence-length, compute and parameter-allocation asymmetries are acknowledged, with the estimand correctly described 
- criterion 3: `not_verified` — The plan responsibly addresses failed runs, divergence versus infrastructure interruption, full evidence retention, no fabricated measurements, the fictional-company/LOTSA scope, and the 60M-only boundary. Feasibility nonetheless cannot be verified: Summary and prerequisites explicitly leave the project 400M versus assigned 2B conflict unresolved, prohibit an unapproved five-pass workaround, and d

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `planned`

> The plan specifies matched runs and clear decision bands, but cannot yet answer the question: comparable NLL, exact held-out data, harness compatibility and full-budget feasibility remain unresolved. Pin and review the missing delivery and resolve the 400M-versus-2B conflict before approval.

- criterion 1: `not_met` — Objective & hypothesis defines the directional 60M question and appropriately limits inference about 150M and C2. Evaluation specifies arm means/ranges, R=100*(muA-muB)/muA, the undetermined band at 2% through below 5%, support at >=5% only with strict B-over-A seed separation, and an unevaluable outcome for invalid denominators. These rules are coherent conditional on valid comparable measurement
- criterion 2: `not_met` — Run allocation correctly gives both arms rates 0.0001/0.0003/0.001 at seed 17 and three fresh seeds 101/202/303 at each arm's own selected rate, with all 12 runs stopping at exactly 2B scalar-observation exposures. The exposure definition prevents patching from receiving sixteenfold data. The plan names quantization, head/MLP, sequence length, parameter allocation and compute asymmetries and corre
- criterion 3: `not_verified` — The plan addresses full run/failure retention, divergence versus infrastructure interruption, no simulated evidence, the 60M-only boundary and LOTSA/fictional-company limitations. It adds a useful full-allocation cost formula and explicitly labels runtime assumptions. Feasibility remains unverified: the Introduction's 400M budget conflicts with the assigned 2B endpoint; the unchanged harness's sup

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `planned`

> Matched tuning, exposure budgets and decision bands are well specified, but this pinned plan leaves the comparable NLL and model-control audit unfinished. The readable harness resolves source identities and the 2B corpus; revise the scientific definitions and feasibility estimate using that evidence before execution.

- criterion 1: `not_met` — The directional 60M hypothesis is clear, and the mean/range, relative-improvement and strict seed-separation rules correctly distinguish support, weakening and the undetermined band, including exact 2% and 5% boundaries. However, Common likelihood requirement explicitly leaves actual common NLL undefined. The cited delivery reports passing analytic-density checks but does not state the scoring mat
- criterion 2: `not_met` — Matched treatment is well specified: both arms sweep 0.0001/0.0003/0.001 at seed 17, then train fresh seeds 101/202/303 at their own selected LR, with every run stopping at exactly 2B scalar-observation exposures. Internal patch positions do not earn extra data credit. The plan appropriately identifies tokenizer/head/objective/parameter-allocation/sequence/compute asymmetries and limits interpreta
- criterion 3: `not_verified` — Failure retention, exact-endpoint invalidation, distinction between infrastructure interruption and divergence, no fabrication, LOTSA scope and the 60M-only boundary are sound. Current authoritative context and delivery resolve the supposed 400M/2B conflict, and the delivery supplies meaningful full-corpus verification, 2B cadence checks and a tiny unchanged-entry-point smoke test; do not seek acc

**Round 4** (revision 7) — verdict `needs_changes`, returnTo `planned`

> The plan now defines comparable NLL and clear decision bands, but its own audit shows the frozen apparatus implements the wrong arms and cannot vary learning rate or seed. The conservative compute estimate also exceeds the cap. Reconcile and pin an executable design before running.

- criterion 1: `met` — The hypothesis and measurement specification are testable: a directional 60M package comparison using the same three named sources, all 224 targets/window, fixed standardized-scalar units, three fresh confirmation seeds per arm and exact 2B endpoints. A's bin masses are converted to normalized continuous density with bin widths and the atan Jacobian; B supplies learned Gaussian mean and scale. The
- criterion 2: `not_met` — The protocol correctly matches three LRs (0.0001/0.0003/0.001 at seed 17), three fresh seeds (101/202/303), observation budgets, data order, backbone and non-LR settings. The source names and manifest are now concrete; training-only calibration and context-only normalization address direct target leakage. Conditioning, density family, head/capacity, precision and compute differences are disclosed,
- criterion 3: `not_met` — The pinned plan expressly states that train.py takes LR=0.0003 and seed=1729 from hashed configuration, lacks LR/seed arguments, and internally reseeds; configuration edits would fail freeze verification. Thus no authorized unchanged invocation can execute its mandatory sweep or three-seed confirmation. This is a concrete feasibility failure even if compute becomes available. Required correction: 

**Round 5** (revision 9) — verdict `needs_changes`, returnTo `planned`

> The evaluation protocol is testable, but the pinned apparatus still implements the wrong arms and cannot vary learning rate or seed. Corrected apparatus is explicitly deferred, and no feasible compute allocation is established. Pin and verify an executable design before running.

- criterion 1: `met` — The protocol defines a testable directional 60M tokenizer-plus-head hypothesis and explicit alternatives. It scores the same 224 targets/window given 32 context observations on australian_electricity_demand, pedestrian_counts and traffic_hourly at exactly 2B consumed observations. A's bin masses are converted to a continuous density using bin width and the atan Jacobian; B's learned Gaussian scale
- criterion 2: `not_met` — The intended allocation correctly matches three rates (0.0001, 0.0003, 0.001) at seed 17, then fresh seeds 101/202/303 at each arm's own selected rate, with common observation budgets, data order, backbone and optimizer settings. Training-only calibration and context-only normalization address direct target leakage; LR selection on final evaluation sources is explicitly disclosed and limits infere
- criterion 3: `not_met` — The plan admits the only identified entry point fixes LR=0.0003 and seed=1729 in hashed configuration, internally reseeds and exposes no LR/seed arguments. Thus the mandatory sweep and independent initialization replications cannot be executed unchanged. No accepted corrected apparatus ID/hash or valid corrected command is pinned, and essential bounded verification is deferred to another reviewed 

**Round 6** (revision 11) — verdict `needs_changes`, returnTo `planned`

> The evaluation protocol is testable, but the pinned apparatus still has the wrong arms and cannot vary learning rate or seed. Corrected architecture, executable commands and a feasible compute allocation remain deferred. The exact design needs repair before execution.

- criterion 1: `met` — The 60M hypothesis and alternatives are explicit. The protocol measures endpoint NLL on australian_electricity_demand, pedestrian_counts and traffic_hourly, using the same 224 targets given 32 context observations per window. A's bin mass is converted to a normalized continuous density with the bin width and atan Jacobian; B's learned Gaussian scale supplies a normalized density under the same sta
- criterion 2: `not_met` — The intended controls match the three rates 0.0001/0.0003/0.001 at seed 17, followed by fresh seeds 101/202/303 at each arm's own selected rate, all at exactly 2B consumed scalar observations including context. Common data order, backbone, optimizer and source aggregation are specified. Training-only calibration and context-only normalization address direct leakage. Reusing final evaluation source
- criterion 3: `not_met` — The plan states the identified unchanged entry point fixes LR=0.0003 and seed=1729 in hashed configuration and internally reseeds, with no LR/seed CLI. Therefore it cannot perform the mandatory three-rate sweep or independent initialization replications. Corrected executable IDs/hashes, actual valid commands and interface checks are explicitly deferred. Pin accepted apparatus and unchanged command

**Round 7** (revision 13) — verdict `needs_changes`, returnTo `planned`

> The evaluation is testable, but this exact plan has no corrected apparatus implementing the required arms, learning-rate sweep and seed replication. Architecture, calibration, executable commands and a supported compute allocation remain deferred. These prerequisites must be resolved before execution.

- criterion 1: `met` — The plan specifies the 60M hypothesis, meaningful alternatives and endpoint NLL on australian_electricity_demand, pedestrian_counts and traffic_hourly. Both densities score the same 224-target joint event given 32 context observations, under the same standardized Lebesgue measure. A's bin-width and atan-Jacobian corrections permit comparison with B's learned-scale Gaussian density; different scala
- criterion 2: `not_met` — The intended controls are concrete: identical three-rate grids (0.0001, 0.0003, 0.001) at seed 17, then fresh seeds 101/202/303 at each arm's own selected rate, exactly 2B consumed scalars including context in every run, common data order/backbone/optimizer, and equal-source aggregation. Training-only calibration and context-only normalization address direct leakage. Final sources are reused for L
- criterion 3: `not_met` — The identified unchanged entry point reportedly fixes LR=0.0003 and seed=1729, internally reseeds and exposes no LR/seed CLI; it cannot execute the required sweep or initialization replications. Accepted replacement IDs/hashes, valid unchanged commands and bounded interface checks are still deferred. Supply those and verify that requested LR changes the schedule, seed changes initialization, repea

**Round 8** (revision 15) — verdict `needs_changes`, returnTo `planned`

> The evaluation protocol is testable and v2 resolves the learning-rate, seed and calibration blockers. However, its patch input is linear rather than the required small MLP. This exact design cannot execute the assigned comparison; pin an accepted correction or obtain an explicit scope amendment, then revise the plan and feasibility evidence.

- criterion 1: `met` — The plan defines the 60M component of C1 and meaningful alternatives, cites arXiv:2211.14730 without importing its learning rate, and explains the fixed 16-step choice. Endpoint NLL uses exactly australian_electricity_demand, pedestrian_counts and traffic_hourly, all 224 targets in each of 256 windows/source. A's bin-width and atan-Jacobian correction and B's learned-scale Gaussian define normaliz
- criterion 2: `not_met` — Most controls are defensible: both arms get rates 0.0001/0.0003/0.001 at seed 17, followed by fresh 101/202/303 seeds at each arm's own selected rate, exactly 2B raw observations including context in all twelve runs, common data order/backbone/optimizer, fixed endpoint weights and equal required evaluation counts. Training-only calibration and context-only normalization address direct leakage. LR 
- criterion 3: `not_met` — V2 now supplies concrete unchanged launch commands, documented LR/seed overrides and producer interface/initialization checks; four 200-step H100 smoke summaries provide actual timing and both delivered-arm parameter/checkpoint counts. These resolve the inherited fixed-LR/seed and absent both-arm timing objections. Recomputed full linear-arm allocation is $137.44 with the plan's overhead/reserve, 

**Round 9** (revision 17) — verdict `needs_changes`, returnTo `planned`

> Matched sweep, 2B endpoint, held-out set and decision bands are sound; the amendment resolves the MLP blocker. One asymmetry is missing: 2^-53-wide tie bins let arm A score about -35.6 nats on exactly repeated targets, while B's clamp stops near -6.1. With no diagnostic or safeguard, the 5%/2% verdict could reflect point-mass exploitation rather than forecasting.

- criterion 1: `met` — The plan states the question for the 60M half of C1 as a hypothesis, not as evidence. Alternatives are support, weaken or undetermined. It says it cannot establish both-size C1 or C2. It cites arXiv:2211.14730, notes that PatchTST uses stride 8 while this apparatus uses non-overlapping stride 16, and justifies fixing the patch length at 16 without tuning it for B alone. Under the operator amendmen
- criterion 2: `not_met` — Most controls are sound. Both arms get the identical grid {1e-4, 3e-4, 1e-3} at seed 17 and full budget, then fresh seeds 101/202/303 at each arm's own selected LR. Every run ends at exactly 2B observations with the same data order, backbone and optimizer. Calibration uses training data only and normalization uses the context only. Reusing the held-out sources for LR selection is disclosed and sym
- criterion 3: `met` — The plan quotes exact v2 README commands for verification and launch. Smoke-derived projections are 2.909 h per run for A and 2.484 h for B: $68.72 for the sweep and $137.44 for all 12 runs including overhead and a 25% reserve. The plan says these are short-prefix estimates, not sustained rates, and reconciles them with the brief's 9.6 h guess. A resource gate against the $200 cap is defined (prio

**Round 10** (revision 19) — verdict `needs_changes`, returnTo `planned`

> Attempt 10 fixes the attempt-9 floor issue with a sound diagnostic and S1/S2 bound; tuning, budget, held-out set and bands meet the brief. A mirror-image asymmetry is unnamed: B's log-SD cap at +7 combined with the 0.001 SD floor can cost B thousands of nats on degenerate jump windows where A pays about 25. The safeguard stops false support but not a false WEAKENS.

- criterion 1: `met` — The question and hypothesis are limited to the 60M half of C1 and are stated as untested. Support, weaken and undetermined outcomes are all defined, and C2 is excluded. The plan cites PatchTST arXiv:2211.14730, notes its stride 8 versus the delivered stride 16, justifies patch length 16 and does not tune it for B alone. B is named 'patch embedding (linear projection)' as the amendment requires. Th
- criterion 2: `not_met` — Sound: identical grid {1e-4, 3e-4, 1e-3} at seed 17, then fresh seeds 101/202/303 at each arm's own LR. Every run ends at exactly 2B with the same data order, backbone and optimizer. Selection reuse is disclosed, the grid-edge rule is symmetric, and the invalidation list covers the brief's four conditions. Asymmetry 10 is named correctly. I verified the diagnostic and the S1 bound: clamped A lies 
- criterion 3: `met` — Commands match the v2 README exactly. Recomputed costs are $68.72 for the sweep and $137.44 for all 12 runs, with a spend gate of prior spend ≤ $60.56 against the $200 cap. The CPU diagnostic must run before production, and S2 needs under 0.5 GPU-h. A smaller card requires a bounded smoke of both arms first and the same card for all runs. Storage for about 172 GB of checkpoints is planned, with ev

**Round 11** (revision 21) — verdict `pass`

> Attempt 11 fixes the attempt-10 blocker. It names B's +7 log-SD cap with the 0.001 SD floor as asymmetry 11, with correct costs. It adds a pre-training diagnostic of |x| > e^7 targets and S3, a symmetric E-excluded re-score that every band must survive, WEAKENS included. S4 and the unevaluable rule fix the minor points. Tuning, budget, held-out set, bands and feasibility still meet the brief.

- criterion 1: `met` — The question is limited to the 60M half of C1 and the hypothesis is stated as untested; the outcome can only support, weaken or leave C1 undetermined at 60M. C2 is excluded. The plan cites PatchTST arXiv:2211.14730 and justifies patch length 16 (fixed by the brief and the config, dividing 32/256 exactly, and not tuned for B alone). B is named 'patch embedding (linear projection)' as the amendment 
- criterion 2: `met` — Matched tuning: both arms get the same grid {1e-4, 3e-4, 1e-3} at seed 17, then fresh seeds 101/202/303 at each arm's own LR. The grid-edge rule is symmetric and the grid is never extended. Matched budget: every run ends at exactly 2B, checked from tokens_seen, with the same data order and backbone. The held-out set is exactly the three named sources. All eleven asymmetries are named and justified
- criterion 3: `met` — Commands and flags match the v2 README, including --verify-only, unittest and verify_interface.py. I recomputed compute at 32.36 h for 12 runs plus 3 h reserve, ×1.25 × $3.20 = $141.44. The spend gate is prior spend ≤ $58.56 under the $200 cap, and the plan does not start, shorten or simulate if the gate fails or no GPU is available. A smaller card is allowed only after a smoke of both arms and mu

**Round 12** (revision 23) — verdict `pass`

> Attempt 11 ran the approved plan: 12 runs, each stopping at exactly 2B observations, with a matched 3-LR sweep and 3 seeds per arm, scored only on the held-out sources. My recomputed values match every file: mu[A] = -0.4704, mu[B] = 1.1954, R = +354%. With mu[A] <= 0, the pre-registered outcome is UNDETERMINED, and it is reported honestly. Deviations are disclosed and do not affect the decision.

- criterion 1: `met` — The execution matches the approved plan: - the model-free diagnostic (T and E) was created before any training; - the sweep {1e-4, 3e-4, 1e-3} at seed 17 ran for both arms, before the confirmation runs; - fresh seeds 101/202/303 ran at each arm's own selected LR; - every run ended at tokens_seen 2,000,000,000 and step 244,160, using the README command form; - one set of code and data hashes covers
- criterion 2: `met` — I recomputed from the per-run files: μ[A] = -0.470380, range [-0.473256, -0.464968]; μ[B] = 1.195445, range [1.184516, 1.201662]; R = +354.14%; separation false; Δ = 0.0042586; shifted μ[A] = -0.466121. Sweep and per-source values match the report tables and verdict-analysis.json. The exhibit pins exactly the 14 result files, and its heldout_nll entries equal the per-run values. All 12 runs appear
- criterion 3: `met` — The plan's decision rule states that μ[A] <= 0 makes the comparison unevaluable, giving UNDETERMINED. The report applies that rule and does not round the result to WEAKENS. It correctly notes that no branch could yield SUPPORTS. It describes the opposite-direction result (quantile lower on every seed, LR and source; gap 1.67 nats) as descriptive only, attributes the effect to the whole tokenizer-p
- criterion 4: `met` — The Methods addition (expectedRevision 1) accurately describes the arms as delivered (B as a linear projection with log SD clamped to [-7, 7]), the shared training setup, the grid, the selection and tie rule, the seeds, the 2B stop, the 172,032-target metric, the T/E diagnostic, S1–S4 and the unevaluable clause. The Results addition (expectedRevision 0) numbers match the per-run files and the reco

## task `rates-from-60m` — `wf_50be102e5d8642b3867925f42c0da9d6`

Expected: in_progress → in_review → done
Observed: in_progress → in_review → in_progress → in_review → in_progress → in_review → done

| state | entered | held |
| --- | --- | --- |
| in_progress | 2026-09-18T11:24:22.815Z | 516 s |
| in_review | 2026-09-18T11:32:58.995Z | 66 s |
| in_progress | 2026-09-18T11:34:04.651Z | 282 s |
| in_review | 2026-09-18T11:38:46.178Z | 75 s |
| in_progress | 2026-09-18T11:40:01.363Z | 325 s |
| in_review | 2026-09-18T11:45:25.961Z | 57 s |
| done | 2026-09-18T11:46:23.064Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`

> The selected rates check out: 3e-4 for the quantile arm and 1e-4 for the patch arm, each traced to its seed-17 runs, with hashes and NLLs that match the source run files. The note quotes the pre-registered rule correctly. However, it rightly declines to confirm that no held-out source was used, because the rule selects on the held-out mean. The second check cannot be met as written, so an operator decision is needed.

- criterion 1: `met` — I read the six run artifacts, art_9edc03a0, art_8c0f5750, art_c2ba6358, art_420b5605, art_31e4411b and art_4b069821. Their server sha256 values match the table. heldout_nll, per-source NLLs, run ids, LR, seed 17, tokens_seen 2B and the metrics and checkpoint hashes all match the trace. I recomputed the argmin: A selects 3e-4 and B selects 1e-4 (grid edge), with no ties. The grid-edge and checkpoin
- criterion 2: `not_met` — The note quotes the rule verbatim from the approved plan, whose hash matches edf8048a…35cb3, and defines the primary as the equal-weight mean over the three held-out sources. The required confirmation that no held-out source was used is not given, and it could not truthfully be given: the plan pre-registered selection on the scored held-out sources. The note is correct to disclose this. To resolve

**Round 2** (revision 3) — verdict `needs_changes`

> The per-arm learning rates are correctly traced and every hash matches: quantile 3e-4 and patch embedding (linear projection) 1e-4, at the lower grid edge. The note quotes the pre-registered rule verbatim. It truthfully cannot confirm that no held-out source was used, because the plan selects on the held-out mean. An operator waiver, an amendment or a new held-out-free selection is required.

- criterion 1: `met` — I read all six sweep run artifacts myself. Each server hash matches the sha256 in the trace. In every run, heldout_nll, the per-source NLLs, LR, seed, status and tokens_seen = 2B match the trace. The recomputed argmin gives A = 3e-4 (run-A-0.0003-17, -0.479960) against -0.473718 at 1e-4 and -0.437881 at 1e-3. It gives B = 1e-4 (run-B-0.0001-17, 1.190203) against 1.210437 at 3e-4 and 1.199998 at 1e
- criterion 2: `not_met` — The first half is satisfied. The note quotes the selection rule verbatim from the approved plan art_b8d2c428 (hash verified), and it defines the primary score correctly as the equal-weight held-out mean. The second half is not satisfied, and it cannot be satisfied truthfully: the plan explicitly selects the LR on the scored held-out sources, and the note correctly says so. Correction required: the

**Round 3** (revision 5) — verdict `pass`

> The learning rates are traced correctly: quantile-binned 3e-4 (interior) and patch embedding (linear projection) 1e-4 (lower grid edge). All six seed-17 run hashes and NLLs match the source runs, and the selection rule is quoted word for word. The no-held-out confirmation is waived under the 12:05Z operator waiver because selection reused the held-out sources, and the note discloses this.

- criterion 1: `met` — All six run-artifact server hashes match the trace. I read the two selected runs in full and their heldout_nll, per-source values, seed, LR, 2B token count and checkpoint/metrics hashes match. The recomputed argmin gives A = 3e-4 (run-A-0.0003-17, -0.479960) against -0.473718 and -0.437881, and B = 1e-4 (run-B-0.0001-17, 1.190203) against 1.199998 and 1.210437. There are no ties, and B is at the l
- criterion 2: `waived` — The first part is met. I checked the note's quote of the selection rule against the approved plan art_b8d2c428 (hash verified) and it is verbatim. The note also gives the primary definition and the scores the selection used. The 'no held-out source used' confirmation is waived under the operator waiver in the project Introduction (contextRevision 9, 2026-09-18 12:05Z). The approved plan selects on

## experiment `tokenizer-ab-150m-2` — `wf_5f2473a8433649cf932a74bf70e3bd09`

Expected: planned → design_review → planned → design_review → running → experiment_review → complete
Observed: planned → design_review → running → experiment_review → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:24:22.899Z | 2007 s |
| design_review | 2026-09-18T11:57:49.566Z | 216 s |
| running | 2026-09-18T12:01:25.687Z | 15505 s |
| experiment_review | 2026-09-18T16:19:50.558Z | 236 s |
| complete | 2026-09-18T16:23:46.075Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The protocol states testable hypotheses and honest limitations, but the pinned design lacks both measured learning rates and the accepted apparatus, data and evaluator specifications. Complete and verify these inputs before resubmitting; conditional execution gates do not establish a defensible comparison.

- criterion 1: `met` — Objective & hypothesis and Evaluation define a falsifiable 150M tokenizer comparison: exactly 2B tokens, three seeds per arm, relative mean held-out NLL improvement with favorable disjoint ranges for support, the prescribed <2%, 2–5% and >=5% bands, and separate whole-C1 interpretation requiring both sizes. C2 has an explicit provisional two-percentage-point magnitude tolerance and a two-size extr
- criterion 2: `not_met` — The fairness and leakage safeguards are scientifically appropriate, but the exact primary comparison is not specified. Learning rates and seeds explicitly lists both numerical rates as unavailable and their measured provenance as pending; shared intended provenance cannot verify equal actual tuning effort or selection without held-out leakage. Apparatus and Evaluation defer the accepted harness, m
- criterion 3: `not_verified` — Compute and retained evidence addresses failed runs, retries, storage, no simulation, budget limits, transferred-tuning limitations and small seed counts. However, feasibility rests on a conditional harness and a planning estimate of 12 H100 GPU-hours; no accepted executable configuration, actual validated card or measured per-arm throughput/cost evidence is pinned. The plan itself calls these sub

**Round 2** (revision 3) — verdict `pass`

> The plan fixes attempt 1's gaps. Both rates trace to the same 60M sweep and rule, and the apparatus and data are pinned. The exact primary rule is kept alongside a pre-registered sign-safe ordering rule. It discloses that rates were chosen on the scored held-out data, which cannot be avoided here, and bounds it with S5. Cost fits the $200 cap. The design can answer its question.

- criterion 1: `met` — H1 is falsifiable: at 150M, μ[B] must be at least 5% below μ[A] with disjoint seed ranges, at exactly 2B observations, on seeds 101/202/303. The alternatives (smaller benefit, no difference, reversal, unresolved variation) are named. The primary rule keeps the sibling bands exactly as specified and declares the result unevaluable when μ[A] ≤ 0. The plan anticipates that case is likely, so it pre-r
- criterion 2: `met` — Learning-rate fairness: both rates come from one sweep procedure (same grid, seed, budget and rule). I verified this by reading the cited rates trace art_fbacc09f… and the 60M verdict-analysis art_37df3086…; the values, run IDs and hashes match. Controls: both arms use the same unmodified configs/150M.json (880/16, rotary), optimizer, schedule, data order, 2B stop and a single GPU SKU. The known a
- criterion 3: `met` — Execution plan: six runs from scratch, with exact v2 CLI commands and pre-flight tests. Card: an H100 80GB, the same SKU as all 12 60M runs. Throughput: estimated from the v1 150M benchmark scaled by 60M ratios (A ~3.6 h, B ~3.3 h, 20.8 GPU-h). The arithmetic checks, and the plan states that the brief's ~2 h/run figure is exceeded. Budget: a spend gate with 1.25× headroom ($95.20) against the $200

**Round 3** (revision 5) — verdict `pass`

> All six 150M runs followed the approved plan: one H100 each, the carried rates, exactly 2B observations. Recomputed numbers match the run files and exhibit. The primary result is UNDETERMINED (mu[A] <= 0). The pre-registered sign-safe ordering gives QUANTILE-BETTER, and S1 and S5 hold. So C1 is contradicted as written and the 60M ordering holds at 150M. The paper edits are accurate.

- criterion 1: `met` — The six runs match the plan's allocation: - A 3e-4 / B 1e-4, seeds 101/202/303, unmodified configs/150M.json (e7f765b2…8864), rotary positions. - Exact planned commands with no forbidden flags; 2,000,000,000 observations and 244,160 steps; the final checkpoint scored and retained. - All 172,032 held-out targets scored; one H100 80GB HBM3 SKU; consistent manifest, tokenizer, freeze and code hashes.
- criterion 2: `met` — I recomputed the per-run primaries from the source means, and mu, ranges, D, R, δ_A/δ_B, the ordering inequalities, S1 and both S5 shifts from the run files. All match verdict-analysis.json and the report table to the printed precision. The exhibit's heldout_nll values, file hashes, band mu values and label match the artifacts. The report tabulates every run with per-source NLL, the in-corpus diag
- criterion 3: `met` — The report states the primary label first (UNDETERMINED, unevaluable because mu[A] <= 0) and does not treat the formal R as a result. It then applies the pre-registered secondary rule, QUANTILE-BETTER, which survives S1 and S5. The C1 reading follows the plan's pre-registered mapping: patch did not improve at 150M, so C1 is contradicted as written. That is a negative finding stated plainly. The C2
- criterion 4: `met` — The Methods addition matches the plan and the run files: config and parameter counts, rates and their provenance, the S5 deltas, seeds and metric, the primary and secondary rules, the card, and about 155k/208k obs/s. It is written against revision 2 and leaves existing sections unchanged. The Results addition quotes the per-seed NLLs, means, ranges, per-source seed means, D, the formal R, the orde

## experiment `posenc-150m-2` — `wf_f8c6dd8c7cf846f19c7afe4ab48f02d9`

Expected: planned → design_review → running → experiment_review → planned → design_review → running → experiment_review → complete
Observed: planned → design_review → planned → design_review → planned → design_review → planned → abandoned

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:24:22.981Z | 1878 s |
| design_review | 2026-09-18T11:55:41.386Z | 119 s |
| planned | 2026-09-18T11:57:40.617Z | 804 s |
| design_review | 2026-09-18T12:11:04.194Z | 164 s |
| planned | 2026-09-18T12:13:48.103Z | 606 s |
| design_review | 2026-09-18T12:23:54.451Z | 156 s |
| planned | 2026-09-18T12:26:30.535Z | 46 s |
| abandoned | 2026-09-18T12:27:16.392Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The plan is honest, well controlled and runnable, but it cannot answer its research question. C3 and the brief require evaluation at 4,096-step context, and the frozen apparatus only evaluates 256-observation windows. The plan itself pre-registers C3 at 4,096 as not tested under every outcome. Before a plan can pass, it needs either a 4,096-capable apparatus or an owner decision re-scoping C3.

- criterion 1: `not_met` — The hypothesis is testable only in a form that differs from the one the experiment exists to test. The brief's research question and claim C3 (claim_049e1e1f27644766bfabe595070f82a2) are explicitly at 4,096-step context. The brief says 'THE EVALUATION SET IS THE WHOLE POINT. Evaluate at 4,096-step context ... and on nothing else.' I checked the plan's incompatibility finding against the accepted v
- criterion 2: `met` — For the comparison the plan actually proposes, the controls are strong. --position is the only varied flag. The config, tokenizer and calibration, schedule, data order, 2B budget (244,160 steps), evaluator and GPU class are identical across arms, and invalidation condition 4 checks this from run.json hashes. Seeds 101/202/303 are disjoint from sweep and default seeds. The plan correctly notes that
- criterion 3: `met` — Execution at 256 is feasible and failure modes are handled well. The plan uses the measured 150M throughput (156k obs/s, about 3.6 h/run), not the brief's 2 h, and derives about 24 GPU-h / about $80. It gates launch on spend_status covering all six runs plus 10%, because the ~$116 remaining cap is shared with tokenizer-ab-150m-2 and a partial seed set invalidates the test. It also forbids running 

**Round 2** (revision 3) — verdict `needs_changes`, returnTo `planned`

> The 4,096-context design is scientifically sound, and its arithmetic checks out. But the plan says it cannot run. It depends on an apparatus task (A1–A7) that does not exist and is not linked. Its evaluator and loader are only specifications, the spend gate is probably not met, and owner decisions are still open. Approving it would send a design with no runnable apparatus into execution.

- criterion 1: `met` — The design now tests C3 as stated. Both arms train and are evaluated at 4,096-step context, on 47 windows cut only from the frozen held-out arrays of the three named sources. Four outcomes are distinguished: supports, rotary better, absolute better and undetermined. D = 100·|m_R−m_A|/|m_A| uses a sign-safe denominator with an unevaluability floor of 0.10 nats. Supports needs D<1% with overlapping 
- criterion 2: `met` — The arms differ only in --position. Config, tokenizer, schedule, data order, budget, evaluator and GPU class are shared. Invalidation condition 4 checks this from run.json, and conditions 1, 5 and 6 bar any other evaluation set or context and any execution without G1. The extra 3.6M-parameter absolute table (2.39%) is part of the method and is disclosed. The data change is identical in both arms: 
- criterion 3: `not_met` — By the plan's own statement it cannot execute. First, G1 and G2 fail: workflow.status_and_next lists rates-from-60m as the only prerequisite, and no A1–A7 apparatus task exists or is linked. The loader, evaluator, config, freeze and launch command are specifications, not delivered code, and the command is only an 'expected form'. Second, G3 is probably unmet. The FLOP estimate of 30–37 GPU-h, abou

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `planned`

> The 4,096-context design is sound and now lists both limitations suggested last time. But it cannot run: no accepted A1–A7 apparatus task exists or is linked, and the loader, evaluator and launch command are unwritten. The spend gate fails and three owner decisions are unrecorded, so the plan cannot be approved yet.

- criterion 1: `met` — The design tests C3 as stated. Both arms train and are evaluated at 4,096-step context, on 47 windows cut only from the frozen held-out arrays of australian_electricity_demand, pedestrian_counts and traffic_hourly. Five outcomes are distinguished: supports, contradicted with rotary lower, contradicted with absolute lower, undetermined, and unevaluable. The statistic D = 100·|m_R−m_A|/|m_A| uses a 
- criterion 2: `met` — The arms differ only in --position. Config, tokenizer, schedule, data order, budget, evaluator and GPU class are shared, and invalidation condition 4 checks this from run.json. The absolute arm's extra 3,604,480 parameters (+2.394%) are intrinsic to the method and disclosed. The data changes apply identically to both arms: 5.1% of observations repeat, and the budget overshoots 2B by 3,072. Held-ou
- criterion 3: `not_met` — The plan itself states that it cannot execute, and the live checks confirm it. - G1/G2 not met: workflow.status_and_next lists rates-from-60m as the only prerequisite, and no A1–A7 task is linked. The v2 apparatus has no context flag, a 256-row absolute table, a budget that must divide by 256, and no checkpoint resume. The loader, evaluator, config, freeze and command therefore exist only as speci

## experiment `harness-in-repo` — `wf_ca23069e82744a72bcfcc705f39678cf`

Expected: planned → design_review → running → experiment_review → complete
Observed: planned → complete

| state | entered | held |
| --- | --- | --- |
| planned | 2026-09-18T11:24:23.150Z | 2 s |
| complete | 2026-09-18T11:24:24.978Z | — |

### Review rounds

**Round 1** (revision 1) — verdict `needs_changes`, returnTo `planned`

> The deterministic manifest evaluation is well designed, but the plan pins obsolete v1 configurations and launch instructions. Accepted v2 changes more than LR/seed support. Update the apparatus pins and installation inventory before execution; retain the unchanged corpus pins and existing controls.

- criterion 1: `met` — Objective & hypothesis and Evaluation define a falsifiable repository-fidelity/metadata test: valid shard digests and sizes, exactly 2,000,000,000 training observations, and zero held-out source overlap. Named assertion failures and separate provenance/environment invalidation distinguish success from alternatives. Scope correctly excludes model quality and full-array truth; no statistical baselin
- criterion 2: `not_met` — The valid/mutated fixtures, independent delivery count, repository-byte identity checks and shard/provenance-level source separation are defensible controls, with identity and semantic tests separated to avoid masking defects. However, Pinned apparatus and data chooses art_1506682239c9429db2ad48cf91072c35 and v1 config/README/freeze hashes as the reference despite the assignment requiring accepted
- criterion 3: `not_met` — CPU-only verification of a roughly 54 MB manifest, single-object acquisition, standard-library checks, code.commit checkpoints and final workspace capture are technically feasible. Missing inputs, symlink/path escape, malformed metadata, provenance mismatch, implementation rework and commit self-reference are addressed. Nevertheless the exact execution plan instructs preflight to stop for a revise

**Round 2** (revision 3) — verdict `pass`

> The pinned v2 plan can answer the repository-fidelity question. It corrects the obsolete apparatus selection and combines independent release pins, manifest invariants and mutation controls with feasible offline evaluation. All three design criteria are met; implementation results remain to be established.

- criterion 1: `met` — Objective & hypothesis and Evaluation define a falsifiable test of committed repository fidelity and manifest metadata: valid digest/size on every shard, exactly 2,000,000,000 training observations, and no held-out training source overlap, together with complete v2 identity. The exact primary command, named diagnostics, nonzero failure exits, separate invalidation conditions and explicit PASS rule
- criterion 2: `met` — The accepted v2 release is an appropriate deterministic reference. Artifact and manifest pins, exact training/evaluation counts, fixed held-out names, complete member inventory and retained provenance prevent certification from self-consistent but changed candidate metadata. Source separation is checked at top-level, shard and provenance levels with agreement checks, and evaluation observations ar
- criterion 3: `met` — The execution is feasible as standard-library CPU verification of one roughly 54 MB manifest and small retained artifacts in the runner-provided private Git checkout. Acquisition is limited to Merv and project storage, with no GPU, shard downloads or launch execution; evaluation consumes repository files only. The plan addresses missing inputs, unsuitable checkout, unsafe archive paths and externa

**Round 3** (revision 5) — verdict `needs_changes`, returnTo `running`

> The v2 installation, provenance checks, verifier and 14 controls are sound and honestly reported, but the pre-registered primary evaluation never ran: the full manifest was not acquired, so all three assertions are not_evaluated and the verifier exits 1. The plan is valid. Repair under it in a lease with sandboxes storage access by committing the manifest and rerunning.

- criterion 1: `not_met` — Execution followed the approved plan up to the manifest. At capture D: - The six artifacts are retained under vendor/ and provenance/. - The 45 v2 members are imported, with v1 kept only as a test fixture. - SOURCES.json, INTEGRATION.md, the standard-library verifier and the committed controls are present. - The C/D separation is present and the report states that the harness is unchanged between 
- criterion 2: `met` — The committed results/harness-in-repo/results.json matches art_c8798cc7 field for field: BLOCKED, null shard_count and observation_total, three not_evaluated assertions, provenance with only the manifest failing, 6/45/24 matches, controls 14/14, exit 1 and Python 3.11.7. verify_manifest.stdout confirms the single error "missing file: harness/data/manifest.json" and not_evaluated for all three asse
- criterion 3: `met` — The one-sentence Conclusion says the harness is installed and its provenance verified in 25e8f15, but that the test is blocked (no valid test of H1): the manifest was not acquired, the verifier exits 1 and no assertion was evaluated. That follows exactly from the evidence and claims no pass or fail of H1. The Limitations section correctly limits even a completed run to metadata consistency and rep

**Round 4** (revision 7) — verdict `pass`

> The repair run did what the approved plan required. The real manifest bytes are now committed. On clean commit 41bf99e the verifier exits 0 and all three assertions pass: 60 shards, 2B training observations and no held-out overlap. Provenance and all 14 controls pass. The results, exhibit, report and proposed Methods text agree with the checkout, and the earlier BLOCKED run is kept and disclosed.

- criterion 1: `met` — The repair followed the approved plan and the previous review's repair list: - It fetched the single object obj_9z92tagytddvhzqp and committed its real bytes at harness/data/manifest.json. The file is present in the checkout and is not an LFS pointer. - It re-derived held_out_sources.json from eval_source_ids, as plan step 4 requires. - It regenerated SOURCES.json. - It evaluated the clean commit 
- criterion 2: `met` — The numbers agree across all sources. The committed stdout shows 60 training shards, 2,000,000,000 training observations, 3 evaluation shards, 196,608 evaluation observations, overlap [] and train_sources [era5_1989]. It also shows the manifest sha256 a23b9537…edaf. The committed results.json and art_96b314c0 report the same values, and the exhibit art_7e7f3d96 restates them exactly. The unittest 
- criterion 3: `met` — The one-sentence PASS conclusion follows from the pre-registered rule. All three assertions hold, the verifier exits 0, provenance passes, the controls pass and no INVALID condition was triggered. The report states its limits: metadata and repository fidelity only, no shard array contents, and no model performance claim. It also notes that training uses a single source.
- criterion 4: `met` — The proposed Methods section apparatus-and-corpus (against revision 0) is supported by the evidence: - The v2 archive ID and hash, commit 41bf99e and the manifest object, hash and size match the plan pins and results. - The configs (640/12 and 880/16, patch 16, seed 1729, learning rate 3e-4) and the tokenizer calibration match the plan. - 60 shards, 2B observations from era5_1989, the three held-o

## Limits

Trajectories and verdicts are asserted after the fact; no verdict text reaches any worker.

A stage carrying a planted defect is launched by this harness, not the runner: the runner builds its child stdin from the frozen assignment and has no per-assignment prompt hook.

The production feed has no voices: each brief post is written by the source credential with its named role as a body prefix.

Reflection, consolidation and post-wave claim updates are outside this harness slice.

| The scenario says | On this server | Stand-in |
| --- | --- | --- |
| Fathom Signals, 40B tokens of pooled industrial sensor data, three held-out plants, a $25,000 run | None of it exists | A named public multi-source time-series archive, ~2B tokens, split by **source**, with three sources held out entirely. That preserves the only property the experiments depend on. A synthetic signal generator is defensible for the *tokenizer* comparison alone; if one is used, the claims must be rewritten to name it and drop "held-out plants". |
| "on one H100" in task check 4 | No H100 has ever been rented live by the sandboxes service; the only validated GPU is a Lambda A10 24 GB | Measure throughput on the card you actually rent and report it by name. Do not carry the scenario's ~700k / ~280k tok/s figures. 60M and 150M at 2B tokens do not need an H100 — this is the one scenario that could run today on validated hardware, at roughly a quarter of the throughput and a small fraction of the price. |
| The task reviewer "launches its own smoke run" | A runner-dispatched reviewer has no network at all and cannot rent anything | Either launch the task-review assignment through path B/C with network on, or accept a reviewer that verifies the logged throughput from the retained JSON lines and records that criterion `not_verified` with notes. Do not record it `met` on an unverified reading. |
| `sandbox.options`, `sandbox.request`, `sandbox.run`, `sandbox.pull_outputs`, 12-hour leases with one extension | Do not exist; Merv exposes only `sandbox.extend` and `sandbox.release`, and the sandboxes plugin is not composed in production | Compute driven beside Merv against the sandboxes service or the operator's machines; evidence returns as artifacts. Note that a long training run can outlive its Merv session lease (active sliding lifetime four hours, hard deadline twenty-four) unless the launcher heartbeats. |
| **Candidate submission and champion promotion** across experiments | **No `candidate.*` tools and no champion record exist.** This is the one mechanism scenario 2 exercises that has no counterpart at all | Record the standing best configuration in the Paper Results section (via a `paperChangesArtifactId` on a results submission) and in the reflection synthesis. It is a written record rather than a tracked one, and no promotion is challengeable by a later wave the way the scenario describes. |
| Reflection lenses `scaling-trend` and `budget-fairness` | Roster fixed at `evidence`, `theory`, `methods`, `synthesis`, `next_steps`; `reflection.create` takes only `title` and `requestId` | Questions carried in a pre-wave artifact + feed post + the wave title, read by the lens agents as live project research. They are not lens records. |
| Feed `chart` and `table` blocks; "the thread turns into the most-read thing in the project" | No kinds, threads, replies, reactions or blocks; a post is body + ≤10 artifact ids | Role prefix in body text; charts as attached PNG artifacts; tables as plain text. |
| The `posenc-150m` attempt-1 rejection | Must be earned | Planted in the executor's prompt (§4), never in the reviewer's. It costs a full rerun of twelve GPU-hours in the scenario's own budget — decide before launching whether you are paying for it, and note that omitting it is legitimate. |
| "the wasted attempt was visible in the Sandboxes view before the reviewer's verdict landed" | The sandboxes plugin is not composed in production, and even when it is, the plugin reads a UI manifest the service does not appear to serve — the Sandboxes row is expected to sit `degraded` | Spend visibility comes from the sandboxes service directly (`spend_status`, `usage_report`), not from Merv's UI. |
| Experiment-on-experiment dependency between 60M and 150M | `experiment.create.dependsOn` would accept it, but the wave rule forbids proposing such an edge | Prose in `details` plus hand-sequencing by the operator, exactly as the scenario itself describes. |
| Every script
