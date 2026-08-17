# Agent Identity

## Purpose

Merv wants to know, per **agent context window**, every tool call the agent
made and everything Merv sent back — so an operator can reconstruct what a
given model conversation worked on and what it was told. A context window is
one conversation of one coding agent; a subagent has a context of its own.

The credential is not enough of a name: one OAuth install or one project key
serves a whole client process, and a runner's session credential serves a
worker and any subagent it spawns. So each context window carries its own
short id.

## Protocol

```text
agent.hello(role?, parent_agent_id?, note?, agent_id?)   -> {agent_id, created, message}
<every other tool>(…, agent_id)                          -> normal result
```

1. At the start of a context window — before any other Merv call — the agent
   calls `agent.hello` once. Merv mints a random six-character `agent_id`
   (lowercase base-31, no look-alikes; ~3 tokens) and binds it to the
   credential's user (or tenant, where no user exists).
2. Every other MCP tool advertises `agent_id` as a required argument. The
   gateway lifts it out before contract validation (no handler ever sees it),
   checks it belongs to the caller, and binds it into the request context.
3. A call without a valid id is refused **with the fix in the message**:
   `agent_id_required` ("if this context already has one, resend with it;
   otherwise call agent.hello once") or `agent_id_unknown` ("not one Merv
   issued to you"). This refusal is the "system asks whether you have an id"
   step; the model resends or hellos, and every later call is attributed.
4. Passing an existing `agent_id` to `agent.hello` confirms it (`created:
   false`) instead of minting a second one, so a model re-orienting after
   context compaction does not split its own trace.

The wire tells a client with no repo and no skills the same thing: the MCP
`initialize` instructions open with the hello step, and the tool descriptions
carry it. `AGENTS.md` and the skills repeat it for checkout-based clients.

## Who must identify

| Caller | Rule |
| --- | --- |
| OAuth / `mk_` / JWT / local over MCP | `agent_id` required on every call but `agent.hello`; bound by user id (so an hourly-rotating OAuth token keeps its identity), by tenant when there is no user. |
| `mas_` coding-agent session credential | `agent.hello` mints an identity bound to that session (a worker's subagent gets its own); a call **without** an id falls back to the session's one default identity (`role="session"`) so runner tooling keeps working; a supplied id must belong to that same session — never the parent's. |
| HTTP / UI routes | Never carry one. |

`MERV_AGENT_IDENTITY=optional` relaxes "required" to "recorded when
supplied" (a made-up id is still refused). It exists for narrow deployments
and test compositions; production leaves the default, `required`.

`merv call` accepts `--agent-id` / `MERV_AGENT_ID` and injects it, so a shell
without native MCP can carry the id too.

## What is recorded

- `agent_identities` — one row per hello: `agent_id`, the binding
  (`tenant_id`, `user_id`, `principal_id`, `oauth_family_id`,
  `agent_session_id`), the transport session it was minted under, the client
  name/version that session declared at `initialize`, and the optional
  `role` / `parent_agent_id` / `note` the model offered. Never a token.
- `mcp_sessions` — one row per successful `initialize`: the server-minted
  `Mcp-Session-Id`, the principal, `clientInfo` name/version, protocol
  version. The header is recorded, never required; a request without it is
  simply unattributed at the transport level.
- `tool_calls` — every row (dispatched or refused) now carries `agent_id`,
  `mcp_session_id`, and `payload_ref`. The row itself stays
  sizes-and-digests, as before.
- **Payload records** — for every agent-attributed call, one JSON blob in the
  content-addressed blob store (namespace `tool-calls`; the same local dir or
  bucket that holds Artifacts and Feed bytes — on disk, never in RAM): the
  redacted arguments (minus the lifted `agent_id`), the redacted result (or
  the error text), status, timing, request/principal/session ids. Results
  above 4 MB and arguments above 1 MB are kept as a bounded preview plus
  length and sha256. Field-level redaction (`reviewer_capability`, presigned
  URLs) and shape-level scrubbing (`mk_`/`mas_`/bearer/JWT shapes) both run
  before anything touches disk.

Retention is one horizon for rows and records: `MERV_TOOL_CALL_RETENTION_DAYS`
(default **180**). The ledger's own hourly sweep deletes each expiring batch's
blobs by key before its rows; every blob also carries `expires_at`, so the
blob store's namespace sweep (`POST /api/admin/cleanup`) is a second net.

## Reading a trace

Operator routes (`/api/admin`, so hosted callers present `X-Admin-Token`;
the loopback brain keeps open access):

```text
GET /api/admin/agents?user_id=&limit=            # identities, newest first,
                                                 # with call count and span
GET /api/admin/agents/{agent_id}?payloads=true   # calls in order, each with
                                                 # its request/response record
GET /api/admin/agents/{agent_id}?after_id=N      # page forward
```

`payload: null` on a call means the record was not kept (no payload store, a
write failure — counted and announced like a dropped ledger row — or already
pruned). The row still proves the call happened.

## Limits

- Identity is declared, not cryptographic: a model that pastes another
  context's id into its calls will be attributed to that context. Binding by
  user/tenant/session bounds the blast radius to one owner's own contexts.
- A model that forgets it already helloed mints a second id and splits its
  trace; the confirm path and the "do not call agent.hello again" message
  make this rare, and `mcp_sessions` + timing let an operator re-join them.
- Rolling this out to a client whose tool catalog was cached before
  `agent.hello` existed: its calls are refused until it reconnects (the
  refusal says so).

## Files

- `surface/agent_identity.py` — the service: mint, hello, resolve, session
  record, trace reads.
- `surface/transport/api/gateway.py` — lifts `agent_id`, asks the service
  after the scope checks, binds the request context.
- `surface/transport/mcp_streamable_http.py` — instructions, catalog
  injection, `initialize` session record.
- `kernel/state/tool_call_payloads.py` — the payload record writer/reader.
- `kernel/state/tool_call_ledger.py` — attribution columns, payload write,
  paired prune.
- `surface/transport/api/agents.py` — the operator routes.
