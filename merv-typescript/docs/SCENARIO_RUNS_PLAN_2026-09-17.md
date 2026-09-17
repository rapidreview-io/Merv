# Running the three scenarios on production: plan and prerequisites (2026-09-17)

Read-only planning study commissioned after the founder asked for Codex agents to run the three founder-written scenarios (Merv/Scenarios/) as real projects on production once the UI waves ship. Nothing was run, created or paid for.

---

# Running the three scenarios on production Merv — run plan and prerequisites

Read-only study, 2026-09-17. Nothing was created, called or paid for. Every
statement below is sourced from the checkout; file paths are absolute.

---

## 0. The four findings that shape everything else

Read these before the tables. They are the difference between "start Monday"
and "start after two decisions and one code change".

**0.1 Production is the TypeScript/Cordis server, and its tool surface is not
the one the scenarios are written in.**
Live right now: release `20260917T101737Z-e95be7f2-5398ae4f6779`, image
`1b842cb4170a`, 54/54 plugins, at `https://experiments.rapidreview.io`
(MCP at `/mcp`, UI at `/ui/`), host `rp-control-1`
(`/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/deploy/RELEASES.md`).
The legacy Python brain was cut over on 2026-09-16.
`/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript/deploy/CLIENT_CUTOVER.md`
says, verbatim: _"Disable the old Merv plugin (the legacy bundle is version
0.1.5), including its skills."_ and _"There is not yet a replacement published
Merv plugin bundle."_

The scenarios are written in the Python vocabulary. The plugin at
`/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv/skills/` calls
`agent.hello`, `project(action=…)`, `artifact.upload`, `storage.submit`,
`review.request`, `candidate.submit` / `candidate.promote`, `feed.register`,
`sandbox.options` / `sandbox.request` / `sandbox.run` / `sandbox.pull_outputs`,
`task.transition`, `reflection.transition`. **None of those exist on
production.** The production surface is `experiment.create` / `.attach` /
`.transition` / `.exhibit` / `.get_state`, `task.create` / `.submit_delivery` /
`.context` / `.get`, `artifact.create` / `.read`, `review.start` / `.submit`,
`claim.create` / `.update`, `reflection.create` / `.lens` / `.submit_lens` /
`.submit`, `research.create` / `.advance`, `paper.read` / `.patch` / `.cite`,
`consolidation.create` / `.submit`, `feed.post`, `workflow.status_and_next` /
`.assignment` / `.begin`, `sandbox.extend`, `sandbox.release`.

Consequence: **the reviewer skills cannot be loaded as written**, and the
runner's Codex profile disables repository skills anyway
(`merv-typescript/packages/runner/src/profiles.ts`, `skills.config` with
`enabled=false`; see `merv-typescript/docs/RUNNER_PROFILE_ISOLATION.md`).
Review standards must travel in the assignment — i.e. in the experiment
`details`, the task `checks`, and the review criteria the server pins — not in a
`SKILL.md`. Section 2 says how.

**0.2 Merv cannot rent or drive a GPU today. Two separate reasons.**

- The sandboxes plugin is **not composed in production**.
  `merv-typescript/deploy/render-config.mjs:79` only adds it when
  `MERV_SANDBOXES_URL` is set; `deploy/typescript.env.example` leaves the whole
  block commented with _"Leave `MERV_SANDBOXES_URL` unset to compose no
  sandboxes plugins at all."_ The 54/54 count in every release row is 53 base
  plugins + `legacy-history-ui`; with sandboxes it would read 57/57.
- Even switched on, **Merv exposes exactly two sandbox tools**:
  `sandbox.extend` and `sandbox.release`
  (`merv-typescript/packages/sandboxes/src/index.ts:30`,
  `export const sandboxTools = ['sandbox.extend', 'sandbox.release'];`).
  There is no `sandbox.options`, `request`, `run`, `job`, `pull_outputs`,
  `attach` or `terminal` in the TypeScript tree. Those 14 curated tools were a
  Python feature (see `merv-typescript/docs/SANDBOXES_STUDY_2026-09-17.md`).
  The sandboxes service's own MCP at `https://sandboxes.rapidreview.io/mcp`
  does expose 35 tools (`sandbox_create`, `job_run`, `storage_upload`, …) — but
  Merv does not mount it in production, and mounting would need the mounts
  plugin composed too.

So compute is driven **beside** Merv, not through it: the operator (or an
execution agent with the sandboxes MCP configured as a second server) talks to
the sandboxes service directly, and the evidence comes back into Merv as
artifacts. That is a supported shape — it is just not the shape the scenarios
describe.

**0.3 A runner-hosted Codex worker has no network at all.**
`merv-typescript/packages/runner/src/profiles.ts` sets
`sandbox_workspace_write.network_access` to `false`, `web_search` to
`"disabled"`, `shell_environment_policy.inherit` to `"none"`, and deliberately
removes the bearer from the shell environment. A worker launched by the runner
therefore cannot SSH to a GPU box, pip-install, download a dataset, or call a
hosted model. It can call Merv's MCP tools and run local CPU work on files
already in its workspace.

That is fine for ~80% of every scenario (planning, design review, report
writing, attempt review by recomputation, all five reflection lenses, synthesis,
reflection review, consolidation review). It is fatal for the execution stage.
The fix without a code change is §2.3: register the execution agent yourself
through `POST /sessions/agents` (or `POST /sessions/offer`) and spawn Codex with
your own flags and network on, using the lease's `ms_` secret as the MCP bearer.
`merv-typescript/scripts/live-sessions.ts` is the working template.

**0.4 No A100 80 GB or H100 80 GB has ever been rented live by the sandboxes
service.**
`/Users/guraltoo/Documents/dev/proj/experiments/merv-sandboxes/docs/providers/README.md`
names exactly two live cloud workflows: Cloudflare `standard-1:cloudflare` CPU
containers, and Lambda `gpu_1x_a10:us-west-1` — **an A10 24 GB, and only that**.
Sixteen other adapters (AWS, Crusoe, Modal, RunPod, Vast, Paperspace, Vultr,
Hyperstack, …) are "offline replica only": _"the driver passes the conformance
suite against an in-memory replica of the vendor API … and has not yet been run
with a real token."_ GiveMeANode prices `h100-1` at $3.996/h and `h100-8` at
$31.968/h but its guide says _"GPU execution … remain[s] unvalidated"_ — only
`cpu-2` passed live.

So every GPU number in §1 has two columns: what the scenario assumes, and what
the catalogue actually prices. Before the first real run, one provider needs
`sbx providers conformance <name>` run live for the first time on the exact
shape/image/access-mode combination.

---

## 1. Per scenario: every record, and what each one needs to be real

Legend for the **Needs** column:

| Code      | Meaning                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `MCP`     | Merv tool calls only. CPU, offline. A runner-dispatched Codex can do it.                                         |
| `CPU+NET` | Local/CPU compute plus network (dataset build, hosted-model API calls). Needs the non-runner launch path (§2.3). |
| `GPU`     | Rented GPU. Needs §0.2 + §0.4 resolved.                                                                          |
| `HUMAN`   | A person. No agent substitution is honest.                                                                       |
| `GAP`     | The record the scenario asks for does not exist on production.                                                   |

### 1.1 Scenario 1 — Ledgerline, fine-tune or keep prompting

