# Scenario 1 — Fine-tune, or keep prompting?

*A three-person pre-seed startup uses Merv to settle one product decision in
two weeks, on about $60 of GPU time.*

## The company

**Ledgerline** (fictional) extracts line items from vendor invoices and
receipts for small accounting firms. Three people: a founder with an ML
background, a backend engineer, and a former bookkeeper who labels data and
talks to customers. The product today is a long few-shot prompt against a
hosted frontier model. It works, but three things are wrong with it:

- accuracy has plateaued around 91% field-level F1 on the internal test set,
  and customers keep reporting tax-line and multi-currency mistakes;
- median latency is six to nine seconds per document, which makes the
  "drag a folder in and watch it fill" demo feel slow;
- per-document cost is fine at today's volume but scales linearly with the
  accounting firms they are courting.

They own 5,200 labeled invoices as line-item JSON. The founder's hunch is that
a LoRA fine-tune of an 8B open-weight model would beat the prompt at a tenth
of the serving cost and a third of the latency. Investors are asking "is the
model your moat or is the prompt your moat?" and the honest answer is "we
don't know."

## The decision

One question, one number: **does a LoRA fine-tune on the data we already have
beat the prompt by enough to justify a month of pipeline and serving work?**
If yes, the next month goes into training and serving. If no, it goes into
product, and the fine-tune idea is parked with a written reason.

The decision needs a number the whole team believes, because the two
engineers disagree and the labeler is the only person who knows what a
"correct" tax line is.

## Why not just a notebook

They tried. A month earlier the founder ran a LoRA over a weekend, saw 94%
F1, and announced it in Slack. The backend engineer then noticed the test set
contained invoices from the same vendors as the training set, often the same
template with different totals. Nobody could reconstruct which learning rate,
epoch count, or seed had produced the 94%, and the notebook had been edited
since. The number was withdrawn and the argument restarted from zero.

That failure is exactly the shape Merv is built around:

- the evaluation set gets built and frozen as a **task** with verifiable
  deliverables before any training starts, and a separate reviewer checks the
  split is really vendor-disjoint;
- every experiment's **plan** pre-registers the metric, baseline, decision
  rule and invalidation conditions, and a different agent reviews it before a
  GPU is rented;
- results are submitted as immutable artifacts tied to the config and seed
  that produced them, so "which run was that" is never a question again;
- the labeler, who does not read Python, follows the **feed** and the project
  overview instead of a Slack thread of screenshots.

## Project setup

The founder installs the Merv plugin in Claude Code, signs in, and asks the
agent to create the project. The agent writes the Introduction from the
conversation, roughly:

> Ledgerline extracts line items from invoices for small accounting firms.
> Today: few-shot prompting of a hosted model, ~91% field-level F1, 6–9 s
> latency. We hold 5,200 labeled invoices. Goal of this project: decide, with
> a vendor-disjoint evaluation, whether a LoRA fine-tune of an 8B open model
> beats the prompt by enough to justify building a training and serving
> pipeline. Budget for this project: under $100 of GPU time and two weeks.

Then three claims, each a sentence the team can be wrong about:

| Claim | Statement | Confidence |
| --- | --- | --- |
| C1 | A LoRA fine-tune of an 8B open-weight model on the 5,200 labeled invoices reaches at least 94.0 field-level F1 on a vendor-disjoint held-out set and beats the re-scored prompt baseline by at least 2.0 points. | medium |
| C2 | Most of the fine-tuning gain arrives by 2,500 examples; going from 2,500 to 5,200 adds less than 1.0 point. Labeling more data is not the bottleneck. | low |
| C3 | Tax-line and multi-currency fields are the dominant failure class for both the prompt and the fine-tune. | medium |

C3 is deliberately not tested by an experiment in wave 1. The per-slice
results that the harness produces will let the reflection judge it for free.

## Wave 1

### Task `eval-harness`

Created straight into `in_progress`, with a goal and four deliverables that
the reviewer can check as written:

1. A vendor-disjoint split: at least 600 held-out invoices, zero vendor overlap
   with the training pool, produced by a script that is checked in, with the
   dedup method (vendor id plus template hash) and the SHA-256 of each split
   file recorded in `splits/manifest.json`.
2. A scorer that emits `results.json` with overall field-level F1, per-field
   F1, and per-slice F1 for three slices: tax lines, multi-currency documents,
   handwritten or photographed documents. Slice membership counts are listed.
3. The current prompt baseline re-scored under this harness, raw model outputs
   retained as a storage object, and its `results.json` submitted.
4. A one-page `README` in the harness folder that lets a fresh agent run the
   scorer on any predictions file in one command.

The agent builds it locally (no GPU needed; the prompt baseline is API calls),
writes `delivery.md` with one confirmation per deliverable, and submits. The
task reviewer, a separate agent, re-runs the overlap check from the manifest
and confirms zero vendor overlap. It notices the handwritten slice has only
41 documents and says so in its synopsis; the task still passes because the
deliverable said "listed", not "at least N".

