# Sessions

Continuing agent identity, authenticated sessions, and assignment execution lifecycle. The provider injects
`state`, `scope`, `workflows`, `domainEvents`, and registers its session tool policy with `tools` whenever a tool
registry is loaded. It stores [transcripts](#transcripts) through `blobs` whenever Blobs is loaded. The registry refuses session callers while no policy is registered. A policy decision or
prepared invocation belongs to the registration that admitted it: withdrawing or replacing that registration,
even with the same provider, prevents later dispatch, and cleanup still goes to the original provider. A handler
already admitted may finish. Its `@merv/sessions/api` adapter (config row `sessions-api`) injects `sessions` and `api`: it mounts `/sessions` and registers the session (`ms_`, POST `/mcp` only), managed-runner (`mr_`, its control routes only) and enrollment (`me_`) credentials, all withdrawn with it. Its optional `/ui` adapter injects `sessions` and `ui`, and its optional `/tools` adapter injects `sessions` and `tools` for usage, dispatch, observation and session messaging. It launches no processes.

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

## Transcripts

The runner that held a session keeps one copy of what the agent process printed, for operators. Nothing in Merv reads it back: there is no GET, tool, page or event. `POST /sessions/:id/transcript` takes `runnerId`, `hostRef`, `sha256`, `size` (1 byte to `MAX_TRANSCRIPT_BYTES`, 64 MiB), `logBytes` and `truncated` in a body of at most 4 KiB, and answers `{transcript: {sessionId, sha256, size, uploadedAt}}`.

- Only the runner that held the session may call it, live or closed: the source credential with the session's owner and `runnerId`, or the managed runner (`mr_`) bound to it. `hostRef` must be the attached host (409 `host_conflict`).
- Without `deliver`, the call declares the file: the first declaration is recorded in `session_transcripts` and every later one must repeat it (409 `transcript_conflict`). It does no store I/O.
- With `deliver: true`, one HEAD at `transcripts-<projectId>/<sha256>`: bytes of the declared size stamp `uploaded_at` once; nothing stored answers a signed PUT in `upload` (`url`, `headers`, `expiresAt`; 1 h, exact size, SHA-256 checksum, `If-None-Match: *`); another size is 409 `transcript_mismatch`. A stamped row is answered as it is.
- Blobs not loaded, or a failed HEAD, is 503 `blob_unavailable`, which a runner retries. A store that cannot sign uploads (disk blobs) is 409 `transcripts_unsupported`, and nothing is recorded.

Sessions trusts the runner for the four file facts only; every other column comes from the session it holds. `hostname` is the dispatching runner's presence at declaration (none for a hand offer). The row is write-once: a trigger refuses any delete and any change but the one stamp. Byte-identical transcripts in one project share one object. A caller with the same owner, runner and host could declare first; that is the same trust as a workspace result. Transcripts are kept forever; the per-project prefix allows a per-project purge or lifecycle rule. On AWS S3 the store credential needs `s3:ListBucket`, or a missing key HEADs as 403 and every delivery answers 503 (R2 answers 404). A retirement migration that deletes worker sessions must first delete their `session_transcripts` rows with `session_transcripts_immutable` disabled.

A hosted machine waits for its transcript: while its bound session has a declared transcript with no `uploaded_at`, the managed inspection reports `capturePending`, so Fleet keeps the machine, for at most 30 minutes from the declaration. A capture plus upload longer than that loses the transcript, never the capture. A step halted at its hard deadline has 300 s of `mr_` authority left; a transcript not delivered by then gets 401 and is lost. A runner that declares and then gives up or is refused keeps its allocation for the rest of the 30 minutes unless Fleet sees the machine fail or stop first: it costs machine time and holds a Fleet slot (the project and global limits and the workflow adapter's `maxAgents`), which can delay the next hosted step.

The runner declares before each release try and delivers after the workspace result ([runner README](../runner/README.md#settling-an-ended-launch)). It counts 10 delivery calls, a minute apart after a failure; a delivery that PUTs and then confirms uses two of them, so a store that keeps failing gets about five PUTs. The runner's own bearers are blanked from the file, but a bearer pattern inside URL-encoded text (after `%20` or `%3D`) is not, so other keys printed that way stay. When the declaration before the release failed and could be retried, the first delivery declares; until then Fleet may see the machine finished and only the transcript is lost.

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
