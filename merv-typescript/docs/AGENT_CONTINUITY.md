# Continuing agents and assignment executions

Agent Sessions owns the agent instance and its authenticated session. Scope owns the corresponding security actor and checks its source authority. Workflows owns assignment reservations. No Cordis dependencies were added.

## Identities

| Field                    | Meaning                                            | Changes on a new assignment? |
| ------------------------ | -------------------------------------------------- | ---------------------------- |
| `agent.id`               | Continuing agent instance, owned by Agent Sessions | No                           |
| `agent.actorId`          | Scope actor used to attribute its work             | No                           |
| `agent.sessionId`        | Continuing authenticated agent session             | No                           |
| `execution.id`           | One assignment execution and workflow lease        | Yes                          |
| `execution.contextEpoch` | Context-reset epoch captured when offered          | Only after a declared reset  |

The existing `Session` type, `/sessions/offer`, `/sessions/:id` routes and persisted `sessionId` references in Code and Runner retain their assignment-execution meaning for compatibility. They are not identifiers for the continuing connection. Every new execution carries `agentId` and `agentSessionId`; historical rows can omit them. Caller `session.id` deliberately remains the execution ID so a delayed invocation cannot acquire authority from a later assignment.

## Connecting your own agent

An authenticated source (human, user key or actor credential) registers the agent using `POST /sessions/agents` with a body:

```json
{
  "name": "My research agent",
  "runnerId": "my-agent-host",
  "requestId": "register-instance-001",
  "secret": "ms_<43 base64url characters from 32 random bytes>"
}
```

Use a cryptographically random secret. Only its digest is stored; registration returns metadata, not the secret. Replaying the same source/runner/request returns the original agent. Changed input conflicts, and replay never revives a retired agent. The agent remains bound to that source authority and project; knowing an agent ID cannot take it over.

The continuing credential supports these controls, even between assignments:

