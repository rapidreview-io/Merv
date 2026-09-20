# Scenario 3 — Cut serving cost in half without losing the long tail

*A Series A startup with a deployed product uses Merv to evaluate three
serving changes in parallel, across five quality slices, for about $100 of
inference-only GPU time, after a previous attempt shipped a regression to
Spanish-speaking customers.*

## The company

**Parlay** (fictional) sells a customer-support copilot to mid-size
e-commerce brands. It drafts replies, calls order and refund tools, and
escalates when it should. Fourteen people; a Series A closed nine months ago.
The model is a 70B-class open-weight model served in bf16 on two H100s per
replica, nine replicas, about $4,200 per replica per month. Serving is 38% of
revenue and the board has noticed.

The VP of Engineering has three ideas, all standard:

1. 4-bit weight-only quantization of the 70B model, which fits on one H100
   and should roughly double throughput.
2. Replace the 70B with a 32B model in bf16.
3. Speculative decoding with a small draft model, which should speed up the
   very repetitive tool-call outputs without changing them.

The risk is the long tail. Twelve percent of tickets are in German, French or
Spanish. Some threads run past 8,000 tokens. Tool calls must be schema-exact
or the refund pipeline rejects them. And the model's refusal behaviour on
abusive tickets is something the support leads care about more than the
engineers do.

## What happened last time

Four months earlier an engineer quantized the model, ran a standard academic
benchmark, saw a 0.3-point drop, and shipped it. Spanish tickets degraded for
two days before a support lead noticed a pattern in escalations. The
post-mortem found the benchmark was English-only, the comparison had used
sampling at temperature 0.7 so run-to-run noise hid the gap, and nobody had
kept the pre-quantization outputs to diff against. The rollback took an
afternoon; the customer apology took longer.

Merv is the answer to the post-mortem's action items rather than to the
research question. The action items were: define the slices before testing,
require per-slice numbers, freeze the baseline outputs, make comparability
rules explicit, and have someone other than the author check the numbers.
Every one of those is a Merv gate.

## Project setup

Introduction:

> Parlay serves a 70B open-weight support model on 2×H100 per replica. Goal:
> reduce per-token serving cost by at least 2× with no more than a 1.0-point
> regression on any of five quality slices, measured on de-identified
> production tickets. Candidates: 4-bit quantization, a 32B model, speculative
> decoding. All comparisons at greedy decoding against a frozen bf16 baseline.
> GPU budget for the project: $200. Timeline: three weeks to a routing
> decision.

Claims:

| Claim | Statement | Confidence |
| --- | --- | --- |
| C1 | 4-bit weight-only quantization of the 70B model loses less than 1.0 point on **every** one of the five quality slices, at greedy decoding, while delivering at least 2.2× tokens per second per GPU at the p95 latency SLO. | medium |
| C2 | The 32B bf16 model matches the 70B within 1.0 point on the English, tool-call, long-context and refusal slices, and does not match it on the non-English slice. | medium |
| C3 | Speculative decoding with a 1B draft model produces byte-identical greedy outputs on the tool-call slice and at least 1.6× tokens per second. | high |

The word "every" in C1 is deliberate and is the whole lesson of the
post-mortem.

## Wave 1

### Task `slice-evals`

Everything in this wave depends on this task. Deliverables:

1. Five evaluation slices from de-identified production tickets, at least 300
   items each: English general, non-English (de/fr/es, at least 90 each),
   long-context (threads over 8,000 tokens), tool-call (tickets whose gold
   answer is a schema-valid tool invocation), refusal (tickets the support QA
   team labelled as must-escalate or must-decline). Item counts and the
   de-identification method stated in a manifest.
2. A scoring protocol per slice: exact schema match for tool calls;
   human-labelled resolution correctness for the other slices using an
   LLM-as-judge calibrated against 100 human labels per slice, with the
   agreement rate reported and any slice below 85% agreement flagged.
3. A latency harness that drives 32 concurrent sessions from recorded ticket
   traces and reports p50/p95 time-to-first-token, tokens per second per GPU,
   and cost per 1,000 output tokens at a stated GPU rate.
4. The bf16 70B baseline scored on all five slices at greedy decoding, with
   every raw output retained as a storage object, and its `results.json`
   submitted.

The support QA lead does the labelling with the agent preparing the sheets.
The task reviewer re-runs the judge-agreement check and refuses the first
delivery: the long-context slice had 212 items, not 300. The agent widens
the date range, resubmits, and the task passes. The refusal-slice judge
agreement is 86%, just over the bar, and the reviewer's synopsis says to
treat that slice's numbers with a wider margin.

Baseline on 2×H100:

| Slice | bf16 70B score |
| --- | --- |
| English general | 88.4 |
| Non-English | 84.1 |
| Long-context | 81.7 |
| Tool-call (exact) | 96.2 |
| Refusal | 92.0 |
| Throughput | 1.0× (reference), p95 TTFT 1.9 s at 32 sessions |

### Experiment `awq-70b` (tests C1)

**Intent:** Determine whether 4-bit weight-only quantization of the
production 70B model preserves every `slice-evals` slice within 1.0 point at
greedy decoding while reaching at least 2.2× throughput on one H100, so that
serving can move from two GPUs per replica to one.

