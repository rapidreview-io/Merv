# Sessions robustness: audit and plan (2026-09-17)

Read-only audit commissioned after the founder ruled "Sessions needs to be robust." Part 1 is the audit with file and line references; Part 2 is the prioritised plan. Nothing here changed code.

---

## Part 1 — Audit

# Sessions robustness audit (read-only, 2026-09-17)

Founder ruling under audit: "Sessions must be robust" (`merv-typescript/docs/UI_DESIGN.md:145`).

Scope read end to end: `packages/sessions/src/{index,dispatch,types,ui,api,observations}.ts`, `packages/runner/src/{index,client,types}.ts`, `packages/api/src/http.ts` (session routes), `packages/ui/src/index.ts`, `packages/ui/web/{api,liveness,components,mutations,list-filters,states,palette}.ts(x)`, `packages/ui/web/views/{sessions,agent-sessions-panel,map}.tsx`, `docs/{SESSION_LEASES,RUNNER_CONTROL_PLANE,UI_LEGACY_PATTERNS,UI_DESIGN}.md`, `deploy/RELEASES.md`, `tests/{sessions,sessions-api,session-dispatch-api,workflow-leases,workflow-dispatch,ui,ui-liveness}.test.ts`, and the legacy Python surfaces `research_state_ui/src/{pages/Sandboxes.jsx,components/SandboxTerminal.jsx,utils/fleet.js}`.

Nothing was edited. All paths are relative to `/Users/guraltoo/Documents/dev/proj/experiments/Merv/merv-typescript` unless stated.

---

## 0. The shape of the page today

`views/sessions.tsx:239-493` renders `ListPage` whose **rows are agents**, and puts everything else — dispatch state, runners, leases, the queue, every control — inside the `create` fold labelled `Operations` (`sessions.tsx:285-492`). `ListPage` opens that fold only when `create.opened` is set (`list-filters.tsx:247`), and `sessions.tsx` does not set it.

**So the default Sessions page shows a list of agent names and nothing else.** No lease, no runner, no dispatch state, no queue, no halt, and no live count is visible until the person finds and clicks a fold named after a category rather than a thing. The one page the founder called out as needing robustness hides its subject behind a click. Every finding below about the lease list is a finding about a panel most people will never open.

---

## 1. Every way the page can lie or go blank

### 1.1 A failed poll blanks the agent list while the lease panel stays (BLANK — real)

`list-filters.tsx:341-342`:

```tsx
{rows.length > 0 &&
  !load.error &&
```

`useTool` does the hard half correctly — on a failed refresh it keeps the last good data beside the error (`api.ts:341-347`) — and `LoadState` renders the intended one-line degradation (`components.tsx:392-398`). Then `ListPage` throws it away: with `load.error` set, the `<ul className="rows">` is suppressed entirely. The agent list vanishes and is replaced by "Could not refresh. Showing the state that loaded 4s ago." — a line that is now false, because nothing is being shown.

Worse, it is _inconsistent_: the `Operations` fold is rendered above that guard (`list-filters.tsx:317`) from the same stale `status` object, so after one flaky poll the page shows a full lease table, a runner table and live halt buttons **beside a message saying the data could not be refreshed and above an empty list**. Half the page degrades, half does not.

This is the exact defect `docs/UI_LEGACY_PATTERNS.md` § `stale-not-blank` said to fix in tasks/experiments/reviews. It was centralised into `ListPage` and the `!load.error` guard came with it.

**Honest?** No. It blanks data that is still correct, and it disagrees with itself.

### 1.2 A live lease reads "lapsed · lease ran out" purely because the tab slept (LIE — real, and guaranteed)

Three mechanisms compose:

- `useTool` stops scheduling while the tab is hidden and catches up once on return (`api.ts:324-333`).
- `useNow` keeps ticking on a plain `setInterval` (`components.tsx:167-175`); browsers throttle it but the value it produces is always a fresh `Date.now()`.
- `leaseLiveness` calls a lease `lapsed`/`bad` the moment `expiresAt` is in the past (`liveness.ts:89-91`), and `Countdown` clamps to `0s` (`components.tsx:186-188`, `liveness.ts:24`).

An active lease's `expiresAt` is extended server-side on every runner heartbeat, to `now + 4h` capped at the hard deadline (`sessions/src/index.ts:1138-1139`, `1223-1224`). The browser learns that only on the next poll. So on tab wake — and on any stall longer than the remaining window — the page states in red that a perfectly healthy, heartbeating lease has **run out**, with a clock saying how long ago. The runner is still working. The page says it is dead.

The same happens in the ordinary case with no tab sleep at all if a poll fails repeatedly (1.1 keeps the stale payload alive; the clock keeps running against it).

**Honest?** No. This is the single worst lie on the page: a red terminal verdict derived from a browser clock against a stale server fact.

### 1.3 Clock skew is silently absorbed into plausible numbers (LIE — latent)

Nothing in the payload carries a server timestamp. `SessionsProjectStatus` (`sessions/src/types.ts:336-347`) has no `now`/`serverTime`; `projectStatus` never sends one (`dispatch.ts:478-487`). Every duration on the page is `browserNow − serverStamp`:

- `Countdown` (`components.tsx:183-189`) — a browser 10 minutes slow shows every lease expiring 10 minutes later than it will; a browser 10 minutes fast shows every live lease as `0s` and `lapsed`.
- `runnerLiveness` (`liveness.ts:107-111`) — `live` itself is computed server-side against `freshForMs = 45_000` (`dispatch.ts:91,281`), so the **word** is right, but the clause beside it (`seen 12s ago`) is browser-derived. A skewed-fast browser produces `live · seen 0s ago` forever; `since()` returns a negative and `elapsed()` clamps with `Math.max(0, …)` (`liveness.ts:36`). The skew is _hidden_, not flagged.

**Honest?** No — and worse than dishonest, it is undetectable: every wrong number looks like a normal number.

### 1.4 A lease that expired server-side still reads `active` and still offers Halt (partly honest)

The sweep closes expired leases every `sweepIntervalMs` (default 1000ms, `index.ts:112`, `1413-1436`), so the window is short. Inside it, `status` is still `'active'` in the row while `expiresAt` has passed.

The liveness module handles this well — it says `lapsed · lease ran out`, tone `bad` (`liveness.ts:89-90`), which is honest behaviour-over-lifecycle reporting and is unit-tested (`tests/ui-liveness.test.ts:45-48`).

But three consumers of the same row disagree with it:

- `isLive()` (`sessions.tsx:90`) still returns true, so the row shows a `Countdown` (at `0s`) instead of the em dash a closed lease gets, and the **Halt lease** control is still offered (`sessions.tsx:430`).
- The panel's KV still reads `Lease expires` rather than `Lease ran to` (`sessions.tsx:135`).
- `liveSessionCount` still counts it (`dispatch.ts:473-476`), so the header line says "N live now" (`sessions.tsx:406`) and the rail badge (`sessions/src/ui.ts:18-20`) says the same.

So the row says "lapsed" and the page's own header says "live". One payload, two stories.

**Honest?** The liveness line is. The count, the countdown and the control are not.

### 1.5 A runner whose credential was revoked is indistinguishable from a runner that was switched off (LIE — real)

`presence()` (`dispatch.ts:268-285`):

```ts
let authorized = true;
try { await this.scope.requireDelegation(JSON.parse(row.source_json), 'read', tx); }
catch (error) { if (… 401 || 403) authorized = false; else throw error; }
…
live: authorized && Date.parse(row.last_seen_at) + freshForMs > this.clock(),
```

A revoked key and a dead machine both produce `live: false`. `runnerLiveness` renders both as `quiet · last seen 6m ago` (`liveness.ts:110-111`). But they need opposite responses: one is "go restart the box", the other is "your machine key was revoked, dispatch will never resume". Meanwhile `lastSeenAt` keeps advancing for a revoked-but-running runner (the heartbeat route itself does not require the check `presence()` makes — `heartbeatRunner` writes the row first, `dispatch.ts:308-314`), so a revoked runner can read `quiet · last seen 1s ago`, which is a contradiction on its face.

