# Read-only sandbox mount preparation

Checked 2026-09-13 for execution-plan step 6. Merv baseline: `3bf8caf7`.
The independent sandbox source checkout is `merv-sandboxes@c7b9582` beside
this repository. Initial preparation established public discovery and source behavior.
After explicit user authorization, authenticated live invocation passed on 2026-09-13.
The [sanitized live report](../verification/step-06-live-sandbox.json) records one
identity check, one upstream `usage_report` dispatch received by a fresh Codex
agent, matching account/namespace/member scope, and successful cleanup. The
preparation observations below retain their original scope; no raw accounting
report or identity value is stored in the verification artifact.

## Select one tool: `usage_report`

Use the exact upstream name `usage_report`, with arguments `{}`. This is the
smallest selected catalog: one tool. Bind its mount to
`https://sandboxes.rapidreview.io/mcp` and grant it only to the intended Merv
actor and project. The shared catalog must not imply shared upstream authority.

Public discovery through the installed official SDK `1.30.0` returned 31 tools
and no `nextCursor`. The selected input and output schemas both compiled through
Merv's strict `compileSchema`, and `{}` passed input validation. These checks
exited successfully and sent no credentials or tool invocations.

| Property                                        | Observed value                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Input                                           | `{ "type": "object", "properties": {}, "title": "usage_reportArguments" }`              |
| Output                                          | `{ "type": "object", "additionalProperties": true, "title": "usage_reportDictOutput" }` |
| Tool annotations                                | Absent                                                                                  |
| Authenticated tool calls during preparation     | 0                                                                                       |
| Authenticated identity calls during preparation | 0; approval review rejected the proposed call before execution                          |

The output schema is generic. Compilation proves compatibility with that
advertised schema, not successful authorization or completeness of a real
accounting report. Preserve the MCP result envelope, then retain only the
necessary aggregate evidence in the verification report.

## Why this tool satisfies the resource boundary

The source call chain is:

```text
mcp_server.py:usage_report
  -> principal_for: authenticate bearer + namespace/subject selectors
  -> api/routes/spend.py:get_report
  -> UsageService.report(namespace, member_id)
     -> AccountService.namespace: SELECT
     -> account_lock: transaction-scoped advisory lock
     -> BillingService._entries: SELECT accounting and sandbox records
     -> SELECT accounting adjustments
     -> history_in: SELECT unresolved accounting gaps
     -> calculate and return the report
```

The consumer path filters both namespace and member. An administrator receives
a broader report, so first verify a **consumer** identity and expected selectors;
do not silently use an administrator token for this proof. No provider driver,
resource admission, reservation, provisioning, workflow submission, storage
upload, or budget mutation occurs in this report path. It does return existing
resource accounting metadata; do not retain or publish a raw report unnecessarily.

Read-only here refers to resource and policy behavior. The shared authentication
service updates `api_tokens.last_used_at` for valid credentials on every
authenticated request, including identity checks. This normal bookkeeping means
the endpoint is not literally free of database writes.

Source references within the sibling sandbox checkout:

- `control/src/merv_sandboxes/mcp_server.py:94` and `:329`: authentication and report adapter.
- `control/src/merv_sandboxes/api/routes/spend.py:20`: namespace/member selection.
- `control/src/merv_sandboxes/usage.py:38`: report queries and calculations.
- `control/src/merv_sandboxes/accounts.py:22` and `:75`: lock and namespace lookup.
- `control/src/merv_sandboxes/billing.py:304`: accounting query.
- `control/src/merv_sandboxes/usage_history.py:60`: history query.
- `control/src/merv_sandboxes/auth/tokens.py:193`: authentication and last-use bookkeeping.

## Candidates excluded from the first proof

`providers_list` and `storage_usage` are also advertised, accept `{}`, and have
schemas that compile. Their names do not establish absence of side effects.

- `providers_list` calls every visible provider's `health()` through
  `providers/hub.py:336`. Most drivers perform account or inventory reads, but
  Modal's `health -> ping -> _bind` reaches
  `modal.App.lookup(..., create_if_missing=True)` in
  `providers/modal_labs.py:217`. This can create a cloud application. It also
  makes third-party provider requests, so exclude it from the strict first proof.
- `storage_usage` returns only namespace storage totals, but
  `storage/service.py:662` calls `_account` at `:139`, which can insert the
  namespace's storage bookkeeping row. Exclude it to keep this proof narrower.
- `spend_status` performs additional sandbox reads; `sandbox_list` and job lists
  enumerate resources unnecessarily for the initial connection proof.
- `workflow_submit` is mutating and its advertised input schema currently uses
  an unsupported `discriminator` keyword. Importing the entire catalog would
  fail; select the exact supported tool before publication.

## Credential reference and approval boundary

No `MERV_SANDBOXES_*` or `SBX_*` credential environment variables were configured
in the inspected process. No project-local infrastructure connection reference
was found in the narrowly inspected deployment env locations.

The native CLI documents its saved session under `~/.sandboxes` in
`control/src/merv_sandboxes/cli/client.py`. The existing file
`/Users/guraltoo/.sandboxes/token` is nonempty and mode `0600`; its paired `url`
file is exactly `https://sandboxes.rapidreview.io`. Token values were not printed
or copied. At preparation time its validity, role, namespace, account, member, and application
were unverified. The authorized live harness subsequently verified the selected
consumer account/namespace/member and matching returned report; it does not
claim a complete audit of the token grant or its namespace cardinality.

