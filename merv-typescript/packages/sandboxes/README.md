# Sandboxes

Sandboxes publishes rows that a service outside this process owns. merv-sandboxes serves a
manifest of rows — what each row holds, never how it looks — and this plugin validates that
manifest, registers one sidebar row per manifest row, and proxies each row's reads with the
calling project's own credentials. It owns no domain state and no Merv capability: its only
Cordis dependency is none at all, and the thin `@merv/sandboxes/ui` adapter injects
`sandboxes`, `ui` and `scope`. It mirrors the rows into the sidebar registry and draws the
project's machines on the Running page; `scope` answers only whether the reader holds `write`, so
Extend lease and Release machine are offered only to a caller the tools would let act.

The public `@merv/sandboxes/types` contract defines `Context.sandboxes`, `Sandboxes`,
`SandboxConnection`, `SandboxesConfig`, `SandboxRow`, `SandboxTarget`, `SandboxExtend`,
`SandboxReadiness` and `SandboxMachines`. `rows()` returns the rows from the last accepted
manifest, `status()` reports readiness only, `refresh()` reads every connection's manifest now,
`read(caller, rowId, params)` proxies the collection or one record, `extend` and `release` change
one named sandbox, and `subscribe(listener)` fires when the published row set changes. For the
Running page, `machines(projectId)` answers the project's machine list from memory, or null until
it has been read once; `machine(projectId, id)` answers one machine's record from memory; and
`watch(projectId, id?)` keeps them read for the next minute. None of the three calls the service.

Configuration names environment variables and never carries a secret:

```json
{
  "id": "sandboxes",
  "name": "@merv/sandboxes",
  "required": false,
  "config": {
    "urlEnv": "MERV_SANDBOXES_URL",
    "connections": [
      {
        "projectId": "project_example",
        "namespace": "research",
        "tokenEnv": "MERV_SANDBOXES_TOKEN"
      }
    ],
    "refreshMs": 300000,
    "timeoutMs": 15000
  }
}
```

`urlEnv` holds the service origin and is the only origin this plugin ever calls; each connection
holds one project's namespace and the name of the variable holding that project's `sbxt_` consumer
grant. Unknown configuration keys are refused, so a literal token cannot be configured by mistake.
Secrets are resolved for each operation and pinned through identity proof and dispatch. Only
credential fingerprints are cached; secrets are never logged or reported in status. A credential
change before dispatch refuses the operation so a retry can prove the replacement grant.
The default composition does not install this optional plugin;
`scripts/ui-demo.ts` composes it, its tools and its UI adapter for the demo project when
`MERV_SANDBOXES_URL` and `MERV_SANDBOXES_TOKEN` are both set.

A deployment composes the same three entries when `MERV_SANDBOXES_URL` is set, and none at all
when it is not: `deploy/render-config.mjs` reads the origin from `MERV_SANDBOXES_URL` (https, no
path, query or credentials) and one connection per project from `MERV_SANDBOXES_CONNECTIONS`, a
JSON array of `{ projectId, namespace, tokenEnv }`. Each `tokenEnv` names the variable holding
that project's grant, such as `MERV_SANDBOXES_TOKEN`; a literal grant in that array is refused
while the configuration is rendered, because a rendered configuration is written to a file and
checksummed.

`src/tools.ts` registers the two acts the manifest binds its controls to. `sandbox.extend`
`{ id, seconds }` adds `seconds` (60–86400, as the service bounds a lease) to what is left of one
lease: a renewal is a total, not an increment — the service sets the lease to now +
`lease_seconds` — so the record is read first and what remains is carried into
`POST /v1/sandboxes/{id}/renew` together with `expected_revision` from that record. The service
must atomically refuse a stale revision, so a concurrent extension cannot shorten another
client's renewal. A conflict requires reading the record again; the plugin does not retry writes.
Deploy the sandbox-service revision-check support before this client: an older service rejects
the extra field, and a record without a revision is refused before any write. There is no unsafe
fallback to an unconditional renewal. The
service publishes no maximum lease anywhere a reader can see, so an over-long total is its
refusal to give rather than a limit this build guesses at. `sandbox.release` `{ id }` sends
`DELETE /v1/sandboxes/{id}` with
`confirm_retained: true` — the browser's guard is the retention confirmation the legacy tool
asked for in a second call — and answers the record as it then reads, so the caller sees the
state deletion left behind. Both require the project's `write` permission, like every other tool
that changes something. Release is idempotent, while each separate extension adds the requested
lifetime. Both answer the
service's own record, stripped of anything named like a credential.

