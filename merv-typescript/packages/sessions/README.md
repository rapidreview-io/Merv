# Sessions

Continuing agent identity, authenticated sessions, and assignment execution lifecycle. The provider injects
`state`, `scope`, `workflows`, `domainEvents`, and registers its session tool policy with `tools` whenever a tool
registry is loaded. It stores [transcripts](#transcripts) through `blobs` whenever Blobs is loaded. The registry refuses session callers while no policy is registered. A policy decision or
prepared invocation belongs to the registration that admitted it: withdrawing or replacing that registration,
even with the same provider, prevents later dispatch, and cleanup still goes to the original provider. A handler
already admitted may finish. Its `@merv/sessions/api` adapter (config row `sessions-api`) injects `sessions` and `api`: it mounts `/sessions` and registers the session (`ms_`, POST `/mcp` only), managed-runner (`mr_`, its control routes only) and enrollment (`me_`) credentials, all withdrawn with it. Its optional `/ui` adapter injects `sessions` and `ui`, and its optional `/tools` adapter injects `sessions` and `tools` for usage, dispatch, observation and session messaging. It launches no processes.

## Where it sits

```mermaid
flowchart LR
  subgraph peopleLayer["People & agents"]
    person["Person<br/><small>browser</small>"]
    workerAgent["Worker agent"]
  end
  subgraph researchLayer["Research logic"]
    tasks["Tasks"]
    experiments["Experiments"]
    reflections["Reflections"]
  end
  subgraph foundationsLayer["Foundations"]
    subgraph machine["Agent machine"]
      runner["Runner"]
    end
    api["API<br/><small>HTTP, /mcp and tools</small>"]
    sessions["Sessions<br/><small>agents, leases, live stream</small>"]
    workflows["Workflows"]
    scope["Scope"]
    blobs["Blobs"]
    fleet["Fleet"]
    sandboxes["Sandboxes"]
    ui["UI"]
  end
  subgraph externalLayer["External"]
    blobStore[("Blob store")]
  end
  runner -- "launches" --> workerAgent
  runner -- "HTTP /sessions/lease" --> sessions
  runner -- "HTTP /sessions/:id/stream" --> sessions
  runner -- "HTTP /sessions/:id/conversation" --> sessions
  workerAgent -- "HTTP /mcp" --> api
  person -- "HTTP /sessions/:id/events" --> sessions
  sessions -- "injects" --> api
  sessions -- "injects; runs admitDispatch" --> workflows
  sessions -- "injects" --> scope
  sessions -- "injects" --> blobs
  blobs -- "reads/writes" --> blobStore
  fleet -- "injects" --> sessions
  ui -- "imports @merv/sessions/models" --> sessions
  sandboxes -- "injects" --> sessions
  sessions -- "emits session.closed" --> tasks
  sessions -- "emits session.closed" --> experiments
  sessions -- "emits session.closed" --> reflections
  sessions -- "emits session.closed" --> sandboxes
  classDef self fill:#2f6feb,color:#fff,stroke:#1f4fb0
  class sessions self
```

Sessions is Main's side of every agent machine: the runner leases work, streams the agent's events and declares its conversation over `/sessions`, while the agent calls tools at `/mcp` under the session's policy. A person's page reads the same live stream, and `session.closed` releases the domain leases and compute that named the session. For hosted Codex's model calls, `managed.boundSession` says which session a bearer or session id holds, live or closed by its own handoff; Fleet grants the model, and names the person the calls count toward ([Fleet README](../fleet/README.md)).

The UI adapter's `ui.read` row returns project status without parameters, or agent
activity with `{rowId: 'sessions', params: {agentId}}`. The inspector uses the shared
browser polling hook at four-second intervals, retaining the last successful read
on a refresh failure and pausing further polls while hidden. This read works without
the optional Sessions tools adapter and keeps the same project-reader authorization
and leased-worker denial as the observation HTTP endpoint.

`session.find` resolves a work item's current session. `session.message` queues an operator
message for that session; `session.messages` and the worker-only `session.message.ack`
retain receipt and an optional reply. Pending messages are surfaced at the next Merv tool
interaction and fence worker writes until acknowledged. See [session steering](../../docs/SESSION_LEASES.md#steering-an-assigned-agent)
for delivery limits and the distinction between acknowledgment and incorporation.

Every close writes what the session cost to `session_usage`, and budgets only pause automatic dispatch; see [loop limits, usage and budgets](../../docs/BUDGETS_AND_LIMITS.md).

See [continuing agents and explicit assignment changes](../../docs/AGENT_CONTINUITY.md) for registration, self-control routes, identity semantics and migration.

Workflows owns the fixed policy and generic ownership hooks. Sessions freezes the
assignment, stores only the secret digest, validates source authority, activates
on first accepted MCP use, and closes expired or released workers. Domain plugins
release their exact old handles through durable events. Safe restarts retain the
lease; previously prepared invocations cannot survive a registration replacement.

See [HTTP routes, identity semantics and recovery](../../docs/SESSION_LEASES.md).
Run `npm run test:sessions` from the workspace root. `test:live:sessions` is the
separate real-agent acceptance harness, not a production runner.

[Automatic assignment and project controls](../../docs/RUNNER_CONTROL_PLANE.md) include default-off dispatch, pause/halt, source-bound runner presence, desired platform settings and transactional capacity checks. Workflows supplies metadata-only candidates; Sessions owns durable lease selection and retry receipts. `npm run test:live:dispatch -- /private/tmp/UNIQUE_DIRECTORY` exercises automatic HTTP assignment with two fresh agents.

## Private account credential delivery

`POST /sessions/:id/huggingface-access` accepts only `{runnerId, hostRef}` from the managed supervisor bearer. It checks the current allocation, bound project, runner, source, attached host and live workflow lease before resolving an account through Scope. A personal key follows its owner; a service follows its immutable validated voucher. Where an account resolves, Secrets issues `{access: {token, endpoint}}`: a read-only capability for its Hugging Face broker, bound to this session, runner, allocation and host and expiring at the session's hard deadline, never the account token. Actor-only sources, sealed offline reviews and a deployment without Secrets receive `{access: null}`. The response uses `Cache-Control: no-store`. There is no corresponding MCP tool or credential field in ordinary session responses.

The older `POST /sessions/:id/huggingface`, which returned the account token itself as `{hfToken}`, answers `{hfToken: null}` from 2026-10-08 and is then removed; runners before `huggingface-access` still call it.

## Continuity

When work comes back to a state it was in, the agent that held that state takes it up again with its own conversation, as a new session with a new lease and credential. Each offer with no named `agentId` gets `session.continuity.key`: the instance's workflow's registered provider's key (`conversations.register(workflow, provider)`, one per workflow; `null` means never), else `[instanceId, state, role]`. The role is part of every key, so a reviewer never continues a producer's conversation; a reviewer of a later round does continue the earlier reviewer's.

- `session_conversations` holds one row per `(project_id, continuity_key)`: the key's latest closed session and its agent, and the conversation that session's runner declared (`harness`, `conversation_id`, `sha256`, `size`), `uploaded_at` once delivered. A close takes the row for its session; the agent the row named before is retired (`superseded`) when it is another. A close of the row's own agent that declared nothing (a lapsed offer, a failed launch, a lost machine) leaves the row's conversation in place and stamps `updated_at` with its close, so that session, and no earlier one, may still declare. A close released `preparation_deferred` with cause `resume_failed` (its harness found no conversation to resume) instead drops the row's conversation when it is the one that session resumed: the key's next offer goes to a fresh agent, on whatever machine, rather than failing to resume it again.
- An offer whose key's row has a declared conversation (delivered or still on its way; a runner that cannot fetch it launches the same agent fresh), and whose agent is active, belongs to the same source and holds no live session, reuses that agent and its actor, from any runner, and carries `continuity.resume` (`sessionId`, `harness`, `conversationId`, `sha256`, `size`) in the frozen session. Fingerprints and replay are unchanged.
- A session with a key leaves its agent active at close, with no credential; the agent is retired when superseded, or by the sweep once its key's row is 14 days old. Review independence still excludes it: it is the same actor, a contributor under every session it held.
- `POST /sessions/:id/conversation` declares and delivers the redacted conversation file exactly as a transcript is declared and delivered, to `conversations-<projectId>/<sha256>`, answering `{conversation}`; 409 `conversation_unkept` for a session with no key, `conversation_superseded` once the key's row has passed to another session. A session may declare while it is live or holds the row; a closed one also may when the row names its agent and a session of that agent older than itself. An older session's, or another agent's, declaration is refused. `POST /sessions/:id/resume` (`runnerId`, `hostRef`, live and attached) answers `{download: {url, expiresAt}}`, a signed GET of the conversation the session resumes. A hosted machine waits for a declared conversation as for a transcript.

## Transcripts

The runner that held a session keeps one copy of what the agent process printed, for operators, without Claude's partial-message (`stream_event`) lines ([runner README](../runner/README.md#settling-an-ended-launch)). Nothing in Merv reads it back: there is no GET, tool, page or event. `POST /sessions/:id/transcript` takes `runnerId`, `hostRef`, `sha256`, `size` (1 byte to `MAX_TRANSCRIPT_BYTES`, 64 MiB), `logBytes` and `truncated` in a body of at most 4 KiB, and answers `{transcript: {sessionId, sha256, size, uploadedAt}}`.

- Only the runner that held the session may call it, live or closed: the source credential with the session's owner and `runnerId`, or the managed runner (`mr_`) bound to it. `hostRef` must be the attached host (409 `host_conflict`).
- Without `deliver`, the call declares the file: the first declaration is recorded in `session_transcripts` and every later one must repeat it (409 `transcript_conflict`). It does no store I/O.
- With `deliver: true`, one HEAD at `transcripts-<projectId>/<sha256>`: bytes of the declared size stamp `uploaded_at` once; nothing stored answers a signed PUT in `upload` (`url`, `headers`, `expiresAt`; 1 h, exact size, SHA-256 checksum, `If-None-Match: *`); another size is 409 `transcript_mismatch`. A stamped row is answered as it is.
- Blobs not loaded, or a failed HEAD, is 503 `blob_unavailable`, which a runner retries. A store that cannot sign uploads (disk blobs) is 409 `transcripts_unsupported`, and nothing is recorded.

Sessions trusts the runner for the four file facts only; every other column comes from the session it holds. `hostname` is the dispatching runner's presence at declaration (none for a hand offer). The row is write-once: a trigger refuses any delete and any change but the one stamp. Byte-identical transcripts in one project share one object. A caller with the same owner, runner and host could declare first; that is the same trust as a workspace result. Transcripts are kept forever; the per-project prefix allows a per-project purge or lifecycle rule. On AWS S3 the store credential needs `s3:ListBucket`, or a missing key HEADs as 403 and every delivery answers 503 (R2 answers 404). A retirement migration that deletes worker sessions must first delete their `session_transcripts` rows with `session_transcripts_immutable` disabled.

A hosted machine waits for its transcript: while its bound session has a declared transcript with no `uploaded_at`, the managed inspection reports `capturePending`, so Fleet keeps the machine, for at most 30 minutes from the declaration. A capture plus upload longer than that loses the transcript, never the capture. A step halted at its hard deadline has 300 s of `mr_` authority left; a transcript not delivered by then gets 401 and is lost. A runner that declares and then gives up or is refused keeps its allocation for the rest of the 30 minutes unless Fleet sees the machine fail or stop first: it costs machine time and holds a Fleet slot (the project and global limits and the workflow adapter's `maxAgents`), which can delay the next hosted step.

The runner declares before each release try and delivers after the workspace result ([runner README](../runner/README.md#settling-an-ended-launch)). It sends at most 10 PUTs, a minute apart after a failure, and one more delivery call to confirm the last; then it gives up. The runner's own bearers are blanked from the file, but a bearer pattern inside URL-encoded text (after `%20` or `%3D`) is not, so other keys printed that way stay. When the declaration before the release failed and could be retried, the first delivery declares; until then Fleet may see the machine finished and only the transcript is lost.

Operator lookup (the joins hold what the row does not copy):

```sql
-- by task/experiment instance; swap the WHERE for t.runner_id, (t.workflow, t.role), t.agent_id,
-- t.host_ref, t.sha256, s.actor_id or m.allocation_id
SELECT t.*, s.instance_id, s.revision, s.actor_id, s.owner_hash,
       s.session_json::jsonb->'source' AS source, s.session_json::jsonb#>>'{assignment,label}' AS label,
       s.session_json::jsonb->>'activatedAt' AS activated_at, s.session_json::jsonb->>'closedAt' AS closed_at,
       s.session_json::jsonb->>'closeReason' AS close_reason,
       u.harness, u.model, u.state, u.outcome, u.input_tokens, u.output_tokens, u.wall_ms,
       m.allocation_id, m.epoch, m.runtime_profile_id,
       CASE WHEN m.allocation_id IS NULL THEN 'source' ELSE 'managed' END AS runner_kind,
       h.actor_id AS moved_by, 'transcripts-' || t.project_id || '/' || t.sha256 AS object_key
FROM worker_sessions s JOIN session_transcripts t ON t.session_id = s.id
LEFT JOIN session_usage u ON u.session_id = s.id
LEFT JOIN session_managed_runners m ON m.bound_session_id = s.id
LEFT JOIN wf_history h ON h.instance_id = s.instance_id AND h.revision = s.revision + 1
WHERE s.project_id = $1 AND s.instance_id = $2 ORDER BY s.revision;
-- declared and never confirmed:
--   WHERE t.uploaded_at IS NULL AND t.declared_at < now() - interval '30 min'
-- attached sessions with no transcript:
--   worker_sessions s LEFT JOIN session_transcripts t ON t.session_id = s.id
--   WHERE s.session_json::jsonb->>'hostRef' IS NOT NULL AND t.session_id IS NULL
```

```sh
aws s3 cp --endpoint-url "$MERV_BLOB_ENDPOINT_URL" \
  "s3://$MERV_BLOB_BUCKET/${MERV_BLOB_PREFIX:+$MERV_BLOB_PREFIX/}transcripts-<project_id>/<sha256>" - | tee <session>.jsonl | sha256sum
```