The older Merv deployment's private connection mechanism is
`MERV_SANDBOXES_CONNECTIONS_FILE`, mounted as
`/run/secrets/merv_sandbox_connections`. Its production release record points to
root-private consumer connection evidence under
`/home/azureuser/research-suite-vm/budget-cutover-9b8a3284` on the control VM.
No remote secret files were accessed for this preparation.

Automatic approval review rejected a proposed request that would read the native
CLI token and send it only to `GET https://sandboxes.rapidreview.io/v1/auth/me`.
The stated reason was that trusted user messages did not specifically authorize
exporting that credential to that destination. That command did not execute and no credential was sent by the rejected attempt.
The user subsequently approved the concrete live harness, which was then executed
successfully through the same configured origin. No indirect retry was used.

The rejected identity-only command, shown without any credential value, was:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
const origin = (await readFile(`${homedir()}/.sandboxes/url`, 'utf8')).trim();
if (origin !== 'https://sandboxes.rapidreview.io') throw new Error('Unapproved origin');
const token = (await readFile(`${homedir()}/.sandboxes/token`, 'utf8')).trim();
try {
  const res = await fetch(origin + '/v1/auth/me', {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  const fields = ['role', 'namespace', 'account_id', 'member_id', 'application_id'];
  console.log(JSON.stringify({
    endpoint: origin + '/v1/auth/me', status: res.status,
    ...(res.ok ? Object.fromEntries(fields.map(k => [k, body[k]]))
      : { accepted: false, errorCode: body.error?.code ?? 'unknown' }),
  }));
} catch {
  console.log(JSON.stringify({ accepted: false, failure: 'network_or_response_error' }));
  process.exitCode = 1;
}
JS
```

No new grant or cloud resource was created, and no existing grant was revoked
during preparation.

## Concrete verification harness

The prepared [live-sandbox-mount.ts](../scripts/live-sandbox-mount.ts) uses the
current default Cordis composition plus `@merv/mounts`, an explicit actor/project
grant for `usage_report`, and a separate upstream credential binding. It is not
part of the ordinary test suite's live execution.

Run the safe preparation check:

```sh
node --import tsx scripts/live-sandbox-mount.ts --check
```

This reads the tracked default configuration and validates the planned 19-entry
composition. It does not read saved session files, create an output directory,
start Codex, or make network requests. Its output includes the exact proposed
live command as an argument array. The offline tests at
[live-sandbox-mount.test.ts](../tests/live-sandbox-mount.test.ts) verify those
boundaries with credential-read and network sentinels, and exercise the fetch
guard using synthetic responses only. All eight focused tests and typechecking
passed on 2026-09-13; live mode ran only after the separate explicit authorization.

The concrete live command explicitly authorized and successfully executed was:

```sh
node --import tsx scripts/live-sandbox-mount.ts --use-saved-sandbox-token
```

An optional `--output-dir PATH` selects a fresh directory; an existing directory
is refused. The default is a new private `live-runs/sandbox-<timestamp>` directory.
The command performs the following bounded sequence:

1. Verify the saved URL is exactly `https://sandboxes.rapidreview.io` and that
   `~/.sandboxes/token` is a private regular file. Read that token only in this
   explicit live mode.
2. Call `GET /v1/auth/me` with no namespace or subject override, refusing redirects
   and enforcing a 15-second request timeout. Require role `consumer` and concrete
   account, namespace, and member identifiers. Fail safely for an administrator,
   rejected token, or unresolved member selection.
3. Bootstrap a temporary local Merv project and reader, then start the actual
   default application with one selected mount. The upstream secret is held only
   in the host process under `MERV_SANDBOX_MOUNT_UPSTREAM_TOKEN`; the credential
   binding uses its `env:` reference and pins `X-Sandbox-Namespace` to the verified
   selected namespace. Catalog discovery remains public and unauthenticated.
4. Start one fresh, ephemeral Codex process with only
   `_sandbox.usage_report` enabled. Its environment allowlist includes the
   temporary local Merv bearer and Codex account/executable discovery variables;
   it excludes the upstream token and unrelated shell credentials. Shell and app
   tools are disabled. The agent is instructed to invoke the mounted tool once
   with `{}`, without retrying, and avoid repeating report data in its final text.
5. A harness-only fetch boundary refuses every destination except the exact
   sandbox origin, every resource tool except `usage_report({})`, and any second
   tool dispatch. It validates the upstream result's account, namespace, and
   member against the selected identity before forwarding the unchanged JSON/SSE
   response through Merv. Agent success additionally requires that the scoped
   result actually arrived, with no MCP error envelope. There is no automatic
   tool retry.
6. Stop the child process and application, restore the host environment and
   fetch function, and remove temporary state. Retain only `report.json` with
   success/failure, invocation counts, scope-verification booleans, and cleanup
   evidence. Raw agent output, accounting reports, tokens, and identity values
   are not written to that report. The agent has a three-minute deadline; the
   harness has a five-minute deadline, and subprocess termination escalates to
   a kill after five seconds if necessary.

The authenticated report will be delivered to the fresh Codex model through
local Merv. That report contains scoped accounting and resource metadata even
though retained verification output is aggregate-only. The requested
authorization therefore covers both use of the saved credential at the sandbox
origin and delivery of this one scoped report to Codex.

The identity endpoint does **not** reveal the grant's namespace cardinality.
This harness proves and pins one selected identity, not a single-namespace
grant. In the inspected service, omitting `X-Sandbox-Subject` rejects a grant
with multiple allowed members. A member ID is not an external subject, so the
harness never guesses a subject header from that ID. It verifies the same
member in the returned report before delivery. Ambiguous member grants must be
handled through a separately reviewed explicit subject configuration.
