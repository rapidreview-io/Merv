# The new research app: principles and how to build it

24 November 2026 · for the owner · design only, no code or production changes.
Sources: the whiteboard photo, Mega Merv plan v2, the Lor comparison, the terms-of-service review of 18 Nov, the port manifest, and both codebases at `origin/main` (Merv `c7a0eee7a`, merv-desktop `b3cddd99`).

**The short version.** Almost everything on the whiteboard already exists, split across two codebases. merv-desktop has the desktop app, the local agents on a person's own subscription, multi-agent jobs and manager wakes. Merv has tasks, experiments, the spend-capped auto-runner, GPUs and storage. The new app is the Mac app from merv-desktop talking to Merv as its one backend. The real work is the join: a "desk" plugin in Merv, one auto-runner instead of two, and an update rule that nobody has built yet.

---

## 1. The principles, restated

**Reading of the photo.** I read the board the same way you did: four numbered items, with three sub-points under 1 and two under 3. Two small notes:

- Item 1's second sub-point reads "Tasks build in" on the board; "built in" is clearly meant.
- Item 3's first sub-point is written "Suggests the next job/experiment". The verb is **suggests**, not "runs". That one word matters for the design and for the terms-of-service risk (section 5).

| # | Whiteboard | What it means for a researcher | What it rules out | Met when |
|---|---|---|---|---|
| 1 | **Desktop app** | One Mac app is the place I work. I do not keep a browser tab, a terminal and a tracker open side by side. | A web-first product with a desktop wrapper. Features that only work in the browser. | A new person downloads one app and never needs a second window to finish a first experiment. |
| 1a | Clean interface | I see my question, what is running and what needs me. Agent steps and logs are one click away, never in my face. | Dashboards of records. Today's Merv left rail with a dozen pages. | First screen has at most three things to press. A stranger can say what each does. |
| 1b | Tasks built in | The list of what to do next lives in the app. Agents and I both add to it; starting a task is one press. | Using Linear or a notes file beside the app. A task list that agents cannot read. | Every job started traces back to a task in the app; every suggestion lands as a task. |
| 1c | Interactable, multi-agent jobs | A job can use several agents (a writer and reviewers, or two approaches in a race). While it runs I can open any agent, read it, message it, stop it. | Fire-and-forget batch runs. Hidden sub-agents I cannot talk to. | During a 3-agent job I message one agent and stop another, and the job carries on correctly. |
| 2 | **Bring your own sub** | The thinking runs on the Claude or ChatGPT plan I already pay for, on my Mac, signed in by me. I pay you nothing for model tokens. | Merv's keys paying for a free user's thinking. Tokens or logins leaving the Mac. Cloud workers on my login. | A free user's month costs us $0 in model tokens after onboarding. No credential ever reaches our servers. |
| 3 | **Auto-runner** | When a job ends, something reads the result and lines up the next sensible job. | Me babysitting. Also: an agent that spends my plan or my GPU allowance without a limit I set. | After a job ends with no one at the keyboard, a next-step card with a cost is waiting. |
| 3a | Suggests the next job or experiment | I get a concrete proposal: what to run, why, and what it costs. I approve, or I let it run on its own inside a cap. | Vague "what next?" prompts. Suggestions with invented numbers. | Over a week, most of what I run started as a suggestion I accepted. |
| 3b | Updates us when enough things happen | I am not pinged per step. I get one digest when the picture has changed: a result landed, the plan forked, the cap is near, or it needs me. | A notification per tool call. Also silence for six hours. | An overnight run of 8 jobs produces 1–3 updates, and each one is worth reading. |
| 4 | **GPU + storage** | The app comes with somewhere to run and somewhere to keep things. No cloud account, no card to start. | "Connect your AWS". Results that live only on a laptop. | From a fresh install, a GPU job runs and its outputs are still there next week, with no card entered. |

---

## 2. The product in one page

**Who it is for.** An ML researcher or research engineer, working alone or in a small lab, who already pays for Claude Code or Codex and does not have a GPU cluster. They want to ask a research question and get reviewed, reproducible results, without building the plumbing.

**The core loop.**