`src/client.ts` is the whole transport, and it reads: origin validated as an HTTP(S) origin with no
credentials, query, fragment or path; `GET /v1/auth/me` for each new connection/credential identity, requiring role
`consumer` and the configured namespace, so an administrator grant is refused before any resource
is requested; `X-Sandbox-Namespace` and the bearer on every call; `{id}` substitution guarded to
letters, digits, dashes and underscores; routes constrained to plain `/v1` paths, so a manifest
cannot point a read at another host; redirects refused rather than followed; bounded timeouts; and
JSON bodies only, limited during streaming to 4,000,000 decoded bytes (4,096 bytes for a write
error). Rejected and oversized bodies are cancelled; the deadline also covers response-body
reads. Upstream read failure bodies are never forwarded — only the
shape of the failure, as `sandbox_forbidden`, `sandbox_not_found`, `sandbox_redirect_refused` or
`sandbox_unavailable`. A write is the caller's own act on one sandbox it named, and why the
service refused it is the answer, so a refused write reports the service's own error code and
message — `sandbox_operation_state`, `sandbox_validation` — and nothing else from the body.

The published contract is the shared schema in `@merv/contracts/ui-manifest`
(`packages/contracts/src/ui-manifest.ts`); `src/manifest.ts` drops nulls, validates the manifest
against it and filters acts. A column type this build does
not know rejects the whole manifest; unknown keys are dropped rather than forwarded; field paths
must be dot paths; the console link must be https or a path on the service itself. The service
writes an unavailable value as JSON null, so a null in the manifest means the same as an absent
key and is dropped before validation; row data keeps its nulls, where a missing field renders
nothing. Controls in `record.act` are dropped unless
their tool is one of `sandboxTools` (`sandbox.extend` and `sandbox.release`, the tools this
package ships), and every other control — a tool a newer service binds that this build does
not have — is dropped before the row reaches the registry, so the browser renders no control it
cannot dispatch.

Each row registers as `sandboxes-<manifest row id>` at `/<manifest row id>` with
`view = { kind: 'collection', icon, spec, record }`, where `spec` and `record` are the manifest's own
specifications. Its status is readiness only — never a count, because a number beside a row label
means open work against the project and a proxy cannot know that; the browser derives any count
from the collection's open states. `read` answers the service's JSON untouched except that every
field named `token`, `secret`, `authorization` or `credential` is removed at any depth, and that a
record read carries `console_origin`, the configured origin, so the browser can resolve a console
href the manifest gives as a path. The record key comes from the row read's `params.id` — the
browser sends `ui.read` `{ rowId, params: { id } }` — and no key reads the collection. The
connection is chosen by the caller's own project, never by input, so one project cannot read
another's namespace.

The manifest is read at startup, every `refreshMs` (five minutes by default), and on demand;
concurrent attempts share one read. Rows are re-registered only when the manifest actually changes.
An unreachable service keeps the last manifest: the row stays where it is and reports `degraded`
with a reason, instead of vanishing or showing an error page. Unloading the plugin withdraws every
row, stops polling, and rejects new operations on captured service handles with `sandboxes_closed`.
Shutdown waits for admitted operations to finish, including the follow-up read after a release.
An active manifest refresh finishes its current connection without publishing or starting the
next connection. Standalone service owners can await `close()` or the disposer from `start()`.

The Running page's machines are the one other thing held, in memory only. One timer reads each
watched project's `GET /v1/sandboxes` every 5 s while a machine or its job is changing and every
30 s otherwise, and each watched record every 8 s; a project is forgotten a minute after its last
watch. A record is read only for a machine the list holds, so a reader never has the service read
an id of its own choosing; one watched before the list first answers waits for it. A failed read
keeps the last rows and marks them failed. `extend` and `release` put their answer into that copy
at once and have the timer read the list and the record again on its next pass; a read already
out when the act landed is dropped.

Run `npm run test:sandboxes` for the fixture regressions: manifest validation and dropped controls,
row identity and view, proxied reads with the namespace header and stripped secrets, the refused
administrator grant, refused redirects and foreign routes, degraded status keeping its rows, the
two tools under a write grant — the read before the renew, a lease of three hours extended by one
hour ending at four, the renew body, `confirm_retained`, a clamped `seconds`, the service's own
refusal, an idempotent release — the deployment entries
appearing only when the service is named, and the shipped fake control plane
(`npm run fake:sandboxes`, port 3210) answering a manifest, six sandboxes and both lifecycle
routes this build accepts.