**Honest?** No.

### 1.6 The Runners table truncates at 100 with no total (BLANK — latent)

`dispatch.ts:420-426`: `ORDER BY last_seen_at DESC,id LIMIT 100`, and no accompanying count. The lease list gets an honest `N of M` line (`sessions.tsx:401-406`); the runner list gets nothing. Past 100 registered runners, machines silently stop existing on the page. A project can register up to 1000 (`dispatch.ts:316-324`).

### 1.7 The lease list truncates at 200 and the Halt-all guard counts the truncated list (LIE — real)

`dispatch.ts:437-438`: `LIMIT 200`, live first. `sessions.tsx:223-224` then derives `offered` and `live` **from the truncated array**, and:

- the guard title says `Halt ${count(live.length, …)} and dispatch?` (`sessions.tsx:322`);
- the guard body lists exactly those `live` leases by name (`sessions.tsx:329-336`), promising "Each lease closes now";
- the header beside it says `${liveCount} live now` from the untruncated server count (`sessions.tsx:406`, `dispatch.ts:473-476`).

With 240 live leases the page offers to "Halt 200 live leases", lists 200, and halts 240 — the server's `halt` with no `sessionId` selects every `offered|active` row in the project with no limit (`dispatch.ts:241-244`). A destructive guard that under-states its own blast radius is the one place this must not happen; `docs/UI_LEGACY_PATTERNS.md` § `sbx-confirm` exists specifically to make the guard name what is under the click.

### 1.8 "Available work" is the operator's queue, presented as the fleet's queue (LIE — real)

`projectStatus` computes `queue` from `this.candidates(caller, tx)` (`dispatch.ts:477`) → `workflows.dispatchCandidates(caller, tx)` (`dispatch.ts:412`), i.e. **source-authorised for whoever is looking** (`docs/RUNNER_CONTROL_PLANE.md:27-36`). The runner leases under a _different_ delegation source (its machine key).

The UI presents this number three ways:

- `sessions.tsx:226` — "`N` assignments to be leased" in the Agent's-move column of the dispatch section;
- `sessions.tsx:463` — `Available work · {status.queueTotal}` as a section heading;
- `sessions.tsx:470` — the empty state, which _is_ honest: "No eligible work is waiting for this identity."

So the page is candid only when the number is zero. When it is non-zero it reads as the fleet backlog, and an operator will conclude "there are 7 jobs and nothing is picking them up" when the runner's own key may see 0 (or 40). Nothing on the page distinguishes them.

### 1.9 Dispatch state changes under the person, with no guard against a stale toggle (LIE — real)

`sessions.tsx:310-315` sends `{ enabled: !status.dispatch.enabled }` computed from data up to 4s (or 15s when idle — `sessions.tsx:205`) old, over `PUT /sessions/dispatch` with no expected-value/If-Match (`http.ts:797-804`). `setDispatch` → `set()` returns the old state unchanged when it already matches (`dispatch.ts:192-194`) and appends no event.

Two operators, or one operator and a halt-all from elsewhere: the button can read **Start dispatch** while the server is already enabled, the click sends `{enabled:true}`, the server no-ops, the page reloads, and the button flips to **Halt dispatch** with no explanation. Nothing was broken, but the person's mental model was, and there is no record that their click did nothing.

`dispatch.updatedAt`/`updatedBy` _are_ in the payload (`types.ts:208-212`) and the UI shows only `set <Ago/>` (`sessions.tsx:296-299`) — never _who_, though `updatedBy` is right there. So "someone else paused dispatch two minutes ago" is on the wire and not on the screen.

### 1.10 A halt that fails, or whose answer never arrives, reads as a plain failure (LIE — real, and the one the docs named)

`sessions.tsx:181-196` is a hand-rolled mutation:

```ts
const mutate = async (path, body, method = 'POST') => {
  if (!state.data?.canManage || busy) return;
  …
  try { await accountRequest(path, { method, body, scoped: true }); if (current()) state.reload(); }
  catch (failure) { if (current()) setError(failure instanceof Error ? failure.message : 'The control request failed.'); }
```

`packages/ui/web/mutations.ts` exists and does exactly the right thing: it classifies a network failure (`status === 0`), a 5xx, or an unconfirmed 200 as **uncertain**, keeps the original command, and says so in words — "The original result is still unknown … Retry the same request to confirm whether it was saved." (`mutations.ts:52-75`). **`views/sessions.tsx` never imports it.** `accountRequest` throws `ApiError('offline', 'The Merv server did not answer', 0)` on a dropped connection (`api.ts:149-151`), and the page renders that string as an ordinary error, indistinguishable from a 403.

A halt whose response was lost has very likely committed — the transaction runs to completion server-side (`dispatch.ts:232-266`). The page tells the operator it failed. This is the precise failure `docs/UI_LEGACY_PATTERNS.md` § `sbx-confirm` required be routed through `mutations.ts`: _"a halt whose response never arrived says so instead of silently appearing to have worked."_ Not done.

### 1.11 A halt that succeeds and changes nothing reports nothing at all

Both routes return `{ halted: n }` (`http.ts:805-809`, `852-860`; `dispatch.ts:265`). The UI discards the body entirely (`sessions.tsx:188`). So:

- Halting a lease the sweep already closed one tick earlier returns `{halted: 0}` with HTTP 200 (`dispatch.ts:250` skips non-live rows). The guard closes, the page reloads, the lease shows `expired`, and the operator believes they stopped it. They did not; the clock did.
- Halt-all on a project where every live lease was just closed returns `{halted: 0}` and still disables dispatch (`dispatch.ts:234`) — a real, unreported side effect.

### 1.12 Halt can half-succeed across the transaction boundary (REAL, and the guard text is wrong about it)

The guard promises: _"Each assignment returns to the queue at its current revision."_ (`sessions.tsx:340-342`, and per-lease at `449-453`). That is not what `halt` does. `halt` closes the session inside its transaction (`dispatch.ts:251` → `hooks.close` → `index.ts:457-492`) and appends a `session.closed` **durable event** (`index.ts:474-489`). Returning the assignment to the queue happens later, in the consumer (`index.ts:252-259` → `workflows.releaseLease`), driven by a `setTimeout` in domain-events (`packages/domain-events/src/index.ts:131-138`) with `.catch(() => {})` on the timer path.

So between the halt and a successful drain, the lease reads closed and the work does **not** reappear in Available work. If the consumer keeps failing (a domain plugin unloaded, a storage error), that state is indefinite. The page shows a closed lease, an empty queue, and no way to learn that a release is stuck. `offer()` drains before acquiring (`index.ts:141-150`) so a later offer papers over it — but only if an offer is attempted, which requires dispatch, which halt-all just disabled.

`docs/SESSION_LEASES.md` is explicit that "Cleanup can wait while that plugin is unavailable." The page does not know that sentence exists.

### 1.13 A queue that never drains has at least five silent causes, and the page shows none of them

`lease()` returns a `reason` for every refusal and **persists none of it**: `dispatch_disabled` (`dispatch.ts:606`), `runner_offline` (`510`), `platform_disabled` (`527`), `settings_pending` (`529`), `capacity_full` (`550`), `retry_backoff` / `no_candidates` (`633`). Only the success path appends an event (`session.dispatched`, `dispatch.ts:685-697`). The runner then **throws the reason away**: `if (session === null) { this.ledger.completeRequest(…); return; }` (`runner/src/index.ts:340-343`) — not logged, not reported, not surfaced.

