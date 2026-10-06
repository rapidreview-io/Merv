# Agents and assignment executions

Sessions owns the agent and its lifecycle. Identity issues and verifies credentials; Scope checks the corresponding actor and source authority. Workflows owns assignment reservations. Every agent is created by an offer (`POST /sessions/offer`, or automatic dispatch's lease) and works through that offer's execution credential.

## Identities

| Field                    | Meaning                                     | Changes on a new assignment?              |
| ------------------------ | ------------------------------------------- | ----------------------------------------- |
| `agent.id`               | Agent instance, owned by Sessions           | Only when no conversation is resumed      |
| `agent.actorId`          | Scope actor used to attribute its work      | Only when no conversation is resumed      |
| `agent.sessionId`        | The agent's own session id                  | Only when no conversation is resumed      |
| `execution.id`           | One assignment execution and workflow lease | Yes                                       |
| `execution.contextEpoch` | Context-reset epoch captured when offered   | No; 0 except on retired continuing agents |

The `Session` type, `/sessions/offer`, `/sessions/:id` routes and persisted `sessionId` references in Code and Runner keep their assignment-execution meaning. Every execution carries `agentId` and `agentSessionId`; historical rows can omit them. Caller `session.id` deliberately remains the execution ID so a delayed invocation cannot acquire authority from a later assignment.

## Continuing agents were removed

Until 2026-10-06 a source could register a continuing agent (`POST /sessions/agents`), rotate its 30-day key (`POST /sessions/agents/:agentId/rotate`), and let it acquire and release assignments itself (`/sessions/self`, `/sessions/self/assignment`, `/sessions/self/release`, `/sessions/self/context-reset`). These routes, the `agentId` field of an offer and the `session-agent` credential are gone: the routes answer as unknown, an offer naming an agent is refused as malformed, and a continuing agent's key no longer authenticates. Their `agents` rows (`persistent: true`, a `token_hash`, a `contextEpoch`) stay as attribution history and are never deleted.

An external agent of your own uses an actor credential (see [Actor credentials](ACTOR_CREDENTIALS.md)) for its own project work, or is offered a step through `/sessions/offer` and works with that execution's secret.

## Assignment boundaries

Each execution freezes the assignment, context, reference IDs, tool policy and workflow revision. Retained history records what context was supplied, not what a model demonstrably remembers.

Ending an assignment releases its workflow/domain ownership and permissions. Sessions renews execution credentials on activation and heartbeat, up to the execution's fixed hard deadline, and revokes them on closure. Hosted Codex retains its existing one-minute model-call handoff grace; closed executions cannot make MCP calls. Output attribution keeps the stable actor. Access to newly authored output is filtered by the exact execution event, so old unpinned files are not silently authorized because the actor ID matches. Experiments likewise require the current execution's own plan/report where fresh authorship is required. Review independence compares the producer and reviewer actors, and a source's agents count as that source's hand.

Already prepared invocations, claims, workspace observations, command receipts and final code captures remain tied to their original execution ID. A late release, result, or cleanup event cannot be redirected to the agent's next assignment. A running remote request may still finish after release; it does not gain the next assignment's authority.

## Runner and existing clients

An offer creates a fresh agent per execution, or continues the dormant agent that last held the same work ([Sessions README](../packages/sessions/README.md#continuity)). An agent retires when its execution closes unless that execution may be continued; then it stays dormant until its work comes back, a later agent supersedes it, or 14 days pass. Runner recovery and workspace capture stay keyed by execution ID; snapshots also include agent and agent-session IDs. There is no automatic process handoff.

The authorizing source can use `GET /sessions/agents`, `GET /sessions/agents/:agentId`, and `DELETE /sessions/agents/:agentId` to inspect or retire its agents. Retirement closes live work and revokes the security actor.

## Storage

Agents live in the Sessions-owned `agents` table. Live assignment uniqueness is enforced per actor. Historical IDs, snapshots, foreign-key references and retention triggers are preserved. Scope distinguishes managed agent actors from historical session actors and permits assignment-role changes only through its internal managed-agent operation.

## Agent activity UI and observations

`/ui/sessions` lists every registered agent in the selected project, newest joined first (including retired instances). Its **Live assignments only** switch selects agents with an offered or active execution. Selecting a row opens the right-hand inspector with current assignment, workflow gate, role, permitted tools, assignment history, and tool-call activity. Both views refresh every four seconds. An active identity or lease does not prove that an external process is connected.

The inspector uses `GET /sessions/agents/:agentId/observation`. Ordinary project readers may inspect this sanitized metadata; worker credentials cannot browse it, and other projects receive a not-found response. This observation route does not activate, reconcile, impersonate, or acquire work. The source-owned agent controls keep their existing ownership checks.

Sessions retains executed Merv calls in `session_tool_calls`, attributed to the original assignment execution and stable agent. Calls appear while running, then record success or failure and elapsed time. MCP `isError` responses and rejected remote output envelopes count as failures. Authorization probes, rejected inputs and tool-list requests do not count as executed calls. A shutdown marks that process's unfinished observations as interrupted, and a restart those started more than three minutes earlier, with no invented completion time. Already completed facts are immutable. No argument values, result contents, error messages, or credentials are retained in this log.

The inspector returns up to 100 calls, prioritizing in-flight calls and then newest calls, plus aggregate counts and payload estimates across all recorded calls for that agent. Assignment history remains independent of the project execution table's display cap. Activity starts when this feature is installed; earlier calls cannot be reconstructed.

**Token figures are payload-size estimates**, computed as UTF-8 serialized JSON bytes divided by four, rounded up separately for input and output. They are not tokenizer counts, model input/output usage, reasoning usage, or billing. Tool calls outside Merv are not observed. Missing output is shown as unknown, not zero; aggregate output sums recorded results only. Exact model usage per tool would require a separate usage signal from the calling agent/provider.

Per session, that signal now exists in a weaker form. [`usage.read`](BUDGETS_AND_LIMITS.md) keeps three kinds of figure apart: lease wall-clock, which Merv **measures**; tokens and model, which the launching machine **reports** and nobody verifies; and these payload sizes, which are **estimates**. Model context, reasoning usage, provider billing and anything done outside a Merv-launched process remain unknown.

No new Cordis plugin or dependency was added. Sessions owns the observations; its existing API/UI adapters expose them. ToolRegistry validates remote responses inside the existing session invocation so invalid response envelopes are observed as failures.