The re-scored prompt baseline comes out at **90.9**, not the 91.2 the team had
been quoting. Small, but it matters below.

### Experiment `lora-vs-prompt` (tests C1, depends on `eval-harness`)

**Intent:** Establish whether a LoRA fine-tune of an 8B instruct model on the
5,200 Ledgerline invoices beats the re-scored few-shot prompt baseline from
`eval-harness` on the vendor-disjoint split by enough to justify building a
training pipeline.

**Details:** Base model is the 8B open-weight instruct model we already serve
in staging. LoRA on attention and MLP projections, bf16, one 80 GB GPU. Use
the harness scorer unchanged. Two seeds minimum. Budget about eight GPU-hours
including evaluation. Do not touch the eval split.

The plan the agent writes follows the template's required spine. Its
Evaluation section is the part that matters:

- Metric: overall field-level F1 from the harness scorer, plus per-slice F1
  reported alongside, never in place of, the overall number.
- Baseline: the re-scored prompt at 90.9 from the harness task.
- Decision rule: mean over seeds of overall F1 ≥ 94.0 **and** ≥ baseline
  + 2.0 supports C1. Mean below baseline + 1.0 weakens it. Anything in
  between is reported as "comparative half holds, threshold half fails."
- Invalidation: any vendor overlap discovered; any change to the scorer after
  this plan is approved; fewer than two completed seeds per configuration.

**Design review, round 1: needs_changes.** The reviewer catches two things.
The plan's baseline sentence still said 91.2, the number from the
contaminated set, rather than 90.9 from the harness. And the method section
proposed one learning rate "from the blog post" with no justification; the
reviewer asks for either a two-value sweep or a stated reason. Plan v2 fixes
both: baseline 90.9, learning rates 1e-4 and 2e-4, two seeds each, four runs
total. Round 2 passes and the experiment moves to `running`.

### Experiment `data-scaling` (tests C2, depends on `eval-harness`)

Sits beside `lora-vs-prompt`, not downstream of it; within one wave an
experiment never depends on another experiment. Its plan fixes one
configuration (the higher learning rate, rank 16) and trains on nested
subsets of 1,000, 2,500 and 5,200 examples, two seeds each, six runs. Decision
rule: if the gain from 2,500 to 5,200 is under 1.0 point, C2 is supported; if
it is over 2.0, contradicted. Design review passes in one round.

## Execution

The agent calls `sandbox.options`, picks a single A100 80 GB, and requests a
six-hour lease tied to `lora-vs-prompt`. It copies the training pool and the
harness over SSH, keeps its private key local, and submits each training run
as a durable job through `sandbox.run` so a dropped terminal cannot lose the
receipt.

Meanwhile it posts to the feed. The labeler reads it on their phone:

- "lora-vs-prompt is up on one A100, four runs queued, first loss curve in an
  hour" with a `status` thread started.
- Two hours later: a `chart` of training loss for run 1 and "loss flattening
  at epoch 2, no sign of divergence at lr 2e-4."
- After the first eval: "**93.1** overall F1 on the vendor-disjoint set, seed
  1, lr 2e-4 — above the prompt, below the 94 bar" with a `stat` block showing
  the delta against 90.9.

Each run writes `results/run-<lr>-<seed>.json` with the config, seed, metric
direction, overall and per-slice F1. Retained runs include the one that
crashed at epoch 3 on an out-of-memory error and was restarted with gradient
checkpointing; it is in the record with its failure log.

Before the lease expires the agent runs `sandbox.pull_outputs`, verifies the
rsync landed, submits the result files as artifacts, and releases the machine
in two steps. `data-scaling` reuses the same lease pattern the next day.

## Results and review

`lora-vs-prompt`, mean over the two seeds at the better learning rate:

| Configuration | Overall F1 | Tax lines | Multi-currency | Handwritten |
| --- | --- | --- | --- | --- |
| Prompt baseline (re-scored) | 90.9 | 84.2 | 86.0 | 79.5 |
| LoRA, lr 1e-4, mean of 2 seeds | 92.7 | 87.9 | 88.1 | 80.2 |
| LoRA, lr 2e-4, mean of 2 seeds | 93.35 | 89.0 | 89.4 | 80.8 |

Under the pre-registered rule this is the awkward middle: +2.45 over the
baseline (comparative half holds), 93.35 against a 94.0 threshold (threshold
half fails). The report has to say exactly that. The metrics exhibit Merv pins
at submission shows the per-slice table, and the report interprets it: the
gains are concentrated in tax lines and multi-currency; handwritten barely
moves.