1. **Ask.** "Does dropout help small transformers?" Typed, or said aloud on the board.
2. **Plan.** Their own agent drafts a plan card: three experiments, uses up to $3 of the $10 allowance. They press Approve.
3. **Run.** Their agent writes the code on their Mac, on their subscription. The GPU sweep runs on our cloud. Results are stored on our storage. A second local agent reviews.
4. **Suggest.** When a run ends the auto-runner wakes, reads the result and puts a next-step card in Tasks: "Baseline reproduced. Try dropout 0.1 and 0.3, about $2."
5. **Update.** One message when it matters: "2 of 3 experiments done, dropout helps below 10M parameters. One question for you."

**One sentence.** Your agent is the brain, our cloud is the muscle, and the auto-runner keeps the two moving while you are away.

**How it differs.**

| | Lor | Today's Merv | The new app |
|---|---|---|---|
| Where you work | Desktop and web chat | A web app with many pages | One Mac app: board, tasks, agents |
| Who pays for thinking | Lor's models (free beta, price unknown) | Merv's API keys | **The person's own subscription** |
| Agents | About 100 cloud sub-agents from one chat (demo) | Workflow items; no sub-agent spawning | A few local agents per job that you can talk to; fan-out happens in GPU jobs, not agents |
| Research discipline | Ad-hoc chat, git hygiene | Reviewed experiments, provenance, enforced caps | **Keeps Merv's**: review, provenance, caps |
| What happens next | You ask again | Autoresearch, off by default, admin page | **Auto-runner on by default in "suggest" mode** |
| GPU | 8×H100 from chat, live cost | T4 smoke test verified only | Same engine as Merv, with a free allowance and a meter |

We do not try to beat Lor on agent count. We beat it on cost to the user (free thinking), on trust (reviewed, reproducible, capped) and on not needing to be watched.

---

## 3. Reuse map

**Legend.** **D** = merv-desktop (`origin/main`). **M** = Merv (`merv-typescript/`). **New** = must be built.

### What each side already has