The nastiest of these is `settings_pending` (`dispatch.ts:528-529`): once `desiredVersion > appliedVersion`, that runner is refused every lease until it acknowledges. The page's Runners table shows this as the single word **"Pending acknowledgement"** in a column called Settings (`sessions.tsx:390-394`) — with no statement that dispatch to that machine is _stopped_, and **no control anywhere in the UI to change or re-push runner settings** (grep for `runners/` across `packages/ui/web` returns nothing; the route `PUT /sessions/runners/:id/settings` at `http.ts:823-833` has no browser caller). A project can reach a state where dispatch is on, a runner is live, work is queued, and nothing ever runs — and the only evidence is one ambiguous word.

> **Since closed on the server.** `session.stuck` derives these causes in one read
> (`dispatch_disabled`, `no_live_runner`, `runner_refusing`, `dispatch_held`,
> `dispatch_failing`, `ready_quiet`), a runner's `decisionSince` says how long a refusal has
> held, and a failing launch is bounded by a hold instead of retried for ever. See
> [stuck work and dispatch holds](RUNNER_CONTROL_PLANE.md#stuck-work-and-dispatch-holds).
> The page does not draw them yet; the counts ride in `GET /sessions/status` as `stuck`.

### 1.14 An actor with no name reads as an em dash while the server knows the actor

`sessions.tsx:424`: `agentName.get(session.agentId ?? '') ?? term(null)` → `—`. A manually offered lease (`POST /sessions/offer`) has no `agentId`; so does a lease whose worker is a plain session actor. But `SessionSummary.actorId` is populated (`dispatch.ts:447`) and typed (`types.ts:263`) and **never read by the UI**. Per the project's own rule 4 (`docs/UI_LEGACY_PATTERNS.md:10`) the em dash means "a fact this record could have and does not" — here the fact exists and the page declines to resolve it. (Resolving it needs a name lookup the payload does not yet carry; see PLAN P3.)

### 1.15 An assignment whose record was deleted, or simply created after mount, loses its link silently

`sessions.tsx:209-210` reads `task.list` and `experiment.list` **with no `every`** — one shot per mount. `routeOf` (`sessions.tsx:211-216`) returns `undefined` when the instance is in neither list, and `LeaseRow` then omits the "Open the record →" line entirely (`sessions.tsx:159-164`). Three different situations collapse into the same silence: the lists have not loaded yet, the work item was created after this mount, and the record genuinely no longer exists. The panel's own first line — the thing `sbx-row-panel` exists to guarantee — just is not there, with no explanation.

If either list read _fails_, nothing reports it: `tasks.error` / `experiments.error` are never inspected.

### 1.16 The agent detail panel blanks on every failed poll (BLANK — real)

`views/agent-sessions-panel.tsx:288-320` does not use `useTool` at all. Its own loop:

```ts
catch (failure) {
  if (!cancelled && version === scopeVersion()) {
    setError(…);
    setObservation(undefined);   // ← 308
  }
}
```

One failed 4s poll wipes the entire observation — current assignment, tool activity, token stats, history — and replaces it with a bare `<p role="alert">`. It then retries forever at 4s (`312`) **with no back-off and no visibility gate**, so a backgrounded tab with a detail panel open keeps hammering the endpoint. Both properties are the ones `api.ts` was built to own centrally (`api.ts:296-302`), and this file opted out.

### 1.17 The eight-slot palette cap, and the fact Sessions has no palette actions at all

`palette.tsx:18` caps each section at 8 (`171`, with an "and N more" line at `225-226`). For Sessions that cap is moot in a worse way: `offered()` (`palette.tsx:41-49`) walks only the registered `act` and `create` slots, and `ListPage` registers `create` on the **fold opener button** (`list-filters.tsx:249,308`), whose text is "Operations" — which fails the `VERB` test (`palette.tsx:37`). The form's contents are not descendants of the opener.

So **⌘K offers no session action at all**: not Halt dispatch, not Halt all leases, not Halt lease — even though `docs/UI_DESIGN.md:121` lists all three in the verb table. And `offered()` dedupes by button text (`palette.tsx:47`), so even if the fold were wired, 50 identical "Halt lease" buttons would collapse to one entry that clicks whichever lease is first in the DOM. The palette cannot safely address a per-row destructive control at all.

Related: `docs/UI_DESIGN.md:123` puts **Extend lease** in the verb vocabulary. There is no extend anywhere — not in `Sessions` (`types.ts:132-198`), not in `http.ts`, not in the UI. The vocabulary promises a verb the system cannot perform, and `sbx-countdown` explicitly warned "the countdown must not grow a button it cannot honour."

### 1.18 `projectStatus` is not atomic, so agents and leases can disagree

`index.ts:820-846` runs the dispatcher's transaction (`822`) and then a **second, separate** transaction for agents (`823-845`). A lease closing between the two produces a payload where `agents[].currentExecutionId` points at a session the `sessions[]` array reports as `released` — and `sessions.tsx:267-276` renders that as "«label» · producer · joined 3h ago" under a `ThreeStates` execution word of `assigned` (`agent-sessions-panel.tsx:61-62`). The agent reads as working on a lease that is over.

### 1.19 One extra poll always fires after the tab hides

`api.ts:325-328`: `schedule()` checks `hidden()` _at scheduling time_. A timer armed while visible fires while hidden, runs a full `refresh()`, and only _then_ sets `waiting`. So the module comment "The cadence stops entirely while the tab is hidden" (`api.ts:299-301`) overstates by exactly one request per tool per hide. Minor, but the comment is load-bearing documentation.

### 1.20 A shared last-good cache that can be wiped wholesale

`api.ts:338`: `if (LAST.size > 64) LAST.clear();` — a page with many tools in flight can drop every cached answer at once, removing the stale-not-blank fallback for tools that did not cause the overflow.

---

## 2. Operator questions the page cannot answer today

Each row: the question, why the page cannot answer it, and whether the fact exists anywhere.

| #   | Question                                                          | Why not                                                                                                                                                                                                                                                                                                                                       | Where the fact is (or is not)                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Why was a lease offered and not taken up?**                     | Only `offered · not taken up · for 6m` (`liveness.ts:87`). Nothing records whether the runner ever saw it.                                                                                                                                                                                                                                    | Runner-side only: the launch ledger's `reserved`/`starting`/`uncertain` states (`runner/src/ledger.ts`) never reach the server. `attach` is the only signal and its absence is all the server has.                                                                  |
| Q2  | **Why did dispatch decline this cycle?**                          | `lease()`'s `reason` is returned to the runner and dropped (`dispatch.ts:606,608,633`; `runner/src/index.ts:340-343`). Only successes are eventful (`dispatch.ts:685`).                                                                                                                                                                       | Computed and discarded. Zero storage cost today; a bounded decision receipt would be new.                                                                                                                                                                           |
| Q3  | **What is a runner doing right now?**                             | The heartbeat carries `machine`, `platforms`, `capacity`, `appliedVersion` and nothing else (`runner/src/index.ts:234-242`; `types.ts:239-245`). Presence is a freshness timestamp.                                                                                                                                                           | `RunnerSnapshot` already holds exactly this — `state: idle\|running\|degraded\|offline\|unauthorized`, `lastError`, `pendingRequests`, per-launch status (`runner/src/types.ts:26-51`, produced at `runner/src/index.ts:318-323,597`). **It is never transmitted.** |
| Q4  | **When did the last dispatch happen, and what did it decide?**    | Nothing on the page. `dispatch.updatedAt` is when someone toggled the _switch_, not when a lease was last attempted (`sessions.tsx:296-299`).                                                                                                                                                                                                 | `session.dispatched` events exist (`dispatch.ts:685-697`) and `State.events(projectId, after)` can read them (`contracts/src/index.ts:152`), but no surface does.                                                                                                   |
| Q5  | **Which leases halted recently, and why?**                        | A halted lease shows `released · halted by operator · 12m ago` only while it is inside the 200-row window, and there is no filter, no "recent" view, no grouping.                                                                                                                                                                             | `session.halted` (`dispatch.ts:253-263`) and `session.closed` with `outcome`+`reason` (`index.ts:474-489`) are durable and unread by any consumer.                                                                                                                  |
| Q6  | **Per-agent history**                                             | Partially answered, but only behind two clicks and only in the detail panel: "Past assignments · N" (`agent-sessions-panel.tsx:260-274`). Not on the row, not filterable, not comparable across agents.                                                                                                                                       | `AgentObservation.assignments` (`types.ts:307-324`).                                                                                                                                                                                                                |
| Q7  | **Error text from the runner**                                    | None, by policy: `observations.ts:47` — _"Metadata only: never retain arguments, results, error messages or credentials."_ A failed call is the word `failed` (`agent-sessions-panel.tsx:205`).                                                                                                                                               | The runner holds `lastError` as a bounded code (`runner/src/index.ts:100-106` — already sanitised to `/^[a-z_]{1,100}$/`), and releases carry a canonical `outcome` (`types.ts:48-56`). A **code** is compatible with the policy; free text is not.                 |
| Q8  | **How long has the queue waited?**                                | `Available work` is a table of label/gate/role/revision (`sessions.tsx:472-487`). No age column, no oldest-first, no "waiting since".                                                                                                                                                                                                         | `WorkflowDispatchCandidate` carries no timestamp; the workflow instance's own created/updated time is not in the payload. **Server change required.**                                                                                                               |
| Q9  | **Which experiment does a lease serve, and what state is it in?** | The panel's link exists only if `task.list`/`experiment.list` happens to contain the id (`sessions.tsx:211-216`), and it shows a kind label, never the item's _state_. `SessionSummary` carries no workflow name or state — `docs/UI_LEGACY_PATTERNS.md` § `sbx-row-panel` flagged this exact gap ("the one gap for the panel's first line"). | `AgentObservation.assignments[].workflow{name,state}` has it (`types.ts:321`) but only per-agent; `queue[].workflow`/`state` has it but only for _unleased_ work (`sessions.tsx:76`). The leased half is the half missing it.                                       |
| Q10 | **Is anything wrong right now?**                                  | There is no attention/health summary. An operator must read a runner table, a lease list and a queue table and compose the answer themselves — and only after opening a fold.                                                                                                                                                                 | Everything needed is already in the payload.                                                                                                                                                                                                                        |
| Q11 | **Who paused dispatch?**                                          | `updatedBy` is on the wire and not rendered (`types.ts:211`, `sessions.tsx:296-299`).                                                                                                                                                                                                                                                         | Present.                                                                                                                                                                                                                                                            |
| Q12 | **Is capacity the constraint?**                                   | The Capacity column is a bare integer (`sessions.tsx:389`) with no used-of-total. `capacity_full` is the refusal it causes (`dispatch.ts:544-550`).                                                                                                                                                                                           | Derivable: live leases per runner via `runnerRef` are already in `sessions[]`.                                                                                                                                                                                      |

---

## 3. The mutations and their failure handling

All three go through one hand-rolled helper (`sessions.tsx:181-196`); none goes through `mutations.ts`.

| Mutation            | Route                                         | Guarded?                                                                                                                                                                                              | Idempotent?                                                                                                                                                                                                                  | Reports uncertainty?                                                                                         | Reports result?                                                                                |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Dispatch on/off** | `PUT /sessions/dispatch` (`http.ts:797-804`)  | No guard — one click, correct per the contract (forward actions stay one click)                                                                                                                       | Server-side yes: `set()` no-ops when unchanged (`dispatch.ts:192-194`). **But the request body is `!stale` (`sessions.tsx:312`), so a retry after a concurrent change flips the wrong way.** No expected-value check exists. | No. `catch` → flat message (`sessions.tsx:191-193`). A dropped response is indistinguishable from a refusal. | Returns `{dispatch}`; discarded.                                                               |
| **Halt one lease**  | `POST /sessions/:id/halt` (`http.ts:852-860`) | Yes — `ConfirmAction` naming the agent, the work and the role (`sessions.tsx:431-454`). Good, and the "what does not change" paragraph is the right instinct.                                         | Yes, naturally: non-live rows are skipped (`dispatch.ts:250`); a missing id 404s (`245-246`). Safe to retry.                                                                                                                 | No. Same flat path.                                                                                          | Returns `{halted}`; discarded — so a no-op halt (already swept) looks identical to a real one. |
| **Halt all**        | `POST /sessions/halt` (`http.ts:805-809`)     | Yes — lists the live leases by name (`sessions.tsx:329-336`). **But the list is the truncated 200 (§1.7), and the promise "each assignment returns to the queue" is not synchronously true (§1.12).** | Yes, and it _also_ disables dispatch in the same transaction (`dispatch.ts:234`) — correctly disclosed in the guard text.                                                                                                    | No.                                                                                                          | Returns `{halted}`; discarded.                                                                 |

Additional defects common to all three:

- **One `busy` string for the whole page** (`sessions.tsx:177,183`): any in-flight mutation disables every other control, including unrelated ones. Acceptable, but it is also the _only_ concurrency control — there is no per-control state.
- **A latent busy-key mismatch**: the request is sent to `` `/sessions/${encodeURIComponent(session.id)}/halt` `` (`sessions.tsx:439`) while the busy label compares against `` `/sessions/${session.id}/halt` `` (`sessions.tsx:436`) — unencoded. Session ids are currently `[A-Za-z0-9_]`, so it works; any id that ever needs escaping silently loses its "Halting…" label.
- **The error lands in the wrong place**: `setError` renders one `<p role="alert">` in the dispatch section at the top of the fold (`sessions.tsx:349-353`). A per-lease halt failure is reported hundreds of pixels above the guard that produced it, possibly off-screen, and the guard stays open with its button re-enabled — so the natural reaction is to click again, and nothing tells the person whether the first click landed.
- **`ConfirmAction` never closes itself** (`components.tsx:197-244`): it has no success path. Per-lease it unmounts because `isLive` goes false; halt-all unmounts because `live.length` goes to 0. Both are incidental, not designed — a halt that returns `{halted: 0}` leaves the guard sitting open with no feedback at all.

---

## 4. Resilience and cost of the reads

### 4.1 Cadence

| Read                               | Where                          | Cadence                       | Visibility-gated?      | Back-off?                                                                   |
| ---------------------------------- | ------------------------------ | ----------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| `ui.read` sessions                 | `sessions.tsx:175`             | 4s live / 15s idle (`205`)    | Yes (`api.ts:324-333`) | **No** — a failing poll retries at the same rate forever (`api.ts:348-351`) |
| `ui.shell`                         | `shell.tsx:312`                | 4s, always, on **every page** | Yes                    | No                                                                          |
| `task.list`, `experiment.list`     | `sessions.tsx:209-210`         | once per mount                | n/a                    | n/a                                                                         |
| `/sessions/agents/:id/observation` | `agent-sessions-panel.tsx:312` | 4s, hand-rolled               | **No**                 | **No**                                                                      |
| `ui.read` sessions (map)           | `views/map.tsx:369`            | 10s on `/`                    | Yes                    | No                                                                          |

The idle slowdown is real and well done (`sessions.tsx:203-205`), and `useNow(anyLive ? 1000 : 0)` freezes the clock on an idle page (`204`) exactly as the legacy `useNow` did.

### 4.2 The polls, counted

`ui.shell` calls `UiRegistry.describe`, which invokes **every registered row's `status()`** (`packages/ui/src/index.ts:64-77`). The Sessions row's `status()` is `(await ctx.sessions.projectStatus(caller)).liveSessionCount` (`sessions/src/ui.ts:18-20`) — the _entire_ status payload computed and then thrown away for one integer.

So, per minute, sitting on the Sessions page:

- 15 × `ui.shell` → 15 full `projectStatus`
- 15 × `ui.read` → 15 full `projectStatus`
- **= 30 full `projectStatus` per minute, 60 DB transactions** (each `projectStatus` is two: `dispatch.ts:418` + `index.ts:823`)

Each `projectStatus` performs:

- runners scan up to 100 rows, and **one `scope.requireDelegation` per row** (`dispatch.ts:271`, inside `mapAsync` at `420-426`) → up to 100 authority checks;
- a 200-row 3-way `LEFT JOIN` over `worker_sessions × session_dispatch_receipts × session_workspaces`, with 200 `JSON.parse` of full session blobs (`dispatch.ts:436-442`);
- a `COUNT`/`SUM` aggregate over all sessions (`473-476`);
- `workflows.dispatchCandidates` — a full program-by-program enumeration with per-item admission callbacks (`docs/RUNNER_CONTROL_PLANE.md:25-36`) — plus a live-set query (`404-411`);
- a second transaction for the agents `LEFT JOIN` (`index.ts:826-836`).

Worst case at a 100-runner, 200-lease project: **~6,000 delegation checks and ~12,000 session-blob parses per minute, from one browser tab** — and half of that is for a number in the rail. On `/` (the map) the same payload is fetched a third time at 10s (`map.tsx:369`).

With an open agent detail panel, add 15 more `/observation` calls per minute, each doing a 100-row tool-call query plus aggregates (`observations.ts:141-160`), _whether or not the tab is visible_.

### 4.3 At 50 leases, and at 200

- **Rendering.** `now` is page-level state (`sessions.tsx:204`), so every 1s tick re-renders the whole `AgentsPage` subtree: the agent list, the runners table, all `LeaseRow`s and the queue table. Nothing is memoized; `LeaseRow` is a plain function (`sessions.tsx:113`). At 200 leases that is a 200-row reconciliation **once per second**, forever, while anything is live.
- **Payload.** 200 `SessionSummary` objects with nested workspace records, ~30×/min.
- **Truncation.** At exactly 200 the list hits its cap and §1.7 activates: the guard under-counts, the header over-counts.
- **Runners.** At >100 machines they silently disappear (§1.6).
- **Queue.** `queue.slice(0, 200)` with an honest "showing the first N" line (`sessions.tsx:464-468`) — the one cap handled correctly.
- **Palette.** `Records` sections cap at 8 with "and N more" (`palette.tsx:225-226`); `Actions here` is empty regardless (§1.18).

### 4.4 What is genuinely good here

Worth preserving explicitly, because a robustness wave can easily break it:

- `useTool`'s keep-last-good-on-error and wait-for-response-before-rescheduling (`api.ts:341-351`) are better than the legacy UI's three independent interval loops.
- The scope-epoch fencing (`api.ts:116-119`, `scopeVersion()` checks in `sessions.tsx:183-195`) correctly prevents a response for project A landing in project B.
- `liveness.ts` is exactly what rule 3 asks for: one pure module, table-tested, honest enough to return `null` and render nothing (`liveness.ts:96-98`, `108`) — and its doc comment names what it cannot say (`liveness.ts:9-14`).
- The server side is genuinely hardened: transactional re-admission around the offer (`dispatch.ts:634-674`), immutable dispatch receipts with SQL triggers (`dispatch.ts:159-162`), and secrets never stored in plaintext.

---

## 5. Tests

### 5.1 What exists

**Server-side, substantial.** `npm run test:sessions` runs six files (`package.json:23`): `sessions`, `sessions-api`, `sessions-integration`, `workflow-leases`, `workflow-dispatch`, `session-dispatch-api`. `session-dispatch-api.test.ts:120` covers "automatic dispatch is off by default; operator UI sees machine-key sessions and pause differs from halt", asserts `halted >= 1` (`230`), and asserts halt-all disables dispatch (`232`). `sessions.test.ts:802-805` covers runner `live` flipping on staleness. Runner process/workspace behaviour has its own eleven files.

**UI-side, effectively nothing for this page.**

- `npm run test:ui` runs **only** `tests/ui.test.ts` (`package.json:36`), which tests `UiRegistry` validation, row ordering and plugin unload/reload. Its only mention of sessions is the string `'sessions'` in expected row-id arrays (`ui.test.ts:355,411,431,457,474`).
- `tests/ui-liveness.test.ts` (73 lines) tests `liveness.ts` in isolation — genuinely good table-driven coverage of `duration`, `elapsed`, `term`, `leaseLiveness`, `runnerLiveness`, including the past-expiry `lapsed` case (`45-48`) and the silence-when-unknown cases (`54-55,72`). It is **not** in `test:ui`; it only runs under bare `npm test`.
- `tests/ui-navigation.test.ts` (94 lines) tests `buildNavigation`.
- **There is no React render test anywhere in the repository.** `grep -rln "react-dom|@testing-library|renderToString" tests` returns nothing. No component in `packages/ui/web` has ever been mounted in a test.

So: **every finding in §1 and §3 is untested.** `sessions.tsx` (497 lines), `agent-sessions-panel.tsx` (355), `list-filters.tsx` (~440), `api.ts`'s `useTool` (72 lines of scheduling logic), `mutations.ts` (82 lines, currently dead on this page) and `components.tsx`'s `Countdown`/`ConfirmAction`/`LoadState` have zero automated coverage.

### 5.2 What a robustness test would look like

The harness needed is already in the tree — it just has never been pointed at Sessions.

- **A fixture server that flaps.** `dev_docs/ui_proxy.mjs` is a toggleable fault-injection proxy with modes `pass | down | 500 | 502json | 401 | hang | slow | html200 | emptyjson`, driven by a file so a test can flip it mid-run. `dev_docs/ui_fault.mjs` is the Playwright driver: it snapshots `_0_before`, flips the mode, snapshots `_1_during`, restores, snapshots `_2_after`, and collects console errors, page errors and every ≥400 response. Pointing this at `/sessions` with `START_MODE=pass MODE=500` and asserting that the agent rows are still in `_1_during.txt` is a direct executable test of §1.1.
- **A clock that jumps.** `useNow` and every liveness call take `now` as a parameter, and `leaseLiveness` is already pure — so the _module_ is testable today and tested. What is missing is the **view**: a render test that mounts `LeaseRow` with an active lease at `expiresAt = now + 60s`, advances a fake clock past it without delivering a new payload, and asserts the row does **not** say `lapsed` (§1.2). That needs a render harness (`react-dom/server` is enough for the static assertions; `@testing-library/react` + `jsdom` for the interactive ones).
- **A halt that returns 500.** Two layers. Server-integration: extend `session-dispatch-api.test.ts` to assert `{halted: 0}` on an already-closed lease and on a lease closed by the sweep between read and halt. UI: mount the fold with a stubbed `accountRequest` that rejects with `ApiError('offline', …, 0)` and assert the rendered text contains the uncertain-result wording from `mutations.ts:71` — which will fail today, because `sessions.tsx` does not use it.
- **Seeding.** `scripts/ui-demo.ts:189-255` already registers agents, assigns work and heartbeats a lease. It does **not** seed runner presence, a large lease fleet, a `settings_pending` runner, or a >200-lease project — all of which are needed to exercise §1.6, §1.7 and §1.13. `dev_docs/cordis_seed_more.mjs` has no session seeding at all.
- **Cost as a test.** `projectStatus` call count per `ui.shell` is assertable in-process today (count transactions or wrap `state.transaction`); an assertion that one `ui.shell` does **not** cost a full `projectStatus` is the cheapest way to lock in P6.

---

## 6. The merged agent directory

### 6.1 What `agent-sessions-panel.tsx` shows that the lease row does not

Reading `AgentObservation` (`types.ts:307-334`) against `SessionSummary` (`types.ts:260-282`):

| Fact                                                                                                       | Detail panel                                          | Lease row                                              |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Current assignment with its **workflow name and state**                                                    | `AssignmentDetails` (`agent-sessions-panel.tsx:72`)   | **No** — `SessionSummary` has no workflow at all (§Q9) |
| **Permitted tools**, the frozen policy in full                                                             | `89-100`                                              | No                                                     |
| **Tool-call feed**: tool, status, start, duration, in-flight first                                         | `202-231`                                             | No                                                     |
| Token estimates, per-scope and lifetime                                                                    | `163-176`, `233-248`                                  | No                                                     |
| **Past assignments**                                                                                       | `260-274`                                             | Only as separate rows, unaggregated                    |
| Runner id, joined, context epoch                                                                           | `250-259`                                             | `runnerRef` exists on the summary and is unrendered    |
| The honest disclaimer "No live assignment. This does not indicate whether the agent process is connected." | `139-141`                                             | No equivalent                                          |
| Lease countdown and liveness verdict                                                                       | **No** — absolute `toLocaleString` stamps only (`81`) | Yes (`sessions.tsx:152-156`)                           |
| Halt                                                                                                       | No                                                    | Yes (`sessions.tsx:431-454`)                           |

They are two views of the same object with almost no overlap and **no shared vocabulary**: the panel uses `StatusPill` on a raw lifecycle status (`agent-sessions-panel.tsx:69`) while the row uses `Live`/`leaseLiveness` on behaviour (`sessions.tsx:155`). The same lease can read `● ACTIVE` in the panel and `lapsed · lease ran out` in the row, at the same instant, from the same data. That is precisely the disagreement rule 3 (`docs/UI_LEGACY_PATTERNS.md:9`) exists to prevent.

The panel also opens as `after` (`sessions.tsx:284`) — _below_ the whole list — while `ListPage`'s split-pane machinery (`list-filters.tsx:391-416`) exists for exactly this and is not used here.

### 6.2 How to fold it into Sessions without duplicating People

The founder's rail ruling already decided the boundary: _"Connections is a settings thing; People is not a row"_ (`docs/UI_DESIGN.md:145`) — People disappears from the rail, and Sessions is the only Agents-group row besides Sandboxes.

The distinction that keeps them separate is **identity vs execution**, which the code already draws:

- **People / Members** (now under Settings) owns the `Actor` record: who may act in this project, their role, their membership. Durable, human-scale, rarely changing.
- **Sessions** owns the `Agent` record (`sessions/src/types.ts:16-29`) and its `Session` executions. An `Agent` is not a person: it has a `runnerId`, a `contextEpoch`, a `persistent` flag and a `retiredAt`. It is a worker process's continuing identity.

They share only `actorId`. So the fold is: **Sessions lists agents; an agent opens to its executions; a lease row links to the work, never to a person.** Concretely —

1. **One list, one anatomy.** Keep the agent list as the page's rows (it already is) and move the leases _under their agent_ rather than into a parallel table, using `ListPage`'s split pane (`list-filters.tsx:391`) instead of `after`. An agent row shows: name, behaviour verdict from `liveness.ts`, its current work by name, and its lease clock. Its record pane shows the current assignment (with workflow state), the tool feed, past assignments, and Halt.
2. **Leases that have no agent** (manual offers, `agentId` absent) need a home: a second section, not a second grammar. They are the minority and they are the ones the operator most needs to see.
3. **One liveness module for both surfaces.** Delete `StatusPill` on lease status from `agent-sessions-panel.tsx:69,82` and call `leaseLiveness` there too. This is a deletion, not an addition.
4. **No person appears on this page.** An agent's `actorId` resolves to a _name for the worker_, not a link to a member — the worker actor is credentialless and retires with the lease (`docs/SESSION_LEASES.md`, "Source authority and worker identity"). Linking it to People would assert an equivalence the model denies.
5. **The source is the one People-adjacent fact worth showing**, in Details only: _who or which key authorised this lease_. `Session.source` (`types.ts:67`) has it. That is the honest join to People, it belongs in the panel, and it is currently shown nowhere.

Net effect: one page, one list anatomy, one liveness vocabulary, and roughly 355 lines of parallel panel folded into the record pane rather than kept beside it.

---

## Part 2 — Plan

# Sessions robustness wave — prioritised plan

Companion to `AUDIT.md`. Server-side items (**S**) and UI-only items (**U**) are separated below; the ordered list interleaves them by priority because several UI items depend on an S item landing first.

LOC estimates are net source lines in `merv-typescript` (the project rule: every merge must lower net source LOC — three items here are net negative and are marked).

---

## Ordering rationale

1. **Stop lying before adding facts.** P1–P4 close cases where the page states something false; P5–P8 close cases where it cannot state something true. A page that answers more questions while still mis-stating lease liveness is worse, not better.
2. **Cheap truth first.** P1, P2, P4 are UI-only, small, and need no migration.
3. **One server payload change carries four UI items.** P5 (`projectStatus` shape) unblocks P7, P9, P11 — do it once.
4. **The harness lands with the first fix, not at the end.** P3 exists so P1's fix is provable and stays fixed.

---

## Priority list

### P1 — Never blank a list that is still correct · **U** · ~6 lines (net −2 possible)

**Closes:** AUDIT §1.1 (failed poll blanks the agent list while the lease fold keeps rendering).

**Files:** `packages/ui/web/list-filters.tsx:341-342`.

**Change:** delete the `!load.error` conjunct so rows render whenever there are rows; `LoadState` (`components.tsx:392-398`) already renders the stale line beside them, which is the designed pairing. Audit the other `ListPage` callers in the same pass — the guard was consolidated here from the per-view `&& !list.error` guards that `docs/UI_LEGACY_PATTERNS.md` § `stale-not-blank` said to remove, so this is finishing that item rather than starting a new one.

**Acceptance:** `dev_docs/ui_fault.mjs` against `/sessions` with `START_MODE=pass` then mode `500`: the `_1_during.txt` body text must still contain every agent name present in `_0_before.txt`, **and** contain the string "Could not refresh". Today `_1_during.txt` loses the names. Add the same assertion for `/tasks` and `/experiments`.

---

### P2 — A lease clock that cannot outrun its data · **U** · ~25 lines

**Closes:** AUDIT §1.2 (a live, heartbeating lease reads `lapsed · lease ran out` after a tab sleep or a stalled poll) and §1.4 (the `active`-past-expiry window disagreeing with `isLive`).

**Files:** `packages/ui/web/liveness.ts` (`leaseLiveness`, `runnerLiveness`), `packages/ui/web/components.tsx:183-189` (`Countdown`), `packages/ui/web/views/sessions.tsx:152-156,175,204`.

**Change:** make freshness an explicit input, not an assumption.

- Pass `loadedAt` (already returned by `useTool`, `api.ts:370`) into `leaseLiveness` and `Countdown`.
- When `now − loadedAt` exceeds one poll interval, the countdown renders the value **as of the last read** with the staleness stated, and `leaseLiveness` must **not** promote `active` to `lapsed`. A verdict that a lease has run out may only be drawn from a payload young enough to have seen a renewal.
- Align `isLive` (`sessions.tsx:90`) with the liveness verdict so a row that says `lapsed` stops showing an `Expires` countdown and starts showing `Lease ran to`.

**Acceptance:** a render test (needs P3) mounting `LeaseRow` with `status: 'active'`, `expiresAt = t+60s`, `loadedAt = t`, then advancing the clock to `t+120s` **without a new payload**: the row must not contain "lapsed" or "ran out". A second case with `loadedAt = t+115s` must show `lapsed`. Extend `tests/ui-liveness.test.ts` with the same table rows at the module level.

---

### P3 — A render harness, and the first tests that use it · **U** · ~120 lines (new test files; source LOC unchanged)

**Closes:** AUDIT §5 — there is no React render test in the repository, so P1, P2, P4, P7, P8 are otherwise unprovable.

**Files:** `package.json` (dev deps `jsdom` + `@testing-library/react`, and a `test:ui` that actually includes the UI tests — today `test:ui` runs only `tests/ui.test.ts`, `package.json:36`, so `tests/ui-liveness.test.ts` and `tests/ui-navigation.test.ts` are outside it); new `tests/ui-sessions.test.ts`; extend `dev_docs/ui_fault.mjs` invocation notes.

**Change:** the minimum harness that mounts a view with a stubbed `call`/`accountRequest` and a controllable clock. Three fixtures: a flapping server (reuse `dev_docs/ui_proxy.mjs`'s mode list for the integration half), a jumping clock, and a halt that returns 500 / drops the connection.

**Acceptance:** `npm run test:ui` runs `tests/ui*.test.ts`; the new file asserts the P1, P2 and P4 behaviours and fails on today's code for all three.

---

### P4 — Halts that report honestly · **U** · ~30 lines added, ~16 deleted (net +14)

**Closes:** AUDIT §1.10 (an uncertain halt reads as a plain failure), §1.11 (`{halted: n}` discarded, so a no-op halt looks like a success), §3 (error rendered far from the guard; guard never closes; unencoded busy key).

**Files:** `packages/ui/web/views/sessions.tsx:181-196,324,349-353,431-456`; `packages/ui/web/mutations.ts` (already written, currently unused by this page); `packages/ui/web/components.tsx:197-244` (`ConfirmAction` gains a `result`/`error` slot and a success callback).

**Change:**

- Replace the hand-rolled `mutate` with `useCommand` (`mutations.ts:5`), passing `idempotent: true` — halt genuinely is (`dispatch.ts:250`), so no `requestId` is needed and the server rejects one. This gives the uncertain-result wording (`mutations.ts:71`) for free on `status === 0` and 5xx.
- Validate the response: `validate: (r) => typeof r.halted === 'number'`, and **state the count**. "Halted 3 leases." / "Nothing to halt — this lease had already closed." A `{halted: 0}` must never read as a success.
- Render the failure **inside the guard that produced it**, and close the guard on a confirmed success rather than relying on the row unmounting.
- Fix the busy-key comparison to use the same `encodeURIComponent` as the request (`sessions.tsx:436` vs `439`).
- Dispatch toggle: send the intended absolute state and surface a no-op ("Dispatch was already enabled — someone else changed it"), rather than silently flipping the label. Show `dispatch.updatedBy` beside `updatedAt` (`sessions.tsx:296-299`) — it is already on the wire.

**Acceptance:** render test — `accountRequest` rejects with `ApiError('offline', …, 0)`; the rendered guard must contain "The original result is still unknown" and keep the operator's command for retry. Second case: resolves `{halted: 0}`; the guard must say nothing was halted. Both fail today.

---

### P5 — `projectStatus` tells the truth about its own limits and its own clock · **S** · ~45 lines

**Closes:** AUDIT §1.3 (clock skew invisible), §1.6 (runners truncate at 100 with no total), §1.7 (Halt-all guard counts the truncated list), §1.18 (agents and leases read in two transactions).

**Files:** `packages/sessions/src/dispatch.ts:417-489`, `packages/sessions/src/index.ts:820-846`, `packages/sessions/src/types.ts:336-347`.

**Change:**

- Add `observedAt: string` (the server's own `this.time()`) to `SessionsProjectStatus`. This is the anchor every UI duration should be measured from, and it makes skew detectable rather than absorbed.
- Add `runnerTotal: number` beside the existing `sessionTotal`/`queueTotal`, so the Runners table can carry the same honest `N of M` line the lease list already has.
- Fold the agents query into the dispatcher's transaction so one payload is one consistent snapshot. (`index.ts:823` currently opens a second transaction after `dispatch.ts:418` has committed.)
- Keep every existing field; this is additive.

**Acceptance:** `tests/session-dispatch-api.test.ts` — assert `observedAt` is present and within tolerance of the server clock; assert `runnerTotal` exceeds `runners.length` when >100 runners are registered; assert that a lease closed concurrently with a `projectStatus` call cannot appear as an agent's `currentExecutionId` while absent from `sessions[]`.

---

### P6 — Stop paying for a full `projectStatus` to render one integer · **S** · net **−0 to −10** (a cheaper query replaces the expensive path)

**Closes:** AUDIT §4.2 — `ui.shell` polls every 4s on _every page_ and `UiRegistry.describe` invokes each row's `status()`, so the Sessions row runs the entire status computation (up to 100 delegation checks, 200 session-blob parses, a full `dispatchCandidates` enumeration) for `liveSessionCount` alone. On the Sessions page this doubles to ~30 full computations per minute; the map adds a third at 10s.

**Files:** `packages/sessions/src/ui.ts:18-20`, `packages/sessions/src/index.ts` (a new narrow `liveSessionCount(caller)`), `packages/sessions/src/types.ts:132-198`.

**Change:** give Sessions a dedicated count method — a single `SELECT COUNT(*) … WHERE status IN ('offered','active')` with a permission check — and have `status()` call it instead of `projectStatus`. This is the single largest cost item in the audit and touches ~10 lines.

Consider also: `views/map.tsx:369` reads the sessions row's full `ui.read` at 10s for a small live count; the same narrow read serves it.

**Acceptance:** an in-process test wrapping `state.transaction` and asserting that one `ui.shell` for a project with one registered sessions row opens **at most one** transaction attributable to sessions, and performs **zero** `dispatchCandidates` calls. Today it performs one full enumeration per shell poll.

---

### P7 — Say why dispatch declined · **S** · ~70 lines

**Closes:** AUDIT §Q2, §Q4, and most of §1.13 (a queue that never drains with five silent causes, chiefly `settings_pending`).

**Files:** `packages/sessions/src/dispatch.ts:553-700` (record the decision), `packages/sessions/src/types.ts` (a `lastDecision` on `RunnerPresence` or a small `dispatchDecisions` array on `SessionsProjectStatus`), `packages/runner/src/index.ts:339-343` (stop discarding `result.reason`).

**Change:** the reason is already computed and already bounded to a fixed vocabulary — `dispatch_disabled`, `runner_offline`, `platform_disabled`, `settings_pending`, `capacity_full`, `retry_backoff`, `no_candidates`, `offered`, `replayed` (`dispatch.ts:591,606,608,633,698`). Persist the **last** decision per runner (an upsert on the existing `session_runners` row: `last_decision`, `last_decision_at`) rather than a log — constant storage, no migration of history, no retention question. Return it on `RunnerPresence`.

This is deliberately _not_ free text: `observations.ts:47` forbids retaining error messages, and a closed enum honours that while answering the question.

**Acceptance:** `tests/session-dispatch-api.test.ts` — with dispatch enabled, a live runner, `desiredVersion > appliedVersion` and eligible work, `POST /sessions/lease` returns `{session: null, reason: 'settings_pending'}` **and** the next `GET /sessions/status` reports that runner's `lastDecision === 'settings_pending'` with a timestamp. Repeat for `capacity_full` and `retry_backoff`.

---

> **Extended.** P7's `lastDecision` now has `decisionSince` beside it, and `session.stuck`
> reports a live runner that has answered `settings_pending` or `platform_disabled` for
> `refusalSeconds` while work is queued. §1.12 and the runner-settings control below stay
> deferred.

### P8 — The page's subject is not behind a fold · **U** · net **−20 to −40** (removing a parallel panel outweighs what is added)

**Closes:** AUDIT §0 (the default page shows only agent names), §6 (two views of the same lease with no shared vocabulary), §1.17 (the palette can offer no session action because `ListPage` registers only the fold opener).

**Files:** `packages/ui/web/views/sessions.tsx:239-495`, `packages/ui/web/views/agent-sessions-panel.tsx`, `packages/ui/web/list-filters.tsx:247,249,317,391-416`.

**Change:** follow §6.2 of the audit.

- Dispatch state, the live count and the halt controls move **out** of the `Operations` fold and onto the page. Runner detail and the queue table may stay folded; the fold is for heavy tables, not for the page's subject (`docs/UI_DESIGN.md:11`).
- Leases move under their agent in the split pane (`list-filters.tsx:391`) rather than living in a parallel table below; leases with no `agentId` get their own section.
- Delete `StatusPill` on lease status from `agent-sessions-panel.tsx:69,82` and call `leaseLiveness` there — one vocabulary on both surfaces, which is rule 3 (`docs/UI_LEGACY_PATTERNS.md:9`).
- Register the real `act` slot so ⌘K can offer `Halt dispatch` / `Halt all leases` (`palette.tsx:41-49` walks `here.act`). Per-row `Halt lease` must stay out of the palette until it can name _which_ lease — `offered()` dedupes by button text (`palette.tsx:47`) and would silently click the first one.

**Acceptance:** `dev_docs/cordis_eval.mjs` capture of `/sessions` at 1440px must contain the dispatch state, the live lease count and at least one lease row **without any click**. A render test asserts ⌘K's "Actions here" on `/sessions` contains "Halt dispatch" and does **not** contain a bare "Halt lease".

---

### P9 — A lease names its work and its state · **S+U** · ~35 lines

**Closes:** AUDIT §Q9, §1.15 (a link that vanishes for three different reasons).

**Files:** `packages/sessions/src/dispatch.ts:441-472`, `packages/sessions/src/types.ts:260-282` (add `workflow: { name: string; state: string }` to `SessionSummary` — the frozen `session.execution` already holds it, as `AgentObservation.assignments[].workflow` proves at `types.ts:321`); `packages/ui/web/views/sessions.tsx:209-216` (delete `routeOf`'s guesswork and the two unused list reads).

**Change:** the panel's first line — the thing `docs/UI_LEGACY_PATTERNS.md` § `sbx-row-panel` exists to guarantee — becomes a fact the payload carries rather than an id-membership guess against two one-shot list reads. Removing `task.list` + `experiment.list` from this page also removes two polls and the un-inspected error paths.

**Acceptance:** server test asserts `sessions[].workflow.name`/`.state` on a leased task and a leased experiment. Render test: a lease whose instance is in neither list still renders "Open the record →" with the work's name and state.

---

### P10 — A runner says what it is doing · **S** · ~55 lines

**Closes:** AUDIT §Q3, §Q7, §1.5 (revoked credential indistinguishable from a dead machine).

**Files:** `packages/runner/src/index.ts:234-242` (send it), `packages/sessions/src/dispatch.ts:71-79,268-285` (accept and return it), `packages/sessions/src/types.ts:239-252`, `packages/ui/web/liveness.ts:107-111`.

**Change:** `RunnerSnapshot` already holds exactly the needed facts and is already sanitised — `state: 'idle'|'running'|'degraded'|'offline'|'unauthorized'`, `lastError` reduced to a bounded `/^[a-z_]{1,100}$/` code (`runner/src/index.ts:100-106`), `pendingRequests` (`runner/src/types.ts:26-51`). Extend the heartbeat schema (`dispatch.ts:71-79`) with `state` and optional `lastError` and carry them onto `RunnerPresence`.

Separately, `presence()` must distinguish its two `live: false` causes (`dispatch.ts:268-285`): return `reachable` (heartbeat freshness) and `authorized` (delegation check) as distinct fields so `runnerLiveness` can say `unauthorized · source revoked` rather than `quiet · last seen 6m ago`. A revoked runner whose heartbeat is still landing currently reads `quiet · last seen 1s ago`, a contradiction on its face.

**Acceptance:** `tests/sessions.test.ts` — revoke the runner's source key and assert `presence.authorized === false` while `reachable === true`; stop the heartbeat and assert the inverse. `tests/ui-liveness.test.ts` — table rows for both, asserting distinct phrases.

---

### P11 — How long the queue has waited · **S+U** · ~30 lines

**Closes:** AUDIT §Q8, and the remaining honesty half of §1.8.

**Files:** `packages/contracts` (`WorkflowDispatchCandidate` gains a `waitingSince`), `packages/workflows` (populate it from the instance's own revision timestamp), `packages/ui/web/views/sessions.tsx:463-488`.

**Change:** add an age column, order the queue oldest-first, and — the cheaper, more important half — **relabel the section** so it stops reading as the fleet backlog. The count is the _caller's_ eligible queue (`dispatch.ts:412,477`); the empty state already says so (`sessions.tsx:470`) and the heading and the "N assignments to be leased" line (`sessions.tsx:226,463`) do not. That relabel is ~3 lines and can ship with P8 ahead of the timestamp work.

**Acceptance:** server test asserts `waitingSince` is present and monotonic; a render test asserts the heading names whose eligibility it reports.

---

## Deliberately deferred, with reasons

- **Extend lease.** `docs/UI_DESIGN.md:123` puts `Extend` in the verb vocabulary and nothing implements it — no route (`http.ts:844-845` allows only `attach|heartbeat|release|halt|workspace-result`), no `Sessions` method. Either build it or cut the verb from the table; do not ship a countdown with a button it cannot honour (`docs/UI_LEGACY_PATTERNS.md` § `sbx-countdown`). **Decided 2026-09-17: not built.** The verb stays in the table for machines only, bound to `sandbox.extend` on the remote Sandboxes rows; session leases keep their countdown and no button.
- **Runner settings control.** `PUT /sessions/runners/:id/settings` exists and has no browser caller. It is the direct remedy for a `settings_pending` deadlock, but it is a new operator surface with its own guard questions — P7 first makes the deadlock _visible_, which is the robustness half.
- **Release/halt cleanup visibility (§1.12).** A halt whose `session.closed` consumer has not drained leaves work neither leased nor queued, and the guard text promises otherwise. The honest fix is either draining in the halt path (changes failure semantics — `docs/SESSION_LEASES.md` is explicit that cleanup may wait) or surfacing pending releases. Both are larger than this wave; at minimum, **soften the guard text** in P4 from "Each assignment returns to the queue" to "Each assignment is released back to the queue" so the page stops promising synchrony it does not have (~2 lines).
- **Per-row re-render cost (§4.3).** `now` at page level re-renders every `LeaseRow` once a second. Memoising is easy but premature until P8 changes the row structure.
- **`LAST.clear()` on overflow (`api.ts:338`)** and the **one-extra-poll-after-hide** (`api.ts:325-328`) are both real but small; fold into whichever wave next touches `useTool`.

---

## Summary

| #   | Item                                            | Layer     | LOC         | Closes                  |
| --- | ----------------------------------------------- | --------- | ----------- | ----------------------- |
| P1  | Never blank a correct list                      | U         | ~6 (net −2) | §1.1                    |
| P2  | Clock cannot outrun its data                    | U         | ~25         | §1.2, §1.4              |
| P3  | Render harness + first tests                    | U (tests) | ~120 tests  | §5                      |
| P4  | Halts report honestly                           | U         | ~+14 net    | §1.10, §1.11, §3        |
| P5  | `projectStatus` states its limits and its clock | S         | ~45         | §1.3, §1.6, §1.7, §1.18 |
| P6  | Stop paying `projectStatus` for one integer     | S         | ~−10        | §4.2                    |
| P7  | Say why dispatch declined                       | S         | ~70         | §Q2, §Q4, §1.13         |
| P8  | The subject is not behind a fold                | U         | ~−30 net    | §0, §6, §1.17           |
| P9  | A lease names its work and state                | S+U       | ~35         | §Q9, §1.15              |
| P10 | A runner says what it is doing                  | S         | ~55         | §Q3, §Q7, §1.5          |
| P11 | How long the queue has waited                   | S+U       | ~30         | §Q8, §1.8               |

Net source LOC across the wave is roughly **+230**, with P6 and P8 the negative contributors and ~120 lines of new test code on top. The first four items are UI-only, need no migration, and close every case where the page currently states something false.