**Attempt review, round 1: needs_changes, return to running.** The reviewer
reads the numeric record, not the report, and finds that the per-slice table
in `results.json` covers only seed 1 for the lr 1e-4 arm; seed 2's per-slice
numbers exist in a run file but were not aggregated. Not selective in intent,
but the record does not support the table as printed. The agent fixes the
aggregation, resubmits, and round 2 passes. The experiment completes with the
conclusion: "C1 as written is weakened: the fine-tune clearly beats the prompt
but does not reach 94.0 on a vendor-disjoint split at this data size."

`data-scaling` completes cleanly:

| Training examples | Overall F1 (mean of 2 seeds) |
| --- | --- |
| 1,000 | 88.0 |
| 2,500 | 92.4 |
| 5,200 | 93.4 |

The 2,500 to 5,200 step is +1.0, exactly on the rule's boundary. The report
says so rather than rounding it either way, and the conclusion is "C2 is
neither clearly supported nor weakened; the curve is flattening but not flat."
The reviewer passes it on the first round and notes in its synopsis that a
third seed would have resolved the boundary and cost under an hour.

A refuted or half-refuted claim is a successful experiment here. The team now
has two numbers it trusts, and it knows which slices moved.

## Reflection

Two experiments and a task are terminal and the project is idle, so
`workflow.status_and_next` recommends reflection. The agent opens a wave with
the three core lenses (amplify, avoid, entropy) and two authored for this
project:

- **serving-economics**: given the measured quality gap, what does the
  fine-tuned model have to cost per document to be worth it, and at which
  model size?
- **label-quality**: read the per-slice failures and the labeler's notes; are
  the remaining errors model errors or label disagreements?

Five lens agents run independently on the snapshot. The synthesis proposes:

- C1 → `weakened`; a new claim replaces it: "at 5,200 examples the fine-tune
  lands between 93 and 94 F1; reaching 94 needs either more tax-line and
  multi-currency data or a larger rank."
- C2 → `weakened` with a note that a third seed decides it.
- C3 → `supported` directly from the per-slice record, without a dedicated
  experiment: both systems fail most on tax lines and multi-currency.
- Wave 2: a task to label 800 more tax-line and multi-currency invoices with
  the bookkeeper's review; an experiment `rank-sweep` (rank 8/16/32 at 5,200
  examples, three seeds); an experiment `3b-same-data` to test whether a 3B
  model at the same data gets within 1 point, since the serving-economics
  lens showed the 3B model would run on a single cheap GPU.

The reflection reviewer passes the synthesis after one return: the first
version of the change spec had proposed a wave-2 experiment that depended on
another wave-2 experiment, which the wave DAG rule forbids. Published.

## What the founder actually gets

- A defensible answer to the investor question: the model is a moat only with
  more labeled data, and the record shows exactly how much data bought how
  much accuracy.
- A decision: build the training pipeline, but pair it with a labeling sprint,
  and evaluate the 3B model before choosing serving hardware.
- Every number in the deck traces to an immutable artifact, a seed, and a
  reviewer's verdict. When the notebook 94% comes up again, the answer is a
  link.

## Budget

Rates are assumed on-demand marketplace prices; substitute the provider's
current offer from `sandbox.options`.

| Item | GPU | Hours | Rate | Cost |
| --- | --- | --- | --- | --- |
| `eval-harness` task | none (API calls, local CPU) | 0 | — | $0 GPU (about $15 of hosted-model API calls) |
| `lora-vs-prompt`: 2 learning rates × 2 seeds, ~2.6 h each, plus eval | A100 80 GB | 12 | $1.80 | $21.60 |
| `data-scaling`: 3 subset sizes × 2 seeds, plus eval | A100 80 GB | 10 | $1.80 | $18.00 |
| Setup, idle lease time, the out-of-memory restart, reviewer-driven re-aggregation (no rerun needed) | A100 80 GB | 4 | $1.80 | $7.20 |
| **Wave 1 total** | | **26** | | **≈ $47** |
| Wave 2 as proposed (rank sweep 9 runs, 3B model 4 runs) | A100 80 GB | ~30 | $1.80 | ≈ $54 |
| **Both waves with 30% contingency** | | | | **≈ $130** |

Agent model tokens for planning, reviewing, and reflecting are a separate
line and are not GPU spend. The project-level daily cap in Merv is set to
$40 so a runaway lease cannot exceed one day's budget without a human
raising it.

## Merv mechanisms this scenario exercises

- Task with verifiable deliverables as the gate before any experiment runs.
- Independent task review that re-runs a check rather than reading a claim.
- Immutable intent and details; the plan as the contract after design review.
- Design review returning a plan for a stale baseline number.
- Pre-registered decision rule that produces an honest "half holds" outcome.
- Durable sandbox jobs, output retention before release, spend caps.
- Feed threads with charts and stats that a non-engineer can follow.
- Attempt review returning to `running` because the numeric record did not
  support the printed table.
- A claim judged from retained per-slice evidence at reflection time without
  its own experiment.
- Reflection with two project-specific lenses and a change spec that proposes
  wave 2 under the DAG rules.