| #   | Record the scenario expects                                                                                                  | Production form                                                                                                                       | Needs                            | Notes on being real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Project "Ledgerline"                                                                                                         | `POST /projects`                                                                                                                      | `HUMAN`                          | Only a verified human can create a project (`packages/scope/src/memberships.ts`, `human()` refuses key and actor principals). An `mk_` key cannot.                                                                                                                                                                                                                                                                                                                                                      |
| 2   | Introduction                                                                                                                 | `project.context.update` (summary) + `paper.patch` kind `problem`                                                                     | `MCP`                            | Real. Compare-and-swap: it takes the exact previously read `summary` as `expectedSummary`. Operators and producers only — _"worker sessions cannot change project intent"_ — so set it with the ordinary `mk_` key, not from inside a lease. Must state the dataset substitution (row 6) or the whole project is fiction.                                                                                                                                                                               |
| 3   | Research cycle                                                                                                               | `research.create` with `consolidationWorkspace: 'none'`                                                                               | `MCP`                            | Real. `research@3`: defining → researching → reflecting → complete. **Ordering trap:** `research.create` takes `dependsOn` — the workflow ids the reflecting gate waits on — so create the cycle _after_ the wave-1 task and experiments exist and pass their ids in. A cycle created first, with no prerequisites, can be advanced straight into reflection. `research.advance` moves the gate explicitly; it never launches agents.                                                                   |
| 4   | Claims C1, C2, C3                                                                                                            | `claim.create` ×3, confidence medium/low/medium                                                                                       | `MCP`                            | Real. Thresholds (94.0 F1, +2.0) are only meaningful against the substitute dataset's own re-scored baseline — re-derive them before writing the claim, or the claim is unfalsifiable theatre.                                                                                                                                                                                                                                                                                                          |
| 5   | Task `eval-harness`, 4 deliverables                                                                                          | `task.create` title/goal/4 `checks` → immutable brief                                                                                 | `MCP`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | Deliverable 1: vendor-disjoint split of 5,200 labeled invoices, ≥600 held out, `splits/manifest.json` with SHA-256           | delivery artifacts + `artifact.create`                                                                                                | `CPU+NET` + **dataset decision** | **The 5,200 invoices do not exist.** A synthetic invoice generator is _not_ honest for a field-level-F1 claim: a LoRA trivially learns a generator's grammar and the number means nothing. Honest substitute: a real public receipt/invoice corpus with a genuine source-disjoint split (vendor/template id), named in the Introduction. Then the split, the hashes and the overlap check are all real.                                                                                                 |
| 7   | Deliverable 2: scorer emitting overall/per-field/per-slice F1, 3 slices                                                      | code + `results.json`                                                                                                                 | `CPU`                            | Real. Pure CPU.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 8   | Deliverable 3: prompt baseline re-scored, raw outputs retained, 90.9                                                         | `results.json` artifact + raw outputs                                                                                                 | `CPU+NET` + **hosted-model key** | Needs a frontier-model API key and ~$15 of calls (scenario's own figure). Merv holds none: `grep process.env` across the server yields no provider keys. Raw outputs are ~tens of MB → they exceed Merv's 2,000,000-byte artifact cap and belong in sandboxes storage, with only the manifest in Merv.                                                                                                                                                                                                  |
| 9   | Deliverable 4: harness README                                                                                                | artifact                                                                                                                              | `MCP`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | Task review: reviewer _re-runs_ the overlap check, notes the 41-document handwritten slice, passes                           | `review.start` + `review.submit` verdict `pass`                                                                                       | `MCP`                            | Real and independent — the reviewer is a separate leased worker and the server refuses producer self-review. **But** re-running the check needs the split files in the reviewer's context; ≤16 KB per artifact read, so put the manifest (not the data) in the delivery.                                                                                                                                                                                                                                |
| 11  | Experiment `lora-vs-prompt`: immutable intent + details, `testedClaimIds:[C1]`, `dependsOn:[eval-harness]`                   | `experiment.create`                                                                                                                   | `MCP`                            | Real. `details` is bounded at 16,000 characters — that is where the scenario's method contract goes.                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12  | Plan v1 with Summary / Objective & hypothesis / Evaluation, decision rule, invalidation conditions                           | `artifact.create` + `experiment.attach` role `plan` path `experiments/lora-vs-prompt/plan.md` → `experiment.transition submit_design` | `MCP`                            | Real. Server enforces the three section headings at submission.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | **Design review round 1 = `needs_changes`** (stale 91.2 baseline; unjustified single learning rate)                          | `review.submit` verdict `needs_changes`                                                                                               | `MCP`, must be **earned**        | This is the scripted verdict problem. A genuinely independent reviewer will only return `needs_changes` if the plan actually contains the defect. **Do not tell the reviewer the verdict.** Plant the defect in the plan instead: brief the _planner_ to quote the pre-harness baseline number and cite one learning rate "from the blog post". Then the review is real and the verdict is earned. If the reviewer passes it anyway, that is a finding about the review gate, not a failure of the run. |
| 14  | Plan v2 (baseline 90.9; lr 1e-4 and 2e-4 × 2 seeds)                                                                          | new attempt, new plan artifact, `submit_design` again                                                                                 | `MCP`                            | Real. A design rejection advances the attempt (`merv-typescript/docs/EXPERIMENTS.md`).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | Design review round 2 = `pass` → `running`                                                                                   | `review.submit` `pass`                                                                                                                | `MCP`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 16  | Execution: 4 training runs (2 lr × 2 seeds), ~2.6 h each, one 80 GB GPU, plus eval                                           | outside Merv                                                                                                                          | **`GPU`**                        | See §1.4 for hardware and cost. 8B LoRA in bf16 wants ≥40 GB; on the only validated GPU (A10 24 GB) it needs 4-bit QLoRA and runs ~3× slower.                                                                                                                                                                                                                                                                                                                                                           |
| 17  | The OOM crash at epoch 3, restarted with gradient checkpointing, retained with its failure log                               | a retained result artifact + `retry_running`                                                                                          | `MCP` + `GPU`                    | Real if it happens; **do not stage it**. `experiment.transition retry_running` exists precisely for infrastructure failure and records a reason.                                                                                                                                                                                                                                                                                                                                                        |
| 18  | Per-run `results/run-<lr>-<seed>.json` with config, seed, metric direction, overall + per-slice F1                           | `experiment.attach` role `result`, `resultFormat: json`                                                                               | `MCP`                            | Real. Each ≤16,000 bytes — fine for metric files.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 19  | `metrics_exhibit.json` pinned at submission                                                                                  | system-generated by `experiment.exhibit` / submission                                                                                 | automatic                        | Real. The report **must** reference the filename `metrics_exhibit.json` or submission is blocked.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 20  | Report with Summary / Results / Deviations from plan / Conclusion, stating "comparative half holds, threshold half fails"    | `artifact.attach` role `report` → `submit_results`                                                                                    | `MCP`                            | Real. Sections enforced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 21  | **Attempt review round 1 = `needs_changes`, `returnTo: "running"`** (per-slice table covers only seed 1 for the lr 1e-4 arm) | `review.submit` with explicit `returnTo: "running"`                                                                                   | `MCP`, must be **earned**        | Same rule as row 13: the aggregation gap must actually be in the submitted JSON. It will be, if the executor aggregates by hand. Do not script the verdict. `returnTo` is mandatory on a negative attempt verdict and picking `running` vs `planned` is the reviewer's call.                                                                                                                                                                                                                            |
| 22  | Round 2 `pass` → `complete`, conclusion "C1 as written is weakened"                                                          | `review.submit` `pass`                                                                                                                | `MCP`                            | Real. Conclusion comes from the pinned report's Conclusion section.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 23  | Experiment `data-scaling`, 3 subset sizes × 2 seeds, design pass first round, attempt pass first round                       | same chain                                                                                                                            | `MCP` + `GPU`                    | Real. Sibling of row 11, not downstream of it — correct under the wave rule.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 24  | Feed: ~6 posts including a training-loss **chart**, a **stat** block, a `status` thread                                      | `feed.post` (body ≤8,000 chars + up to 10 artifact ids)                                                                               | `MCP` / **`GAP`**                | **Partial gap.** The production feed has no post kinds, no threads, no replies, no voices, no reactions, and no stat/chart/table/heatmap blocks (`packages/feed/src/types.ts`: `id, sequence, projectId, authorId, body, artifactIds, createdAt`). A "chart" becomes a PNG artifact attached to a post. The QA-lead reply in scenario 3 has no mechanism at all.                                                                                                                                        |
| 25  | Paper Methods/Results updated through the experiment submission                                                              | `paperChangesArtifactId` on `experiment.transition submit_results`                                                                    | `MCP`                            | Real, and reviewed: the proposal is pinned into the same independent review and applied atomically on pass.                                                                                                                                                                                                                                                                                                                                                                                             |
| 26  | Reflection wave: 3 core lenses (amplify, avoid, entropy) + 2 authored (`serving-economics`, `label-quality`)                 | `reflection.create`                                                                                                                   | **`GAP`**                        | Production lenses are **fixed five**: `evidence`, `theory`, `methods`, `synthesis`, `next_steps` (`packages/reflections/src/definitions.ts`). `reflection.create` takes only `title` + `requestId`. Authored lenses do not exist. Either fold the two project-specific questions into the synthesis brief, or add roster input to `reflection.create` (small, contained change).                                                                                                                        |
| 27  | Five independent lens reports                                                                                                | 5 assignments → 5 fresh agents, `reflection.submit_lens`                                                                              | `MCP`                            | Real, and the server enforces five _different_ producer identities (`reflection_independent_lenses` unique index).                                                                                                                                                                                                                                                                                                                                                                                      |
| 28  | Synthesis report + change spec                                                                                               | `reflection.submit` with report + change-spec artifacts                                                                               | `MCP`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 29  | **Reflection review returns once** (wave-2 experiment depended on another wave-2 experiment)                                 | `review.submit` `needs_changes`, `return_to` synthesis                                                                                | `MCP`, must be **earned**        | Only real if the synthesis actually proposes the illegal edge. Do not plant it in the reviewer.                                                                                                                                                                                                                                                                                                                                                                                                         |
| 30  | C1 → `weakened`, C2 → `weakened`, C3 → `supported`                                                                           | `claim.update` ×3                                                                                                                     | `MCP`                            | Real, but note: **nothing applies a change spec automatically.** `merv-typescript/docs/EXPERIMENTS.md`: _"No completed experiment automatically changes linked claims."_ An agent makes these calls after publication.                                                                                                                                                                                                                                                                                  |
| 31  | Wave 2 nodes created with dependency edges                                                                                   | `task.create` + `experiment.create` with `dependsOn`                                                                                  | `MCP`                            | Real, and only after the wave is approved: an active reflection sets `blocksStarts: ['task','experiment']` and refuses creation with `workflow_creation_paused`.                                                                                                                                                                                                                                                                                                                                        |
| 32  | Consolidation                                                                                                                | none                                                                                                                                  | n/a                              | Scenario 1 has no code consolidation. `consolidationWorkspace: 'none'` is correct.                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 1.2 Scenario 2 — Fathom Signals, proxy-scale ablation

Rows 1–5, 24–31 of §1.1 apply identically (project, introduction, cycle, claims,
task, feed gap, fixed lenses, claim updates, wave 2). What differs:

| #   | Record                                                                                                                                                      | Production form                                                                 | Needs                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task `proxy-harness`, 5 deliverables                                                                                                                        | `task.create`                                                                   | mixed                            | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | D1: frozen 2B-token corpus as sharded storage objects + manifest of shard hashes + plant ids                                                                | sandboxes storage objects; manifest artifact in Merv                            | `CPU+NET` + **dataset decision** | **40B tokens of pooled industrial sensor data do not exist.** A 2B-token proxy corpus can be assembled from real public multi-source time-series archives, split by _source_, which preserves the only property the experiment depends on (held-out sources). A synthetic signal generator is defensible for a _tokenizer_ comparison and only that — it cannot support "three held-out plants", so the claims must be rewritten to name the substitute. Corpus bytes far exceed Merv's 2 MB artifact cap; the manifest goes in Merv, the shards in sandboxes storage (namespace cap 1 TiB). |
| 3   | D2: held-out eval set from 3 absent sources + zero-overlap check script                                                                                     | artifact + code                                                                 | `CPU`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | D3: 60M and 150M configs differing only in width/depth, both tokenizer arms and both position encodings selectable by flag                                  | code artifact                                                                   | `CPU`                            | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 5   | D4: single training entry point logging tokens/wall-clock/eval NLL every 100M tokens + measured tokens-per-second per size on one H100                      | code + a smoke run                                                              | **`GPU`**                        | The throughput figure is only real if measured on the GPU actually used. On an A10 the scenario's 700k tok/s at 60M becomes roughly 150–200k — state the measured number, do not carry the scenario's.                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | Task review re-runs the overlap check **and launches its own smoke run**                                                                                    | `review.submit`                                                                 | **`GPU`** for the reviewer       | This is the one place a _reviewer_ needs compute. Under the runner it cannot (no network). Use §2.3 for the task-review assignment too, or accept the reviewer verifying the logged throughput rather than reproducing it, and say so in its notes.                                                                                                                                                                                                                                                                                                                                          |
| 7   | `tokenizer-ab-60m`: 3-value lr sweep × 2 arms at 1 seed, then 3 seeds at each arm's best lr                                                                 | experiment chain                                                                | `GPU`                            | 9.6 GPU-h in the scenario.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 8   | `tokenizer-ab-150m`: **design review round 1 `needs_changes`** (arm B got the paper's lr, arm A the harness default — breaks the matched-tuning rule in C1) | `review.submit needs_changes`                                                   | `MCP`, **earned**                | Plant the unmatched treatment in plan v1; let the reviewer find it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 9   | Hand-sequencing 60m before 150m because the wave DAG forbids experiment-on-experiment edges                                                                 | prose in `details` + operator ordering                                          | `MCP`                            | Real: `experiment.create.dependsOn` accepts tasks _or_ experiments on production, but the wave rule in the reflection change spec forbids proposing experiment→experiment edges. Sequence by hand as the scenario says.                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | `posenc-150m` **attempt 1 returned to `planned`** (scored the in-corpus validation shard, not the held-out plants); 12 GPU-hours lost; attempt 2 passes     | `review.submit needs_changes` with `returnTo: "planned"`                        | `MCP`, **earned**, + `GPU` twice | The wasted 12 GPU-h is real money. Budget it (the scenario does) or brief the executor correctly and accept that this scripted beat may not occur.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 11  | Candidate submission and **champion promotion** across experiments                                                                                          | —                                                                               | **`GAP`**                        | No `candidate.*` tools and no champion record exist in the TypeScript tree. The nearest honest substitute: record the standing best configuration in the Paper Results section and in the reflection synthesis.                                                                                                                                                                                                                                                                                                                                                                              |
| 12  | Two parallel sandboxes, 12-hour leases with one extension                                                                                                   | sandboxes service directly; `sandbox.extend` from Merv only if §0.2 is resolved | `GPU`                            | Service defaults: `lease_default_seconds` 3600, server ceiling 604800 (7 days); `sandbox.extend` in Merv caps a single call at 86,400 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 13  | Reflection lenses `scaling-trend`, `budget-fairness`                                                                                                        | —                                                                               | **`GAP`**                        | Same as §1.1 row 26.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 1.3 Scenario 3 — Parlay, cut serving cost

