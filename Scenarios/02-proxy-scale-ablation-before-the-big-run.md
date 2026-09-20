# Scenario 2 — Settle the architecture argument at proxy scale before the $25k run

*A six-person seed-stage startup that trains its own small foundation model
uses Merv to run a controlled ablation for about $180 of H100 time, so that a
$25,000 pretraining run is not launched on an opinion.*

## The company

**Fathom Signals** (fictional) builds a foundation model for industrial sensor
time series: vibration, temperature, current draw, flow. Customers are plant
operators who want anomaly forecasting without labeling anything. The team is
six people, four of them engineers, all of whom have opinions about how the
model should tokenize a continuous signal.

Their next milestone is a 1.3B-parameter model trained on roughly 40B tokens
of pooled sensor data. At current H100 prices that run costs about $25,000
and takes most of a week. There is one such run in the budget before the
Series A, so it has to be the right one.

Two decisions are stuck in a Slack argument:

1. **Tokenization.** Arm A is the current scheme: each value is quantile-binned
   into one of 1,024 discrete tokens. Arm B is a patch-embedding scheme from a
   recent arXiv paper: 16-step patches projected by a small MLP, with a
   continuous regression head. The paper reports large gains; one engineer
   believes it, one believes the paper's baseline was weak.
2. **Positional encoding.** Rotary versus learned absolute. Everyone suspects
   it does not matter at their context length, but nobody will sign off on
   "does not matter" without a number.

The CTO's rule: nobody argues, we run the proxy. The catch is that proxy
ablations are easy to game, even unintentionally.

## Why Merv, specifically

Small-scale ablations go wrong in predictable ways, and the team has done most
of them before:

- one arm got a tuned learning rate and the other got the default;
- arms compared at different token budgets because one converged faster;
- the "winning" seed was reported and the other two were not mentioned;
- evaluation on a validation shard from the same plants as training, so the
  distribution shift the product actually faces never showed up;
- nobody wrote down beforehand what result would change the decision, so the
  result was argued about after the fact.

Merv's experiment contract addresses each one by construction. The plan must
pre-register matched budgets, matched tuning effort, seed counts, the exact
evaluation set, and a decision rule. A different agent reviews the plan before
compute is spent, and a different agent again reviews the numeric record
before a conclusion can enter the project. The reflection at the end includes
an **entropy** lens whose whole job is to say what was not tried. And the
**champion/candidate** mechanism keeps track of the best configuration across
experiments without anyone maintaining a spreadsheet.

The other reason is cheaper: with 40B tokens of the real run at stake, a
$180 ablation that is trustworthy is worth more than a $60 one that is not.

## Project setup

Introduction, written by the agent from the CTO's brief:

> Fathom Signals is preparing a 1.3B / 40B-token pretraining run on pooled
> industrial sensor data. Before launching it we need controlled proxy-scale
> evidence on two design choices: quantile-binned tokens (current) versus
> patch embedding with a continuous head, and rotary versus learned absolute
> positions. Proxies are 60M and 150M models on a frozen 2B-token corpus,
> evaluated on three held-out plants. Budget: about $200 of H100 time; a
> decision is needed in ten days.

Claims:

| Claim | Statement | Confidence |
| --- | --- | --- |
| C1 | At a matched 2B-token budget and matched learning-rate tuning effort, the patch-embedding tokenizer improves held-out forecasting NLL on the three held-out plants by at least 5% relative at both 60M and 150M parameters. | medium |
| C2 | The ordering and approximate magnitude of the tokenizer effect at 60M predicts the effect at 150M (the small proxy is a valid proxy). | low |
| C3 | Rotary and learned absolute positions differ by less than 1% relative held-out NLL at 150M and 4,096-step context; the choice is immaterial at this scale. | medium |

C3 is a claim the team hopes to **confirm**, so the argument can end.

## Wave 1

### Task `proxy-harness`

Deliverables the task reviewer can check:

1. A frozen 2B-token training corpus as sharded storage objects with a
   manifest of shard hashes and the plant ids each shard came from.
2. A held-out evaluation set drawn from three plants absent from the corpus,
   with the plant ids named and a zero-overlap check script.
3. Model configs for 60M and 150M that differ only in width and depth, with
   both tokenizer arms and both positional encodings selectable by flag.
4. A single training entry point that logs tokens seen, wall-clock, and
   evaluation NLL every 100M tokens to a JSON lines file, plus a measured
   tokens-per-second figure for each model size on one H100.
5. A `README` such that a fresh agent can launch any arm with one command.

The task takes the agent two days, most of it corpus assembly on a CPU box.
The reviewer passes it after re-running the overlap check and confirming the
throughput numbers match a short smoke run it launches itself.

### Experiment `tokenizer-ab-60m` (tests C1 and C2)

