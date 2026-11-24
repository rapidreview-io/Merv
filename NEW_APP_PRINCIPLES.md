# The new research app: principles and how to build it

24 November 2026, revision 2 · for the owner · design only, no code or production changes.
Sources: the whiteboard photo, Mega Merv plan v2, the Lor comparison, the terms-of-service review of 18 Nov, the port manifest, and both codebases at `origin/main` (Merv `c7a0eee7a`, merv-desktop `b3cddd99`).

**The short version.** Almost everything on the whiteboard already exists, split across two codebases. merv-desktop has the desktop app, the local agents on a person's own subscription, multi-agent jobs and manager wakes. Merv has tasks, experiments, the spend-capped auto-runner, GPUs and storage. The new app is the Mac app from merv-desktop talking to Merv as its one backend. The real work is the join: a "desk" plugin in Merv, one auto-runner instead of two, an update rule that nobody has built yet, and one assistant conversation that either side can continue.

**Owner decisions folded into this revision (24 Nov).**

1. A user's own agents run only on that user's machine. We give those users our GPU and storage.
2. Our cloud execution suite stays, and runs only **our Pi agents** on our keys. It never runs a user's agent or a subscription login.
3. There is one persistent assistant conversation. On the desktop the user's own agent continues it; when the desktop is away our Pi agent continues the same conversation (section 5).
4. **No extra chrome.** The interface is minimalist and content-first (section 1).

**UI sketches** for all eight screens are on the board "Lore and Merv desktop", in the frame "New app · UI sketches" (`9LwQxfG9XFtINNFjo9-B`).

---

## 1. The principles, restated

**Reading of the photo.** I read the board the same way you did: four numbered items, with three sub-points under 1 and two under 3. Two small notes:

- Item 1's second sub-point reads "Tasks build in" on the board; "built in" is clearly meant.
- Item 3's first sub-point is written "Suggests the next job/experiment". The verb is **suggests**, not "runs". That one word matters for the design and for the terms-of-service risk (section 7).

| # | Whiteboard | What it means for a researcher | What it rules out | Met when |
|---|---|---|---|---|
| 1 | **Desktop app** | One Mac app is the place I work. I do not keep a browser tab, a terminal and a tracker open side by side. | A web-first product with a desktop wrapper. Features that only work in the browser. | A new person downloads one app and never needs a second window to finish a first experiment. |
| 1a | Clean interface | I see my question, what is running and what needs me. Agent steps and logs are one click away, never in my face. See "no extra chrome" below. | Dashboards of records. Today's Merv left rail with a dozen pages. Toolbars and panels for their own sake. | First screen has at most three things to press. A stranger can say what each does. |
| 1b | Tasks built in | The list of what to do next lives in the app. Agents and I both add to it; starting a task is one press. | Using Linear or a notes file beside the app. A task list that agents cannot read. | Every job started traces back to a task in the app; every suggestion lands as a task. |
| 1c | Interactable, multi-agent jobs | A job can use several agents (a writer and reviewers, or two approaches in a race). While it runs I can open any agent, read it, message it, stop it. | Fire-and-forget batch runs. Hidden sub-agents I cannot talk to. | During a 3-agent job I message one agent and stop another, and the job carries on correctly. |
| 2 | **Bring your own sub** | The thinking runs on the Claude or ChatGPT plan I already pay for, on my Mac, signed in by me. When my Mac is away, Merv's own agent can keep the conversation going. | My subscription being used anywhere but my own machine. Tokens or logins leaving the Mac. Cloud workers on my login. | No credential ever reaches our servers. Every cloud turn runs on Merv's Pi agent and Merv's keys, and is metered. |
| 3 | **Auto-runner** | When a job ends, something reads the result and lines up the next sensible job. | Me babysitting. Also: an agent that spends my plan or my GPU allowance without a limit I set. | After a job ends with no one at the keyboard, a next-step card with a cost is waiting. |
| 3a | Suggests the next job or experiment | I get a concrete proposal: what to run, why, and what it costs. I approve, or I let it run on its own inside a cap. | Vague "what next?" prompts. Suggestions with invented numbers. | Over a week, most of what I run started as a suggestion I accepted. |
| 3b | Updates us when enough things happen | I am not pinged per step. I get one digest when the picture has changed: a result landed, the plan forked, the cap is near, or it needs me. | A notification per tool call. Also silence for six hours. | An overnight run of 8 jobs produces 1–3 updates, and each one is worth reading. |
| 4 | **GPU + storage** | The app comes with somewhere to run and somewhere to keep things. No cloud account, no card to start. | "Connect your AWS". Results that live only on a laptop. | From a fresh install, a GPU job runs and its outputs are still there next week, with no card entered. |