| #   | Record                                                                                                                                                                                               | Production form                                                                             | Needs                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Task `slice-evals`, 4 deliverables                                                                                                                                                                   | `task.create`                                                                               | mixed                                              | The heaviest task of the three.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | D1: five slices from **de-identified production tickets**, ≥300 items each, ≥90 per language                                                                                                         | artifacts + manifest                                                                        | **`HUMAN` + dataset decision**                     | There are no production tickets. A public multilingual support/dialog corpus plus a tool-call schema set can stand in for four slices. The **refusal** slice ("tickets the support QA team labelled as must-escalate or must-decline") has no public equivalent and is the slice the scenario's own post-mortem cares about most.                                                                                                                                                  |
| 3   | D2: scoring protocol per slice; **LLM-as-judge calibrated against 100 human labels per slice**, agreement rate reported, any slice under 85% flagged                                                 | artifact                                                                                    | **`HUMAN`** + `CPU+NET`                            | 500 human labels. This cannot be agent-substituted without destroying the deliverable's meaning — the whole point of the scenario is that the judge is calibrated against people. Either the founder supplies a labeller, or the task reviewer records that finding as `status: "waived"` with notes explaining why the check is unnecessary for the goal — production allows `pass` only when every criterion is `met` or explicitly `waived` — and the project says so out loud. |
| 4   | D3: latency harness driving 32 concurrent sessions from recorded traces; p50/p95 TTFT, tok/s/GPU, cost per 1,000 output tokens                                                                       | code + results                                                                              | **`GPU`**                                          | Real once a GPU exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | D4: bf16 70B baseline on all five slices, **every raw output retained**, `results.json` submitted                                                                                                    | sandboxes storage + Merv manifest                                                           | **`GPU` (2×80 GB)**                                | 70B bf16 needs ≥140 GB VRAM → two 80 GB cards minimum. See §1.4 for why this is the expensive line.                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | **Task review refuses the first delivery** (long-context slice had 212 items, not 300)                                                                                                               | `review.submit needs_changes` → task returns to `in_progress`                               | `MCP`, **earned**                                  | Plant the short slice, or let it happen naturally — a first pass at a date-range filter often does come up short.                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | Refusal-slice judge agreement 86%, reviewer's synopsis says treat with a wider margin                                                                                                                | review `notes` / `findings`                                                                 | `MCP`                                              | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 8   | `awq-70b` design review round 1 `needs_changes` on **three** grounds (published numbers instead of the harness baseline; decoding config unstated; calibration set disjointness unchecked)           | `review.submit`                                                                             | `MCP`, **earned**                                  | Three real defects to plant in plan v1.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 9   | `dense-32b`, `specdec-70b` design reviews pass first round                                                                                                                                           | `review.submit pass`                                                                        | `MCP`                                              | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Three experiments run in parallel by **three agent sessions with their own `agent_id`**                                                                                                              | three leases → three worker actors                                                          | `MCP` + `GPU`                                      | Real, though `agent_id` is Python vocabulary; on production the identity is the leased worker actor (`merv-typescript/docs/AGENT_CONTINUITY.md`).                                                                                                                                                                                                                                                                                                                                  |
| 11  | Each agent **registers a feed voice**                                                                                                                                                                | —                                                                                           | **`GAP`**                                          | No `feed.register`, no voices.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 12  | QA lead **replies on the feed**; the agent adds a per-language breakdown; the reply is in the record                                                                                                 | —                                                                                           | **`GAP`**                                          | No replies on the production feed. The intervention would have to arrive some other way (a human editing the Introduction, or a new task), and the "comment in the record next to the agent's response" does not exist.                                                                                                                                                                                                                                                            |
| 13  | Quantized weights (~40 GB) retained as a storage object with its id in the report                                                                                                                    | sandboxes `storage_upload` (1 TiB object cap)                                               | `GPU` + sandboxes storage                          | Real. Definitely not a Merv artifact (2 MB cap).                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 14  | **`awq-70b` attempt review returns to `running`**: report v1 claimed "preserved within noise on aggregate … recommend rollout" while the record shows −2.3 on non-English, and C1 says _every_ slice | `review.submit needs_changes` + `returnTo: "running"`                                       | `MCP`, **earned**                                  | The single best test of the review gate in all three scenarios. The defect is a _reporting_ defect over a correct record, which is exactly what `returnTo: "running"` is for. Let the executor write the aggregate-only summary; do not tell the reviewer what to find.                                                                                                                                                                                                            |
| 15  | Report v2 states "C1 is contradicted" → `pass` → `complete`                                                                                                                                          | `review.submit pass`                                                                        | `MCP`                                              | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 16  | `dense-32b` passes first round with a note that three −0.8 deltas sit near the boundary                                                                                                              | `review.submit pass` + `notes`                                                              | `MCP`                                              | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 17  | `specdec-70b`: byte-identical greedy outputs on 300/300, 78% acceptance, 1.7×                                                                                                                        | results + report                                                                            | `GPU` (2×80 GB)                                    | Real. The diff is the primary check, which is cheap to verify independently.                                                                                                                                                                                                                                                                                                                                                                                                       |
| 18  | Reflection lenses `cost-model`, `safety-regressions`                                                                                                                                                 | —                                                                                           | **`GAP`**                                          | Same fixed-five problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 19  | **Code consolidation**: the speculative-decoding serving config becomes an immutable proposal, reviewed by a consolidation reviewer, compare-and-swapped into the serving repo's Merv ref            | `research.create` with `consolidationWorkspace: 'git'` → `consolidation.create` / `.submit` | `MCP` + **GitHub decision** + runner git workspace | Real _up to_ publication. `merv-typescript/docs/CONSOLIDATION.md`: _"Completion does not publish central Git."_ Cross-machine Git object transport and central publication are listed as open work in `docs/MACHINE_RUNNER.md`. The GitHub publication path is separately READY (`docs/GITHUB_PUBLICATION_READINESS.md`, smoke PR merged 2026-09-17) but needs a per-project connection, automation set to write, a base branch, and a **fresh runner directory per repository**.  |
| 20  | Living paper sections doubling as the customer-facing change note                                                                                                                                    | `paperChangesArtifactId` on submissions                                                     | `MCP`                                              | Real.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 1.4 Compute and cost, per scenario