**Intent:** Compare quantile-binned tokens against patch embedding at 60M
parameters on the frozen 2B-token corpus from `proxy-harness`, with matched
tuning effort, to establish the direction and size of the tokenizer effect at
the small proxy scale.

**Details:** Both arms get the same three-value learning-rate sweep at one
seed, then the best learning rate per arm gets three seeds. Report NLL on the
three held-out plants; in-corpus validation is diagnostic only. Sibling
`tokenizer-ab-150m` owns the larger size; do not run 150M here. Cite the
patch-embedding paper by arXiv id in the plan.

Plan v1's Evaluation section pre-registers: held-out NLL at exactly 2B tokens
seen; three seeds per arm at the arm's own best learning rate from the sweep;
decision rule: relative improvement of the mean ≥ 5% with the worst seed of
the better arm beating the best seed of the other supports C1 at 60M; under 2%
weakens it; invalidation: any arm stopped before 2B tokens, or a learning-rate
sweep of different size per arm.

**Design review, round 1: pass.** The reviewer's synopsis notes that the paper
cited used a 4× larger patch and asks the plan to say why 16 steps was chosen;
the plan already had that in Method, so it passes.

### Experiment `tokenizer-ab-150m` (tests C1 and C2)

Same shape at 150M, carrying the best learning rate per arm from the 60M
sweep rather than re-sweeping, which the plan states as a budget choice.

**Design review, round 1: needs_changes.** The plan gave arm B the learning
rate recommended by the paper and arm A the harness default, and said the 60M
sweep "would confirm" them. The reviewer points out that this breaks the
matched-tuning-effort rule stated in C1 itself, and that the experiment cannot
begin until the 60M sweep has finished anyway. Plan v2 makes the dependency
explicit in prose (the wave DAG cannot express experiment-on-experiment
dependencies, so the agent sequences them by hand) and commits to using each
arm's own best 60M learning rate. Round 2 passes.

### Experiment `posenc-150m` (tests C3)

Rotary versus learned absolute at 150M with the current quantile tokenizer,
three seeds each, same 2B-token budget, evaluated at 4,096-step context on the
held-out plants. Decision rule: relative difference in mean NLL under 1% with
overlapping seed ranges supports C3; over 3% contradicts it.

Design review passes in one round.

## Execution

Two H100 80 GB sandboxes run in parallel, each on a twelve-hour lease with
one extension. The wave never approaches the seven-experiment cap. The agent
submits every training run through `sandbox.run` with the harness command,
the arm flags, and the seed, so the run receipt names its configuration.

Measured throughput from the harness task, and the resulting per-run times:

| Model | Tokens/s on one H100 | Time to 2B tokens |
| --- | --- | --- |
| 60M | ~700k | ~0.8 h |
| 150M | ~280k | ~2.0 h |

The feed thread for `tokenizer-ab-60m` gets a `chart` of held-out NLL against
tokens seen for both arms after the sweep, then one line per seed as it
finishes. The CTO, who is not in the terminal, sees "patch embedding ahead by
**7.8%** at 60M, all three seeds, ranges do not overlap" before lunch.

## Results and review

**`tokenizer-ab-60m`**: patch embedding wins clearly.

| Arm | Best lr | Held-out NLL, mean of 3 seeds | Seed range |
| --- | --- | --- | --- |
| A: quantile tokens | 6e-4 | 1.412 | 1.405–1.421 |
| B: patch embedding | 3e-4 | 1.302 | 1.296–1.309 |

Relative improvement 7.8%, ranges disjoint. Under the rule, C1 is supported at
60M. Attempt review passes in one round.

**`tokenizer-ab-150m`**: the gap shrinks.

| Arm | Held-out NLL, mean of 3 seeds | Seed range |
| --- | --- | --- |
| A: quantile tokens | 1.288 | 1.281–1.296 |
| B: patch embedding | 1.261 | 1.252–1.270 |

Relative improvement 2.1%. The rule said 5% supports and under 2% weakens;
2.1% sits just inside the undetermined band. The report says exactly that, and
the conclusion for C1 is "contradicted as written": the claim demanded 5% at
**both** sizes and the larger size did not deliver it. The agent posts the
comparison as a `table` block on the feed with the 60M row beside it, and the
thread turns into the most-read thing in the project.

**`posenc-150m`, attempt 1: needs_changes, return to planned.** The attempt
reviewer opens the result files and finds the evaluation was scored on the
in-corpus validation shard, not the three held-out plants. The plan named the
held-out set explicitly, so this is not a report fix; the design as executed
did not test the claim. The review returns the experiment to `planned`, a new
attempt starts, and the twelve GPU-hours are lost. This is what the
contingency line in the budget is for. Attempt 2 runs the same plan with the
correct evaluation and passes:

