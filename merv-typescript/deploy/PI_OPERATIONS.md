# Read-only Pi operations

Pi is an optional Fleet client. The Agent sidebar opens conversations, not tasks.
The production configuration keeps workflow dispatch disabled and uses the
authenticated, model-restricted relay with the models in `MERV_PI_MODELS`.
Provider credentials stay on the main server; workers receive only bounded
per-command relay authority.

Since 2026-09-24 18:17 UTC Pi is enabled for all existing human-accessible
projects and the service pilot. Owner-authorized enablement does not certify
unfinished security or full UI acceptance; see `docs/PI_IMPLEMENTATION_STATUS.md`.

**Machines.** One operator-owned Pi host project rents every Pi machine with
its reader key (`MERV_PI_HOST_KEY`), a capacity-only exception the founder
approved on 2026-09-24 (`docs/PI_AGENT_PROPOSAL.md`). Each person gets one
machine per project. All of their conversations in that project share it,
running up to its slots at once (Standard 3, Large 4), and it stops 10 minutes
(`MERV_PI_IDLE_TIMEOUT_SECONDS`) after the last answer in any of them. The
person picks the machine or releases it (Release machine) on the Agent page. Every read the agent makes still runs as
the person, with their current permissions. A new project needs no Sandboxes
connection and no onboarding for Pi.

Writers and their agents may choose Large in any project. Fleet's $20 per UTC day
per-person compute cap bounds Standard and Large together.

## Credentials and access

- Browser callers use normal authenticated human project membership. The old
  acceptance actor credential is not the browser credential or a production
  identity fallback. Enabling Pi does not make a project without an active human
  membership accessible.
- The Pi host key is a reader actor credential in the host project, with no
  expiry and no member behind it. It only rents machines there; it never reads
  a person's project. To rotate it, adopt the host project
  (`cli.js adopt-project`), issue a new reader credential, swap
  `MERV_PI_HOST_KEY`, recreate Main, then revoke the old credential.
- Fleet checks the host project's live link and payer before renting through its server-only
  runtime capability.
- Human project onboarding uses the normal verified-login/membership path. Do not
  fabricate a human JWT, mutate membership tables directly, or convert a canary
  service actor into the user's identity.

## Linking the Pi host

Use the Sandboxes project-link flow with Merv project-admin and Sandboxes account-admin authority.
Preserve existing links. Set `MERV_PI_HOST_PROJECT_ID` and its Merv reader credential through
`MERV_PI_HOST_KEY_ENV`; Fleet defaults its host project to the same ID. Configure the existing
runtime catalog in `MERV_FLEET_RUNTIMES`. Link and runtime availability are checked live by Fleet.

## Machines

- `MERV_FLEET_RUNTIMES` is the one catalog. Each entry is a Sandboxes runtime
  profile, and it is also the machine a person picks: `label` is what the
  picker shows, `slots` how many turns share the machine, and `agent` whether
  the agent may move itself there. The first entry is the default.
- Standard is always allowed. A person, and their agent, may use another machine
  with write permission in the project. Otherwise the picker shows the machine as
  unavailable, and the agent is not offered `switch_machine`. The agent moves
  only with `MERV_PI_AGENT_MOVES=true`. It starts the new machine and moves
  there only once the machine is proven ready.
- Sandboxes resource limits and provider controls name the plugin, `cloudflare`,
  never the app, so nothing in Sandboxes caps or disables Large alone:
  - The host namespace limit covers both machines.
  - Large's only ceiling of its own is its app's `max_instances` of 10.
  - A price cap below Large's price makes Large unrentable.
  - A `cloudflare` provider control stops Standard and Large together.
- **Turning Large off:** remove the `large` entry from `MERV_FLEET_RUNTIMES`
  and recreate Main. To leave Main running instead, set `"enabled": false` on
  the `cloudflare-fleet-large` provider and recreate Sandboxes. Its offer then
  disappears, and moves to Large fail while people stay on Standard. Hosted
  releases, and so production `release.mjs` runs without `--skip-hosted`, then
  refuse until it is enabled again, since they cannot read the Large app that
  Main still names.
- Fleet caps the host at its `MERV_FLEET_PROJECT_LIMITS` entry and at
  `MERV_FLEET_GLOBAL_LIMIT`. Pi holds one machine per person per project, or
  two while it moves, and starts a move only while at least 3 slots are free.

## Models