| Needed component | Take from | Paths | Why |
|---|---|---|---|
| Mac app shell, signing, release channels | D | `desktop/apps/desktop/` | Only one exists. Electron, signed, has an installer and nightly/stable channels. |
| Local agent runtimes (Claude, Codex) | D | `desktop/packages/runtime-claude`, `runtime-codex` | Runs the person's unmodified CLI under their own login; never reads tokens. |
| The desk: threads, approvals, commands, worktrees | D | `desktop/packages/desk-server/src/` (`desk.ts`, `requests.ts`, `command-gate.ts`, `worktrees.ts`, `store.ts`) | The single local authority over agents. SQLite. Already paired to a cloud through one outbound link (`uplink.ts`). |
| Multi-agent jobs | D | `desk-server/src/jobs.ts` (review-loop: writer plus fresh reviewers in rounds), `reviewer.ts`, `job-page.ts`; units and races in `command-gate.ts`, `docs/units.md` | This is "interactable multi-agent jobs" today: open, message, continue, stop any member. |
| Project manager thread | D | `desk-server/src/project-threads.ts` (tools `agent_start`, `agent_review`, `agent_message`, `job_start`, `job_direction`) | One main thread per project that coordinates workers, on the person's subscription. |
| Panel UI: chat, step trail, button questions, plan card, job marks | D, already in M | Origin `desktop/packages/desk-ui/src/`; ported copy `packages/ui/web/panel/` | Same parts in both. See conflict 4. |
| Board, voice, welcome cards | D, already in M | `packages/ui/web/board-app/`, `packages/ui/web/views/board*`, `packages/board` | Ported and in production since 24 Nov. |
| Persona and looks | D | `desk-server/src/persona.ts`, `taste.ts`; `shared/protocol/src/persona.ts`, `looks.ts` | Makes the interface feel personal. Optional for phase 1. |
| Tasks and experiments with review | M | `packages/tasks`, `packages/experiments`, `packages/reviews`, `packages/workflows` | Merv's verified strength: plan → design review → run → results review. |
| Spend-capped auto-runner (policy) | M | `packages/autoresearch/src/` (`index.ts`, `policy.ts`, `spend.ts`, `brief.ts`), `docs/AUTORESEARCH.md` | Admits each start against a dollar cap inside the start transaction; wake limit 20; pause and ask. |
| GPU jobs | M | `packages/sandboxes/src/` (`sandbox-runs.ts`, `compute-waits.ts`), `vendor/merv-sandboxes`, `packages/sessions/src/compute-waits.ts` | Modal GPUs from a tool call; `session.await_compute` waits up to 7 days. |
| Storage | M | `packages/artifacts`, `packages/blobs/src/s3.ts` (R2), `packages/mounts` | Immutable, hash-checked artifacts up to 512 MiB. Verified in production. |
| Free allowance, top-ups, caps | M | `packages/sandboxes/src/people.ts` (`newPersonCredits`, `{ monthly }`), `credits.ts`, `packages/fleet/src/schema.ts` | Monthly credit that expires, card top-ups, per-person daily limits all exist. |
| Curves on cards | M | `packages/metrics/src/proxy.ts`, `packages/ui/web/item-card.tsx` | Trackio curves, in production (env-gated). |
| Paper | M | `packages/paper` | Keep, but later. Not on the whiteboard. |
| Outside agents reach Merv | M | `clients/claude-code`, `clients/codex` (plugin `merv@merv`), MCP in `packages/api` | The lowest-risk way for a person's own agent to use research tools. |
| Cloud agents (paid tier only) | M | `packages/fleet`, `packages/pi`, `packages/runner` | For laptop-closed work on Merv's keys. Not for the free tier. |
| **Desk plugin in Merv** | **New (port)** | from `hosted/packages/desk/src/` (`core.ts`, `commands.ts`, `stream.ts`, `handoff.ts`, `todos.ts`, `compute.ts`, `releases.ts`) and `shared/protocol/` | Merv has no `desk` package. Without it the Mac app cannot pair with Merv. This is the largest single piece of work. |
| **Research tools lent to local agents** | **New (small)** | pattern in `desk-server/src/cloud.ts` and `project-tools.ts` | The desk already lends board tools through the Mac's pairing. Lend Merv's task, experiment, sandboxes and artifact tools the same way. |
| **Update rule ("when enough things happen")** | **New** | inputs: `desk-server/src/stream.ts`, `manager-wakes.ts`; `packages/feed`; autoresearch lines | Neither side decides *when an update is worth sending*. See section 4. |
| **Suggestion card** | **New (small)** | UI from `panel/plan-card.tsx`, `panel/handoff.tsx`; record from `task.create` | A proposed task with a reason and a cost, with Run and Dismiss. |
| **Tier presets and allowance meter** | **New** | on `people.ts`, `fleet/src/schema.ts`; UI from desk-ui `credits.tsx`, `compute.tsx` | No "free tier" concept exists; limits are set by hand per person. |
| **Remote stop** | **New** | `packages/sessions/src/stuck.ts:365` documents the gap; D has a per-machine stop in `hosted/packages/desk/src/compute.ts` | Stop must kill the GPU job, or the allowance leaks. |

### Where the two codebases overlap or conflict, and the pick

