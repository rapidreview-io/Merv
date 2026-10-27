# Issues: one push-fed store behind the owners' own failure points

Status: final design, synthesised from the three candidates and three judgements. The spine is **push**. Every graft is listed in §0, every factual error is corrected in §13, and every line reference was checked against `Merv-issues` at b015a9660 (paths below are under `merv-typescript/`).

> **Founder ruling, 2026-10-27: alerts go to Slack, not email.** The only sink is a Slack incoming
> webhook (`SlackSink`, `packages/issues/src/alerts.ts`), configured as
> `alerts: { slack: { webhookEnv: 'MERV_ISSUES_SLACK_WEBHOOK' } }` whose zod `.describe('Issue alerts · Slack webhook URL')`
> lists it on the admin Credentials page. It POSTs `{ text, blocks }` (one section per issue: title ·
> count · since, linked to `${publicOrigin}/ui/admin/issues?issue=<id>`) with a 10 s timeout. A 2xx is
> success; anything else keeps the issues owed with the same backoff. Slack has no idempotency key, so
> the durable `alerted_at` throttle is the only dedupe. `render-config.mjs` sets the issues entry's
> config only when `MERV_ISSUES_SLACK_WEBHOOK` is present in the env. Everywhere below that says
> email, Resend, `EmailSink`, `MERV_ISSUES_ALERT_TO`, recipient or "mails", read Slack webhook instead.
> Defaults taken for the open rulings: admins may read agent conversations through the drill-in
> (yes); the `agent_tool_calls` ledger stays this merge; thresholds as listed; launch failures warn,
> severe on spike; transcript-less streams are kept; no backfill.

## 0. Summary

One new owner plugin, `@merv/issues` (`merv-issues`). It injects only `state`, it is `required: false`, and it has one migration component `issues`.

- **Reporting.** Owners report through `reporter(ctx)` from `@merv/contracts/issues`. The reporter looks up `ctx.get('issues')` at every call. So there is no inject edge and no owner imports `@merv/issues`, following the `payments.ts:46-50` precedent.
- **The report call.**
  - It is synchronous and O(1), and it never throws.
  - It is held by `State.afterCommit` (`state/src/postgres.ts:429-447`): inside a writer it waits for commit and is dropped on rollback.
  - It lands in a bounded in-memory map.
  - It reaches Postgres at the next 1 s flush, in one transaction.
- **Who decides what.**
  - Owners decide whether something is an issue and set its level.
  - Issues applies only class-generic rules: fingerprint, count, an hourly bucket with spike re-arm, a per-subject loop window, standing conditions, quiet resolution, and sampling of kept cases.
  - There is no rules table in Issues that knows other owners' codes.
- **Polls.** There are two small polls, both owned by Issues:
  1. The event-flood scan, through a new `State.eventCounts` method, so the events table is still read only by State.
  2. The one-shot trace pin, a read of `sessions.running.platformTrace` for kept cases whose visit has ended.
- **Alerts.**
  - Severe issues email the founder through a pluggable `AlertSink`. The first sink is Resend email, reusing `ResendMailer` and `emailHtml` from `@merv/scope/mail`.
  - The `issues` row is the outbox: `alerted_at` is owed through a partial index. Restarts neither resend nor lose an alert.
  - There is an alert pass at boot and at dispose, so a crash-looping Main still mails.
- **UI.** The admin gets an Issues page (ListPage + Ruled + drawer) and a rail badge counting open severe issues.

Grafts taken:

| From | What |
|---|---|
| pull | Boot alert pass, plus the crash file through `uncaughtExceptionMonitor`. A tiny marker file stands in for a boot table (§2.4). |
| case-file / pull | Hourly bucket, spike rule and alert re-arm. |
| case-file | `argsDigest` in the tool loop subject. |
| case-file | The inner error code of a mounted tool's `isError`. |
| all three | Condition watches. Here they are owner-pushed standing reports: Fleet's full pass and the DomainEvents retry. |
| case-file / pull | Reports at the swallowed code-work, code-store and sandboxes loops. |
| pull | Minimal trace pinned once per case (write-once). |
| push | `afterCommit`, the outbox, the stream-prune exception, and `WeakSet` dedupe of api_error. |
| case-file | Case sampling that always keeps a new subject. |
| case-file | Shared `useDrawer`, which deletes Credits plumbing. |
| pull | The complete operator-read change, including the UI gate. |
| pull | Download case JSON. |

Avoided:

- Severe at first sight for non-500 5xx, `state_*` or `stateFault`.
- Recency-dropped alerts.
- A backfill.
- Ledger polling.
- Aggregate "loops".
- An allowlist classifier.
- `fleet.unclaimed` at `workflow.ts:728`.
- Process-global buses.
- An acked state.
- A per-event consumer.
- Sliding re-reporting floods.
- Free-text tails.
- `uncaughtException` handlers.
- A boots table.
- Workflows changes.
- Bundled ruling-dependent deletions.

## 1. Issue classes, and what counts

| Class | Covered by | Not covered (stated, not polled) |
|---|---|---|
| tool: agents' Merv tool calls erroring | `ToolRegistry.invoke` (every caller: MCP `http.ts:573`, leased `/mcp`, Pi `registry.ts:1085-1087`, `script.run` `scripts/src/tools.ts:189`); git push rejection | Errors returned by user code inside Sandboxes jobs |
| question: agents asking Pi or the user | `SessionMessages.ask`, `QuestionResponders.finish`, `toThread` answer; a stop without a handoff | Person→agent inquiries; `workflow.escalated` (system escalation, already on Work) |
| platform: fleet, runners, dispatch, Pi, code, sandboxes, API, plugins, process, floods | Owner sites in §3, the flood scan, the crash marker | Read-time findings (`no_live_runner`, `runner_refusing`, `session_idle`, `ready_quiet`, `work_deferred`); runner-local `lastError`; Sandboxes-service internals except through Fleet and floods; VM, Docker or Postgres down (needs an outside uptime check) |

## 2. Data model (`packages/issues/src/schema.ts`, component `issues`, version 1)

Run by `ctx.state.migrate('issues', issueMigrations)`. The header is "Published PostgreSQL migrations. Production pins each text by its digest: never edit one." Later changes are new versions only.