- `MERV_PI_MODELS` is the catalog: a JSON array of 1 to 8 entries, the first
  the default, each with `id`, `label` and `effort`. `id` is the provider's
  model id; `label` (at most 24 characters) is all the picker shows; the
  retired `inputUsdPerM`/`outputUsdPerM` prices are dropped by the render if an
  env file still carries them; `effort` (`none` or `low`) is the reasoning effort the relay
  sets on every call, whatever the worker asks. Unset, the catalog is GPT-6.1 Sol at low effort, followed by GPT-6 Luna. `MERV_PI_MODEL` is ignored. The render makes the
  checks Main makes as it starts, so dry-run it on the edited env before you
  recreate Main; it refuses a bad catalog with `Invalid MERV_PI_MODELS entry`
  (or `must hold 1-8 models`, `repeats a model id`):
  ```
  cd "$(sudo docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' merv-typescript-control-1)"
  sudo MERV_TS_IMAGE="$(sudo docker inspect -f '{{.Config.Image}}' merv-typescript-control-1)" docker compose -f compose.yml run --rm --no-deps -T --entrypoint node control /app/deploy/render-config.mjs /tmp/render.json
  ```
  Production:
  ```
  MERV_PI_MODELS=[{"id":"gpt-6.1-sol","label":"GPT-6.1 Sol","effort":"low"},{"id":"gpt-6-luna","label":"GPT-6 Luna","effort":"none"},{"id":"gpt-6-sol","label":"GPT-6 Sol","effort":"none"},{"id":"gpt-6-astra","label":"GPT-6 Astra","effort":"low"}]
  ```
- GPT-6.1 Sol requires `low` or higher reasoning; `none` is unsupported. Its API pricing is $2 input / $10 output per million tokens below the long-context threshold. The bundled worker keeps the existing Sol 272K working-context budget.
- **Reasoning models only** (every GPT-5 and GPT-6 model): the worker asks for
  reasoning on any model, so a model without it fails every call. Astra runs at
  `low`: pi-ai lists no `none` effort for it. No reasoning summary is ever requested;
  encrypted reasoning is requested only where effort is not `none`, and only
  that model gets it back.
- **Per conversation.** Each conversation stores its model from creation: the
  person's last pick in that project (a `pi_people` row keyed
  `model:<userId>:<projectId>`, never the machine record), else the first entry.
  A turn's model is fixed when a worker claims it. The turn's notes tell the
  agent that model, and that earlier answers may be other models'. Told only
  its name, Luna named the model of the answer before a switch in 17 of 27
  tries; with this note, in 1 of 42, and in 0 of 40 once the note came first
  after the full instructions and 90 tools. A conversation whose model leaves the
  catalog answers on the first entry. Only the person switches: the agent has
  no model tool, and conversation, worker and managed callers are refused.
  Callers holding the person's own key (MCP, `mk_`) may switch, as they may
  send and pick the machine; a send that names a model the conversation no
  longer has creates nothing (409 `pi_model_changed`).
- **Idle limits.** A call at effort `none` ends after 20 s without upstream
  bytes; any other after 120 s (`reasoningIdleTimeoutMs`), under Main's 300 s
  turn stall limit. Measured 2026-09-25 through the relay on 141k-token
  histories, the longest silence was 1.9 s on Luna, 2.8 s on Sol and 4.5 s on
  Astra (with a tool call and its reasoning replayed).
- **Cost.** A turn can make 72 calls on each machine it runs on (the relay's
  `maxRequestsPerGrant`), each up to 272k tokens in and 128k out: at most about
  $7 on Luna, $131 on Sol and $657 on Astra. A turn starts again on a fresh
  machine only before it has shown a word or called a tool, so that adds at
  most the one call it had begun. Nothing caps it. Each
  finished call writes one `pi_relay_usage` record to Main's stderr with the
  model and its input, cached, output and reasoning tokens, and nothing about
  the person. A call refused before it was sent, or answered with an error
  status, writes one with zero tokens and `refund: true`, which returns its
  charge. Spend by model for the last day:
  ```
  sudo docker logs --since 24h merv-typescript-control-1 2>&1 | grep '"pi_relay_usage"' |
    jq -rs 'map(select(.refund | not)) | group_by(.model)[] | [.[0].model, length, (map(.inputTokens)|add), (map(.outputTokens)|add)] | @tsv'
  ```
  Look again when Astra passes about $50 a day.
