# Threads and their visits

Sessions owns threads and sessions. Identity issues and verifies credentials; Scope checks the corresponding actor and source authority. Workflows owns assignment reservations.

- A **thread** is the worker that owns one stage of one work item for one role: its continuity key's holder. It holds the attribution actor, the saved conversation and a status (`open` while a visit holds its lease, `dormant` while it waits for its work, `retired`).
- A **session** is one visit by a thread: one offer (`POST /sessions/offer`, or automatic dispatch's lease), its lease, its execution credential and its launch.

## Identities

| Field              | Meaning                                                | Changes on a new visit?              |
| ------------------ | ------------------------------------------------------ | ------------------------------------ |
| `session.threadId` | The thread, owned by Sessions                          | Only when no conversation is resumed |
| `session.actorId`  | The thread's Scope actor, which attributes its work    | Only when no conversation is resumed |
| `session.id`       | One visit: its credential, lease and workflow revision | Yes                                  |

The `Session` type, `/sessions/offer`, `/sessions/:id` routes and persisted `sessionId` references in Code and Runner keep their visit meaning. Caller `session.id` deliberately remains the visit's id, so a delayed invocation cannot acquire authority from a later visit; `session.threadId` names the thread whose actor it acts as. Scope binds a thread's actor to its thread (`actors.agent_id`, `actors.session_id`), and an actor from before agents to its one session.

Threads replaced the `agents` and `session_conversations` tables on 2026-10-06 (sessions@13): each agent became a thread with its id, so a session stored with `agentId` names its thread, and a runner's ledger written before then reads that id as its thread. Agents have no administration routes; the continuing agents that registered and took assignments themselves (`POST /sessions/agents`, `/sessions/self…`, the `session-agent` credential) were removed earlier the same day, and an offer naming an agent is refused as malformed. An external agent of your own uses an actor credential (see [Actor credentials](ACTOR_CREDENTIALS.md)) for its own project work, or is offered a step through `/sessions/offer` and works with that visit's secret.

## Assignment boundaries

Each execution freezes the assignment, context, reference IDs, tool policy and workflow revision. Retained history records what context was supplied, not what a model demonstrably remembers.

Ending an assignment releases its workflow/domain ownership and permissions. Sessions renews execution credentials on activation and heartbeat, up to the execution's fixed hard deadline, and revokes them on closure. Hosted Codex retains its existing one-minute model-call handoff grace; closed executions cannot make MCP calls. Output attribution keeps the stable actor. Access to newly authored output is filtered by the exact execution event, so old unpinned files are not silently authorized because the actor ID matches. Experiments likewise require the current execution's own plan/report where fresh authorship is required. Review independence compares the producer and reviewer actors, and a source's agents count as that source's hand.

Already prepared invocations, claims, workspace observations, command receipts and final code captures remain tied to their original execution ID. A late release, result, or cleanup event cannot be redirected to the thread's next visit. A running remote request may still finish after release; it does not gain the next visit's authority.

## Runner and existing clients

An offer opens a new thread, or continues the dormant thread that holds the same work ([Sessions README](../packages/sessions/README.md#continuity)). A thread retires when its visit closes unless that visit may be continued; then it stays dormant until its work comes back, an offer that cannot resume it supersedes it, or 14 days pass. Runner recovery and workspace capture stay keyed by session id; snapshots also name the thread. There is no automatic process handoff.

Halting a session (`POST /sessions/:sessionId/halt`) closes its live visit; a thread without continuity retires with it, which revokes its actor. `GET /sessions/threads?instanceId=…` lists a work item's threads and their visits; `GET /sessions/threads/:id/conversation` is an operator's read of what the thread's agent did ([Sessions README](../packages/sessions/README.md#continuity)).

## Inquiry visits

A person may ask any thread's agent a question (`session.ask_thread`), whatever the thread's status. An inquiry visit is a session of the thread's actor that resumes its saved conversation read-only, answers, and stops; it holds no lease on the work and makes no workflow move or write but its reply ([Sessions README](../packages/sessions/README.md#inquiries)). Its conversation is a fork that is never saved back, so the thread's next work visit resumes exactly the conversation it had, and reads the question and answer as a message to its thread. The alternative, saving the inquiry's conversation as the new head, would carry the exchange in the agent's memory but let a person's side question change what the work resumes; it was not chosen.

## Storage

Threads live in the Sessions-owned `session_threads` table, at most one not retired per continuity key; `worker_sessions.thread_id` names each visit's thread. Live assignment uniqueness is enforced per actor. Historical ids, snapshots, foreign-key references and retention triggers are preserved. Scope distinguishes thread actors from historical session actors and permits role changes only through its internal managed-agent operation.

## Agent activity UI and observations

`/ui/sessions` lists the project's threads (`GET /sessions/threads`): every live one first, then the newest 50 others, and older pages a press further (`?before=<next>`). Each row names the work item, role and stage. A row opens the same thread view a unit's Agents tab opens: its messages and the box that sends it one, then its conversation (an operator's), its visits and its Merv calls. An active identity or lease does not prove that an external process is connected.

The calls tab uses `GET /sessions/threads/:id/calls` (tool `session.observe {threadId}`). Ordinary project readers may read this sanitized metadata; worker credentials cannot browse it, and other projects receive a not-found response. It does not activate, reconcile, impersonate, or acquire work.

Sessions retains executed Merv calls in `session_tool_calls`, attributed to the original visit and its thread. Calls appear while running, then record success or failure and elapsed time. MCP `isError` responses and rejected remote output envelopes count as failures. Authorization probes, rejected inputs and tool-list requests do not count as executed calls. A shutdown marks that process's unfinished observations as interrupted, and a restart those started more than three minutes earlier, with no invented completion time. Already completed facts are immutable. No argument values, result contents, error messages, or credentials are retained in this log.

The read returns up to 100 calls, prioritizing in-flight calls and then newest calls, plus aggregate counts and payload estimates across all recorded calls of the thread. Activity starts when this feature is installed; earlier calls cannot be reconstructed.

**Token figures are payload-size estimates**, computed as UTF-8 serialized JSON bytes divided by four, rounded up separately for input and output. They are not tokenizer counts, model input/output usage, reasoning usage, or billing. Tool calls outside Merv are not observed. Missing output is shown as unknown, not zero; aggregate output sums recorded results only. Exact model usage per tool would require a separate usage signal from the calling agent/provider.

Per session, that signal now exists in a weaker form. [`usage.read`](BUDGETS_AND_LIMITS.md) keeps three kinds of figure apart: lease wall-clock, which Merv **measures**; tokens and model, which the launching machine **reports** and nobody verifies; and these payload sizes, which are **estimates**. Model context, reasoning usage, provider billing and anything done outside a Merv-launched process remain unknown.

No new Cordis plugin or dependency was added. Sessions owns the observations; its existing API/UI adapters expose them. ToolRegistry validates remote responses inside the existing session invocation so invalid response envelopes are observed as failures.