```sql
CREATE TABLE issues (
  id TEXT PRIMARY KEY,                         -- 'issue_' || left(fingerprint, 32): stable, so links survive
  fingerprint TEXT NOT NULL UNIQUE,            -- sha256Hex(JSON.stringify([class, where, code, key ?? null]))
  class TEXT NOT NULL CHECK (class IN ('tool','question','platform')),
  where_at TEXT NOT NULL CHECK (length(where_at) BETWEEN 1 AND 120),
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 120),
  key TEXT CHECK (key IS NULL OR length(key) <= 300),
  level TEXT NOT NULL CHECK (level IN ('notice','warn','severe')),
  loop BOOLEAN NOT NULL DEFAULT false,
  standing BOOLEAN NOT NULL DEFAULT false,
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  count BIGINT NOT NULL CHECK (count > 0),     -- every report ever folded in (a 1.7M flood stays one row)
  hour_at TEXT NOT NULL,                       -- 'YYYY-MM-DDTHH' that hour_count counts
  hour_count BIGINT NOT NULL,
  peak_hour BIGINT NOT NULL,
  stored INTEGER NOT NULL DEFAULT 0,           -- cases kept this episode
  kept_at TEXT, kept_subject TEXT,             -- sampling: last kept case
  note TEXT CHECK (note IS NULL OR length(note) <= 280),
  first_at TEXT NOT NULL, opened_at TEXT NOT NULL, last_at TEXT NOT NULL,
  resolved_at TEXT, resolved_by TEXT,          -- 'owner' | 'quiet' | admin label
  alerted_at TEXT,                             -- NULL while a severe episode owes its alert
  reopened INTEGER NOT NULL DEFAULT 0,
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX issues_recent ON issues(last_at);
CREATE INDEX issues_owed ON issues(opened_at) WHERE state='open' AND level='severe' AND alerted_at IS NULL;
CREATE INDEX issues_quiet ON issues(last_at) WHERE state='open' AND (standing OR level<>'severe');
-- issues_guard (BEFORE UPDATE OR DELETE, ERRCODE 23514, $merv$ style as session_questions_guard
--   sessions/src/index.postgres.ts:204-217): DELETE refused ('Issues are retained'); any change to
--   id, fingerprint, class, where_at, code, key, first_at refused; a falling count refused.

CREATE TABLE issue_occurrences (
  id TEXT PRIMARY KEY,                         -- newId('issue_case')
  issue_id TEXT NOT NULL REFERENCES issues(id),
  at TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('notice','warn','severe')),
  status INTEGER,
  repeats INTEGER NOT NULL CHECK (repeats > 0),   -- reports of this subject folded in within one flush
  project_id TEXT, subject TEXT, session_id TEXT, instance_id TEXT,
  release TEXT,                                -- refs.release ?? process.env.MERV_RELEASE ?? NULL
  refs_json TEXT NOT NULL,                     -- IssueRefs, ids only, <= 4 KB
  error_json TEXT,                             -- ErrorFacts, never a message
  note TEXT CHECK (note IS NULL OR length(note) <= 280),
  trace_json TEXT,                             -- write-once SessionTrace, or '{}' when none exists
  _merv_rowid BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);
CREATE INDEX issue_occurrences_issue ON issue_occurrences(issue_id, _merv_rowid);
CREATE INDEX issue_occurrences_session ON issue_occurrences(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX issue_occurrences_instance ON issue_occurrences(instance_id) WHERE instance_id IS NOT NULL;
CREATE INDEX issue_occurrences_unpinned ON issue_occurrences(_merv_rowid) WHERE trace_json IS NULL AND session_id IS NOT NULL;
-- issue_occurrences_guard (BEFORE UPDATE OR DELETE, 23514): DELETE refused; UPDATE allowed only
--   when OLD.trace_json IS NULL, NEW.trace_json IS NOT NULL and every other column is unchanged.
```

`issues` is the only mutable projection, and it is never deleted. Occurrences are write-once cases. Retention is forever, with no prune.

At prod volume, 100–300 reports a day collapse to roughly 50–150 kept cases a day, under 60k rows a year. A trace is typically under 1 KB.

### 2.1 Write path (`IssueStore`, `packages/issues/src/store.ts`)

`report(r)` runs: `try { state.afterCommit(() => enqueue(r, isoNow())) } catch {}`.

`enqueue` folds the report into `pending: Map<fpKey, Group>`:
- The key is `class\0where\0code\0key`. No hashing happens on the hot path.
- At most 2,000 keys. Overflow is counted and reported as `issues.dropped` (warn) at the next flush.
- Each group holds n, the max level, loop, standing, the latest note and status, and up to 20 subject buckets `{subject, n, at, refs, error: errorFacts(error), note, status, level}`. A 21st subject folds into the count only.
- Strings are clipped: where/code to 120, key to 300, subject to 200. `note` goes through `redacted(note, 280)` (contracts/text.ts).

`resolve(t)` records `{fpKey, seq}`. Reports and resolves of one fingerprint inside one flush apply in arrival order.

`flush()` runs every 1 s, unref'd, single-flight, and only if something is pending. It swaps the map and opens one `state.transaction`:
1. `SELECT * FROM issues WHERE fingerprint IN (…) FOR UPDATE`. Writers already serialise on the schema advisory lock (`postgres.ts:150-161`), so a read-then-write is race-free.
2. In JS, per fingerprint:
   - **New episode.** If there is no row, or the row is resolved: `opened_at = now`, `stored = 0`, level = the report's, `loop = flag`, `alerted_at = NULL`, `reopened += 1` (if a row existed).
   - **Open episode.** `level = max(old, new)` (it never falls); `loop ||= flag`.
   - **Fault rule.** Any subject bucket with `status === 500` makes the level severe.
   - **Count.** `count += n`, except a standing report on an open episode adds 0.
   - **Hour bucket.** If `hour_at` is this hour, add n; otherwise `hour_count = n`. Then `peak_hour = max`.
   - **Spike rule** (not for questions or standing): `hour_count >= 10` (platform) or `>= 60` (tool) makes it severe. If `alerted_at < start of this hour`, `alerted_at = NULL`, so a spike re-arms at most once an hour.
   - **Loop rule** (only for reports with a subject, not standing):
     - An in-memory fixed 10-min bucket per `fpKey + subject` (Map ≤ 5,000 keys, oldest evicted).
     - At 15 reports it sets `loop = true`, level severe, and `alerted_at = NULL` if not already a loop.
     - An owner `loop: true` (floods) does the same.
   - **Escalation.** A level that became severe sets `alerted_at = NULL`.
   - **Sampling.** Each subject bucket becomes an occurrence row when any of these holds (at most 20 per issue per flush; a standing open episode keeps only its first):
     - `stored < 50`;
     - `kept_at` is NULL or ≥ 10 min old;
     - `subject ≠ kept_subject`.
