# Issues

What went wrong anywhere in Merv, said once by its owner where it went wrong, kept over time and
shown to the platform admin. Three classes:

| Class      | What                                                                                       | Where it is said                                                                  |
| ---------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `tool`     | an agent's Merv tool call that failed                                                      | `ToolRegistry.invoke` (MCP, leased `/mcp`, Pi, `script.run`), a rejected git push |
| `question` | an agent asking Pi or its owner                                                            | `session.ask_owner`, its responder, a visit that stopped without a handoff        |
| `platform` | Fleet, runners, dispatch, Pi, code, sandboxes, API 5xx, plugins, the process, event floods | the owners' own failure points (§3), the flood scan, the crash marker             |

Not covered: read-time findings (`no_live_runner`, `session_idle`, …), runner-local errors, the
Sandboxes service's internals except through Fleet and floods, and the VM, Docker or Postgres
being down, which needs an outside uptime check.

Severe issues reach the founder in Slack within a minute (§5).

## 1. Shape

- **Plugin.** `@merv/issues` (`merv-issues`), `required: false`, injects only `state`, one
  migration component `issues`. It is placed before `domain-events` in `config/default.json` and
  `config/production.example.json`.
- **Contract.** `@merv/contracts/issues`: `Issues` (`report`, `resolve`), `IssueReport`,
  `IssueTarget`, `IssueStore` (the service, `ctx.issues`), `silent`, `errorFacts`, `reporter`,
  `issueCode` and `swallowed`. Its data types (`IssueRefs`, `ErrorFacts`, `SessionTrace`,
  `IssueRow`, `IssueCase`, the class, level and state unions) live in the node-free
  `@merv/contracts/issue-models`, which `@merv/admin/models` and the browser import.
- **Owners.** Each owner holds `issues: Issues = silent`, set in its plugin as
  `x.issues = reporter(ctx)`. `reporter` looks `ctx.get('issues')` up at every call, so no owner
  imports `@merv/issues` and no inject edge is added: Issues may be absent, reloading or failing.
  `issueCode(error)` is a MervError's code, else `unexpected`; `swallowed(issues, where, level?)`
  is the catch of a pass whose failure the next pass retries (platform, `subject = where`, warn).