| # | Overlap | merv-desktop | Merv | Pick |
|---|---|---|---|---|
| 1 | **Backend** | `hosted/`: a trimmed fork of Merv with 18 packages, no research | `merv-typescript/`: the full platform, 40 packages | **Merv.** Port `desk` (and `browser` if wanted) in; retire `hosted/`. Same pick as plan v2. |
| 2 | **Manager loop** | Local main thread woken by `manager-wakes.ts`: 30-second batching, 20-wake limit, runs on the person's sub, no money cap | `autoresearch`: server workflow, dollar cap admitted in the start transaction, wake limit 20, runs on a Merv worker | **Both halves, one loop.** The brain is merv-desktop's local main thread (it is on the person's sub). The rules are Merv's: every start it proposes is admitted by autoresearch's cap. Cloud run endings are fed into the same local wake queue. |
| 3 | **Task list** | Todos: a light list of put-off ideas, held in the cloud, shown in the project column (`todos.tsx`) | Tasks: workflow records with review, leases, provenance | **Merv tasks are the record; the todos column is the face.** A todo is the inbox for ideas and suggestions; pressing Run turns it into a Merv task or experiment (a todo already carries a link to its job). |
| 4 | **Panel UI** | `desk-ui`, 117 files, the origin | `packages/ui/web/panel/`, a copied subset (about 50 files) | **One source.** Two copies will drift. Move `desk-ui` into the home repository as a package both the Mac app and the web build import. |
| 5 | **Jobs** | Local `jobs.ts` recipes (review-loop) | Workflows engine with pinned manifests | **Local jobs for local agents; Merv experiments for anything that spends allowance.** A local job reports its outcome to a Merv task. Do not rebuild one inside the other. |
| 6 | **Transcripts and stream** | Desk event log, mirrored up as a redacted stream | Session transcripts in Postgres and R2 | **Keep local transcripts local** (they are the person's own sessions); send up outcomes and the redacted stream only. |
| 7 | **Sign-in and credits** | Fork of Merv's identity; Stripe removed 16 Nov; $200-a-day default | Supabase sign-in, Stripe checkout present | **Merv's.** Existing runmerv.com accounts and boards need a one-off migration. |

---

## 4. Architecture

```
        THE PERSON'S MAC                                        ONE BACKEND (Merv)
+------------------------------------------+        +------------------------------------------+
| Merv.app (Electron)                      |        | desk plugin (new, ported)                |
|   board, tasks column, agents panel      |        |   pairing, command relay, stream, marks  |
|                                          |  one   |                                          |
| desk-server (SQLite)                     |  out-  | tasks, experiments, reviews (the record) |
|   manager thread = auto-runner brain     | bound  | autoresearch policy: cap, wake limit     |
|   jobs: writer + reviewers, races        |  link  | sandboxes  ->  Modal GPUs                |
|   wake queue (local + cloud endings)     | <----> | artifacts + blobs  ->  R2 storage        |
|   runtime-claude / runtime-codex         |        | credits: allowance, top-ups, tiers       |
|        |                                 |        | update rule (new) -> digest, phone, voice|
|        v                                 |        |                                          |
| unmodified claude / codex CLI,           |        | paid tier only:                          |
| the person's own login                   |        |   Fleet + Pi cloud agents                |
|        -> Anthropic / OpenAI             |        |                                          |
+------------------------------------------+        +------------------------------------------+
  thinking: paid by the person                        running and keeping: paid from the allowance
```

**Lane 1: local agents on the person's subscription.**

- The desk starts sessions through the two runtimes. Tokens never leave the Mac; this is true today.
- The manager thread and its workers are ordinary local sessions. Research tools (create a task, start an experiment, rent a GPU, save an artifact) are lent to them through the Mac's pairing, never through a key the agent holds.
- Laptop closed: this lane pauses and says "waiting for your computer".

**Lane 2: cloud GPU and storage.**

- A local agent calls a sandboxes tool. The backend checks the allowance, rents a Modal GPU, runs the job and captures outputs as artifacts.
- The job keeps running with the laptop closed. Its ending is recorded on the backend and delivered to the Mac's wake queue when the Mac is next online.
- Stop from the app must stop the machine (new work; today a halt leaves the remote job running).

**The auto-runner.** One loop, in four steps:

1. **Wake.** A local job ends (existing `manager-wakes.ts`) or a cloud run ends (existing autoresearch wake consumer, relayed through the desk link). Wakes are batched for 30 seconds.
2. **Think.** The manager thread reads the results, on the person's subscription.
3. **Propose.** It writes one or more suggestion cards: what, why, cost. Each is a todo linked to a draft task or experiment.
4. **Start.** Depends on the mode the person chose:
    - **Suggest (default):** nothing starts until the person presses Run.
    - **Auto, within a grant:** the person has approved "up to N rounds and $X". Each start is admitted against the cap by autoresearch's existing check. At the limit the loop pauses and asks.

**The update rule (new).** The backend keeps a per-project count of what changed since the person last looked. It sends one digest when any of these is true:

- something needs the person (always, at once);
- an experiment's reviewed result landed;
- the allowance or the cap crossed 80%;
- three or more jobs ended since the last update;
- the auto-runner stopped itself.

Otherwise it stays silent, with at most one update an hour and a daily summary if anything ran. The digest is written by the manager thread; the rule that decides *when* is plain code, so it is predictable and testable. These thresholds are my starting proposal, to be tuned.

**Control and data flow, for one experiment.**

| Step | Who acts | Where | What moves |
|---|---|---|---|
| 1. Ask | Person | Mac app | Words to the manager thread |
| 2. Plan card | Manager agent | Mac, person's sub | Draft experiment → backend (`experiment.create`), cost shown |
| 3. Approve | Person | Mac app | Approval; allowance reserved |
| 4. Write code | Worker agent | Mac, own worktree | Commits pushed to the project's Merv git |
| 5. Run | Backend | Modal GPU | Code in; metrics to Trackio; outputs to artifacts |
| 6. Review | Second local agent | Mac, person's sub | Verdict → backend |
| 7. Wake and suggest | Manager agent | Mac | Suggestion card → Tasks |
| 8. Update | Backend rule + manager's words | Phone, voice, app | One digest |

---

## 5. Key risks and decisions for the owner

### Risks

| Risk | Why it matters | Handling |
|---|---|---|
| **Terms of service for subscription logins** | "Bring your own sub" inside an app we distribute is exactly the case the 18 Nov review flagged. Codex on a ChatGPT login in a commercial app: **likely breaks** ("App-server authentication has never been permitted for commercial or hosted services"). Claude through the Agent SDK on a Claude.ai login: **grey, leaning towards breaking** without approval. Either vendor may enforce without notice. | See decision 1. Until answered: ship to a named private beta only, keep API-key mode working, and keep the auto-runner in suggest mode. |
| **The auto-runner makes that risk worse** | Unattended rounds on a consumer plan stretch "ordinary, individual usage". The review says: keep caps, show rounds before they start, never auto-extend, and do not add parallel fan-out on subscription logins. | "Suggests" is the safe reading of the whiteboard: the agent proposes, the person presses Run. Auto mode is an explicit, bounded grant. The cloud never starts a local session by itself. |
| **Cost of the GPU and storage allowance** | At $10 a person a month, 1,000 active free users is up to $10,000 a month. Rough list prices, not re-checked today: a T4 is about $0.60 an hour, an H100 about $4. So $10 is about 16 T4-hours or 2.5 H100-hours. Storage is small by comparison: about $0.015 per GB a month on R2, so 10 GB a person is $0.15. | A prepaid free pool as the hard ceiling (when it is empty, free jobs stop and nobody is billed). Small GPU classes, one cloud job at a time and a maximum job length on the free tier. Grant the allowance on first agent connection, not on sign-up. A per-person storage cap with expiry of old run outputs. |
| **Idle and orphaned machines** | Stop does not kill remote jobs today. With an allowance, a forgotten machine is real money. | Build remote stop in phase 1. Release idle machines automatically. |
| **Multi-agent at scale** | A Mac comfortably runs about four agents at once, and a consumer plan's rate limit is shared by all of them. A job with a writer and reviewers already multiplies plan usage. We will not match Lor's 100 agents on this lane. | Be honest in the product: a few agents you can talk to, plus wide GPU fan-out. Sell wide agent fan-out later as cloud agents on Merv's keys or the person's API key. Say on the plan card when a job will use several sessions. |
| **Two codebases drifting** | Merv's panel is already a copy of desk-ui. `hosted/` and Merv have diverged since 5 Nov. Each week makes the join larger. | Decision 2. Freeze backend features in `hosted/` now. |
| **GPU path is unproven** | Merv's only verified GPU run is a T4 smoke test. No training run in production. Staging has lacked Sandboxes since mid-October. | Phase 1's demo must be a real training run, end to end, before anything else is built on it. |
| **Local-only state** | Jobs, threads and the wake queue live in SQLite on one Mac. A second Mac or a reinstall loses the thread of the work. | Outcomes, tasks and the auto-runner ledger live on the backend. Local transcripts are treated as disposable. |

### Decisions

1. **How do local agents sign in for people who are not you?** Options: (a) ask Anthropic and OpenAI in writing now and wait; (b) open-source the desktop app, which the review says puts it in OpenAI's allowed category; (c) API keys for everyone but the founder. *Recommended: (a) this week, private beta meanwhile, (c) as the fallback that always works.* This decides whether principle 2 can ship publicly at all.
2. **Which repository is home?** *Recommended: Merv.* It has the production backend, the research engine and the release process. Bring `desktop/` and `shared/protocol/` in as top-level folders, port `hosted/packages/desk` as `@merv/desk`, then archive merv-desktop. The alternative, keeping two repositories with merv-desktop as a thin app, keeps the duplicated panel and the protocol split.
3. **Auto-runner default.** *Recommended: on, in suggest mode.* Auto mode is opt-in per project with rounds and dollars set by the person.
4. **The allowance.** The dollar figure, the size of the prepaid pool, and whether storage is counted in the same number. *Recommended: one number in dollars, $10 as a placeholder, storage capped separately and free.*
5. **Who reviews on the free tier?** *Recommended: a second local session on the person's own plan*, said plainly on the plan card. Cloud reviewers are paid.
6. **Mac only at launch?** The app is Mac only. The plugin route (`merv@merv`) works on any computer but is not "a desktop app". *Recommended: Mac only; plugin as the escape hatch.*
7. **Voice and board at launch.** They are built and delightful, but voice runs on Merv's OpenAI key, which is a per-user cost on a free tier. *Recommended: board yes, voice behind the paid tier or a small monthly cap.*
8. **The 214 uncommitted files in the local merv-desktop folder.** They must be committed or discarded before any move. Yours to decide; I did not touch them.

---

## 6. Phased build plan

### Phase 1, about 2 weeks: the loop works for you, on your Mac

Goal: prove the whole loop once, for one person, with the least new code.

- Point the existing Mac app at Merv for research and compute: lend Merv's task, experiment, sandboxes and artifact tools to the manager thread through the pairing (the `cloud.ts` pattern). Keep runmerv.com for the board for now.
- Feed cloud run endings into the local wake queue.
- Suggestion card: the manager's proposal as a todo with a cost and a Run button. Suggest mode only.
- Update rule, version 1: the five triggers in section 4, delivered as one message in the app.
- Remote stop: stopping a job releases its machine.
- Allowance meter in the app, reading existing credits.
- Send the two vendor questions (decision 1).

**Demo.** On your Mac, signed in to your own Claude: you ask a question and approve a plan. A real training run executes on a Modal GPU. You close the lid. When you open it, there is one update, a curve on the result card and a suggested next experiment with a price. You press Run.

### Phase 2, about 6 weeks: one backend, strangers can use it

Goal: one codebase, and a free tier that is safe to hand out.

- Port `desk` into Merv as `@merv/desk`; move `desktop/` and `shared/protocol/` into the home repository; one `desk-ui` source for app and web; retire `hosted/`; migrate runmerv.com accounts and boards.
- Auto mode: the bounded grant, with every start admitted by autoresearch's cap.
- Tasks column backed by Merv tasks; todos as the inbox.
- Tier presets (free, pay as you go), allowance granted on first agent connection, prepaid pool, free-tier GPU classes and job-length limit, storage cap.
- First run: download → sign in → the checklist that ticks itself → a first question. Sign-in mode per the vendors' answers, with API-key mode as fallback.
- Updates reach the phone and voice.
- A clean first screen: question, tasks, what is running, what needs you.

**Demo.** A stranger with a Mac and a Claude plan downloads the app, enters no card, and overnight gets three reviewed experiments run by the auto-runner inside a $5 grant, with two updates on their phone.

### Later

- Paid tier: cloud agents on Merv's keys for laptop-closed thinking and cloud reviewers; subscription billing.
- Wide agent fan-out on the cloud lane; multi-node GPU jobs; larger GPUs.
- Paper drafting from accepted results; literature search.
- Windows and Linux; teams and shared projects.
- A hands-on Lor comparison once beta access exists.

---

## Not verified in this pass

- GPU and storage prices are from memory, not re-checked today.
- The terms-of-service quotes are from the 18 Nov review, not re-read on the vendors' pages. This is not legal advice.
- Autoresearch and Trackio cards are in production but have had no feature-level check there (per the Lor comparison).
- I read code structure and file headers, not every file. Line-level claims come from plan v2 and the Lor comparison, which cite them.