3. `INSERT INTO issues … ON CONFLICT (fingerprint) DO UPDATE SET <every mutable column = excluded.col>`, then `INSERT INTO issue_occurrences …`.
4. Owner resolves: `UPDATE issues SET state='resolved', resolved_at=?, resolved_by='owner' WHERE fingerprint IN (…) AND state='open'`.

A failed flush merges its groups back, bounded, and keeps them for the next tick (as `api/src/call-log.ts:53-73` does). It increments `flushFailures` (reset on success). After 30 consecutive failures, if any pending group is severe, the store sends one in-memory digest "Merv · issues cannot be recorded" through the sinks, at most once per 30 min. This is the stderr-plus-email fallback when the database is away.

### 2.2 Quiet, floods, pins (`packages/issues/src/watch.ts`)

**Quiet** (every 60 s). A read on `issues_quiet` first, and a write only if rows match:
- `standing AND last_at < now-10min`: resolved, `resolved_by = 'quiet'`.
- `NOT standing AND level <> 'severe' AND last_at < now-24h`: resolved.
- Severe non-standing issues close only by their owner or the admin.

**Flood scan** (every 5 min, non-overlapping windows).
- The cursor starts at `state.eventHead()` on plugin start, with no backfill.
- The scan is `state.eventCounts(cursor, min(head, cursor+100_000), 150)`. If more than 100k ids are pending, the cursor then jumps to head.
- Each row reports `{class:'platform', where:'events', code:'event_flood', key:`${type} ${subjectId}`, subject: subjectId, loop:true, level:'severe', n: count, refs:{projectId, eventType:type, subjectId, eventIds:[first,last]}}`.
- At 30 events a minute per (type, subject), it would have caught `code.main_landed` for `wf_12cba832…` (809/min) and `sbx_vor3btq3` (58/min) within one window, instead of 7 days.

**Pin** (every 60 s, only while `issue_occurrences_unpinned` has rows).
1. Read up to 200 unpinned cases with `at < now-60s`.
2. Call `ctx.get('sessions')?.running.platformTrace(sessionIds)` outside any transaction. If Sessions is absent, skip the pass.
3. Write `trace_json` once, when the trace's `closedAt` is set or the case is more than 24 h old. If no trace exists, write `'{}'`.

That write is the only `UPDATE` the occurrence guard allows. The pin copies what retirement migrations delete (`sessions/src/index.postgres.ts:552-595`, which also cascade `session_events`, `stream.postgres.ts:9`) and what the next visit overwrites (`threads.ts:458-468`).

### 2.3 State method (new, for the flood scan only)

- `contracts/src/index.ts`, State interface beside `eventHead` (`:640`): `eventCounts(after: number, through: number, atLeast: number): Promise<{ type: string; subjectId: string; projectId: string; count: number; first: number; last: number }[]>`.
- `state/src/postgres.ts`, on the readers pool: `SELECT type, subject_id, min(project_id), count(*)::int, min(id), max(id) FROM events WHERE id>? AND id<=? GROUP BY type, subject_id HAVING count(*)>=? ORDER BY 4 DESC LIMIT 20`. This is a PK range scan; at the observed peak (48,551/h) a window is about 4k rows.

### 2.4 Crash marker (no table)

`src/cli.ts serve` keeps `<directory>/serve.json`, which sits on the persistent `/var/lib/merv-ts` volume (`deploy/compose.yml`):

1. Before `createApp`, read any leftover marker into `previous`, then write `{startedAt, release: process.env.MERV_RELEASE ?? null}`.
2. `process.on('uncaughtExceptionMonitor', (e, origin) => writeFileSync(marker, JSON.stringify({...current, crash: {origin, ...errorFacts(e)}})))`. This write is synchronous, and Node's default exit is untouched. It also catches unhandled rejections, which Node 22 raises as uncaught.
3. If `createApp` throws, remove the marker. The boot refusal itself is reported (§3.3).
4. After `createApp`, if `previous` existed, report one `{class:'platform', where:'process', code: previous.crash ? 'crashed' : 'unclean_exit', key: previous.crash?.origin, level:'severe', refs:{release: previous.release}, note: undefined}`, with error facts from the crash (code, name, frames).
5. On a clean stop, unlink the marker.

This catches OOM, SIGKILL and uncaught crashes pinned to the release that crashed. There are no heartbeat writes.

## 3. Collectors (owner sites)

Every report goes through `reporter(ctx)` and is held by afterCommit. Reports that cause a rollback are made outside the transaction. A warn or severe report also writes one stderr line `{event: where, code, level, key, subject, status, …refs, name, at, sqlstate, table, constraint}`, rate-limited to one per issue every 10 s. That line replaces each site's hand-written line, so docker greps keep working and nothing is silent while the database is down.

### 3.1 Class 1: tools