| Positional encoding | Held-out NLL at 4,096 steps, mean of 3 seeds |
| --- | --- |
| Rotary | 1.286 |
| Learned absolute | 1.291 |

Relative difference 0.4%, seed ranges overlap. C3 is supported. The argument
is over.

Along the way, whenever a run beat the standing best held-out NLL, the agent
submitted it as a **candidate** against the project champion. At the end of
the wave the champion is the 150M patch-embedding run at seed 2, promoted
with a written reason, and the promotion is in the record for the next wave
to challenge.

## Reflection

Three terminal experiments plus the task trigger a reflection suggestion. The
authored lenses:

- **scaling-trend**: is the 7.8% → 2.1% shrinkage a trend that reaches zero
  by 1.3B, or noise between two points?
- **budget-fairness**: did the fixed 2B-token budget favour the arm that
  converges faster, and would a longer budget change the ordering?

What the lenses surface:

- **avoid**: the patch-embedding arm reaches its best NLL earlier and
  plateaus; at a fixed budget this flatters it. Do not launch the big run on
  the assumption the 60M gap generalizes.
- **entropy**: nobody tried patch embedding with the high-frequency vibration
  channels excluded, which is where the continuous head is expected to help
  most; nobody ran a size between 150M and 1.3B; C2 was never tested on its
  own terms, only inferred from two points.
- **amplify**: the positional-encoding result is clean and cheap; stop
  spending attention on it.
- **scaling-trend**: two points cannot distinguish "gap closes" from "gap
  stabilizes at 2%"; a 300M point costs about $120 and settles it.
- **budget-fairness**: a 6B-token budget at 150M would show whether arm A
  catches up; that is about $70.

Synthesis and change spec:

- C1 → `contradicted` as written. New claim: "patch embedding improves
  held-out NLL by 2–8% depending on scale, with the gap shrinking as the model
  grows."
- C2 → `weakened`: ordering was preserved, magnitude was not.
- C3 → `supported`, confidence high.
- Wave 2: experiment `tokenizer-ab-300m` (one seed per arm, 2B tokens, the
  scaling-trend lens's request), experiment `tokenizer-ab-150m-6b` (arm A and
  B at 6B tokens, one seed each, the budget-fairness lens's request), and a
  task to produce a vibration-only evaluation slice for the entropy lens's
  question.

The reflection reviewer passes the synthesis on the first round. Publication
records the graph version, applies the claim changes, and creates the wave-2
nodes with their dependency edges.

## The decision

The CTO does not switch tokenizers for the $25k run on the strength of wave 1.
Wave 2 costs about $190 and answers the two questions that actually gate that
decision. Either way, the big run launches with a written record of why its
architecture is what it is, which is also the first draft of the Methods
section in the living paper.

## Budget

Assumed H100 80 GB on-demand rate of $3.00 per hour.

| Item | GPU-hours | Cost |
| --- | --- | --- |
| `proxy-harness` throughput smoke runs (task) | 1 | $3 |
| `tokenizer-ab-60m`: lr sweep 2 arms × 3 values × 0.8 h, then 2 arms × 3 seeds × 0.8 h | 9.6 | $29 |
| `tokenizer-ab-150m`: 2 arms × 3 seeds × 2.0 h | 12 | $36 |
| `posenc-150m` attempt 1 (returned to planned, wasted) | 12 | $36 |
| `posenc-150m` attempt 2 | 12 | $36 |
| Evaluation passes, setup, idle lease tail | 4 | $12 |
| **Wave 1 total** | **50.6** | **≈ $152** |
| Wave 2 as proposed: 300M pair (~5 h each at 2B tokens) plus 150M pair at 6B tokens (~6 h each), plus evals | ~26 | ≈ $78 |
| Contingency for one more reviewer-forced rerun | ~12 | ≈ $36 |
| **Both waves, ceiling** | | **≈ $270** |

The project-level spend policy is a $300 cap with a $60 daily cap; the wasted
attempt on `posenc-150m` was visible in the Sandboxes view before the
reviewer's verdict landed, so the CTO knew about it the same hour.

## Merv mechanisms this scenario exercises

- Claims that encode the fairness rules (matched budget, matched tuning
  effort) so a reviewer can hold the plan to them.
- Design review catching an unmatched learning-rate treatment before compute.
- Hand-sequencing two experiments when the wave DAG cannot express
  experiment-on-experiment edges.
- Pre-registered decision bands, including an honest undetermined band.
- Attempt review returning an experiment to `planned` for evaluating the wrong
  set, with the rerun cost carried by the budget's contingency line.
- Candidate submission and champion promotion across experiments.
- Two parallel sandboxes under the experiment cap, durable jobs, and spend
  caps.
- The entropy and two authored lenses turning "what wasn't tried" into a
  costed wave 2.
- A refuted claim treated as a successful experiment that protects a much
  larger spend.