- **Adding a model.** Probe it first on the control host with the provider key
  (never printed): a streamed Responses call with `store:false` at the effort
  you mean to set returns 200; at `low`, including
  `reasoning.encrypted_content`, it returns an encrypted reasoning item; on a
  ~140k-token input with one required function tool, the longest gap between
  SSE frames stays under 60 s (else raise `reasoningIdleTimeoutMs`, under
  300 s), and replaying that input with the reasoning item, the call and its
  output returns 200. Then add the entry and recreate Main. A model pi-ai does
  not know gets the worker's 32k-token fallback window until the hosted image
  upgrades pi-ai.
- **Rollback.** An older Main ignores `MERV_PI_MODELS` and runs every
  conversation on `gpt-6-luna`; the stored models are kept for a roll forward.

## One CPU host per work item

Every Fleet workflow machine is a work host: it serves all the steps of one work item, each in a
fresh session, and is stopped when the item settles (after five idle minutes), when its release
acknowledgement is overdue, or at its deadline. There is no switch and no approval list:
`MERV_FLEET_WORKFLOW_REUSE_WORK_HOSTS` and `MERV_FLEET_WORKFLOW_REUSABLE_RUNTIME_PROFILE_IDS` are
ignored if set, and may be removed from the env file.

The list used to protect against renting retained machines on an image nobody had proved could
run several sessions in sequence safely. That proof is now automatic: the hosted release's
workflow gate (`linux-workflow-gate.py`, run against the exact candidate on every boundary
release, before any push or switch) enrolls the image's supervisor with a work-host bootstrap
and lets it run one step of the work item through to its release (its runner, Code driver,
retained workspace and Codex launch, with only the launcher's attestation, which the isolation
gate proves, set aside), runs two Codex steps in one retained working directory with fresh credentials, and between them
resets through the supervisor's own launcher (`assignment-probed.py --reset`), checking that a
detached assignment process is killed, private home and temp state is gone, and the step's files
are kept. A worker-lane release changes only the Pi worker bundle, so its image keeps the gated
supervisor and reset. An image that cannot be a work host fails the gate and is never switched in.

An image older than work hosts (before 2026-10-02) refuses the work-host bootstrap; Fleet then
stops renting for the revision after two unclaimed machines, so never pin such an image by hand.
Rolling Main back past this change needs the old approval list naming the current profile, or its
machines will not enroll on images built after this change. Releasing this change stops any
one-machine-per-step machine still running; release in a quiet window.

## Restarts and limits

- Changing `hostedCodexPlatform` (including its model or effort) requires Main and
  the hosted image to agree. Wait for workflow sessions and allocations to finish,
  back up the private env, and set `MERV_FLEET_WORKFLOW_ENABLED=false` for the
  release. Re-enable it only after the matching hosted image passes its canary;
  then verify a real workflow worker. Do not resume dispatch with mismatched
  Main/image profiles after a failed release. Explicit Pi model selections persist;
  adding a new default does not rewrite existing conversations or preferences.
- Main's shutdown stops every Pi allocation and interrupts, with
  `service_unavailable`, every live Pi turn that has shown a word or called a
  tool. A turn that has not waits, and starts on a fresh machine once Main is
  back; so does one whose machine is lost, once. A machine Fleet rented for a
  workflow step keeps running through the restart (its lease is at most 900 s,
  renewed by Fleet), and the restarted Main takes it back. A Cloudflare rollout
  of the hosted image replaces every running container of the app, so a work
  visit on it would die; the hosted release drains work machines first (below).
  `MERV_FLEET_WORKFLOW_ENABLED=false` with Fleet on stops them.
  Schedule the change for a quiet window all the same.
- `render-config.mjs` runs on every start, and the restart policy is
  `unless-stopped`, so a bad env value crash-loops Main. The rollback in
  `release.mjs` restores only the image, not the env. Keep a backup of the env
  and dry-run the render before any recreate.