**Details:** Calibration data must be disjoint from all five slices; say where
it comes from. Greedy decoding only. Keep the quantized weights as a storage
object. Sibling `dense-32b` owns the smaller-model question and `specdec-70b`
owns speculative decoding; do not combine techniques here.

**Design review, round 1: needs_changes.** Three problems. The plan's decision
rule compared against "published bf16 numbers" for the model rather than the
harness baseline. The plan did not state the decoding configuration, and the
reviewer quotes the post-mortem's temperature-0.7 finding back at the author.
And the calibration set was described as "a sample of tickets" without a
disjointness check. Plan v2 fixes all three, adds a retained diff of outputs
against the baseline as an output, and passes.

### Experiment `dense-32b` (tests C2)

Same slices, same harness, 32B bf16 on one H100. The plan's rule mirrors the
claim: within 1.0 on four slices supports; a non-English gap over 1.0 is
expected and is part of what "supports" means. Design review passes on the
first round with a note that the plan should retain the 32B outputs for a
later routing analysis.

### Experiment `specdec-70b` (tests C3)

bf16 70B on 2×H100 with a 1B draft model. Because the claim is byte-identical
greedy outputs, the plan's primary check is a diff, not a score; scores are
reported as a sanity check. Throughput measured on the tool-call slice only,
since that is where the acceptance rate is expected to be high. Passes design
review.

## Execution

Three sandboxes, three experiments, three agent sessions, each with its own
`agent_id`. Well under the seven-experiment cap. Hardware:

| Experiment | Machine | Lease |
| --- | --- | --- |
| `awq-70b` | 1× H100 80 GB | 8 h |
| `dense-32b` | 1× H100 80 GB | 6 h |
| `specdec-70b` | 2× H100 80 GB | 6 h |

Each agent registers a feed voice. The support QA lead follows the feed on
the project page: the `awq-70b` thread posts quantization done, then the
per-slice `table` as slices finish; the `specdec-70b` thread posts a `stat`
of acceptance rate. When the non-English row lands in the `awq-70b` table, the
QA lead replies on the feed: "that is the Spanish thing again — check es
separately from de/fr." The agent adds a per-language breakdown to the
retained results, which the plan's Outputs section already allowed.

All raw outputs go to storage objects before any lease is released. The
quantized weights (about 40 GB) are retained as a storage object with its id
in the report.

## Results and review

**`awq-70b`**

| Slice | bf16 70B | AWQ 4-bit | Δ |
| --- | --- | --- | --- |
| English general | 88.4 | 88.1 | −0.3 |
| Non-English | 84.1 | 81.8 | **−2.3** |
| Long-context | 81.7 | 81.0 | −0.7 |
| Tool-call (exact) | 96.2 | 95.9 | −0.3 |
| Refusal | 92.0 | 92.8 | +0.8 |
| Throughput per GPU | 1.0× | **2.4×** | |
| p95 TTFT at 32 sessions | 1.9 s | 1.4 s | |

Per language: de −1.1, fr −1.6, es **−4.0**.

Report v1's Summary reads: "Quality is preserved within noise on aggregate
(−0.6 mean across slices) at 2.4× throughput; recommend rollout." The
**attempt reviewer returns it to running** in one paragraph: the numeric
record shows a 2.3-point regression on the non-English slice, the
pre-registered rule names any slice over 1.0 as failure, and the report's
conclusion must state that C1 is contradicted. It also asks that the
per-language breakdown appear in the report since it is in the record.
Report v2 says: "C1 is contradicted. Quantization holds on four slices and
delivers 2.4× throughput, and fails on non-English, driven by Spanish." Round
2 passes. This is a successful experiment: the claim was falsified, and the
rollout that would have repeated the post-mortem did not happen.

**`dense-32b`**

| Slice | bf16 70B | 32B bf16 | Δ |
| --- | --- | --- | --- |
| English general | 88.4 | 87.6 | −0.8 |
| Non-English | 84.1 | 81.0 | −3.1 |
| Long-context | 81.7 | 80.9 | −0.8 |
| Tool-call (exact) | 96.2 | 95.4 | −0.8 |
| Refusal | 92.0 | 91.5 | −0.5 |
| Throughput per GPU | 1.0× | 2.0× | |

Exactly what C2 predicted: within 1.0 everywhere except non-English. C2
supported. Attempt review passes on the first round; the reviewer notes the
three −0.8 deltas are all near the boundary and recommends a second judge
pass before this model carries any production traffic.

**`specdec-70b`**

Tool-call outputs byte-identical to the baseline on 300 of 300 items.
Acceptance rate 78%. Throughput 1.7× on the tool-call slice, 1.3× on English
general (reported as a sanity check; not part of the claim). C3 supported,
confidence high. Passes on the first round.

## Reflection

Three terminal experiments and an idle project. The authored lenses:

- **cost-model**: combine the measured throughputs with the traffic mix
  (88% English-dominant, 12% non-English; 31% of output tokens are tool
  calls) into a cost per 1,000 tickets for each candidate routing.