- **Rules.** Telemetry never throws, waits or decides a call. A report keeps codes and ids only;
  an error is kept as `errorFacts` (name, MervError code and status, three frames of a fault,
  sqlstate, table, constraint, refused field paths), never its message. The one exception is
  `note`: owner-bounded words (a worker's question, its own failure reason), redacted of bearers
  (`redacted` in `contracts/text.ts`), at most 280 characters, read by platform admins only and
  never sent to Slack.
- **stderr.** A warn or severe report also writes one line
  `{event: where, code, level, key, subject, status, …refs, name, at, sqlstate, table, constraint}`,
  at most one per issue every 10 s. It replaces each site's hand-written line, so nothing is
  silent while the database is away.

## 2. Store (`packages/issues/src`)

### 2.1 Tables (`schema.ts`, version 1, published: never edit)

`issues` is one row per fingerprint, never deleted; its guard (23514) refuses a delete, a changed
identity (`id, fingerprint, class, where_at, code, key, first_at`) or a falling count.
`issue_occurrences` holds the kept cases, write-once except `trace_json`, which is written once.

- `id = 'issue_' || fingerprint[0:32]`, `fingerprint = sha256(JSON [class, where, code, key])`.
- An issue: level, loop, standing, `open | resolved`, count, the hour bucket and its peak, the
  episode's kept-case count and last kept case, note, first, opened, last and resolved times,
  `resolved_by` (`owner` or `quiet`), `alerted_at`, `reopened`.
- A case: time, level, status, repeats (reports of its subject folded in within one flush),
  project, subject, session, instance, release (`refs.release ?? MERV_RELEASE`), refs, error
  facts, note and the pinned trace.
- `issue_hours`: each issue's reports in each UTC hour that had any, for the page's week.
- Partial indexes serve the owed alerts, the quiet pass, the unpinned cases, and the reverse
  reads by session and instance.

### 2.2 Write path (`store.ts`)

- `report` and `resolve` go through `State.afterCommit`: inside a writer they wait for its commit
  and are dropped on rollback. They fold into a bounded map (2,000 fingerprints; per fingerprint
  at most 8 report groups and resolves between flushes, in arrival order; 20 subjects a group).
  Strings are clipped: where and code 120, key 300, subject 200, refs at most 30 ids of 200.
  Overflow is counted and reported as `issues.dropped` / `overflow`.
- A flush every second writes it all in one transaction (`SELECT … FOR UPDATE`, then
  `INSERT … ON CONFLICT DO UPDATE` and the cases, 100 rows a statement), applying the
  class-generic rules:
  - **Episode.** A report on a resolved issue opens a new episode: its own level, sample and
    alert, `reopened + 1`. A level never falls within an episode.
  - **Fault.** Status 500 is severe whatever the owner said.
  - **Count.** Every report adds `n`; a standing report counts once an episode.
  - **Spike.** Platform ≥ 10 or tool ≥ 60 in the hour (never questions or standing) is severe,
    and re-arms an alert sent before this hour.
  - **Loop.** 15 reports of one fingerprint and subject in a fixed 10-minute window (not
    standing), or an owner's `loop`, make it a severe loop and re-arm its alert.
  - **Escalation.** Becoming severe makes the alert owed.
  - **Sampling.** Every case up to 50 an episode; then one every 10 minutes, or one a minute
    when its subject differs from the last kept; at most 20 a flush; a standing condition keeps
    only its first.
- A failed flush keeps its batch, bounded, for the next. From the third failure in a row entries
  go one at a time: a row the database refuses (`state_constraint`, `state_invalid_value`,
  `state_integer_range`) is dropped and counted; any other failure keeps that entry and the
  rest for the next flush, ahead of new ones. After 30 failures in
  a row with a severe issue pending, the sink gets one digest `issues cannot be recorded`, at
  most every 30 minutes.

### 2.3 Passes (`index.ts`, `watch.ts`)

Unref'd timers, each skipped while boot maintenance holds the process: flush 1 s, alerts 30 s,
quiet and pin 60 s, floods 5 min; an alert pass at start; on dispose the last flush, then one
alert pass of at most 10 s.

- **Quiet.** A standing issue resolves 10 minutes after its last report, any other non-severe
  one after 24 hours, a severe one after 3 days. A question stays open until its owner settles
  it. One read first; a write only when rows are due.
- **Floods.** From the event head at start (no backfill), non-overlapping windows of at most
  100,000 event ids through `State.eventCounts(after, through, 150)` (a PK-range group-by, the 20
  largest): each (type, subject) with ≥ 150 events in a window is a severe loop
  `events` / `event_flood`, key `<type> <subject>`, refs `{projectId, eventType, subjectId,
eventIds: [first, last]}`. Too far behind, the scan restarts at the head.
- **Pin.** Up to 200 unpinned cases older than a minute a page, through
  `ctx.get('sessions')?.running.platformTrace(sessionIds)` (absent Sessions: skipped). A trace is
  written 15 minutes after its visit closed (the runner's result, transcript and conversation
  arrive after its release, uploads retried for ten minutes) or once the case is a day old; a
  close reason that is not a code is left out; a session Sessions does not know
  keeps `{}`. The trace (`SessionTrace`) is one snapshot join: thread, instance, revision, role,
  harness, status, outcome, close reason, runner, host, allocation, the uploaded transcript, the
  conversation it left (the thread's while it is the latest, else the resuming visit's
  `continuity.resume`), and its workspace branch and OIDs.

## 3. Owner sites

`where` values, and what each reports. Levels default to warn.

**Tools (`api`, `code`).**

| where             | code                                                                                         | level, subject, refs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<tool>:<action>` | MervError code, `internal_error`, or a mounted tool's inner `error.code` (else `tool_error`) | 500 severe; other 5xx and the execution refusals (`execution_tool_forbidden`, `…_arguments_forbidden`, `…_reference_unavailable`) warn; other 4xx and mounted errors notice. Subject `<session, conversation or actor>:<digest(name, input)[0:16]>`; refs project, actor, client, session, thread, invocation, conversation, command, allocation. `MervError.wait` is never reported; a caller that is neither an agent, a session nor a conversation only at ≥ 500; a nested call's error once (`tools.reported`) |
| `api_error`       | the answer's code                                                                            | ≥ 500 only, not while stopping, not an error a tool call reported; key `<METHOD> /<mount>` or `mcp`; never an unmounted or withdrawn route's 503                                                                                                                                                                                                                                                                                                                                                                   |
| `git.push`        | MervError code or `code_git_rejected`                                                        | notice; subject the fence's session, else the project; refs project, push, session, instance                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Questions (`sessions`).**

| where                         | code                                                    | level, key, refs                                                                                                                         |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `session.ask_owner`           | `asked`                                                 | key the question; notice when a responder took it, severe when none is registered; note the question; refs the asking visit and question |
| `session.ask_owner`           | `needs_you`                                             | severe; Pi's own judgement or its responder's failure                                                                                    |
| `sessions.question_responder` | `responder_unloaded`, `_deadline`, `_silent`, `_failed` | severe, beside `needs_you` when the responder failed it                                                                                  |
| `session.stopped`             | `stopped_without_handoff`                               | subject `<instance>@<revision>`                                                                                                          |

An answer, an `answered` or `obsolete` response, or the question's work moving on (each
responder sweep settles the open questions that no longer stand) resolves both `asked` and
`needs_you`.

**Platform.**

| where                                                                                           | code                                                                              | level and notes                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions.launch`                                                                               | the counted failure (`host_failed`, `workspace_failed`, …) or `model_interrupted` | key the close reason when it is a code, else `other`; refs the visit, runner, host                                                                         |
| `sessions.sweep_failed`                                                                         | the error's code                                                                  | subject the sweep subject                                                                                                                                  |
| `dispatch.offer_failed`                                                                         | the cause's code, status                                                          | an offer passed over (server fault or a refusal of who asked)                                                                                              |
| `dispatch.inquiry_refused`                                                                      | the refusal's code                                                                | subject the inquiry                                                                                                                                        |
| `dispatch.launch_held`                                                                          | `launch_held`                                                                     | severe, key the instance; resolved when the hold is withdrawn, reset, or its work has moved past it                                                        |
| `fleet.retry`                                                                                   | the error's code                                                                  | notice, severe from the fifth counted failure                                                                                                              |
| `fleet.refused`                                                                                 | the error's code                                                                  | notice for wallet refusals, else severe                                                                                                                    |
| `fleet.not_ready`, `fleet.unpriced`, `fleet.machine_gone`                                       | `runtime_not_ready`, `fleet_unpriced`, `stopped`                                  | severe                                                                                                                                                     |
| `fleet.stuck_releasing`                                                                         | `releasing`                                                                       | standing, severe: stopped over 10 minutes without the host acknowledging its shutdown                                                                      |
| `fleet.queued`                                                                                  | `queued`                                                                          | standing: queued over 15 minutes                                                                                                                           |
| `fleet.relay`                                                                                   | the provider's code, else the relay's                                             | key `<relay> <key env> <model>`, status the provider's; severe for a key it refuses (401, `invalid_api_key`), else an outage or timeout as warn            |
| `fleet.pass`, `fleet.reconcile`                                                                 | `issueCode`                                                                       | swallowed passes                                                                                                                                           |
| `fleet.workflow_skipped`                                                                        | `issueCode`                                                                       | standing, key the project; notice for `sandbox_not_connected` and `fleet_compute_cap`                                                                      |
| `fleet.unclaimed`                                                                               | `unclaimed`                                                                       | standing, severe, key `<project> <target>`: hosted machines that never claim the work                                                                      |
| `pi.turn`                                                                                       | the `PiInterruption`                                                              | not `cancelled`; severe for `service_unavailable`, `checkpoint_unavailable`; notice for `wallet_refused`, `ambiguous_prompt`; note the worker's own reason |
| `pi.hosts`                                                                                      | `issueCode`                                                                       | swallowed host-pass steps                                                                                                                                  |
| `code.maintain`, `code_work.bases`, `code_work.landing`, `sandboxes.runs`, `sandboxes.evidence` | `issueCode`                                                                       | swallowed passes: a pass failing every tick becomes a loop                                                                                                 |
| `code.capture_quarantined`                                                                      | `capture_quarantined`                                                             | severe, key the unit, subject the session; refs the session and operation (`commandId`)                                                                    |
| `sandboxes.retire`                                                                              | `issueCode`                                                                       | subject the run                                                                                                                                            |
| `consumer`                                                                                      | the handler's code                                                                | standing, key the consumer, severe from the fifth attempt; refs the event                                                                                  |
| `plugin`                                                                                        | the error's code, `plugin_failed`, or an unready required entry's state           | severe, key the plugin: the root logger exporter (activation, reload, dispose) and a refused boot                                                          |
| `composition.restore_failed`, `secrets.platform_unopened`                                       | `issueCode`, `secrets_unavailable`                                                | severe, key the env name                                                                                                                                   |
| `process`                                                                                       | `crashed` (key its origin) or `unclean_exit`                                      | severe, under the release that ran                                                                                                                         |
| `events`                                                                                        | `event_flood`                                                                     | §2.3                                                                                                                                                       |
| `issues.dropped`, `issues.alert`                                                                | `overflow`, `alert_failed`                                                        | Issues' own; never alerted                                                                                                                                 |

Fleet's refs are `{projectId, allocationId, sandboxId, launchId, profileId, runtimeRelease,
instanceId}`; Pi's `{projectId, conversationId, commandId, allocationId, hostId}`.

**Composition root.** `src/app.ts` reports through `reporter(ctx)`; reports made before Issues
is up (at most 50) are replayed once the composition settles. `src/cli.ts serve` keeps
`<directory>/serve.json`: written at start with `{startedAt, release}`, rewritten with the
crash's error facts by `uncaughtExceptionMonitor` (Node's own handling untouched), removed on a
clean stop and put back as it was on a refused start. One left behind is reported by the next
boot.

## 4. Traceability

- **Code.** `deploy/release.mjs` writes `MERV_RELEASE=<stamp>-<sha8>-<content12>` to
  `source/deploy/release.env`, which `compose.yml` reads as an optional env file, so image ids
  stay the same and a rollback reads its own release's file. Every case keeps it; hosted
  machines carry `runtimeRelease` (`rt1_…`, see `deploy/HOSTED_RELEASES.md`).
- **Ids at capture**, by kind: a leased call's session, thread and invocation (its
  `session_tool_calls` row); an outside agent's project, actor and client; Pi's conversation,
  command, allocation and host; a question's visit; Fleet's allocation, sandbox and launch; a
  push; a flood's event range; a fault's frames and SQL cause.
- **The visit, pinned once** (§2.3), with its transcript `transcripts-<projectId>/<sha256>`,
  conversation `conversations-<projectId>/<sha256>` and workspace OIDs.
- **Streams.** `SessionStreams.prune` keeps the events of a visit whose transcript never
  uploaded, its only record of what the agent did.
- **Reading agents.** `readsAgents` admits the platform actor (`PLATFORM_ACTOR`, now in
  `contracts/scope-models.ts`), so the admin's drill-in reads an agent's stream and conversation.
- **Following a case.** The alert links `/ui/admin/issues?issue=<id>`; each case's `Thread →`
  opens its visit in the drill-in, `Work →` the work a case names without a visit; `Download case` saves the detail JSON for an investigating
  agent; every id sits in the case row's hover title.

## 5. Alerts (`alerts.ts`)

- **Sink.** One optional `AlertSink { send(digest) }`: the Slack incoming webhook. Config
  `alerts.slack: { webhookEnv (default MERV_ISSUES_SLACK_WEBHOOK, described "Issue alerts · Slack
webhook URL", so the Credentials page lists it), publicOrigin }`. `deploy/render-config.mjs`
  sets it only when `MERV_ISSUES_SLACK_WEBHOOK` is in the environment; the URL never leaves the
  environment and is read at each send.
- **Digest.** `AlertDigest { at; issues: { id, title, level, loop, count, openedAt }[] }`: codes
  and counts only, the title `words(where) · words(code)`; the sink builds each link. Slack gets
  `{ text, blocks }`: `Merv · <title>` or `Merv · <n> severe issues`, one section per issue
  (linked title · count · since) and the digest time, with a 10 s timeout. A non-2xx throws.
- **Pass.** The open severe issues owed an alert (`alerted_at` null, not `issues.*`), oldest 20,
  one digest at most every five minutes by the durable `max(alerted_at)`, so a restart never
  sends sooner. On success they are marked, and the store waits five minutes even when the
  marking fails; on failure they stay owed, the sink is retried after
  1, 2, 4, then 10 minutes, and `issues.alert` is reported. Each episode alerts once; a spike or
  loop re-arms it.
- **Latency.** A severe report: about a second to flush plus at most 30 s, under a minute after a
  quiet spell, at most five minutes inside a burst. A flood: at most 10 minutes. A crash: the next
  boot. A refused boot: its dispose.

## 6. Admin (`packages/admin/src/issues.ts`, `packages/ui/web/admin/issues.tsx`)

Routes, all 503 `issues_unavailable` without Issues; see docs/ADMIN.md:

- `GET /admin/issues` → `AdminIssues { rows, open, severe, at }`: the open issues and those
  resolved in the last 7 days (at most 500), each with the project names its cases name, its
  hours of the week (`issue_hours`) and its newest case.
- `GET /admin/issues/:id` → `AdminIssueDetail { issue, cases }`: the first kept case and the
  newest 50; 404 `not_found`.

Every case the admin reads carries its project's name, its visit (the pinned trace, else Sessions'
`platformTrace` of it now) and the work that visit served (`workflows.platformWork`). No admin
resolves an issue: its owner does, or the quiet pass.

The page follows docs/UI_DESIGN.md and polls every 15 s; the rail's Issues row counts the open
severe issues. Top to bottom:

- **The week.** Each hour's reports stacked by class (tools, questions, platform, each its own
  hue); the legend names each class with its total, or the hovered hour's, and narrows the page
  to it.