### Design principle: no extra chrome

The owner's rule for every screen: **the content is the interface.** For example, the job view for 120 agents is one dot per agent, gathered into groups, on an empty page. Clicking a group opens it like a lens. Clicking an agent shows its trail and a place to write. There is no toolbar, no sidebar of rows, no dashboard.

- **Content first.** The conversation, the result, the curve and the swarm fill the page. Whitespace is generous.
- **Controls appear when needed.** A question brings its own buttons. A selection on the board brings "run this". Stop is one small red word next to the thing it stops.
- **Detail is one click away,** never on the first surface: steps, logs, receipts, settings.
- **Scale by grouping and zoom, not by panels.** 100 agents read as one picture; power is reached by zooming in.
- **Rules out:** permanent sidebars full of rows, badges and borders for their own sake, status dashboards, a page per record type.
- **Met when:** every screen passes a simple test. Cover the content and almost nothing is left.

---

## 2. The product in one page

**Who it is for.** An ML researcher or research engineer, working alone or in a small lab, who already pays for Claude Code or Codex and does not have a GPU cluster. They want to ask a research question and get reviewed, reproducible results, without building the plumbing.

**The core loop.**

1. **Ask.** "Does dropout help small transformers?" Typed, or said aloud on the board.
2. **Plan.** Their own agent drafts a plan card: three experiments, uses up to $3 of the $10 allowance. They press Approve.
3. **Run.** Their agent writes the code on their Mac, on their subscription. The GPU sweep runs on our cloud. Results are stored on our storage. A second local agent reviews. If they close the laptop, our Pi agent carries the same conversation on.
4. **Suggest.** When a run ends the auto-runner wakes, reads the result and puts a next-step card in Tasks: "Baseline reproduced. Try dropout 0.1 and 0.3, about $2."
5. **Update.** One message when it matters: "2 of 3 experiments done, dropout helps below 10M parameters. One question for you."

**One sentence.** Your agent is the brain at your desk, our cloud is the muscle and the stand-in brain when you are away, and it is always one conversation.

**How it differs.**

| | Lor | Today's Merv | The new app |
|---|---|---|---|
| Where you work | Desktop and web chat | A web app with many pages | One Mac app: board, tasks, agents |
| Who pays for thinking | Lor's models (free beta, price unknown) | Merv's API keys | **The person's own subscription** |
| Agents | About 100 cloud sub-agents from one chat (demo) | Workflow items; no sub-agent spawning | A few local agents on your Mac; wide fan-out as our Pi agents and GPU jobs in the cloud, shown as one calm swarm |
| Laptop closed | Cloud agents carry on | Cloud agents carry on | **The same conversation carries on**, with Pi standing in |
| Research discipline | Ad-hoc chat, git hygiene | Reviewed experiments, provenance, enforced caps | **Keeps Merv's**: review, provenance, caps |
| What happens next | You ask again | Autoresearch, off by default, admin page | **Auto-runner on by default in "suggest" mode** |
| GPU | 8×H100 from chat, live cost | T4 smoke test verified only | Same engine as Merv, with a free allowance and a meter |

We can match Lor on cloud agent count only with new work (section 7). We beat it today on cost to the user (free thinking at the desk), on trust (reviewed, reproducible, capped), on not needing to be watched, and on calm.

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
| Cloud execution suite (our Pi agents) | M | `packages/pi`, `packages/fleet`, `packages/sessions` | Stays, per the owner. Runs only Pi on Merv's keys: the stand-in assistant and cloud fan-out. Never a user's agent or login. |
| **Persistent assistant store and handoff** | **New** | see section 5 | One conversation that the Mac's agent or Pi can continue. |
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
| unmodified claude / codex CLI,           |        | cloud execution suite:                   |
| the person's own login                   |        |   our Pi agents, our keys only           |
|        -> Anthropic / OpenAI             |        | assistant thread (canonical, section 5)  |
+------------------------------------------+        +------------------------------------------+
  thinking: paid by the person                        running and keeping: paid from the allowance