The scenarios assume on-demand marketplace rates ($1.80/h A100 80 GB,
$3.00/h H100 80 GB). Here is the same work priced against what the sandboxes
catalogue actually publishes, and what is actually rentable today.

**Scenario 1 — 8B LoRA + data scaling**

| Line                                                                            | GPU-hours | Scenario's price    | Nearest catalogue offer                                                                                                                                                    | Validated today?                  |
| ------------------------------------------------------------------------------- | --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `lora-vs-prompt` 4 runs + eval                                                  | 12        | $21.60 @ $1.80 A100 | RunPod A100 SXM 80 GB $1.39–1.59/h → $17–19; Crusoe A100 80 GB PCIe $2.00/h → $24; Modal A100-80GB $2.4984/h → $30; Vast A100 SXM4 80 GB $0.7095/h → $9                    | **No.** All offline-replica-only. |
| `data-scaling` 6 runs + eval                                                    | 10        | $18.00              | as above, $7–25                                                                                                                                                            | No                                |
| Setup, idle, OOM restart                                                        | 4         | $7.20               | $3–10                                                                                                                                                                      | No                                |
| **Wave 1**                                                                      | **26**    | **≈ $47**           | **≈ $36–65** on an A100 80 GB                                                                                                                                              | —                                 |
| Same work on the only validated GPU (Lambda A10 24 GB, 4-bit QLoRA, ~3× slower) | ~78       | —                   | Lambda prices come live from `GET /instance-types`; the guide only says _"the cheapest on-demand type is a few tens of cents an hour"_ — read the live rate, do not assume | **Yes**                           |
| Non-GPU: hosted-model calls for the prompt baseline                             | —         | ~$15                | founder's provider account                                                                                                                                                 | n/a                               |

**Scenario 2 — 60M/150M ablations, 2B tokens per run**

| Line                                                                        | GPU-hours | Scenario's price    | Nearest catalogue offer                                                                                                                                                                                                                                                                                                                                    | Validated?                                                          |
| --------------------------------------------------------------------------- | --------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Wave 1 total (harness smoke, 60m sweep+seeds, 150m seeds, posenc ×2, evals) | 50.6      | ≈ $152 @ $3.00 H100 | GiveMeANode `h100-1` $3.996/h → $202; Modal H100 $3.9492/h → $200; RunPod H100 SXM 80 GB $2.69/h (secure) → $136; Vast H100 1× $1.79/h → $91                                                                                                                                                                                                               | GiveMeANode is live **for CPU only**; the rest offline-replica-only |
| Wave 2 as proposed                                                          | ~26       | ≈ $78               | $47–104                                                                                                                                                                                                                                                                                                                                                    | —                                                                   |
| **Honest note**                                                             | —         | —                   | 60M and 150M models at 2B tokens do not need an H100. An A10/L4 runs them at roughly a quarter of the throughput for a small fraction of the price — the scenario's conclusions survive, the wall-clock quadruples (~200 A10-hours). This is the one scenario that can run _today_, on the validated Lambda A10, if the founder accepts a slower schedule. |                                                                     |     |

**Scenario 3 — 70B serving (the expensive one)**

| Line                                              | Machine | Hours | Scenario's price | Catalogue reality                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ------- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slice-evals` bf16 70B baseline + latency harness | 2× H100 | 3     | $18              | **The catalogue's validated-shape H100 offers are 1× or 8×, not 2×.** GiveMeANode sells `h100-1` ($3.996) and `h100-8` ($31.968); Crusoe sells H100 80 GB SXM only as `…-ib.8x`. On an 8× node: 3 h → $96. On RunPod/Vast (arbitrary GPU counts, offline-replica-only): 2 × $2.69 = $5.38/h → $16.       |
| `awq-70b`                                         | 1× H100 | 6     | $18              | $16–24                                                                                                                                                                                                                                                                                                   |
| `dense-32b`                                       | 1× H100 | 4     | $12              | $11–16                                                                                                                                                                                                                                                                                                   |
| `specdec-70b`                                     | 2× H100 | 4     | $24              | $128 on an 8× node; $22 on a 2× rental                                                                                                                                                                                                                                                                   |
| Re-scoring, idle tails, setup                     | 1× H100 | 3     | $9               | $8–12                                                                                                                                                                                                                                                                                                    |
| **Wave 1**                                        |         |       | **≈ $81**        | **≈ $73 if a 2× H100 rental exists; ≈ $260–370 if the only H100 shapes are 1× and 8×**                                                                                                                                                                                                                   |
| Hidden line the scenario omits                    |         |       |                  | 70B bf16 weights ≈ 140 GB to download per machine, per rental, plus a ~40 GB quantized artifact. Egress and storage are billed separately by every provider; Cloudflare's published prices are explicitly _"an upper bound on the compute line only"_. Budget a further ~$20–40 and a lot of wall-clock. |
| Non-GPU                                           |         |       |                  | LLM-as-judge calls across 5 slices × 2–4 systems — a hosted-model key and its own spend.                                                                                                                                                                                                                 |

**Combined, if all three run wave 1 only, on validated hardware with a 30%
contingency: plan for $600–900 of infrastructure**, dominated by scenario 3, and
assume the first week's spend is conformance and debugging rather than science.

---

## 2. Agent topology

### 2.1 The mechanism: one `mk_` key per project, the runner mints the agents

This is the part that already works and that nobody has to build. From
`merv-typescript/docs/SESSION_LEASES.md`:

> Two independently leased agents under the **same human account or machine key**
> can produce and review. The producing worker cannot review its own output.

and from `docs/AGENT_CONTINUITY.md`: _"Automatic dispatch still launches one
fresh agent per execution."_

So: **one project-scoped `mk_` key per project** is the whole credential story.
The runner holds it as its source credential; every worker gets a per-launch
`ms_` session secret derived by the runner and never sees the source key. Each
worker is a distinct Scope actor, so independence is enforced by the server, not
by convention.