- **`api/src/registry.ts` `invoke`** (`:914-960`). The report goes in the catch (`:956-958`) and the mounted `isError` branch (`:951-954`).
  - **where:** `${identity.tool}:${identity.action}` once identity is resolved, otherwise the raw name.
  - **code:**
    - the `MervError.code`;
    - for a mounted `isError`, the inner `error.code` parsed from its JSON text (Sandboxes), else `tool_error`;
    - otherwise `internal_error`.
  - **status:** the error's status, else 500.
  - **subject:** `${caller.session?.id ?? caller.conversation?.id ?? caller.actorId}:${argsDigest}`, where `argsDigest = digest([name, input]).slice(0,16)`, computed only on failure.
  - **refs:** `{projectId, actorId, client, sessionId, threadId, invocationId, conversationId, commandId, allocationId: conversation.runtimeId ?? managed.allocationId}`.
  - **error:** the error itself.
  - **invocationId** is plumbed: `run()` calls `seen({...identity, invocationId: prepared.caller.session?.invocationId})` once `prepared` resolves (`registry.ts:1017`). The catch has only the transport caller (`:923`).
  - **Filters:**
    - `MervError.wait` is never reported (`contracts/src/index.ts:85-87`).
    - Callers that are neither an agent, a session nor a conversation are reported only at status ≥ 500.
    - `open()`'s stopping refusal (`:922`, outside the try) is never reported.
  - **Levels:**
    - status 500 or a non-MervError: severe (the store's fault rule);
    - other ≥ 500 (`state_busy`, `state_timeout`, `unavailable`): warn, raised by the spike rule;
    - `execution_tool_forbidden`, `execution_arguments_forbidden`, `execution_reference_unavailable`: warn;
    - every other 4xx and `tool_error`: notice.
    - Never `stateFault()` alone (it matches 409 `transaction_conflict` and 400 `state_invalid_value`, `contracts/src/index.ts:124-132`).
  - Each reported error object is added to `tools.reported: WeakSet<object>` (a registry field).
  - The existing `log` closure stays unchanged until the ledger ruling.
- **`api/src/http.ts` `logFailure`** (`:97-133`) becomes:
  - `if (status < 500 || this.stopping || tools.reported.has(error)) return;` (`stopping`: `http.ts:246`, `:396`);
  - report `{class:'platform', where:'api_error', code, key: where (route or 'mcp'), status, error}`, level warn. The fault rule makes 500s severe, and the spike rule handles a burst of 503s.
  - The function becomes an `ApiServer` method. This removes the release-time 503 pages (`POST /sessions/runners/shutdown`).
- **`code/src/store/http.ts:1110-1123`, git push rejected.**
  - **where:** `git.push`; **code:** the `MervError.code` or `code_git_rejected`; **level:** notice.
  - **subject:** `push.fence.sessionId ?? projectId`; **refs:** `{projectId, pushId: id, sessionId: fence.sessionId, instanceId: fence.unitId}`.
  - The loop rule fires at the 15th rejection in 10 min, so the dead lease's 1,880 rejections (about 22 per 10 min) page within about 10 min.
  - The stderr line no longer carries `error.message`; the pusher's socket still gets the reason.

### 3.2 Class 2: questions (`packages/sessions/src`)

- **`messages.ts` `ask()` (`:639-692`).** The report goes after the INSERT and the `question_asked` event.
  - `{class:'question', where:'session.ask_owner', code:'asked', key: questionId, note: question, refs:{projectId, sessionId, threadId, instanceId, revision, questionId}}`.
  - `reserve()` (`question-responder.ts:50`) now returns whether a responder took it. Level is notice when one did, and severe when none is registered: nobody would answer, so a person must.
- **`question-responder.ts` `finish()` (`:68-88`)** gains a `cause?: string`.
  - On `needs_you`: report the same key at severe with `code:'needs_you'`.
  - If `cause !== 'pi'`: also report `{class:'platform', where:'sessions.question_responder', code: cause, refs:{questionId, …}}`, severe. The causes are:
    - `responder_unloaded` (`:36-47`);
    - `responder_deadline` (`:115-125`);
    - `responder_silent` (the 10 s race, `:179-183`);
    - `responder_failed` (the catch, `:184-190`).
  - `messages.ts:268-269` passes `'pi'`.
  - On `answered` or `obsolete`: resolve the question.
- **`messages.ts` `toThread()` (`:556-581`).** For each answered `open` row: `resolve({class:'question', where:'session.ask_owner', code:'asked', key:id})` and the same with `code:'needs_you'`.
- **`index.ts` `closeSession`** with reason `STOPPED_WITHOUT_HANDOFF` (`rules.ts:62`): `class:'question', where:'session.stopped', code:'stopped_without_handoff'`, warn (the implicit question).

Pi answers 136 of 154 questions (p50 346 s). Those stay notice and resolve on their own; only `needs_you`, a missing responder or a failed responder page.

### 3.3 Class 3: platform

**Sessions:**

| Site | Report | Level |
|---|---|---|
| `index.ts:940-949` counted failure (after `dispatch.failed`) | where `sessions.launch`; code = failure (`host_failed`, `crash_loop`, `workspace_failed`, `launch_failed`, `offer_expired`, `review_unfinished`) or `model_interrupted`; key = reason if `/^[a-z0-9_.:-]{1,80}$/` else `other` (halts are free text); subject `${instanceId}@${revision}`; refs {projectId, sessionId, threadId, instanceId, revision, runnerId, hostRef} | warn, spike → severe (≥10/h) |
| `dispatch.ts:919-925` lease loop, `error.silent` | where `dispatch.offer_failed`, code, status, subject instanceId, refs {projectId, instanceId, revision}. The write at `:1156-1170`, inside the rolled-back lease, is deleted along with its 300-char message | warn (500 → severe) |
| `dispatch.ts:1095-1098` inquiry refused | where `dispatch.inquiry_refused`, code, subject inquiryId | warn |
| `dispatch.ts:335` `reportHold(row)` | row set: where `dispatch.launch_held`, code = `row.last_code`, key = instanceId, subject `${instanceId}@${revision}`, refs {projectId, instanceId, revision, sessionId: last_session_id}. row null: resolve. This covers the dispatch toggle reset (`budgets.ts:77-87` calls `reportHold(null)`) and re-reports the 3 standing holds at first boot (`dispatch.ts:222-245`) | severe |
| `index.ts:2106-2118` `alone()` | where `sessions.sweep_failed`, code, subject; replaces the stderr write | warn (a subject failing every 30 s pass becomes a loop at 15, about 7.5 min) |

**Fleet** (`packages/fleet/src`). The module `report()` at `index.ts:117-121` becomes a method that uses `this.issues`. Its refs are `{projectId, allocationId, sandboxId, launchId, profileId, runtimeRelease: profile.releaseId, instanceId from owner work:<id>}`.

| Site | Report | Level |
|---|---|---|
| `index.ts:1006` `fleet.retry` | only when counting (not `booting`, `:1033`); subject = allocation | notice; severe once failures ≥ 5 (this is how an expired Cloudflare token pages) |
| `index.ts:1164` `fleet.refused` | wallet codes | notice; otherwise severe |
| `index.ts:1193` `fleet.not_ready`, `:900` `fleet.unpriced` | | severe |
| `index.ts:475` pass `.catch(() => false)` | where `fleet.pass` | warn (failing every pass becomes a loop) |
| `index.ts:978-979` | runtime `stopped` while intent `run`: where `fleet.machine_gone`, code `stopped`, subject allocation | severe |
| reconcile full pass (`:985-987`), new `watch(a)` per open allocation (standing) | `fleet.stuck_releasing` (releasing ∧ shutdownRequired ∧ ¬shutdownAcknowledged ∧ updatedAt > 10 min; severe, key allocation); `fleet.queued` (queued > 15 min; warn, key allocation). This replaces renewal-gated detection (`index.ts:1086` runs only within 60 s of lease expiry) | as stated |
| `workflow.ts:157-160` `skipped()`; swallowed reconcile catches `:268`, `:272`, `:615` | where `fleet.workflow_skipped` / `fleet.reconcile` | `sandbox_not_connected` notice, otherwise warn |
| `workflow.ts:881` exhausted unclaimed streak (not `:728`) | standing `fleet.unclaimed`, key `${projectId} ${target}`: hosted machines that never claim work | severe |

**Pi** (`packages/pi/src`):
- `hosts.ts` `interrupt()` (`:326-345`), after `saveCommand`, except `cancelled`. It gains an optional `note`.
  - where `pi.turn`, code = the `PiInterruption`, subject conversationId, refs `{projectId, conversationId, commandId, allocationId: runtimeId, hostId}`.
  - Levels: `service_unavailable` and `checkpoint_unavailable` are severe; `wallet_refused` and `ambiguous_prompt` are notice; the rest are warn (77 `worker_interrupted` a week; the spike rule pages a burst).
- `worker-protocol.ts` `fail()` (`:862-873`): its stdout `pi_turn_failed` block is deleted, and its schema-bounded `value.reason` becomes the interrupt's `note`.
- `hosts.ts:384`, `:395`, `:398`, `:408` swallowed catches: where `pi.hosts`, warn.

**Code and code-work, swallowed loops.** Each reports at its catch with `subject = where`. Level is warn, and a failing tick becomes a loop, which is severe.
- `code/src/store/operations.ts:87`, `:101`: `code.maintain`.
- `code/src/store/receive.ts:655-656` final capture quarantined: `code.capture_quarantined`, severe, refs `{projectId, instanceId: unitId}`.
- `code-work/src/bases.ts:250-254`: `code_work.bases`.
- `code-work/src/service.ts:253-262`: `code_work.landing`.

**Sandboxes:** `integration.ts:75-78` reports `sandboxes.runs` and `sandboxes.evidence`; `sandbox-runs.ts:190` reports `sandboxes.retire`. Both warn.

**DomainEvents:** `index.ts:283-305`, after the attempts UPDATE: standing `{where:'consumer', code, key: consumer.id, refs:{eventIds:[cursor+1, cursor+1]}}`. Level is warn, and severe at attempts ≥ 5. It resolves quietly 10 min after the consumer stops failing.

**Composition root** (`src/app.ts`, `src/cli.ts`):
- **Root exporter.** Before the loader plugin, `ctx.logger.exporter({ export: (m) => m.type === 'error' && report({class:'platform', where:'plugin', code: m.args[0]?.code ?? 'plugin_failed', key: m.name, level:'severe', error: m.args[0]}) })`. Cordis `lib/index.js:592-598` produces that message shape. This catches effect, reload and dispose crashes (`:741`, `:886`, `:932`, `:973`, `:995`) that today stay in the 1,000-entry ring.
  - Reports made while `issues` is absent are buffered (≤ 50) and replayed after the second `settle()` (`app.ts:242`).
- **Boot refusal.** Before `assertReady` throws (`app.ts:243`), each inactive required entry is reported as `{where:'plugin', code: entry.state, key: entry.id, level:'severe'}`. createApp's catch `ctx.fiber.dispose()` (`:281-284`) then runs the issues disposer: final flush, then one alert pass (≤ 10 s). So the 2026-09-16 kind of crash loop mails on its first failure.
- **Other sites.** The `log` helper (`app.ts:35`) is deleted. `composition.restore_failed` (`:205`) and `secrets.platform_unopened` (`:240`) become buffered reports at severe. `cli.ts:204` `console.error(error)` becomes a `main.stop_failed` line built from `errorFacts`, with no message.
- **Crash marker:** see §2.4.

## 4. Traceability

**Code identity.** `MERV_RELEASE` reaches Main as a runtime env, never as a build arg, so image IDs stay byte-identical across the full, `--expected-image`, prebuilt and retry paths (`release.mjs:68-155`).
- `release.mjs` writes `printf 'MERV_RELEASE=%s\n' '${release}' > source/deploy/release.env` before the first compose call.
- `deploy/compose.yml` `control.env_file` gains `- path: release.env, required: false`.
- Rollback runs compose in `PREV_DIR` (`release.mjs:176`, `:203`), which is the previous release's `source/deploy`, so it picks up that release's own file. Hosted-release recreates run in the same working directory.
- Every case stores `release`. `<stamp>-<sha8>-<content12>` gives `git checkout <sha8>`. A UI-only release leaves the server's id alone, which is correct.

Pinned at capture, from the ids the owner holds:

| Case | Ids |
|---|---|
| Leased tool call | sessionId, threadId, invocationId (the exact `session_tool_calls` row), argsDigest |
| Outside agent | projectId, actorId, client: all MCP carries. No agent id exists over MCP (0/248) |
| Pi | conversationId and commandId (`pi_commands` keeps every tool input, output and error), allocationId (runtimeId), hostId |
| Question | questionId, asking sessionId, threadId, instanceId, revision |
| Launch | sessionId, threadId, instanceId, revision, runnerId, hostRef |
| Fleet | allocationId (`fleet_allocations` never deleted), sandboxId (Sandboxes `sandbox_events`), launchId, profileId, runtimeRelease `rt1_…` (`HOSTED_RELEASES.md` gives sourceCommit) |
| Git | pushId (`code_git_pushes` fence) |
| Flood | eventType, subjectId, `[first,last]` event ids (`SELECT * FROM events WHERE id BETWEEN …`) |
| 5xx | frames (file:line in that release), sqlstate, table, constraint |

**Pinned once, after the visit ends** (`trace_json`, §2.2), by the new `sessions.running.platformTrace(sessionIds): Promise<Map<string, SessionTrace>>` in `sessions/src/running.ts`. It is documented as "Platform admin read, never exposed through a tool, a lease or a machine key". It is one snapshot join of:
- `worker_sessions`: thread, instance, revision, role, status, outcome, close_reason, runner_id, host_ref, created and closed;
- `session_threads`: harness;
- `session_transcripts`: uploaded sha256 and size; the blob is `transcripts-<projectId>/<sha256>`, permanent;
- `session_workspaces`: branch, base, head and tree OIDs from attachment/result_json;
- `session_managed_assignments`: allocation.
- The conversation is `session_threads` sha256/size while `latest_session_id` is this visit, otherwise the next visit's `session_json.continuity.resume` (`threads.ts:281-286`). That recovers the pointer `threads.ts:458-468` overwrites.

**Stream retention.** `SessionStreams.prune` (`stream.ts:343-348`) adds `AND EXISTS (SELECT 1 FROM session_transcripts t WHERE t.session_id=worker_sessions.id AND t.uploaded_at IS NOT NULL)`. A visit whose machine vanished before upload keeps its stream, its only record, past 30 days. A retirement migration still cascades it (`stream.postgres.ts:9`); the pinned trace and ids survive that.

**Reading what agents said.** This is the founder ruling below, and the default is yes.
- `rules.ts:81` becomes `readsAgents = (actor: Pick<Actor,'id'|'role'>) => actor.role === 'operator' || actor.id === PLATFORM_ACTOR`.
- `PLATFORM_ACTOR` moves from `scope/src/index.ts:96` to `contracts/src/scope-models.ts`, re-exported by scope.
- All three gates pass the actor: `threads.ts:940-945`, `stream.ts:185`, and the UI `session.tsx:67-70` (which gates `trajectory.tsx:141`, `threads.tsx:712` and `agents-gallery.tsx:68`).
- The platform caller is vouched by `scope.platformRead` (`scope/src/index.ts:803-825`), and its reads stay audited hourly (`admin/src/platform.ts:19-24`). Pi conversations stay out of the drill-in.

**How the admin follows a case:**
1. The email link `/ui/admin/issues?issue=<id>` opens the drawer.
2. Each case row has `Thread →`: `/ui/admin/p/<projectId>/work?key=work:<instanceId>&thread=<threadId>`, or `/ui/admin/p/<projectId>/sessions?thread=<threadId>` without an instance. It opens with `reloadDocument`, as `admin/work.tsx:73` does, and lands on the record page's Agents tab and trajectory for that visit.
3. `Download case` saves the `GET /admin/issues/:id` JSON (the issue and every case with refs, error, note and trace): the hand-off to an investigating agent.
4. Every id (session, invocation, conversation, allocation, sandbox, release, transcript sha, OIDs) appears only in the case row's hover title.
5. Off-UI recipe:
   - `git checkout <sha8>`;
   - `git -C /var/lib/merv-ts/code/<sha256(projectId)[0:32]>/repository.git show <headOid>` (gc is off);
   - blobs `transcripts-<projectId>/<sha>` and `conversations-<projectId>/<sha>`.
6. The reverse direction, which cases a visit or a unit hit, uses `issue_occurrences_session` and `issue_occurrences_instance`.

## 5. Severity, loops, lifecycle, alerts

**Levels.** Levels are notice < warn < severe, and the owner sets them per §3. An omitted level is warn, so a new failure is visible by default. Generic store rules only ever raise the level:
- status 500 makes it severe;
- a spike (platform ≥ 10 an hour, tool ≥ 60 an hour; never questions or standing reports) makes it severe and re-arms the alert at most once an hour;
- a loop (15 reports with the same fingerprint and subject in a 10-min bucket, or owner `loop`) makes it severe and re-arms the alert;
- floods are loops (§2.2).

An agent retrying a few times stays on the board; only a runaway pages.

**Lifecycle.** An issue is open or resolved, with no acked state.
- An owner resolves it when the question is answered or obsolete, or the hold is released or reset.
- An admin resolves it with `Resolve issue`, which is audited.
- Quiet resolution: a standing issue 10 min after its last report; a non-severe issue after 24 h.
- The next report opens a new episode: `opened_at` resets, the 50-case cap resets, the level resets, `alerted_at` is NULL and `reopened` increments.
- Each episode alerts once.

**AlertSink** (`packages/issues/src/alerts.ts`): `interface AlertSink { readonly name: string; send(digest: AlertDigest): Promise<void> }` and `AlertDigest = { at: string; issues: { id; title; level; loop; count; openedAt; url }[] }`. Issues are codes only; the title is `words(where) · words(code)`, and there are no notes or agent text.
- Sinks come from config only: today `alerts.email` gives an `EmailSink` over `ResendMailer` and `emailHtml` (`scope/src/mail.ts:45-88`).
- The mailer is built at send time, so a key replaced on the Credentials page applies immediately, and a missing key gives `email_unavailable`.
- `ResendMailer.send` takes one `to` (`mail.ts:66`), so the config takes one recipient.
- A future webhook is one more config key; every configured sink receives every digest.

**Alert pass.** It runs at plugin start, every 30 s, and in the disposer after the final flush (≤ 10 s).
1. Read `issues_owed` for `where_at` not starting with `issues.`.
2. If none, do nothing.
3. Otherwise send one digest of up to 20, but only if `max(alerted_at)` across issues is ≥ 5 min old. That is a durable throttle, so a restart never resends early.
4. Subject: `Merv · <title>` for one issue, otherwise `Merv · N severe issues`. Each line is `title · count · since`, plus the link `${publicOrigin}/ui/admin/issues?issue=<id>`. The Idempotency-Key is `issues-${sha256Hex(ids+openedAts).slice(0,32)}`.
5. On success, set `alerted_at = now` for those ids. On failure, they stay owed (never dropped by age); back off 1→2→4→10 min in memory, and report `issues.alert` / `alert_failed` warn, which is never emailed.

**Latency.**

| Event | Time to inbox |
|---|---|
| Severe report | about 1 s flush plus ≤ 30 s sweep plus Resend, under a minute after a quiet period; at most 5 min inside a burst (one mail per 5 min) |
| Standing condition | its threshold plus one Fleet poll |
| Flood | ≤ 10 min |
| Crash | the next boot's start pass |
| Boot refusal | at dispose, within seconds |

**Badge.** The admin rail's Issues row shows the count of open severe issues, from the same `/admin/issues` read the page polls. Zero renders nothing.

## 6. Service interface

The contract is `packages/contracts/src/issues.ts`, given verbatim in `interfaceTs`: `Issues`, `IssueReport`, `IssueRefs`, `IssueTarget`, `ErrorFacts`, `SessionTrace`, `IssueRow`, `IssueCase`, `IssueStore`, the cordis augmentation `issues: IssueStore`, `silent`, `errorFacts()` and `reporter()`.
- The `bearer` regex moves from `runner/src/transcript.ts:16-17` to `contracts/src/text.ts`. The runner re-exports it.
- `redacted(value, max)` (cleanText + every bearer → `[redacted]` + clip) is added beside it.

**Plugin `merv-issues`** (`packages/issues/src/index.ts`):
- Config: `z.object({ alerts: z.object({ email: mailSchema('Issue alerts').extend({ to: z.string().email() }).optional() }).strict().default({}) }).strict().default({})`. The key env carries the description "Issue alerts · Resend API key", so the Credentials page lists it.
- `inject: ['state']`.
- Effect:
  1. migrate;
  2. `new IssueStore(ctx, config)`;
  3. unref'd timers (flush 1 s, alerts 30 s, quiet and pin 60 s, floods 5 min), each skipped while `bootMaintenance.active`;
  4. start an alert pass;
  5. yield a disposer that clears the timers, awaits any in-flight send, runs the final flush and then one bounded alert pass;
  6. `yield ctx.provide('issues', store)`.
- Owners are read only with `ctx.get('sessions')` at call time.
- `config/default.json` gains `{ "id": "issues", "name": "@merv/issues", "required": false }`, placed before `domain-events`.

**Owner wiring.** Each owner adds one field `issues: Issues = silent`, set in its plugin's apply as `x.issues = reporter(ctx)`:
- ToolRegistry and ApiServer (`api/src/index.ts`);
- LeasedSessions (`sessions/src/index.ts:2173-2200`), which passes closures to dispatch, messages and responders;
- Fleet and FleetWorkflowAdapter;
- PiService/core;
- the code service;
- code-work;
- sandbox integration;
- DurableEvents.

`src/app.ts` and `src/cli.ts` call `reporter(ctx)` directly. No inject edge is added anywhere.

## 7. Admin routes (`packages/admin/src/issues.ts`, spread into `admin/src/index.ts:73-78`)

All routes sit behind `adminOf`. When `ctx.get('issues')` is absent they answer `check(issues, 'issues_unavailable', …, 503)`.
- `GET /admin/issues` returns `AdminIssues { rows: AdminIssue[]; open: number; severe: number; at }`. `AdminIssue = IssueRow` with `projects: {id,name}[]`, names joined from `scope.directory()`. One read serves the page and the badge, so there is no `/count` route (the matcher takes the first match, `admin/src/index.ts:51-55`).
- `GET /admin/issues/:id` returns `AdminIssueDetail { issue: AdminIssue; cases: (IssueCase & { project: {id,name} | null })[] }`. Unknown ids answer 404 `not_found`.
- `POST /admin/issues/:id/resolve` takes body `{}` and returns `{ id, state }`. It calls `store.close(id, who.label ?? who.subject)` and `env.audit.record(who, 'issues.resolve', id)`.

The types are written out in `admin/src/models.ts` (`export type` only), so the browser imports them.

## 8. UI (`packages/ui/web/admin/issues.tsx`)

It follows `docs/UI_DESIGN.md`: no ids as text, no legends or explanatory text, absence renders nothing, an error is never shown as empty.

**Rail.**
- `app.tsx:18-22` PLACES gains `{ to: '/admin/issues', label: 'Issues', icon: 'alert' }` after Work, and a Route.
- `AdminApp` reads `useTool<AdminIssues>('/admin/issues', {}, { every: 30_000 })` (the same read the page shares) and passes `count={data?.severe}` to that RailRow (`shell.tsx:43-82`).

**Page:** ListPage + useListFilter + Ruled, as on `admin/work.tsx`, polled every 10 s.
- Head `Issues`, with facts `[severe>0 && [severe,'severe',true], [open,'open']]`.
- Behind the quiet Filter word:
  - Chips Class (Tools · Questions · Platform, with counts);
  - Level (Severe · Warn · Notice);
  - `Resolved` (the last 7 days).
  - Search covers titles, project names and notes; the id matches by prefix only.
- Columns:
  - Issue: the class word faint, then the title `words(where) · words(code)`, or for a question the first sentence of its note; one faint line of the note under it.
  - Level: a Word in its tone, plus `loop` in the bad tone.
  - Count: compact, with the peak per hour in the hover title.
  - Project: the name for one project, otherwise the figure.
  - Last: Ago.
  - Since: the episode's age, with the first-seen stamp in the hover title.
- Order: open severe, then warn, then notice, each newest-first; then resolved.
- Empty: `Nothing open`.

**Drawer:** the running-plane / running-panel pattern of `credits.tsx`, through the new shared `useDrawer(rows, openId, setOpen)` in `admin/parts.tsx`.
- It opens from a row or from `?issue=<id>`. ↑/↓ step through issues and Esc closes.
- It holds:
  1. the title and Close;
  2. `Resolve issue` (not the accent; absent once resolved) and `Download case`;
  3. one fact line: level · loop · count · since · last;
  4. the note;
  5. the error: code · status, then up to 3 frames in faint mono;
  6. cases, newest first: Ago · project · role and harness words · outcome words · `Thread →`, with every id in the row's hover title.
- `docs/UI_DESIGN.md` verb table gains `| Resolve | closes an issue; its next occurrence reopens it | Resolve issue |`. `Download case` uses the existing Download verb.

**Superseded-UI test.**
- Credits' drawer keyboard, focus-return and escape plumbing (`credits.tsx:405-436`) moves into `useDrawer`, a net deletion.
- Work's attention line (state of running units), Credentials' relay outcomes (key health) and members' Needs-you cards are not incident history, so they stay.

## 9. Deletions

- `api/src/http.ts:97-122`: the `logFailure` body; frames and SQL cause move to `errorFacts`.
- `sessions/src/index.ts:2111-2114`: the stderr block in `alone()`.
- `sessions/src/dispatch.ts:1158-1170`: `dispatch.offer_failed` written inside the rolled-back lease, including its 300-char message.
- `dispatch.ts:1096-1098`: the inquiry_refused stderr block.
- `fleet/src/index.ts:117-121`: the module `report()` stderr body.
- `fleet/src/workflow.ts:157-160`: the `skipped()` body.
- `pi/src/worker-protocol.ts:864-872`: the stdout `pi_turn_failed` block.
- `code/src/store/http.ts:1119-1121`: the stderr write, and `error.message` leaving the logs.
- `src/app.ts:35`: the `log` helper.
- `src/cli.ts:204`: `console.error(error)`.
- `runner/src/transcript.ts:16-17`: the bearer regex, moved.
- `ui/web/admin/credits.tsx:405-436`: drawer plumbing, moved into `useDrawer`.
- About 12 silent `.catch(() => …)` swallows become reports at no line cost.
- Not deleted pending a ruling: the `agent_tool_calls` ledger (`api/src/call-log.ts` and its wiring, `types.ts:87-98`, the registry `log` closure, and the tests in `tests/noun-tools.test.ts` and `tests/tool-compat.test.ts:563`). Deleting it is about −147 source and about −150 test lines in a follow-up merge.

## 10. Config and env

- `config/default.json`: the `issues` entry with `required: false`. `tests/config.test.ts` pins it: the core list includes `issues`; the required-for-all test becomes `required === !['feed','issues'].includes(id)`; the API selection count goes 46 → 47 if the entry is in that selection.
- `deploy/render-config.mjs`: it does not use `set()`, which forces `required: true` (`:93-99`). When `MERV_ISSUES_ALERT_TO` is set, the issues entry's config becomes `{alerts:{email:{apiKeyEnv: MERV_ISSUES_RESEND_KEY_ENV || 'RESEND_API_KEY' (required), from: MERV_ISSUES_ALERT_FROM || 'Merv <alerts@rapidreview.io>', publicOrigin: origin('MERV_TS_PUBLIC_ORIGIN'), to}}}`. Unset, there is no email and only the badge shows.
- `deploy/typescript.env.example` gains the three variables, commented.
- `deploy/compose.yml` and `deploy/release.mjs`: the `release.env` change in §4.

## 11. Tests

| File | Covers |
|---|---|
| `tests/issues.test.ts` | fingerprint and episode; afterCommit rollback drop; readFirst not double-counted; sampling (cap, 10 min, new subject); loop at 15; spike re-arm; standing count-once and quiet in 10 min; quiet 24 h; guards raise 23514; flood scan through `eventCounts` with non-overlapping windows; pin pass write-once; alert digest throttle, idempotency, retry with no loss, never mails `issues.*`; boot and dispose alert pass; DB-down fallback |
| `tests/issues-tools.test.ts` | invoke reports with level rules; wait skipped; non-agent 4xx skipped; argsDigest subject; inner mounted code; invocationId; `reported` WeakSet; logFailure skipped while stopping; git push rejection |
| `tests/issues-sessions.test.ts` | ask notice; no responder severe; needs_you severe plus the responder platform issue per cause; answer resolves; closeSession failure; offer_failed from the lease loop; hold report and resolve including the dispatch toggle; `platformTrace` with the continuity fallback; prune keeps transcript-less streams; platform reader reads a conversation |
| `tests/issues-platform.test.ts` | fleet machine_gone, stuck_releasing, unclaimed, retry level; Pi interrupt with note; consumer standing; code-work and sandboxes swallows |
| `tests/admin-issues.test.ts` | routes through `tests/fixtures/admin.ts`, 503 when absent, audit on resolve, project names |
| `tests/ui-admin-issues.test.ts` | rows, badge, drawer, `?issue=` |
| `tests/issues-boot.test.ts` | root exporter, plugin_unavailable report and flush on refused boot, crash marker ingest |
| Existing line-format updates | `tests/api.test.ts:479`, `tests/sessions-sweep.test.ts:128,187`, `tests/session-liveness.test.ts:512`, `deploy/render-config.test.mjs` |

## 12. Rollout

1. Deploy with `MERV_ISSUES_ALERT_TO` unset for one day. Watch the board, tune two or three owner levels if notices are noisy, then set the recipient. The sender must be a verified Resend domain.
2. There is no backfill. The 3 held launches are re-reported at boot by `dispatch.ts:222-245`, Fleet's watch reports the 3 stuck-releasing allocations on its first full pass, and the 10 historical needs_you questions stay on Work.
3. The stderr line format changes to `{event: where, code, level, …}`, keeping event names. VM grep recipes keep working by event name.
4. Regenerate `docs/architecture` (`npm run docs:architecture`) after all slices land.
5. Releases built before this change have no `release.env`, so their cases show no release.
6. Main cannot alert when the VM, Docker or Postgres is down; that needs an outside uptime check, which is out of scope.

## 13. Corrections to the candidate designs

1. **Release identity.** A `MERV_RELEASE` build-arg changes image IDs and breaks the `--expected-image` and prebuilt paths (`release.mjs:111-155`). Use a runtime `release.env` per release directory instead; rollbacks to `PREV_DIR` stay correct.
2. **Email recipient.** `ResendMailer.send` takes a single `to` (`scope/src/mail.ts:66`), so there is one recipient.
3. **Workflows blockers.** `replaceBlockers` returns `void` and `clearBlockers` is a bare DELETE (`workflows/src/blockers.ts:60-150`). There is no Workflows hook; holds are reported by Sessions' `reportHold`, which also runs on the dispatch toggle (`budgets.ts:86`).
4. **Stuck releasing.** It is caught at `fleet/index.ts:1086` only within 60 s of lease expiry. Detection moves to a standing check in Fleet's full pass.
5. **`stateFault`.** It matches 409 and 400 codes (`contracts/src/index.ts:124-132`), so levels key on status 500 only.
6. **invocationId.** It is not on the caller at the invoke catch (`registry.ts:923`); it is plumbed from `prepared.caller` (`:1017`).
7. **Retained streams.** `session_events` is `ON DELETE CASCADE` (`stream.postgres.ts:9`). A kept stream is not "the only record" against retirement; the pinned trace is.
8. **Drill-in reads.** Widening `readsAgents` at the server alone leaves the drill-in Agents tab empty; the UI gate (`session.tsx:67-70`) changes too.
9. **Conversation pointer.** The overwritten pointer survives in the next visit's `continuity.resume` (`threads.ts:281-286`), and each visit's own transcript row survives (`threads.ts:946-952`).
10. **Route matching.** `GET /admin/issues/count` would collide with `:id` (first match wins, `admin/src/index.ts:51-55`). There is one list read instead.
11. **Line drift.** `settle()` and `assertReady` are at `app.ts:242-243`.
12. **Unclaimed hosts.** "Runners not triggering" for hosted work is the exhausted streak at `fleet/src/workflow.ts:881`, not the per-host lapse at `:728-729`.
13. **`fleet.retry` placement.** `fleet.retry` (`index.ts:1006`) runs outside any writer.
14. **Sessions platform reads.** Sessions' platform reads live on `sessions.running` (`running.ts:618`); `platformTrace` goes there, and there is no `platform.ts`.
15. **`snapshotTransaction`.** It nests (contracts State docs). Pull's argument does not apply here because no event consumer is used.

## 14. Estimated size (source, excluding tests and docs)

| Package | Added / removed |
|---|---|
| @merv/issues | +500 |
| contracts (`issues.ts` 283, about 110 of which are doc comments and types, plus text and State) | +305 |
| state | +14 |
| runner | −8 |
| api | +32 / −26 |
| code | +16 / −3 |
| sessions (`platformTrace` 45) | +105 / −22 |
| scope | ±1 |
| fleet | +30 / −8 |
| pi | +12 / −10 |
| code-work, sandboxes, domain-events | +16 |
| src | +45 / −3 |
| admin | +85 |
| ui (`issues.tsx` 185, `useDrawer` +30 / credits −32) | +240 / −35 |
| deploy and config | +22 |

That is about +1,420 / −115, net about +1,300. Ruling-dependent offsets: deleting the ledger saves about −147.
