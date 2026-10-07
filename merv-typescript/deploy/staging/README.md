# Staging checks

Scripts that test the real staging system (`rp-control-dev`, schema `merv_ts_staging`) end to
end: real runners, real agents, real Fleet machines on Cloudflare, and real Modal machines through
the Sandboxes service. Run them from a Mac that has `ssh azureuser@dev-experiments.rapidreview.io`.
Each run appends one row to [`../STAGING_CHECKS.md`](../STAGING_CHECKS.md); commit that row with
the change it vouches for. The full log goes to `$STG_LOG_DIR` (default `$TMPDIR/merv-staging-checks`).

| Script                                                | When                                                | Time       | Cost    | What it proves                           |
| ----------------------------------------------------- | --------------------------------------------------- | ---------- | ------- | ---------------------------------------- |
| `smoke.sh [TAG]` (T0)                                 | every staging release                               | ~10–20 min | ~$0.5–1 | the release gate below                   |
| `provider-check.sh`                                   | after a Sandboxes release, and daily                | ~2–4 min   | ~$0.02  | Modal and Cloudflare start, run and stop |
| `research-loop.sh [TAG] [--project hosted\|e2e]` (T1) | cycles that touch workflows, experiments or compute | ≤45 min    | ≤$2     | one whole small research flow            |

Exit codes: 0 pass, 1 fail, 3 partial (a step was blocked by something outside the script, named
in the row). Assertions are about structure (states reached, artifacts present, numbers above a
floor, nothing stuck or held), never about the wording an agent chose.

## How they reach staging

Each `.sh` pipes [`stg.py`](stg.py) plus its own `.py` over ssh into `sudo python3 -` on the VM, so
every credential stays there. Nothing prints a token, a database URL or a signed link; logs show ids.

- Merv tools: `POST http://127.0.0.1:3081/tools/<name>` with
  - `/opt/merv-staging-e2e/operator.json`: operator of the actor-owned **Staging E2E** project
    (`project_4cf03f9172dc…`), served by the `merv-staging-runner` container (Codex);
  - `/opt/merv-staging-e2e/hosted-key.json`: the owner's key for the owner-owned **Staging E2E
    hosted** project (`project_7fb4bb6969…`), served by Fleet machines on Cloudflare.