- A changed release in a `MERV_FLEET_RUNTIMES` entry changes that machine's
  profile, and every allocation on it is then asked to stop. Roll it out
  drained. The hosted runtime is digest-pinned; `hosted-release.mjs` (run by
  `release.mjs`) builds it from committed sources and moves it together,
  drained, gated and canaried, with automatic rollback: its drain ends the idle
  clock of every idle Pi machine at each poll, so Main releases it instead of
  the rollout killing it (the next turn starts on the person's own pick), and
  waits until no Pi machine is up for 10 s. A turn sent after that, before the
  rollout begins, can still start on the old image and lose its machine to it.
  The drain also holds work machines (a `fleet_holds` row in Main): Fleet rents
  none, admits no new step on one, and stops each whose step has settled, and the
  drain waits until Fleet has released every one. A step still running at
  `--drain-minutes` stops the release with nothing deployed and the hold lifted;
  rerun later, or with a longer `--drain-minutes` (a step runs for up to two
  hours, and no new step starts while the drain waits). A passed canary, or the
  run's finish, lifts the hold (it outlasts the switch, so a failed canary's
  rollback never waits on a step admitted meanwhile); one left behind lapses an
  hour after the drain's last look. A rollback drains work machines the same way before it
  redeploys, and staging Main's are drained before the staging apps move.
  The image on every
  Cloudflare app that serves one of Main's machines (Standard, and Large once
  `MERV_FLEET_RUNTIMES` names it), the release and its Large copy in the
  catalog, and each machine's release id (Standard's also in
  `MERV_FLEET_RUNTIME_RELEASE_ID`). It refuses while any of them differs from
  what it recorded, and `release.mjs` checks the same before releasing Main.
- Once production passed its canary, the same run brings staging along: the
  release's copy for `cloudflare-fleet-staging` and `-large` in production's
  Sandboxes catalog (only for those Sandboxes serves), the image and Worker on
  `merv-fleet-staging` and `merv-fleet-staging-large`, then staging Main
  (`--staging-host`) names those releases. A staging failure never rolls
  production back; the ledger row says `STAGING NOT UPDATED` and why, and
  staging launches are refused until a later run (or a hand switch) agrees.
- An open hosted run blocks every Main release, emergencies included. When it
  can neither finish nor roll back, `node deploy/hosted-release.mjs --abandon`
  closes it once production agrees on one of its releases: every live Cloudflare
  app runs that image with no rollout, Main and the env file name its release
  ids, and both Sandboxes services' catalog holds them. Otherwise it refuses and
  names what disagrees; the run stays open. On the run's own release it first
  runs a canary; if that fails, it exits 4 and marks the live pins unverified,
  and every later run canaries them again until one passes.
- Before you raise a Fleet limit, confirm that Sandboxes `infra_resource_limits`
  (`max_concurrent` for the account, member and namespaces) allows the new
  concurrency. Also confirm that each Cloudflare app's `max_instances` allows
  it. Otherwise the extra creates are refused, and those turns fail.
- The Fleet wallet cap is policy `fleet-canary-monthly`: USD 5,000 per UTC month,
  all users (founder, 2026-09-25).

## Releases, receipts and evidence

A `release.mjs` row marked `pass` covers health, UI, authentication and origin
checks. It does not test Agent, so run a bounded Pi turn separately. The plugins
column records what the running container reported, and which of Fleet, Fleet
workflow and Pi it composed. Env-only changes produce no row: enabling Pi and changing limits. For each
one, add a dated receipt section at the top of `RELEASES.md`. List what changed,
the env and catalog SHA-256 before and after, and the
plugin count the container reports afterwards. Never record a secret.

For a Main-only authentication release, run the existing protected canary even
when `hosted-release.mjs` finds no worker-image change. This reads the root-only
canary key inside the VM, tests one real Pi turn on the currently pinned Standard
release, stops the canary machine, and checks the other hosted apps. The helper
limits the turn to 420 seconds and machine-release polling to 180 seconds. It
prints only the receipt, never the key. Run after Main's release smoke passes:

```sh
ssh -o BatchMode=yes ResearchSuite_Control 'sudo timeout 12m python3 -' <<'PY'
import json, runpy
from pathlib import Path

base = Path('/opt/merv-typescript/hosted')
runs = sorted(p for p in base.iterdir()
              if (p / 'preflight.json').is_file()
              and (p / 'finish.json').is_file()
              and json.loads((p / 'finish.json').read_text()).get('result') == 'pass')
if not runs:
    raise SystemExit('No passing hosted release is available for the canary')
run = runs[-1]
plan = json.loads((run / 'plan.json').read_text())
state = json.loads(Path('/var/lib/merv-fleet-pilot/hosted-release/state.json').read_text())
step = runpy.run_path(str(run / 'source/deploy/hosted-release-vm.py'),
                      run_name='merv_live_canary')['Step'](run, plan)
print(json.dumps(step.canary({'releaseId': state['current']['releases']['cloudflare-fleet']})))
PY
```