```

**Lane 1: local agents on the person's subscription.**

- The desk starts sessions through the two runtimes. Tokens never leave the Mac; this is true today.
- The manager thread and its workers are ordinary local sessions. Research tools (create a task, start an experiment, rent a GPU, save an artifact) are lent to them through the Mac's pairing, never through a key the agent holds.
- Laptop closed: this lane pauses. Work that needs the Mac waits for it; the conversation itself moves to Pi (section 5).
- A user's agent never runs anywhere else. This is a hard rule, not a default.

**Lane 2: cloud GPU and storage.**

- A local agent calls a sandboxes tool. The backend checks the allowance, rents a Modal GPU, runs the job and captures outputs as artifacts.
- The job keeps running with the laptop closed. Its ending is recorded on the backend and delivered to the Mac's wake queue when the Mac is next online.
- Stop from the app must stop the machine (new work; today a halt leaves the remote job running).

**Lane 3: our Pi agents in the cloud.**

- Pi runs on Merv's keys, inside the existing Fleet and Sessions machinery. It is the assistant's stand-in when the Mac is away, and the worker for cloud fan-out.
- Pi has Merv's research and compute tools. It has no way to start or steer a session on the user's Mac.
- Its model tokens are our cost, so every Pi turn is metered against the person's allowance or plan.

**The auto-runner.** One loop, in four steps:

1. **Wake.** A local job ends (existing `manager-wakes.ts`) or a cloud run ends (existing autoresearch wake consumer, relayed through the desk link). Wakes are batched for 30 seconds.
2. **Think.** The assistant reads the results: the local manager thread on the person's subscription when the Mac holds the conversation, Pi when the cloud does.
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

## 5. Persistent assistant: one conversation, two engines (MVP)

**Example.** At your desk you tell the assistant "use seed 3 for everything", and your own Claude Code answers. You close the laptop. On the train you ask from your phone, "did the sweep finish?" Our Pi agent answers in the same conversation, already knowing about seed 3. Back at your desk, you ask "so what next?" and your Claude Code already knows what Pi said.

**The one idea.** The conversation lives on the backend as a plain, engine-neutral log. Claude Code, Codex and Pi each keep their own private transcript, but those are caches. Whoever holds the lease reads the log, answers, and appends to it.

**There is a precedent in the code.** merv-desktop already moves a project's manager between Claude Code and Codex without losing the thread: `project-threads.ts` (`reserveSwitch`, a durable exclusive reservation), `main-segments.ts` (one identity, many native sessions, a cursor of what each has seen) and `docs/manager-provider-switch.md`. The MVP treats Pi as a third engine that happens to live in the cloud.

### 5.1 The canonical store

| What | Where it lives | Notes |
|---|---|---|
| **The thread's identity** | Merv Sessions: one `session_threads` row per person and project, continuity key `assistant` | Reuses the table that already means "one continuing agent conversation". The assistant is also the auto-runner's brain, so in the cloud this should be the thread autoresearch's manager holds today. |
| **Entries** (the log) | **New** table `assistant_entries`, append-only, numbered per thread | Kinds: `said` (the person), `answer` (the assistant), `step` (one-line tool-call summary), `decision` (a question and the answer chosen), `attachment` (an artifact id), `handoff` (from, to, why). Each carries the engine, the device, the lease number and a local id so a retry is not written twice. |
| **Attachments and results** | Existing `packages/artifacts` and `packages/blobs` | Entries point at artifact ids. Nothing is copied into the log. |
| **The context pack** | An artifact per version; the thread points at the newest | A rolling briefing: the goal, decisions taken, open questions, the plan, the last 20 turns word for word, pointers to artifacts, and a "only on the Mac" list. Target size about 8,000 tokens. |
| **Engine transcripts** | Claude Code and Codex files on the Mac; Pi's checkpoint (`packages/pi/src/checkpoint.ts`); Sessions' `session_transcripts` in R2 | **Never the source of truth.** Any of them can be thrown away and rebuilt from the pack plus the entries after it. |

How the pack is made without spending tokens: it is assembled by code, not by a model. The verbatim tail comes from the log (the way `handoff-context.ts` `transcriptTail` already reads 20 turns). The summary part is the manager's own running note, which the local manager already keeps (`project_note` in its brief) and Pi already produces when it compacts (`packages/pi/src/worker.ts`). Running work is never stored in the pack; it is read live from tasks, experiments and sandboxes.

### 5.2 Handoff, both directions

**Desktop → cloud (the Mac goes away).**

1. While the Mac holds the conversation, it mirrors each finished turn to the backend as entries. This uses the outbox pattern the Mac already has for its stream (`desk-server/src/stream.ts`: written with a cursor, kept until the server confirms).
2. The Mac renews a lease every 20 seconds. On sleep or quit it releases the lease cleanly; if it just vanishes, the lease runs out after 90 seconds.
3. **Takeover is lazy.** Pi does nothing merely because the Mac left. Pi takes the lease only when there is something to answer: the person writes from the phone or web, or (later) a cloud job ends and the auto-runner is on.
4. Pi starts from the newest pack plus the entries after it, answers, and appends. A `handoff` entry is written in the same transaction as the lease change. That entry is the "continued in cloud" marker.
5. Pi cannot touch the Mac. When something needs the Mac ("edit `train.py`"), Pi writes it down as a task marked "needs your Mac".

**Cloud → desktop (the Mac returns).**

1. The Mac reconnects and asks for entries after its cursor. It shows them in the chat at once.
2. If Pi is idle, the Mac takes the lease straight away and the badge flips to "Your Mac". If Pi is mid-answer, Pi finishes that answer (or the person presses "bring it back now", which interrupts Pi), then releases.
3. **No model call happens because of the handoff itself.** The missed cloud turns are injected into the local agent together with the person's next message:
    - **Resume the same native session** where it exists, and prefix only what it missed. For Claude Code that is a quoted context block in the user turn (already done for side questions in `handoff-context.ts`). For Codex it is the existing one-shot prefix (`fork.context` in `runtime-codex/src/index.ts`), and later the protocol's `thread/inject_items`, which appends real history.
    - **Start a new session** seeded with the pack and the tail when the native session is gone: a reinstall, a second Mac, or a session too old to resume.
4. The cursor moves only after the local agent has completed a prompt that included those turns. This is how `managerSeen` in `main-segments.ts` already works, so a crash in between re-sends rather than loses.

### 5.3 Single writer: leases and conflicts

- **One lease per thread,** held on the backend: holder (engine and device), a number that only goes up, and an expiry.
- **Every append carries the lease number.** The backend refuses an append with an old number. So an engine that lost the lease cannot write, even if it does not know yet.
- **Only the holder answers.** A message from any surface (Mac, phone, web, voice) is routed to the holder. If the holder is the Mac, the phone's message goes down the existing command relay to the Mac.

| Case | What happens | What the person sees |
|---|---|---|
| Mac sleeps mid-answer | The unfinished local answer is not mirrored. Pi starts from the last complete entry. On return the local half-turn is marked interrupted. | "Interrupted when your Mac slept." |
| Person writes on the phone while the Mac is awake | Routed to the Mac; no handoff. | Badge stays "Your Mac". |
| Mac returns while Pi is answering | Pi finishes or is interrupted; then the lease moves. | "Merv cloud is finishing…" with "bring it back now". |
| Network flaps | Lazy takeover, plus a minimum hold of 60 seconds once Pi has the lease. | At most one marker, not a flicker. |
| Mac cannot reach Merv but can reach its model | It finishes the current turn. New turns wait once its lease has run out. | "Reconnecting to Merv…", the message is kept and sent on return. |
| Two Macs | One holds the lease. The other shows the conversation read-only with "take over here". | "Active on your other Mac." |

**What the person always sees:** a small dot and two words saying who is speaking ("Your Mac" or "Merv cloud"), one thin red line where the cloud took over ("continued in cloud"), and one grey line where the Mac took it back.

### 5.4 Context fidelity: what is lost, and what covers it

| Lost when engines change | Why | What covers it |
|---|---|---|
| The other engine's reasoning and raw tool output | Tied to its provider; cannot be replayed | `step` summaries and the pack. Pi is told plainly what it cannot see. |
| Local files that were never pushed, worktrees, the local environment | They exist only on the Mac | The Mac pushes its work branch to the project's Merv git at the end of a turn, so Pi can read committed code. The pack lists what is "only on the Mac" by name. |
| Local worker sessions and local jobs | They pause with the Mac | Their last state is in the log as outcomes. Pi can say "that is waiting for your Mac", never guess. |
| Pi's tool state | Pi's checkpoint stays in the cloud | Pi's turns arrive on the Mac as plain turns plus step summaries. Results are artifacts either side can open. |
| Native extras: rewind, prompt cache, Claude's or Codex's own memory | Per engine | Accepted loss. Resuming the same native session keeps most of it on the Mac. |

The honest limit: Pi is a well-briefed stand-in, not a clone. It is strong on "where are we, what finished, what next, start this GPU job" and weak on "continue the edit you were halfway through".

### 5.5 Privacy and consent

- **What goes to the cloud, with consent:** the words of the assistant conversation itself (the person's and the assistant's), one-line step summaries, decisions, and artifact ids. Without the words, Pi could not continue the conversation.
- **What never goes:** worker and reviewer transcripts, file contents, terminal output, secrets, and the persona. They stay on the Mac. Summaries pass through the redaction both sides already share (`shared/protocol/src/redact.ts`), and merv-desktop's rule holds: nothing leaves the Mac until the person has said yes.
- **The consent, asked once at first run:** "Keep this conversation going when your Mac is off? Merv will store this conversation's messages and short summaries of what your agents did. Your files and your agents' full transcripts stay on your Mac."
- **If they say no:** the assistant is desktop-only and nothing is mirrored. Cloud GPU jobs still work.
- **Control:** deleting the conversation deletes its entries and packs. Entries show which engine wrote them, so it is always clear what Merv's own agent said.

### 5.6 The minimal version to build first

Scope of the MVP: one project, one Mac, text only. Handoff to the cloud is triggered only by the person writing from the phone or web. The auto-runner waking Pi comes after.

| Piece | Where | Reuse or new |
|---|---|---|
| Thread identity and lease | Merv `packages/sessions` (`threads.ts`, `index.postgres.ts`) | Reuse `session_threads` for identity. **New:** lease holder, number and expiry for a holder that is a Mac, with compare-and-swap. Pi's own turns already hold ordinary Sessions leases. |
| Entry log and pack | Merv, **new** small plugin `packages/assistant` | **New:** `assistant_entries` table, append and read-after-cursor routes, the pack builder. Packs are stored with `packages/artifacts`. |
| Pi continues the thread | Merv `packages/pi` (`profiles.ts`, `prompt.ts`, `service.ts`, `worker.ts`) | Reuse the Pi worker and its one-active-turn guard (`pi_one_active_turn`). **New:** an `assistant` profile whose prompt is the pack plus later entries, and which appends entries at turn end. No `desk.write` tools. |
| Mirror from the Mac | merv-desktop `desk-server/src/stream.ts` pattern; calls through `cloud.ts` (the Mac's pairing over HTTPS) | Reuse the outbox and the pairing. **New:** `assistant-sync.ts`: mirror main-thread turns, renew the lease, pull missed entries. This avoids needing the full desk-plugin port first. |
| The local thread | merv-desktop `desk-server/src/project-threads.ts`, `main-segments.ts` | Reuse the project main thread, segments and the `managerSeen` cursor. **New:** cloud turns stored as local events, and the "what did I miss" prefix. |
| Building the tail and the prefix | merv-desktop `desk-server/src/handoff-context.ts` | Reuse `transcriptTail` and the quoted context block. |
| Injecting into the engines | merv-desktop `runtime-claude/src/index.ts`, `runtime-codex/src/index.ts` | Reuse resume and the one-shot prefix. Later: Codex `thread/inject_items`. |
| What the person sees | `desk-ui/src/one-thread-view.tsx`, `chat-head.tsx`; Merv copy in `packages/ui/web/panel/` and `board-app/thread.tsx` | Reuse the thread view. **New:** the engine dot and the two marker lines. |

**Test plan.**

1. **Lease and fencing (unit).** An append with an old lease number is refused. The same local id twice writes once. Two takers at once: exactly one wins.
2. **Pack builder (unit).** Same log, same pack. Always under the size budget. Never contains a step's raw output.
3. **Round trip with fake engines (Merv integration,** in the style of `tests/autoresearch.test.ts`**).** Mac holds; lease expires; a phone message makes Pi answer with a `handoff` entry; the Mac returns, reads after its cursor, takes the lease, appends.
4. **Round trip with real engines (desktop end to end,** on the existing `npm run e2e` harness**).** Tell the local agent fact A. Stop the desk. Ask on the web "what did I just tell you?": Pi says A. Tell Pi fact B. Start the desk. Ask locally about B: the local agent says B. Run for Claude Code and for Codex.
5. **Conflicts.** Each row of the table in 5.3, asserting there are never two answers to one message.
6. **Privacy.** Plant a fake secret in a tool output and in a file. Assert neither appears in any stored entry or pack.
7. **Fidelity.** Twenty scripted conversations with a handoff in the middle; score whether decisions made before it are honoured after it. Aim for nine in ten before showing it to anyone.

**Effort,** as a rough guide for one engineer working with agents: backend log, lease and pack about 4 days; Pi profile about 3 days; Mac sync and injection about 5 days; interface about 2 days; tests about 3 days. **About three and a half weeks,** or about two with two people. The riskiest part is the Mac's injection path, because it touches both runtimes.

---

## 6. Layout system

**Example.** The app opens as one pane: the conversation. A big job starts, and a quiet line offers "split the job in?". You accept, and the swarm opens beside the chat. Later a curve lands and offers to be pinned under it. You press ⌘K, type "save", and call the arrangement "Watching a big job". Tomorrow one keystroke brings it back. Zen mode returns you to one pane.

The idea is borrowed from VS Code's composite layouts, held to the no-chrome rule: **one pane by default, and layout power only through the palette, shortcuts and drag.**

| Element | What it is | Reused or new |
|---|---|---|
| **Surfaces** | Chat, board, job swarm, experiment card, results, machines. Each is a self-contained view that can sit in any pane. | Reused views: `desk-ui` thread and job page, the board (`packages/ui/web/views/board*`), `item-card.tsx`. **New:** a common "surface" wrapper so any of them can be placed anywhere. |
| **Panes and splits** | Two or three panes side by side or stacked, with a draggable divider. | Reused: `desk-ui/src/panes.ts` (`paneRects`, `paneShare`: a two-pane split, across or stacked, clamped) and `panel-grip.tsx`; the Mac app already splits board and panel (`apps/desktop/src/panel-size.ts`, `board-view.ts`). **New:** a third pane and nested splits. |
| **Tabs** | More than one surface in a pane, shown as plain words only when there are two or more. | Reused: `apps/desktop/src/tabs.ts` (browser tabs). **New:** tabs for surfaces. |
| **The board on demand** | The board is one surface. It opens as a split, a tab or full screen, and closes away to nothing. | Reused: the whole board. **Change:** it stops being the permanent left half of the window. |
| **Command palette** | ⌘K: open a surface, split, move, zen, switch or save a layout. | Reused: `desk-ui/src/palette.ts` and `palette-view.tsx` (already finds sessions, messages, actions and jobs). **New:** layout commands. |
| **Saved layouts** | Named arrangements such as "Thinking" (board and chat), "Watching a big job" (chat, swarm, curve), "Writing up" (paper and results). | **New.** A small JSON description per layout, stored with the person's settings so it follows them between devices. Three ship as defaults. |
| **Context offers** | When a job launches: "split the job in?". When a curve lands: "pin it?". One quiet line in the conversation; never a forced change. | Reused: the question-with-buttons card (`question-card.tsx`). **New:** the rules that raise an offer, and "always do this". |
| **Zen mode** | One keystroke back to a single pane. | **New,** and small. |

Rules that keep it calm:

- The default is always one pane. Nobody has to learn the layout system to use the app.
- No visible layout controls: no tab bar for a single surface, no dock buttons, no activity bar. Dividers appear on hover.
- Layout changes are offered, never imposed, unless the person chose "always".
- On a phone there is one pane and no layout system at all.

---

## 7. Key risks and decisions for the owner

### Risks

| Risk | Why it matters | Handling |
|---|---|---|
| **Terms of service for subscription logins** | Decisions 1 and 2 remove the worst case: our cloud never touches a user's login, and a user's agent never runs off their machine. What remains is narrower. The 18 Nov review's concern about *other people* using their subscriptions *inside an app we distribute* was about who offers the product, not where it runs: Codex's app-server sign-in "has never been permitted for commercial or hosted services", and Anthropic asks for approval before a product offers Claude.ai login through the Agent SDK. | Lower than before, not zero. Still ask both vendors in writing (decision 1). Private beta and API-key mode meanwhile. The handoff design keeps us clean: the cloud never starts a local turn, and no handoff spends the user's plan. |
| **Unattended use of a consumer plan** | The auto-runner and multi-agent jobs run several local sessions on one plan. The review advises caps, showing rounds first, and no wide fan-out on a subscription login. | Local fan-out stays small and bounded. Wide fan-out is Pi's job in the cloud. Auto mode is an explicit grant. |
| **Pi's model cost is now ours** | With Pi standing in for the assistant and doing cloud fan-out, model tokens are a real cost per user. Pi's default cap is $200 of model spend a person a day, which is far too high for a free tier. | Meter every Pi turn against the allowance in dollars. Lazy takeover means an idle away-period costs nothing. Set a small daily Pi budget for free accounts. See decision 8. |
| **Cost of the GPU and storage allowance** | At $10 a person a month, 1,000 active free users is up to $10,000 a month. Rough list prices, not re-checked today: a T4 is about $0.60 an hour, an H100 about $4. So $10 is about 16 T4-hours or 2.5 H100-hours. Storage is small by comparison: about $0.015 per GB a month on R2, so 10 GB a person is $0.15. | A prepaid free pool as the hard ceiling (when it is empty, free jobs stop and nobody is billed). Small GPU classes, one cloud job at a time and a maximum job length on the free tier. Grant the allowance on first agent connection, not on sign-up. A per-person storage cap with expiry of old run outputs. |
| **Idle and orphaned machines** | Stop does not kill remote jobs today. With an allowance, a forgotten machine is real money. | Build remote stop in phase 1. Release idle machines automatically. |
| **Multi-agent at scale** | Two different limits. On the Mac: about four agents at once, sharing one plan's rate limit. In the cloud: Pi agents can fan out, but today Fleet defaults to 5 hosted agents a project and 50 in all, agents cannot spawn sub-agents, and nothing has been run at 50 or more. The 120-agent job on the board is a target, not a current ability. | Keep local jobs small. Build cloud fan-out in steps: raise the limits and prove 50 agents on staging, then add spawning. Every Pi agent is metered. |
| **Two codebases drifting** | Merv's panel is already a copy of desk-ui. `hosted/` and Merv have diverged since 5 Nov. Each week makes the join larger. | Decision 2. Freeze backend features in `hosted/` now. |
| **GPU path is unproven** | Merv's only verified GPU run is a T4 smoke test. No training run in production. Staging has lacked Sandboxes since mid-October. | Phase 1's demo must be a real training run, end to end, before anything else is built on it. |
| **Local-only state** | Jobs, threads and the wake queue live in SQLite on one Mac. A second Mac or a reinstall loses the thread of the work. | Solved for the main conversation by section 5. Outcomes, tasks and the auto-runner ledger live on the backend. |
| **Handoff quality** | If Pi answers worse than the local agent, or the local agent ignores what Pi said, the "one conversation" promise breaks visibly. | The fidelity test in 5.6 is a release gate. Pi says what it cannot see instead of guessing. |
| **Layout system creep** | Splits, tabs and docking are where clutter comes from. | One pane by default; no visible layout controls; ship two panes and the palette first. |

### Decisions

1. **How do local agents sign in for people who are not you?** Options: (a) ask Anthropic and OpenAI in writing now and wait; (b) open-source the desktop app, which the review says puts it in OpenAI's allowed category; (c) API keys for everyone but the founder. *Recommended: (a) this week, private beta meanwhile, (c) as the fallback that always works.* Your decisions 1 and 2 make the question much easier to ask: "the user's own agent, on the user's own machine, started by the user; our cloud uses only our own keys".
2. **Which repository is home?** *Recommended: Merv.* It has the production backend, the research engine and the release process. Bring `desktop/` and `shared/protocol/` in as top-level folders, port `hosted/packages/desk` as `@merv/desk`, then archive merv-desktop. The alternative, keeping two repositories with merv-desktop as a thin app, keeps the duplicated panel and the protocol split.
3. **Auto-runner default.** *Recommended: on, in suggest mode.* Auto mode is opt-in per project with rounds and dollars set by the person.
4. **The allowance.** The dollar figure, the size of the prepaid pool, and whether storage is counted in the same number. *Recommended: one number in dollars, $10 as a placeholder, storage capped separately and free.*
5. **Who reviews on the free tier?** *Recommended: a second local session on the person's own plan*, said plainly on the plan card. Pi reviewers in the cloud count against the allowance.
6. **Mac only at launch?** The app is Mac only. The plugin route (`merv@merv`) works on any computer but is not "a desktop app". *Recommended: Mac only; plugin as the escape hatch.*
7. **Voice and board at launch.** They are built and delightful, but voice runs on Merv's OpenAI key, which is a per-user cost on a free tier. *Recommended: board yes, as a surface that opens on demand (section 6); voice behind the paid tier or a small monthly cap.*
8. **Does the allowance pay for Pi's thinking too?** *Recommended: yes, one number in dollars covers GPU, storage and Pi turns,* with a small daily Pi budget on free accounts. The alternative, free unlimited stand-in turns, has no ceiling.
9. **Consent wording for the mirrored conversation** (section 5.5). *Recommended: ask once at first run, default on, with a plain off switch.*
10. **The 214 uncommitted files in the local merv-desktop folder.** They must be committed or discarded before any move. Yours to decide; I did not touch them.

---

## 8. Phased build plan

### Phase 1, about 2 weeks: the loop works for you, on your Mac

Goal: prove the whole loop once, for one person, with the least new code.

- Point the existing Mac app at Merv for research and compute: lend Merv's task, experiment, sandboxes and artifact tools to the manager thread through the pairing (the `cloud.ts` pattern). Keep runmerv.com for the board for now.
- Feed cloud run endings into the local wake queue.
- Suggestion card: the manager's proposal as a todo with a cost and a Run button. Suggest mode only.
- Update rule, version 1: the five triggers in section 4, delivered as one message in the app.
- Remote stop: stopping a job releases its machine.
- Allowance meter in the app, reading existing credits.
- Persistent assistant, first half: the entry log, the lease, and the Mac mirroring its main conversation (section 5.6). No Pi yet.
- Interface: one pane, the conversation, with the board opening as a split (existing two-pane code).
- Send the two vendor questions (decision 1).

**Demo.** On your Mac, signed in to your own Claude: you ask a question and approve a plan. A real training run executes on a Modal GPU. You close the lid. When you open it, there is one update, a curve on the result card and a suggested next experiment with a price. You press Run.

### Phase 2, about 6 weeks: one backend, strangers can use it

Goal: one codebase, and a free tier that is safe to hand out.

- Port `desk` into Merv as `@merv/desk`; move `desktop/` and `shared/protocol/` into the home repository; one `desk-ui` source for app and web; retire `hosted/`; migrate runmerv.com accounts and boards.
- Persistent assistant, second half: Pi continues the conversation from the phone or web, and the Mac catches up on return. Then the auto-runner may wake Pi while the Mac is away.
- Layout system: three panes, tabs, palette commands, three saved layouts, context offers, zen mode.
- Cloud fan-out, step one: raise the Fleet limits and prove 50 Pi agents on one job; the swarm view.
- Auto mode: the bounded grant, with every start admitted by autoresearch's cap.
- Tasks column backed by Merv tasks; todos as the inbox.
- Tier presets (free, pay as you go), allowance granted on first agent connection, prepaid pool, free-tier GPU classes and job-length limit, storage cap.
- First run: download → sign in → the checklist that ticks itself → a first question. Sign-in mode per the vendors' answers, with API-key mode as fallback.
- Updates reach the phone and voice.
- A clean first screen: question, tasks, what is running, what needs you.

**Demo.** A stranger with a Mac and a Claude plan downloads the app, enters no card, and overnight gets three reviewed experiments run by the auto-runner inside a $5 grant, with two updates on their phone. From the phone they ask a follow-up; Pi answers in the same conversation; next morning their own agent picks it up without being told.

### Later

- Subscription billing and larger allowances.
- Pi agents that spawn sub-agents; 100 and more on one job; multi-node GPU jobs; larger GPUs.
- Voice on the persistent assistant; a second Mac; Codex `thread/inject_items`.
- Paper drafting from accepted results; literature search.
- Windows and Linux; teams and shared projects.
- A hands-on Lor comparison once beta access exists.

---

## Not verified in this pass

- GPU and storage prices are from memory, not re-checked today.
- The terms-of-service quotes are from the 18 Nov review, not re-read on the vendors' pages. This is not legal advice.
- Autoresearch and Trackio cards are in production but have had no feature-level check there (per the Lor comparison).
- Section 5 is a design. Nothing in it has been built or tested; the effort figures are estimates.
- Whether `session_threads` can hold the assistant thread without a schema change was not tested: today its rows are tied to a workflow stage.
- I read code structure and file headers, not every file. Line-level claims come from plan v2 and the Lor comparison, which cite them.
