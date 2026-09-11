# Surface

## Purpose
`surface` is the product boundary. It turns HTTP and MCP requests into calls on
Application or a module-owned public root, and turns their results into stable
wire responses. It owns authentication, authorization at the delivery edge,
the tool registry, upload/download protocols, OAuth/project keys, telemetry,
and deployment composition. It does not own research workflow decisions,
artifact/feed/storage lifecycles, sandbox lifecycle, or database schema. Keep this note
under 100 lines; qualify named action, role, tool and skill references inline.

## Main flow

1. `surface.py` builds one `Surface` from `programs.INSTALLED`: each program's
   graphs become the workflow registry, its records bind through Research, and it
   must declare no effect without a handler and no requirement without a resolver.
   It composes Research, Workflows, Application, Agent Sessions,
   Artifacts, Feed, Literature, the merv-sandboxes object and sandbox facades,
   telemetry, and tools.
   Machine setting `features.sandbox=false` substitutes a fail-closed backend
   and omits Sandbox tools and HTTP routes; absence keeps Sandbox enabled.
2. `tools/contracts.py` merges each installed program's tools and each support
   component's own `TOOLS` table into one manifest (unique names, fixed order),
   and declares the surface's own tools.
   `tools/dispatcher.py` binds each manifest entry directly to its owning module,
   validates input, enforces reviewer read-only access, and records the outcome.
3. `transport/mcp_http.py` and `transport/mcp_streamable_http.py` implement the
   MCP protocol. They delegate tool calls to the dispatcher.
4. `transport/api/app.py` builds FastAPI once. Its routers parse path/body/query
   input, call the dispatcher or the narrow capability that owns the operation,
   and serialize HTTP responses. Each router names the collaborators it needs —
   Research, Agent Sessions, the shared logic-graph read — and takes them as
   keywords here; Application appears only where a route joins two components.
5. `transport/api/gateway.py` authenticates the caller, resolves project scope,
   applies hosted/local policy, and invokes tools. Middleware supplies CORS,
   error rendering, redaction, and request telemetry.

## Necessary supporting boundaries

- `auth.py`, `identity.py`, `project_keys.py`: caller identity plus project and
  account credential lifecycle. Project-key policy and SQL are intentionally
  together because there is one implementation and rotations must be atomic.
- `transport/api/agent_sessions.py` and gateway policy: runner control called
  straight on Agent Sessions, the generic central-advance routes, and MCP-only,
  default-deny authority for local agent workers enforced from the
  node-declared execution policy each lease carries
  (`http_policy.SessionExecution`); no tool, id field, or workflow name is
  hardcoded beyond `tool:workflow.transition` and the baselines.
- `runner_pairing.py` plus `transport/api/runner_pairing.py`: device-code
  pairing of an auto-run machine — the runner presents only its key digest, an
  owner approves the printed code, and the digest is registered as a labelled
  project key in the same transaction (`ProjectKeys.register_digest`). The two
  runner-facing routes are the only unauthenticated ones besides `/health`; it
  is mounted exactly where owner key management is (hosted auth).
- `oauth.py`, `oauth_store.py`, and `transport/api/oauth.py`: OAuth policy,
  race-safe persistence, and protocol routes. `oauth_store.py`, `project_keys.py`,
  `user_settings.py` and `agent_identity.py` each declare the tables behind the
  flow they own; composition installs them, kernel first, then every other
  component's as it is constructed. Persistence stays separate because
  both halves are substantial and transactional behavior must remain explicit.
- `artifacts.py` plus `transport/api/artifacts.py`: stable artifact wire shapes
  and token-authenticated uploads. Project-authenticated content/file/figure
  reads accept generic content IDs or research association handles. The three
  tools are `tool:artifact.upload` (optional `attach_to`), `tool:artifact.read` (ID, batch,
  or research filters), and `tool:artifact.attach` (reuse existing content). ID reads
  include authenticated download URLs, including for unattached binary files.
  Raw file/figure responses isolate active content with CSP sandbox and nosniff.
- `telemetry.py`: in-memory activity, durable tool-call recording, and optional
  structured logs.
- `config.py`, `brain_dirs.py`, `transport/http_server.py`: environment parsing
  and local/hosted server construction.
- `transport/api/views.py`: UI-only derived projections.
- `workflow_knowledge.py`: binds project and immutable artifact readers to the
  workflow transaction; workflows receive a read-only, project-scoped capability.
- That file, and the experiment, task, claim, review, reflection, sandbox and
  view routers, are research files hosted in this delivery tree. Everything
  else here is support, and the support-vocabulary law reads it.
- `feed_http.py`, storage routes, and user settings: protocols whose byte
  streaming, token, or security behavior cannot be represented as an ordinary
  tool call.

## Boundary rules

- Surface may format and authorize; it may not reproduce module workflow rules.
- HTTP routes receive narrow collaborators, never a dependency bag or facade.
- Tools and routes bind directly to their owning product roots; Application is
  used only for genuinely cross-module workflows, never as a way to reach one.
- Generic workflow tools use instance IDs and ordinary action names; their
  schemas and routing contain no per-workflow cases. Workflows checks project
  scope, definition version, current revision, and durable gate facts.
- Public MCP/HTTP names, schemas, status codes, response dictionaries, token
  behavior, and auth scope are compatibility contracts.
- Token-bearing paths are redacted before telemetry. Upload tokens, project
  keys, and OAuth credentials are never logged as plaintext.
- Optional capabilities are omitted from their tool and HTTP surfaces when
  disabled rather than advertised as failing operations.
- New helper files require real protocol, security, persistence, or presentation
  behavior. Do not add facades, repositories with one implementation, dependency
  carriers, forwarding services, compatibility re-exports, or duplicate DTOs.