- Database: read-only `psql` (`default_transaction_read_only=on`) inside `deploy-supabase-db-1`.
- Sandboxes: `/opt/merv-staging-e2e/sandboxes-staging-compute.json`, a **consumer** token of the
  `staging-compute` namespace (token id `tok_p8dfo8i1ma2rg68v`, label `merv-staging-checks-provider`,
  minted 2026-10-07 with `sbx token create -n staging-compute` inside prod's `sandboxes-control-1`).
  That namespace offers Modal only; an account-wide limit kills any Modal machine after 1 h.
  Revoke with `sbx token revoke tok_p8dfo8i1ma2rg68v` there if the VM is ever suspect.

`lib.sh` refuses any host but the staging VM (override with `STG_ALLOW_HOST=1`).

## smoke.sh (T0)

1. Rebuilds `merv-staging-runner` FROM the live staging Main image.
2. A slow task on the E2E runner; the runner process is SIGKILLed while the producer streams. The
   task must reach `done` and its stream must have no seq gaps or duplicate events.
3. **Review back-edge.** A task briefed to need two rounds; the operator also steers the first
   reviewer with `session.message` to return `needs_changes`. Asserts the verdicts
   (`needs_changes`, …, `pass`) and that `session.threads` shows **one** producer thread with
   **two** visits, the second `resumed: true`.
4. **Thread reads** for both tasks: `session.threads` equals `GET /sessions/threads?instanceId=`, and
   `GET /sessions/threads/:id/conversation` returns one entry per visit, with events for every
   launched visit.
5. **Hold and release.** Stops the healthy runner and starts `merv-staging-crashrunner` (same
   image, profile executable `/bin/false`), so every launch of a fresh task closes `crash_loop`.
   After 5 attempts `session.stuck` must list it `dispatch_held` with code `crash_loop`. The crash
   runner is removed, the healthy runner restarted, `session.release_hold` clears the hold and a
   healthy runner must activate a session for it; the probe task is then marked failed. ~3 min.
6. Pi canary on a staging hosted (Cloudflare) machine, then the machine is stopped.
7. A Fleet hosted task in the owner-owned project reaches `done`.
8. Main logged no `uncaught|unhandled|FATAL|Connection terminated` since the start and did not
   restart.

Steps 6 and 7 run in parallel with 2–5; the back-edge task runs alongside the slow task.

## provider-check.sh

- Modal `cpu-2` and `gpu-t4` through the Sandboxes API: rent, time to `ready`, a tiny job whose
  stdout is checked exactly (a sum on CPU; `nvidia-smi -L` and a CUDA matmul on the T4), release.
- **Nothing left running**, verified through the Sandboxes API (staging holds no Modal credentials,
  which is why the old Modal-SDK check failed with "Token missing"): every rental is `stopped`, the
  namespace lists no live sandbox, and `cost_so_far` no longer grows. Sandboxes reads presence from
  Modal itself.
- Cloudflare: `pi.warm` in the E2E project starts a staging hosted agent machine; time to `ready`,
  then `pi.machine.stop` and the machine must leave `ready`. Do not run it while `smoke.sh` is in
  its Pi step: both use the operator's one Pi machine.
- Records `cpu2_ready_s`, `t4_ready_s`, `cloudflare_ready_s` and the cost (Modal from Sandboxes'
  `cost_so_far`; Cloudflare as the offer's hourly ceiling times the seconds it was up).
- Flags: `--skip-cpu`, `--skip-gpu`, `--skip-cloudflare`.

## research-loop.sh (T1)

In the owner-owned hosted project by default (`--project e2e` uses the E2E runner instead):

1. `task.create`: an agent writes `data/make_dataset.py` (standard library, seeded synthetic
   binary classification data) and commits it; an independent reviewer passes it.
2. `experiment.create` depending on that task: logistic regression by gradient descent, 80/20
   split, held-out accuracy, the result attached as `results/metrics.json` (role `result`). The
   design asks for the training to run on one Modal `cpu-2` machine through the project's native
   Sandboxes connection, released afterwards.
3. Agents plan, get the design reviewed, run, submit results and get them reviewed.

Asserts: task `done`; the experiment passes `planned > design_review > running >
experiment_review > complete`; the last review passes; a result JSON with `accuracy ≥ 0.80`;
with a Sandboxes connection, native work rows for the experiment and a `sbx_…` machine in the
result; nothing stuck or held; no live session at the end; inside the caps.

Caps: 45 min (`STG_T1_CAP_SECONDS`) and $2 (`STG_T1_CAP_USD`). Past either, the script abandons
the experiment, fails the task, halts their sessions and fails. A wall-clock budget of 120 lease
minutes is also set on the experiment with `usage.set_budget` as a Merv-side backstop.

**Blocked today:** neither staging project has a Sandboxes connection
(`GET /sandboxes/connection` → `connected: false`; `sandbox_native_connections` is empty), and a
connection needs a signed-in human to consent at sandboxes.rapidreview.io with credentials =
`staging-compute`. Until the owner connects the hosted project once, the script tells the agent to
train in its own workspace, records the Modal step as BLOCKED and the run as PARTIAL.

## Cost estimate

Merv records tokens, not dollars. Model cost is estimated from `usage.read` totals at
`STG_USD_PER_MTOK_IN` (default 0.25, a blended rate for Codex's mostly cached input) and
`STG_USD_PER_MTOK_OUT` (default 10). Modal cost is what Sandboxes reports; machine costs are
upper bounds.