- **Where it fails.** Each class's busiest groups this week: a tool by its name, a question by
  its project, the platform by its part (Fleet, Sessions, Code, Server, …). A group narrows the
  page to its issues.
- **One card per issue**, open severe, warn, then notice, newest first; resolved ones behind
  `Filter`. A card says what went wrong in words (`issueTitle`, shared with Slack; a question by
  what it asked) with its level, `loop`, `new` or `back`; the facts (key, status, fields, SQL
  state, the fault's frame, the owner's note); where it last happened (project › work › agent,
  and how many projects and agents); its week as six-hour bars with its total, first and last.
- **Open …** goes where that case's context is, in its project's read-only drill-in, as its people
  see it: an agent's visit opens the project's Work with its record beside the map and its Agents
  tab on that thread; work with no thread opens the same without it; a machine its Fleet page;
  else the project's Work. A fault's frame opens the code at the release's commit on GitHub, and a
  case with neither project nor frame, the commit.
- The title (or `?issue=`, the alert's link) unfolds the issue's kept cases, each with its own
  way in, and `Download case`.

## 7. Rollout

1. Deploy without `MERV_ISSUES_SLACK_WEBHOOK` for a day; watch the board and tune owner levels.
2. Install the webhook on the control host only, never in JSON config.
3. No backfill: held launches are re-reported at boot, Fleet's first full pass reports what is
   stuck releasing, and old questions stay on Work.
4. Releases built before this change have no `release.env`; their cases show no release.