- **safety-regressions**: the refusal slice moved +0.8 under quantization,
  within threshold but in the direction of over-refusal; is that a trend
  worth a dedicated slice?

What comes out:

- **amplify**: speculative decoding is free quality and 1.3–1.7× speed; ship
  it on every replica regardless of the other decisions.
- **avoid**: neither AWQ nor the 32B model may carry non-English traffic.
  Both fail the same slice for the same reason.
- **entropy**: nobody tested per-language routing (non-English to bf16 70B,
  everything else to AWQ 70B), which the cost-model lens estimates as a 2.1×
  cost cut on 88% of traffic; nobody tested 8-bit weights or an 8-bit KV
  cache, which might hold the non-English slice; nobody tested AWQ on the
  32B model.
- **cost-model**: routing plus speculative decoding cuts blended cost per
  1,000 tickets by 2.3×; AWQ alone without routing would have cut it 2.4×
  and lost the Spanish accounts.
- **safety-regressions**: +0.8 over-refusal is within the rule but the
  refusal judge had the lowest agreement; propose a 200-item human-only
  refusal slice before any rollout.

Change spec:

- C1 → `contradicted`. New claim: "AWQ 4-bit holds within 1.0 on English,
  long-context, tool-call and refusal slices at 2.4× throughput; it does not
  hold on non-English."
- C2 → `supported`. C3 → `supported`, high.
- Wave 2: a task to implement language detection and routing in the gateway
  with a shadow-traffic log as a deliverable; an experiment `int8-70b` (8-bit
  weights, same slices, the entropy lens's question); an experiment
  `awq-routing-shadow` scoring the routed configuration on a fresh week of
  shadow traffic; and a task for the human-only refusal slice.
- A code consolidation is selected: the speculative-decoding serving config
  becomes an immutable proposal, reviewed by a consolidation reviewer, and
  compare-and-swapped into the serving repo's Merv ref rather than pasted
  into a PR by hand.

The reflection review returns the synthesis once, because the change spec's
`awq-routing-shadow` experiment depended on the routing task but the task's
deliverables did not name the shadow log format the experiment needed. Fixed,
passed, published.

## What the company gets

- Speculative decoding ships in week two with byte-identical outputs and a
  record that says so.
- The quantization rollout that would have repeated the Spanish incident
  never happens, and the reason is a reviewer's paragraph, not a customer's
  email.
- A routing plan with a costed estimate of 2.3× blended savings, with the two
  open questions (8-bit, refusal slice) already scheduled as wave 2.
- The Methods and Results sections of the living paper, updated through the
  experiment submissions, become the customer-facing model-change note
  without anyone rewriting them.
- The support QA lead, who never opened a terminal, caught the Spanish signal
  early because it appeared in a feed table, and their comment is in the
  record next to the agent's response.

## Budget

Inference-only work; assumed H100 80 GB at $3.00 per hour. Everything fits on
H100s because the bf16 70B baseline and speculative-decoding runs need two
GPUs of memory; the AWQ and 32B runs need one.

| Item | Machine | Hours | Cost |
| --- | --- | --- | --- |
| `slice-evals`: bf16 70B baseline on five slices plus latency harness | 2× H100 | 3 | $18 |
| `awq-70b`: quantization with calibration, five slices, latency harness, output diff | 1× H100 | 6 | $18 |
| `dense-32b`: five slices plus latency harness | 1× H100 | 4 | $12 |
| `specdec-70b`: tool-call slice diff plus throughput, English sanity pass | 2× H100 | 4 | $24 |
| Per-language re-scoring after the feed comment, idle lease tails, setup | 1× H100 | 3 | $9 |
| **Wave 1 total** | | | **≈ $81** |
| Wave 2 as proposed: `int8-70b` (1× H100, 6 h), `awq-routing-shadow` (1× H100, 4 h), refusal-slice re-score (2× H100, 1 h) | | | ≈ $36 |
| Contingency, one reviewer-forced rerun of a full slice pass | 2× H100 | 3 | ≈ $18 |
| **Both waves, ceiling** | | | **≈ $135** |

The project spend cap is $200 with a $50 daily cap. The most expensive line
in the whole project is not GPU time but the support QA lead's labelling
hours for the task, which is exactly where the money should go.

## Merv mechanisms this scenario exercises

- A task whose deliverables encode the post-mortem (slice counts, judge
  calibration, retained baseline outputs) and a task reviewer refusing a
  short slice.
- Three experiments with a shared task dependency, run in parallel by three
  agent sessions on three sandboxes.
- Design review enforcing comparability rules: greedy decoding, harness
  baseline, disjoint calibration data.
- A claim written with "every slice" so the attempt reviewer can refuse an
  aggregate-only conclusion, and the return-to-running that follows.
- A refuted claim recorded as a successful experiment.
- Feed tables and stats that let a non-engineer intervene, with the reply in
  the record.
- Storage objects for large retained outputs and quantized weights.
- Authored reflection lenses that turn measurements into a costed routing
  decision, and an entropy lens that finds the untested combination.
- Code consolidation carrying a reviewed serving-config change into the
  repo.
- Living paper sections doubling as the customer-facing change note.