Do **not** try to run producer and reviewer as two plain `codex exec` processes
sharing one `mk_` key: a key resolves to the owner's single actor, so the second
one is self-review and the server refuses it. And key callers _cannot_ mint
actor credentials (`docs/USER_KEYS.md`), so the `live-codex.ts` trick of issuing
separate producer/reviewer actors is not available to a key holder — only to a
human login.

### 2.2 Agent count per scenario

One fresh Codex process per workflow assignment.

| Stage                                     | Assignments                                        |
| ----------------------------------------- | -------------------------------------------------- |
| Task                                      | 2 (work, review) — plus 2 per rejected delivery    |
| Experiment, clean                         | 4 (design, design review, execute, attempt review) |
| Experiment, design rejected               | +2 (new plan, new design review)                   |
| Experiment, attempt returned to `running` | +2 (repair, re-review)                             |
| Experiment, attempt returned to `planned` | +4 (full new attempt)                              |
| Reflection                                | 7 (5 lenses, synthesis, reflection review)         |
| Consolidation (git cycles only)           | 2 (consolidator, consolidation review)             |

| Scenario     | Task    | Experiments                                                  | Reflection | Consolidation | **Total Codex executions** |
| ------------ | ------- | ------------------------------------------------------------ | ---------- | ------------- | -------------------------- |
| 1 Ledgerline | 2       | `lora-vs-prompt` 4+2+2 = 8; `data-scaling` 4                 | 7          | 0             | **21**                     |
| 2 Fathom     | 2       | `tokenizer-ab-60m` 4; `-150m` 4+2 = 6; `posenc-150m` 4+4 = 8 | 7          | 0             | **27**                     |
| 3 Parlay     | 2+2 = 4 | `awq-70b` 4+2 = 6; `dense-32b` 4; `specdec-70b` 4            | 7          | 2             | **27**                     |

**75 agent executions across the three projects**, plus retries. At Codex
reasoning-effort defaults that is the dominant _token_ cost and is independent of
the GPU budget.

### 2.3 Which launcher each role uses

Three launch paths, chosen per assignment:

| Path                                    | How                                                                                                                                                                                                                               | Network | Use for                                                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Runner auto-dispatch**             | `npm run cli -- runner --config runner.json` + dispatch enabled on the project's Sessions page                                                                                                                                    | **No**  | Design authoring, design review, attempt review, all 5 lenses, synthesis, reflection review, consolidation review, task review (except scenario 2's smoke-run reviewer) |
| **B. Self-registered continuing agent** | `POST /sessions/agents` with an `ms_` secret → `POST /sessions/self/assignment` → you spawn `codex exec` with your own flags, the `ms_` secret as MCP bearer, network **on**, and the sandboxes MCP configured as a second server | Yes     | Execution stage of every experiment; the dataset-building task work; scenario 2's smoke-running task reviewer                                                           |
| **C. Explicit lease offer**             | `POST /sessions/offer` with `instanceId`, `expectedRevision`, `runnerId`, `requestId`, `secret` → spawn Codex against the returned `session.execution.policy.tools`                                                               | Yes     | Same as B; simpler when you do not want a persistent agent identity. `merv-typescript/scripts/live-sessions.ts` is the working template for this exact spawn.           |

Path B/C is not a workaround: `docs/AGENT_CONTINUITY.md` documents "Connecting
your own agent" as a first-class path, and the session secret is MCP-only and
fenced to `POST /mcp` — it cannot administer anything.

### 2.4 Where the review standards live now that skills are gone

The five reviewer skills at `merv/skills/*-review/` contain the actual
adversarial standard ("you verify, you do not read and nod"; "the report is
interpretation, submitted results are the numeric record"; the return-path
rules). They call Python tool names and the runner disables repository skills,
so they cannot simply be loaded.

Port them into the three places the server _does_ carry text into an assignment:

