# Surface

## Purpose

`surface` is the product boundary. It turns HTTP and MCP requests into calls on
Application or a module-owned public root, and turns their results into stable
wire responses. It owns authentication, authorization at the delivery edge,
tool schemas, upload/download protocols, OAuth/project keys, request telemetry,
and deployment composition. It does not own research workflow decisions,
artifact/feed/storage lifecycles, sandbox lifecycle, or database schema.

## Main flow

1. `surface.py` builds one `Surface`: Research, Application, Agent Sessions,
   Artifacts, Feed, Literature, Object Storage, Sandbox, telemetry, and tools.
   Machine setting `features.sandbox=false` substitutes a fail-closed backend
   and omits Sandbox tools and HTTP routes; absence keeps Sandbox enabled.
2. `tools/contracts.py` defines the public MCP input schemas and descriptions.
   `tools/dispatcher.py` binds each manifest entry directly to its owning module,
   validates input, enforces reviewer read-only access, and records the outcome.
3. `transport/mcp_http.py` and `transport/mcp_streamable_http.py` implement the
   MCP protocol. They delegate tool calls to the dispatcher.
4. `transport/api/app.py` builds FastAPI once. Its routers parse path/body/query
   input, call the dispatcher or the narrow capability that owns the operation,
   and serialize HTTP responses.
5. `transport/api/gateway.py` authenticates the caller, resolves project scope,
   applies hosted/local policy, and invokes tools. Middleware supplies CORS,
   error rendering, redaction, and request telemetry.

## Necessary supporting boundaries

- `auth.py`, `identity.py`, `project_keys.py`: caller identity plus project and
  account credential lifecycle. Project-key policy and SQL are intentionally
  together because there is one implementation and rotations must be atomic.
- `transport/api/agent_sessions.py` and gateway policy: runner control plus
  MCP-only, experiment-scoped, default-deny authority for local agent workers.
- `runner_pairing.py` plus `transport/api/runner_pairing.py`: device-code
  pairing of an auto-run machine — the runner presents only its key digest, an
  owner approves the printed code, and the digest is registered as a labelled
  project key in the same transaction (`ProjectKeys.register_digest`). The two
  runner-facing routes are the only unauthenticated ones besides `/health`; it
  is mounted exactly where owner key management is (hosted auth).
- `oauth.py`, `oauth_store.py`, and `transport/api/oauth.py`: OAuth policy,
  race-safe persistence, and protocol routes. Persistence stays separate because
  both halves are substantial and transactional behavior must remain explicit.
- `artifacts.py` plus `transport/api/artifacts.py`: stable artifact wire shapes
  and token-authenticated byte upload/download.
- `telemetry.py`: in-memory activity, durable tool-call recording, and optional
  structured logs.
- `config.py`, `brain_dirs.py`, `transport/http_server.py`: environment parsing
  and local/hosted server construction.
- `experiment_figure.py`, `transport/api/views.py`: UI-only derived projections.
- `feed_http.py`, `runs_wait.py`, storage routes, and user settings: protocols
  whose byte streaming, long-polling, token, or security behavior cannot be
  represented as an ordinary tool call.

## Boundary rules

- Surface may format and authorize; it may not reproduce module workflow rules.
- HTTP routes receive narrow collaborators, never a dependency bag or facade.
- Tools bind directly to the seven product roots; Application is used only for
  genuinely cross-module workflows.
- Public MCP/HTTP names, schemas, status codes, response dictionaries, token
  behavior, and auth scope are compatibility contracts.
- Token-bearing paths are redacted before telemetry. Upload tokens, run-wait
  signatures, project keys, and OAuth credentials are never logged as plaintext.
- Optional capabilities are omitted from their tool and HTTP surfaces when
  disabled rather than advertised as failing operations.
- New helper files require real protocol, security, persistence, or presentation
  behavior. Do not add facades, repositories with one implementation, dependency
  carriers, forwarding services, compatibility re-exports, or duplicate DTOs.