| Route                               | Purpose                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET /sessions/self`                | Agent identity, current execution, assignment history and available-work metadata                                      |
| `POST /sessions/self/assignment`    | Explicitly acquire an assignment with `instanceId`, `expectedRevision`, `requestId` and optional `hardDeadlineSeconds` |
| `POST /sessions/self/release`       | Release the supplied `executionId`; a stale release cannot close a later execution                                     |
| `POST /sessions/self/context-reset` | Record an idle agent's declared context reset with a short `reason`                                                    |

After acquisition, use the **same agent secret** as the MCP bearer. The server activates the current assignment on first accepted MCP use and applies that assignment's fixed tool/argument policy. An idle agent has no domain-tool authority; its self-control endpoint remains available. It cannot administer other agents, choose a different project, obtain operator tool permissions, or delegate another agent.

Before another assignment, finish or explicitly release the current one. Acquisition reconciles stale/finished work and drains durable cleanup before offering a successor. One agent can hold only one live assignment, enforced transactionally and by a database index. Acquiring work does not launch a process or perform an automatic handoff.

The authorizing source can use `GET /sessions/agents`, `GET /sessions/agents/:agentId`, and `DELETE /sessions/agents/:agentId` to inspect or retire its agents. Retirement closes live work and revokes the security actor. Source credential revocation, expiry, rotation, or membership-epoch changes remain fail-closed; a replacement credential does not silently reclaim the old agent.

## Assignment boundaries

Each execution freezes the assignment, context, reference IDs, tool policy and workflow revision. Retained history records what context was supplied, not what a model demonstrably remembers. Explicit resets increment the context epoch while preserving agent identity and older snapshots. Resetting context does not make a producer an independent reviewer.

Ending an assignment releases its workflow/domain ownership and permissions without retiring a continuing agent. Output attribution keeps the stable actor. Access to newly authored output is filtered by the exact execution event, so old unpinned files are not silently authorized because the actor ID matches. Experiments likewise require the current execution's own plan/report where fresh authorship is required. Review independence continues to compare the stable producer/reviewer actor.

Already prepared invocations, claims, workspace observations, command receipts and final code captures remain tied to their original execution ID. A late release, result, or cleanup event cannot be redirected to the agent's next assignment. A running remote request may still finish after release; it does not gain the next assignment's authority.

## Runner and existing clients

Automatic dispatch still launches one fresh agent per execution. These agents are registered as nonpersistent and retire when their execution closes. Runner recovery and workspace capture stay keyed by execution ID; snapshots now also include agent and agent-session IDs. There is no automatic process reuse or handoff.

Existing one-assignment clients can continue using `/sessions/offer` and their execution token. A trusted source can additionally offer to a registered continuing agent by supplying `agentId` and the same `runnerId`. The execution token must differ from the continuing credential.

The Sessions UI shows agents separately from assignment executions. Agent status can be idle while its identity remains active. Retired agents and historical executions remain attributable.

## Storage upgrade

New immutable identity records live in the Sessions-owned `agents` table. Additive migrations remove the old one-actor-ever constraints from session, task and experiment lease tables; live assignment uniqueness remains enforced. Historical IDs, snapshots, foreign-key references and retention triggers are preserved. Scope distinguishes managed agent actors from historical session actors and permits assignment-role changes only through its internal managed-agent operation.

SQLite table rebuilds run in a transaction with foreign keys checked before commit and enforcement restored on either success or failure. Migration fingerprints for previously shipped schemas are unchanged. No existing agent is inferred to be a continuing external process; register a continuing agent explicitly.

## Agent activity UI and observations

`/ui/sessions` lists every registered agent in the selected project, newest joined first (including retired instances). Its **Live assignments only** switch selects agents with an offered or active execution. Selecting a row opens the right-hand inspector with current assignment, workflow gate, role, permitted tools, assignment history, and tool-call activity. Both views refresh every four seconds. An active identity or lease does not prove that an external process is connected.

The inspector uses `GET /sessions/agents/:agentId/observation`. Ordinary project readers may inspect this sanitized metadata; worker credentials cannot browse it, and other projects receive a not-found response. This observation route does not activate, reconcile, impersonate, or acquire work. The source-owned agent controls keep their existing ownership checks.

Sessions retains executed Merv calls in `session_tool_calls`, attributed to the original assignment execution and stable agent. Calls appear while running, then record success or failure and elapsed time. MCP `isError` responses and rejected remote output envelopes count as failures. Authorization probes, rejected inputs and tool-list requests do not count as executed calls. A shutdown/restart marks unfinished observations as interrupted, with no invented completion time. Already completed facts are immutable. No argument values, result contents, error messages, or credentials are retained in this log.

The inspector returns up to 100 calls, prioritizing in-flight calls and then newest calls, plus aggregate counts and payload estimates across all recorded calls for that agent. Assignment history remains independent of the project execution table's display cap. Activity starts when this feature is installed; earlier calls cannot be reconstructed.

**Token figures are payload-size estimates**, computed as UTF-8 serialized JSON bytes divided by four, rounded up separately for input and output. They are not tokenizer counts, model input/output usage, reasoning usage, or billing. Tool calls outside Merv are not observed. Missing output is shown as unknown, not zero; aggregate output sums recorded results only. Exact model usage per tool would require a separate usage signal from the calling agent/provider.

Per session, that signal now exists in a weaker form. [`usage.read`](BUDGETS_AND_LIMITS.md) keeps three kinds of figure apart: lease wall-clock, which Merv **measures**; tokens, cost and model, which the launching machine **reports** and nobody verifies; and these payload sizes, which are **estimates**. Model context, reasoning usage, provider billing and anything done outside a Merv-launched process remain unknown.

No new Cordis plugin or dependency was added. Sessions owns the observations; its existing API/UI adapters expose them. ToolRegistry validates remote responses inside the existing session invocation so invalid response envelopes are observed as failures.