1. **`experiment.details`** (≤16,000 chars, immutable) — the scenario's method
   contract, the fairness rules, and the standard the reviewer will be held to.
   `merv-typescript/scripts/live-experiments.ts` does exactly this: its
   `protocol` string carries per-role instructions ("Design reviewer: … Return
   an honest `review.submit` verdict with synopsis, verification notes and
   findings, **not an automatic approval**.").
2. **Task `checks`** — one numbered, independently verifiable check per
   deliverable. These become the pinned review criteria.
3. **The stdin prompt** for path-B/C launches.

Then, separately, write a small skill bundle against the production tool names.
That is the real fix and it is a day of work, not a week — but it is not needed
to start.

Useful detail while writing the briefs: `review.submit` takes
`verdict: pass | needs_changes | fail`, a plain single-paragraph `synopsis` of
40–420 characters, and **exactly one finding per numbered criterion** with
`status: met | not_met | not_verified | waived`, `evidenceIds` drawn from the
pinned review, and notes explaining the verification. `met` requires evidence;
`pass` requires every criterion `met` or explicitly `waived`. **Task reviews
reject `returnTo` entirely** — their routes are fixed (`pass`→done,
`needs_changes`→`in_progress`, `fail`→failed). Only experiment attempt reviews
choose between `running` and `planned`. `not_verified` is a legitimate finding
and is the honest answer when a reviewer cannot reproduce a check with what it
was given.

### 2.5 `scripts/live-scenario.ts` — what a new harness takes

The existing harnesses all boot an **in-process** app (`createApp`) and are
therefore local-only. A production driver is a different animal. Sketch:

```
node --import tsx scripts/live-scenario.ts \
  --scenario /Users/guraltoo/Documents/dev/proj/experiments/Merv/Scenarios/01-finetune-or-keep-prompting.md \
  --base-url https://experiments.rapidreview.io \
  --project prj_XXXX \
  --token-env MERV_TOKEN_LEDGERLINE \
  --runner-dir /var/lib/merv-runner/ledgerline \
  --out /var/log/merv-scenario/ledgerline-<stamp>
```

What it needs, concretely:

- **Inputs:** the scenario file (the brief), the project id, the `mk_` token env
  var name, a run directory, and a per-role prompt map extracted from the
  scenario (intents, details, claims, checks).
- **Setup over HTTP** (not `ctx.*`): `POST /tools/project.context.update`,
  `/tools/claim.create`, `/tools/task.create`, `/tools/experiment.create`,
  `/tools/research.create`, `/tools/paper.patch`, with
  `Authorization: Bearer $MERV_TOKEN` and, for an account-scoped key,
  `X-Merv-Project-Id`. Every mutation needs a stable `requestId`; the context
  update additionally needs `expectedSummary`.
- **Runner:** construct `MachineRunner({ directory, baseUrl, projectId,
credentialEnv, capacity, profiles:[{name:'codex',harness:'codex',executable:'codex',enabled:true,parallelism:N}] })`
  — it already speaks HTTP to a remote server, so it points at production
  unchanged. Then `PUT /sessions/dispatch {enabled:true}`.
- **Interception:** poll `GET /sessions/status`; when the next eligible
  assignment is an _execution_ stage, do **not** let the runner take it — pause
  dispatch, take the lease yourself (path B/C), spawn a network-enabled Codex,
  then resume. The clean version of this is a second runner profile flag; the
  quick version is dispatch pause/resume around execution stages.
- **Observation:** the same state-change log `live-experiments.ts` prints, plus
  `runner.snapshot().launches`, written to the run directory alongside each
  child's `jsonl` and redacted stderr.
- **Assertions:** none of the scenario's scripted verdicts. Assert only
  structural facts (the workflow reached a terminal state; the reviewer actor
  differs from the producer actor; every submitted result is retained). Asserting
  a verdict would turn the review gate into theatre.

Budget: a day to write, half a day to rehearse locally against `createApp` +
`npm run fake:sandboxes` before it touches production.

---

## 3. Prerequisites — only the founder can supply these

Copy this list; each line blocks the runs until it is answered.

- [ ] **1. Authorization to write to production.** These three projects will be
      real records on `https://experiments.rapidreview.io`, visible to every
      member, and experiments/reviews/artifacts are immutable and undeletable.
      Confirm that is wanted, and whether the projects should be named as
      fictional companies (Ledgerline / Fathom Signals / Parlay) or as what they
      are (demonstration runs).
- [ ] **2. The agent host and Codex credentials.** Which machine hosts the
      agents — this Mac, or `merv-harness-dev` in `MERV-DEV-RG`? A logged-in
      Codex CLI must be present there (`CODEX_HOME` with a live account), and
      the runner profile takes an optional `model` and `effort`. Name the model.
      (The profile isolation audit was done against `codex-cli 0.155.0-alpha.2`;
      a newer CLI needs the launch observations rechecked.) The host also needs
      Node 22.13.1+, the repo checked out, and `npm ci` run in `merv-typescript`.
- [ ] **3. Three projects and three machine keys.** Only a verified human can
      create a project — `mk_` keys cannot. In the production UI: create the
      three projects, then account menu → **Manage machine keys** (or
      `https://experiments.rapidreview.io/ui/settings/keys`), issue one
      **project-scoped** key per project with a label and an explicit
      `expiresAt` (omitting it means _no expiry_). Hand over the three project
      ids and put the three tokens in the agent host's environment as, say,
      `MERV_TOKEN_LEDGERLINE`, `MERV_TOKEN_FATHOM`, `MERV_TOKEN_PARLAY`. Each
      secret is shown once.
- [ ] **4. Decide the GPU question.** Three sub-decisions: - [ ] 4a. **Is Merv to drive compute at all, or is compute driven beside
      it?** Today Merv exposes only `sandbox.extend` and `sandbox.release`
      even when the plugin is on. Recommendation: drive compute beside
      Merv via the sandboxes service's own MCP / the `sbx` CLI, and bring
      evidence back as artifacts. Nothing needs deploying for that. - [ ] 4b. **If Merv is to show sandbox rows at all**: set
      `MERV_SANDBOXES_URL=https://sandboxes.rapidreview.io` and
      `MERV_SANDBOXES_CONNECTIONS` — a JSON array of
      `{projectId, namespace, tokenEnv}`, one entry per project, with each
      `tokenEnv` naming a variable holding that namespace's `sbxt_`
      **consumer** grant (an admin grant is refused). This is baked into
      `/etc/merv/typescript.env` and needs a **redeploy**, so the three
      projects must exist first. Note: the plugin reads `/v1/ui/manifest`,
      which the service does not appear to serve — expect the Sandboxes
      row to sit `degraded` even when connected. - [ ] 4c. **A provider credential and a validated GPU shape.** BYOK, per
      user, per namespace, connected in the sandboxes UI Providers tab or
      `sbx providers connect <plugin>`. Then, for whichever GPU you choose,
      a **first live conformance run**: `sbx providers conformance <name>`
      rents the cheapest offer, checks every driver rule and deletes the
      machine. Nothing bigger than a Lambda A10 has ever been rented live.
      Name the provider and the shape.
- [ ] **5. Spend caps, in writing.** Per account/namespace budget
      (`PUT /v1/accounts/{account}/budgets/{id}`, scope `namespace`, window
      `day` and `month`) and resource ceilings (`max_concurrent`,
      `max_lifetime_seconds`, `max_hourly_price`). Zero blocks new positive-cost
      commitments; null means unlimited. Proposed, matching the scenarios:
      Ledgerline $40/day, $130 total; Fathom $60/day, $300 total; Parlay
      $50/day, $200 total — but see §1.4: scenario 3's real number may be 3–4×
      its written budget if only 1× and 8× H100 shapes exist. **Give me a total
      ceiling for all three.**
- [ ] **6. A hosted-model API key and its budget**, separate from GPU: scenario
      1's prompt baseline (~$15 of calls) and scenario 3's LLM-as-judge across
      five slices and several systems. Merv holds no provider keys; this lives
      on the agent host.
- [ ] **7. Data decisions — one per scenario.** Each scenario's dataset is
      invented. For each, choose: (a) a named real public corpus as a declared
      substitute, with claims re-derived against its own baseline; or (b) a
      declared synthetic stand-in, accepting that the numbers measure the
      generator; or (c) real proprietary data, if any exists. - [ ] 7a. Ledgerline: 5,200 labeled invoices → ? - [ ] 7b. Fathom: 2B tokens of industrial sensor data across plants → ? - [ ] 7c. Parlay: de-identified support tickets in de/fr/es with tool-call
      gold answers and QA-labelled refusals → ?
- [ ] **8. A human labeller for scenario 3, or an explicit waiver.** Deliverable
      2 requires 100 human labels per slice (500 total) to calibrate the judge.
      Either name the person and their hours, or authorize the task reviewer to
      waive that check on the record — and accept that scenario 3 then no longer
      demonstrates the mechanism it exists to demonstrate.
- [ ] **9. GitHub publication: wanted or not?** Only scenario 3 needs it (its
      code consolidation). If yes: confirm the `merv-research` App installation
      (`162326306`) still has access to the target repositories under
      `rapidreview-io` — the readiness record says the user set it to _all
      repositories_ during verification, but if it has since been narrowed, an
      org owner must add each new repo; Merv has no administration permission.
      Then, per project, the connecting human must link the repository in the
      UI, set automation to **write**, and choose a base branch (it is currently
      **off** for the only existing connection). Each repository also needs a
      **fresh runner directory** — a runner ledger is bound to one repository
      and one source credential. Decide: one repo per scenario, or skip
      publication and stop at an approved consolidation proposal.
- [ ] **10. Approve or decline three small code changes.** The runs can start
      without any of them; each closes a gap named in §1. - [ ] 10a. A network-enabled runner profile (or accept path B/C launching
      for execution stages — recommended, no change needed). - [ ] 10b. Lens roster input on `reflection.create`, so the scenarios'
      authored lenses exist (currently the five are fixed: `evidence`,
      `theory`, `methods`, `synthesis`, `next_steps`). - [ ] 10c. Feed post kinds/threads/attachment blocks, or accept the
      production feed as body + artifact ids.
- [ ] **11. A stop rule.** What ends a run: a wall-clock limit, a spend limit,
      a number of reviewer-forced reruns, or your call. Also: who may halt —
      `POST /sessions/halt` disables dispatch and closes every session in a
      project, and any project admin can use it.

---

## 4. Order of work once those arrive

Nine steps. Steps 1–3 need nothing from §3 and could start now.

**Step 1 — Rehearse the whole loop locally, against nothing real.**
Prove the four-agent lifecycle still passes on this checkout before pointing
anything at production.

```
cd /Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript
npm test                      # full suite
npm run test:runner
node --import tsx scripts/live-experiments.ts /private/tmp/merv-rehearsal-01
```

That last one boots an in-process server, creates one claim and one experiment,
starts a `MachineRunner` with a `codex` profile, enables dispatch, and waits for
four fresh Codex agents to carry an experiment from `planned` to `complete`. It
is the exact machinery the scenarios need, at toy scale. If it does not pass,
nothing downstream will. Evidence lands in the run directory:
`report.json`, per-phase `*.jsonl`, redacted `*.stderr.log`.

**Step 2 — Rehearse the UI and the sandbox row with fakes.**

```
# .claude/launch.json already has these
cordis-demo-api        (npm run demo:ui,      port 3091)
cordis-ui              (npm run dev:ui,       port 5190)
cordis-fake-sandboxes  (npm run fake:sandboxes, port 3210)
```

`scripts/fake-sandboxes.ts` implements `/v1/ui/manifest`, which the real service
does not — so this is where the Sandboxes row can be seen working at all.

**Step 3 — Port the review standards into assignment text.**
Write, per scenario, a `details` block (≤16,000 chars) carrying the method
contract, the fairness rules and the per-role standard, modelled on the
`protocol` string in `scripts/live-experiments.ts`. Write the task `goal` and
numbered `checks`. Keep these in
`/Users/guraltoo/Documents/dev/proj/experiments/Merv/Scenarios/briefs/`.
**Do not put verdicts in them.** Where the scenario scripts a `needs_changes`,
put the _defect_ in the producer's brief, never the verdict in the reviewer's.

**Step 4 — Founder creates the three projects and three keys** (§3 item 3).
Then, on the agent host:

```
export MERV_TOKEN_LEDGERLINE=mk_...
curl -s -H "Authorization: Bearer $MERV_TOKEN_LEDGERLINE" \
  https://experiments.rapidreview.io/tools/actor.whoami -X POST -d '{}' \
  -H 'content-type: application/json'
```

Expect the right project and role. Then `workflow.status_and_next` with `{}`.

**Step 5 — Seed one project by hand and watch it.**
Start with **Ledgerline**, and within it with **`eval-harness` only**. Set the
Introduction (`project.context.update`, or the Project context page in the UI),
then C1–C3, then the task. Leave the research cycle until the wave-1 nodes
exist, so it can name them in `dependsOn`. Then:

```
cp merv-typescript/config/runner.example.json /etc/merv/runner-ledgerline.json
# set baseUrl https://experiments.rapidreview.io, projectId, capacity 2,
# credentialEnv MERV_TOKEN_LEDGERLINE, profile codex with the chosen model
cd merv-typescript && npm run cli -- runner --config /etc/merv/runner-ledgerline.json
```

Dispatch starts **off** for every project. Enable it from the Sessions page (or
`PUT /sessions/dispatch {"enabled":true}`) only when you are ready to watch.
Let one task go work → in_review → done with two fresh agents before creating a
single experiment.

**Step 6 — First experiment, first design review, no GPU.**
Create `lora-vs-prompt` and let the design stages run. Design authoring and
design review are pure MCP work: this is where you learn whether a
runner-dispatched reviewer, with no skill file, still reviews properly. Read its
synopsis and findings before spending a cent on compute.

**Step 7 — The first paid run.** Only after §3 items 4–6.
Take the execution lease yourself (path B/C), spawn a network-enabled Codex with
the sandboxes MCP as a second server, and run the _smallest_ configuration in
the plan — one seed, one learning rate — end to end: rent, stage, run as a
durable job, pull outputs, upload results as artifacts, release in two steps,
confirm `terminated`. Verify the spend line in `GET /v1/spend` before scaling to
the full grid.

**Step 8 — Scale out.** Fathom second (it is the cheapest to make real and the
only one that fits comfortably on a validated A10), Parlay last (most expensive,
most human-dependent). Run the three projects with three separate runner
directories and three separate keys; never share a runner ledger between
projects (it is bound to one source credential digest).

**Step 9 — Reflection and close.** When a project is idle with terminal work,
`reflection.create` pauses new task/experiment creation and opens five lens
assignments; capacity ≥5 lets them run in parallel. Then synthesis, reflection
review, and `research.advance`. Apply the claim changes with `claim.update`
(nothing does it automatically). Create wave 2 nodes only after the wave is
approved.

### How progress is observed

All at `https://experiments.rapidreview.io/ui/`, per project:

| Page                                     | What it answers                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sessions**                             | Is dispatch on, is the runner connected and heartbeating, which leases are live, which assignments are available, what workspaces are attached. The first page to open when nothing is happening. |
| **Experiments**                          | Inventory and detail: revision, attempt, approved plan, retained evidence, review history, feedback, workflow blockers and dependencies, metrics preview.                                         |
| **Reviews**                              | The review desk: what is requested, claimed, and decided; verdicts, synopses, findings.                                                                                                           |
| **Tasks**                                | Brief, delivery confirmations, review state.                                                                                                                                                      |
| **Claims**                               | Statement, status, confidence, revision.                                                                                                                                                          |
| **Feed**                                 | The narrative, such as it is (body + attachments).                                                                                                                                                |
| **Files**                                | Every retained artifact.                                                                                                                                                                          |
| **Cycles / Reflections / Consolidation** | Outer gate, the five lenses, synthesis, and the code stage.                                                                                                                                       |
| **Paper**                                | Methods/Results as the reviewed submissions build them.                                                                                                                                           |
| **Code**                                 | Commit receipts and, if enabled, GitHub publication status.                                                                                                                                       |

### How a broken step is debugged

1. **The workflow says why.** `workflow.status_and_next {"instanceId":"..."}`
   returns `state`, `currentGate`, `nextAction`, `blockers`, `actions` with
   `ready` / `needs_input` / `blocked`. Preflight a command with
   `{instanceId, action, input}` — read-only, same validators as the real call.
2. **The runner ledger.** `runner.snapshot()` (printed by the driver) and the
   private SQLite ledger under the runner directory: launch intent, status
   (`reserved`, `starting`, `running`, `stopped`, `exited`, `uncertain`), and
   redacted child logs. `uncertain` means the guardian could not confirm
   termination — the slot is held deliberately and is **never respawned**.
   Investigate; do not delete.
3. **Child output.** Per-launch `*.jsonl` and `*.stderr.log`, with the session
   bearer and known secrets redacted, including across chunk boundaries.
4. **The VM.** `ssh ResearchSuite_Control`, then
   `/opt/merv-typescript/releases/<id>/` for `source-manifest.json`,
   `build.log`, `deploy.log`, `staging-refresh-acceptance.json`;
   `docker compose -f compose.yml logs` for the server. Rollback is one command,
   recorded in the `RELEASES.md` row.
5. **The review desk** for scientific breakage: a returned experiment carries
   the reviewer's synopsis, findings and return path. That is the diagnosis —
   `returnTo: "running"` means the plan stood and the execution or the report
   did not; `returnTo: "planned"` means the plan itself was wrong.
6. **Sandboxes** separately: `sandbox_events`, `job_status` / `job_read`
   (durable — jobs survive a dropped connection on either side), `spend_status`,
   `usage_report` against the service's own MCP.

---

## 5. Risks, and what will not be real

### Most likely to break, in order

1. **The reviewer will not deliver the scripted verdict.** This is the deepest
   risk and the most important one to get right. Every scripted
   `needs_changes` in all three scenarios must be _earned_: the defect goes in
   the producer's brief, never the verdict in the reviewer's. If you brief a
   reviewer to return `needs_changes`, you have not demonstrated Merv, you have
   demonstrated a puppet. Expect a meaningful fraction of the scripted
   rejections not to occur, and treat each non-occurrence as a finding about the
   gate. Conversely, expect _unscripted_ rejections; budget compute for them
   (scenario 2 already does).
2. **No GPU is actually rentable yet.** §0.4. The first live conformance run on
   a real provider token is unexplored territory and may fail on quota, capacity,
   image family, or access mode. Lambda throttles launches to one per 12 seconds
   and new accounts carry a launch quota that surfaces as a non-retryable
   `global/quota-exceeded`. GiveMeANode queues rather than refuses — a create can
   sit in `provisioning` indefinitely.
3. **Tool-name drift between the scenarios and production.** Any agent that has
   ever seen the old plugin will reach for `agent.hello`, `artifact.upload`,
   `review.request`, `sandbox.run`. Those calls fail. Make sure the legacy plugin
   is disabled on the agent host — running both connections is explicitly warned
   against — and that the briefs use production names.
4. **Lease expiry mid-run.** Active sliding lifetime is four hours, hard deadline
   twenty-four (cap seven days). A 6–12 hour training run outlives its Merv lease
   unless the launcher heartbeats. Heartbeat renews only an _active, unexpired_
   lease; once it lapses the execution closes permanently and the work restarts.
   The sandbox lease is a second, independent clock (default 3600 s;
   `sandbox.extend` caps one call at 86,400 s and is a _total_, not an increment).
5. **Schema and bound refusals.** Artifacts ≤2,000,000 bytes; plan/report/result
   role inputs ≤16,000 bytes each; `experiment.details` ≤16,000 chars; feed body
   ≤8,000; ≤7 nonterminal experiments per project; ≤10 artifact ids per post; at
   most 100 dependency ids. An agent that tries to submit a full results dump as
   an artifact will be refused.
6. **Rotating or expiring a key orphans its runner.** The launch ledger is bound
   to the server URL, the project, and the _original source credential digest_:
   _"a different key requires a new ledger until a verified rotation handoff is
   implemented."_ So do not rotate a project's `mk_` key mid-run, and give the
   keys an `expiresAt` comfortably past the expected end — or accept rebuilding
   the runner directory. A key with no expiry is the other failure mode; it
   never lapses on its own.
7. **Cost overrun on scenario 3.** If the only H100 shapes available are 1× and
   8×, every 2×H100 line becomes an 8× rental and the scenario's $81 becomes
   $260–370 before egress. Set the cap _before_ the first rental; a create whose
   full lease would cross the cap is refused with `budget_exceeded`, which is the
   behaviour you want.
8. **Deployment fragility.** A recent release (2026-09-16T23:27Z) restart-looped
   because the experiments plugin refused `workflow_version_conflict` — an
   execution-policy change without a version bump. Any code change from §3 item
   10 that touches a workflow definition risks the same. Also: the working tree
   is **dirty** relative to the live release, and releases are built from an
   archive of the working tree, not from git. Do not deploy mid-run.
9. **The GitHub path is the least exercised.** Consolidation completes without
   publishing central Git; cross-machine object transport is open work. Scenario
   3's consolidation can produce a reviewed, immutable proposal — treat actual
   publication as a stretch goal.

### What will not be real, stated plainly

- **The companies, the data and the numbers.** Ledgerline, Fathom Signals and
  Parlay do not exist. Unless §3 item 7 substitutes real corpora, every F1, NLL
  and slice score is a measurement on a stand-in, and the Introductions must say
  so in the first sentence. A reader who takes "93.35 F1 on a vendor-disjoint
  split" at face value has been misled.
- **The scripted verdicts, if they are scripted.** See risk 1.
- **Authored reflection lenses.** Fixed five on production. The scenarios'
  `serving-economics`, `label-quality`, `scaling-trend`, `budget-fairness`,
  `cost-model` and `safety-regressions` lenses do not exist as records.
- **The feed as written.** No threads, kinds, voices, reactions, replies, stat
  or chart or table blocks. Scenario 3's central human moment — the QA lead
  replying "that is the Spanish thing again", and the reply living in the record
  — has no mechanism.
- **Champion and candidate.** Scenario 2's champion promotion has no record type.
- **Merv-driven compute.** The scenarios show agents calling `sandbox.options`,
  `sandbox.run` and `sandbox.pull_outputs` as Merv tools. On production those are
  operator or external-MCP actions; Merv sees only the evidence that comes back.
- **Scenario 3's human calibration**, unless a person does 500 labels.
- **Central Git publication** for scenario 3's consolidation.
- **Anything about "real projects" meaning real research.** What these runs
  genuinely demonstrate is the _machinery_: immutable intent, a plan as a
  contract, independent design and attempt review with real return paths,
  retained numeric evidence, five independent lenses, and a refuted claim
  recorded as a success. That is worth demonstrating and it is honest. Claiming
  more than that is not.

## 6. Decisions taken 2026-09-17 (the founder delegated §3 in full)

The founder: "Please handle all of these yourself … The compute will need to come from lambda and cloudflare. You can use whatever data, etc. you want for the mock scenarios." Every item in §3 is now decided and, where it is a thing, done.

| Item                           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corpus, scenario 1             | SROIE 2019 (ICDAR 2019 receipts, Task 3 key information extraction; 973 receipts, fields company/date/address/total; `company` is the vendor id). Written into brief 01 §1; check 1 asks for at least 250 held-out receipts instead of 600.                                                                                                                                                                                                                                                                                                                                |
| Data, scenario 2               | LOTSA (Salesforce, Hugging Face `Salesforce/lotsa_data`, Apache-2.0 collection); a source is a sub-dataset; the frozen corpus is 400M observations, not 2B, so a 150M run takes about four hours on an A10. Written into brief 02 §1.                                                                                                                                                                                                                                                                                                                                      |
| Data, scenario 3               | MTOP (en/de/fr/es, semantic frames as the tool-call schema) for the English, non-English and tool-call slices; Ubuntu Dialogue Corpus v2 for long-context threads; CoCoNot (`allenai/coconot`) as the named refusal substitute. Model sizes: Qwen2.5-7B-Instruct bf16 baseline on one A10, AWQ 4-bit of it, Qwen2.5-3B-Instruct for the 32B arm, Qwen2.5-0.5B-Instruct as the draft. Written into brief 03 §1.                                                                                                                                                             |
| Projects and keys              | Three projects on production owned by the founder's own identity, each with one project-scoped `mk_` key labelled `scenario N harness (Claude, 2026-09-17, expires in 21 days)`, created through the server's own `createProject` / `createKey` code paths by a one-off operator script run inside the container (the API's human-only rule was honoured by running the same code as the founder's principal, at the founder's request). Keys live only in `~/.merv/scenarios/N.merv.env` (mode 0600) on the founder's Mac.                                                |
| Agent host and model           | This Mac: codex-cli 0.155.0-alpha.2 in ChatGPT mode, pinned `--model gpt-6-astra --effort high` on every harness launch and in the runner profile.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GPU compute                    | Beside Merv, through the sandboxes service's own MCP (`https://sandboxes.rapidreview.io/mcp`) mounted on network stages. Lambda is the shared provider (`MERV_SHARED_LAMBDA_KEY`, A10 24 GB validated). Cloudflare's plugin is Cloudflare Containers, CPU only and tunnel access; it has no shared credential, only a BYOK key in the `dev` namespace, so CPU-only stages run on Lambda CPU shapes or on the harness host, and Cloudflare stays out until a credential is connected by a person. The Merv-side sandboxes plugin (rows in the rail) stays off for the runs. |
| Namespaces and provider access | One namespace per project, `merv-project-<projectId>`, appended to both shared providers' `namespaces` lists in the sandboxes compose file (`pilot-a740864090ba/0d64e2f8-native-compose.json`, backup kept beside it) and the control plane recreated.                                                                                                                                                                                                                                                                                                                     |
| Spend caps and ceiling         | Monthly caps set on the sandboxes service per namespace: scenario 1 $40, scenario 2 $120, scenario 3 $60; ceiling $220 across the three; every lease at most 6 h, idle stop at 30 min. A create whose lease would cross the cap is refused, which is the behaviour wanted. Codex executions run on the ChatGPT plan and are not metered in dollars.                                                                                                                                                                                                                        |
| GitHub publication             | No. Consolidation stops at the approved proposal in every scenario; no repository is linked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Scenario 3 labeller            | Waived, on the record: check 2 of `eval-slices` is reviewed `waived`, the Introduction says the judge is uncalibrated.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Stop rule                      | A scenario stops when its spend cap refuses a lease, when the same stage has been relaunched twice without advancing, when three consecutive submissions are rejected for the same reason, or after 12 h (scenario 1), 36 h (2), 24 h (3) of wall clock. Anything that breaks Merv itself (5xx, crash-loop, a lease the server cannot release) stops all runs until fixed and deployed. The founder can halt at any time from Sessions.                                                                                                                                    |
| Extend lease                   | Not built for sessions; the verb stays for machines only (`sandbox.extend`). Recorded in `docs/UI_DESIGN.md` and `docs/SESSIONS_ROBUSTNESS_2026-09-17.md`.                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 7. Run log

**2026-09-17, first production runs.** Scenario 1 started 14:33Z, scenario 2 at 15:04Z, both on this Mac against production with the pinned model.

What broke, and the fix each time (all committed):

1. `research.create` refused the cycle's request id (it must match `[A-Za-z0-9][A-Za-z0-9_.:-]*`; the cycle name has spaces and a dash). The harness now slugs it.
2. Codex 404'd on the sandboxes MCP because the flag carried the service origin; the MCP is at `/mcp`.
3. A rerun after a failed launch replayed the previous run's session offer with a fresh secret (409 `request_conflict`). Offers now carry a per-process run id.
4. One `task.get` died on a transient `fetch failed`; then one on a 503 `state_timeout`. Requests that never reached the server, and 5xx responses, are retried with backoff.
5. Every sandboxes tool call was refused: Codex prompts for MCP tools by default and a lease runs with approval policy never, so the scenario 2 agent built its harness without compute. The sandboxes server's tools are now approved (`default_tools_approval_mode`); the namespace's spend cap is the guard. MCP handshakes get 120 s after one timed out at 30 s.
6. The runner reported `session_packet_large` and dispatched no reviews for scenario 1: a task review's frozen packet carries the review standards in the assignment text plus the whole delivery, and eval-harness's ran past 64 KiB. Limit raised to 512 KiB (server release).
7. Every runner-dispatched review died on Codex's 30 s MCP handshake: the tool listing asked the session policy about each of the 66 tools in its own transaction, each behind the advisory lock, a second apiece under load. A session's policy is frozen at offer, so its tool names are now read once per session (release 20260917T154000Z).
8. Production Postgres serialises every transaction on one advisory lock per schema; with two runs and their runners polling every second, waits overran the 5 s lock timeout. Production now waits up to 20 s and the harness polls every 3 s (server release). The lock itself is the real ceiling and stays on the list.

9. The first reviews on production were sound rejections the briefs had scripted as passes (eval-harness: no measured prompt baseline; proxy-harness: an unmeasurable sixth check). The harness stopped at the first divergence; it now logs it and keeps driving every record to a terminal state or `--max-rounds` (4 on these runs).
10. That sixth check was a note after the numbered list, swept up by the quoted-string parser; checks now come from numbered items only, and a create that replays with different input reuses the existing record by name.
11. A restarted harness counted rounds from what it had seen itself, so a returned record looked like round 1 again and would have received the planted defect twice; the round is now the process graph's entry count for the state.

12. Scenario 2's and 3's runners sat degraded with `context_too_large`: a task review recipe embeds text and JSON evidence within a 96,000-character budget it shares with the task and the assessment, and the second proxy-harness delivery carried 96 KB of JSON manifests. Recipes are immutable per version, so the fix is at the input: when the embeddable evidence would leave no room, the evidence section lists the artifacts and the reviewer reads them (release 2026-09-17 ~18:00Z).

13. Three Introduction edits by the operator (the lever the briefs allow), mirrored in the briefs: scenario 1 names the frozen harness's readable index and confirmations artifacts and the baseline F1 0.64438, because the design reviewer kept asking planners for pinned, readable harness evidence; scenarios 2 and 3 waive the transcription-defect checks ("plant", "production tickets") and define "plant" as a LOTSA source, because a delivery cannot change its task's checks and the reviewer would not waive without operator authority.

What worked: records replay by request id across reruns, so every relaunch resumed where the trajectory stood; the eval-harness agent (scenario 1) obtained SROIE, built a company-disjoint split of 258 held-out receipts, a scorer and a README, and delivered with check 3 honestly unmet; the lora-vs-prompt planner quoted the planted pre-harness figure and went to design review; the proxy-harness agent (scenario 2) pinned LOTSA and delivered, naming what it could not do without compute.