Identity now records each Pi worker and model credential's hash, purpose,
expiry, and revocation. Pi still checks its live Fleet slot, turn, and person's
delegated authority on each use. A queued Fleet allocation gets its running
deadline when provisioning begins; Pi can renew its worker credential only
while that slot remains current, and its fixed outer deadline is 48 hours from
allocation creation (the two 24-hour maximum phases). A model credential ends
with its turn. No bearer can renew itself.

The previous Main image may not enforce a revocation or expiry first recorded
only in Identity. Before rolling back an authentication release, stop new agent
work and check that image against the credentials and schema in use, including
revoked and expired keys. If it cannot enforce the current authority, keep Main
in maintenance and release a corrected image forward. Preserve the new image,
database, credential ledger, and active-session evidence; do not restore an old
database snapshot or restart an older image as an automatic response to a later
authentication failure.

For the first central-authentication cutover, publish the reviewed commit at
`origin/main` and run `node deploy/release.mjs --no-rollback`. If the new image
fails its health wait, this option stops Main without restarting the old image;
recover with a corrected forward release. After Main is healthy, run the Pi
canary above and, from `merv-typescript`, run:

```sh
ssh -o BatchMode=yes ResearchSuite_Control 'sudo timeout 12m docker exec -i -e MERV_IDENTITY_CANARY=1 -w /app merv-typescript-control-1 node --input-type=module -' < deploy/identity-auth-canary.mjs
```

The reviewed script creates one isolated project and,
through `POST /tools`, creates one agent actor with `actor.create`, rotates its
credential with `actor.rotate_token` and withdraws it with `actor.revoke`. It
verifies the wrong-project (403), old-after-rotation (401), rotated (200) and
retired (401) answers of `actor.whoami`, and revokes every synthetic credential in
Scope and Identity. It prints one JSON line with `result: pass`, the agent's
`actorId` and the applied `identity-credentials@1` migration hash for the
published-migration receipt. The synthetic project and revoked actors remain as
audit history; they have no usable credentials or running machine.

Publish the reviewed main-server source before building an immutable release.
Reconcile concurrent changes; do not deploy an old checkout. Do not change
published migration SQL or remove production migration-ledger rows for rollback.
Complete Merv-controlled capture and secret scanning remain the security
boundary. Scan all available provider logs with source/time/pagination checks,
and keep recording the provider-internal visibility limitation. Previously accepted
evidence is not proof of a new run's complete logs. Do not relabel ordinary
release regression checks as a fresh full security acceptance. Keep diagnostic
SSH disabled and temporary administrator keys absent after maintenance.

## Clearing a wedged allocation

Use this only when the code cannot release an allocation itself. The 2026-09-24
18:28Z example was an `uncertain` row with no runtime, `createAttempted` set, and
the only global slot held.

- Find it with the query below. Use `->>`, because `->` never matches a JSON
  `null`.
- A `provisioning` row may still have its create in flight; it is not a wedge.
- Closing Fleet leaves a row with no runtime as it is. The next Fleet's first
  pass recovers any machine by the same create key, then stops it, or launches
  it when a workflow step still wants it. Such a row is a wedge only if it
  outlives that pass.
- Unless the failure provably happened before any network call, first confirm
  that Sandboxes holds no sandbox for the allocation, with the second query in
  the Sandboxes database.
- Use one transaction that first takes
  `pg_advisory_xact_lock(hashtextextended('merv-state:<schema>', 0))`. In it, set
  both the `phase` column and `data_json` to `phase: released`, `intent: stop`,
  `retryAt: null`, `error: null` and `failures: 0`. Never delete the row: the
  Pi host slot that names it could then never be reconciled. Never update only
  the column: Fleet reads each allocation from `data_json`, so the slot would
  stay held. Every Pi allocation is in the host project.

```sql
SELECT id, project_id FROM <schema>.fleet_allocations
WHERE phase IN ('uncertain', 'releasing') AND data_json::json->>'runtime' IS NULL
  AND data_json::json->>'createAttempted' = 'true';
-- Sandboxes: the create key is a hash of the project and '<id>:create'.
SELECT id, state FROM sandboxes WHERE idempotency_key = 'runtime:' ||
  encode(sha256(convert_to('["<project_id>","<id>:create"]', 'UTF8')), 'hex');
```
