# Fleet implementation status

The reduced [Fleet/Pi proposal](FLEET_PI_PROPOSAL.md) is approved for staged
implementation. Fleet owns generic VM/runtime lifecycle; a separate workflow
adapter asks it for capacity, and chat uses independent taskless requests.
Neither Fleet nor chat depends on the research workflow. Hosted execution is
disabled. Local managed Codex acceptance and the first Cloudflare platform
canary have passed; full protected Cloudflare launch and three-VM acceptance
remain pending.

## Implemented locally

- The sandbox control plane has encrypted, expiring bootstrap envelopes; immutable
  launch bindings and tombstones; protected-runtime creation mode; and denial of
  generic SSH, jobs, workflows, snapshots, restores and terminals on that mode.
- An operator-owned fixed-release catalog and launch/inspect/stop API exist. The
  release catalog and explicit grant IDs default to empty. Admission checks the
  authenticated namespace, protected sandbox, provider and release. Launch
  receipts persist delivery state and support retry without claiming enrollment
  or readiness. Stop revokes the bootstrap and requests sandbox deletion; actual
  provider termination still needs confirmation.
- Launch-bound SSH certificates force a fixed receiver. Bounded transport pins
  the gateway host key; the receiver stores a private tmpfs bootstrap and a
  durable local launch claim before detached supervisor dispatch. This path
  avoids ordinary job scripts and their retained command/environment fields.
  The control plane now requires an operator-owned provider and independent
  native image verification before each delivery attempt. Cloudflare checks the
  pinned application image, exact native instance and running version, including
  all inventory pages, then rechecks for deployment drift. Actual hosted-image
  acceptance is still pending.
- The TypeScript Runner has an isolated Codex adapter, including a
  dedicated assignment launcher, scoped process environment and repository
  skill controls. Its local `oneAssignment` setting fences the runner to one
  durable assignment across completion and restart. Managed enrollment now
  gives that supervisor an allocation-bound control credential; the harness
  receives only its existing assignment-session authority.
- Hosted Git and code.v2 checkouts have their own `.git` directory. Their private
  mirrors and journals stay in the supervisor directory. Git against an
  assignment-owned checkout runs as UID 12001 with privilege escalation disabled;
  outgoing bundles are copied to a private, no-follow staging file before the
  supervisor imports them.

## Evidence and limits

An integrated sandbox bootstrap store, launch service, receiver, transport,
release and protected-boundary run passed 74 tests with one macOS skip for a
Linux-only test. One-assignment Runner integration, Ruff and TypeScript
typecheck passed again.
Earlier separate focused runs passed: sandbox service/store 26 tests, Runner
profiles 15 and Runner workspaces 15. These counts are
not a distinct-test total or a full suite result. Earlier Linux and gateway
fixture tests also exercised
receiver isolation, forced-command delivery and synthetic recording canaries;
they do not prove the final provider image or Cloudflare gates.

A real-model local acceptance passed using the authorized key supplied privately
to the test process, bypassing Keychain. The fixed `gpt-6-luna` Codex profile ran
one assignment inside the local Linux sandbox, submitted an artifact and both
acceptance confirmations, and released its session with outcome `completed`.
The task reached `in_review`; its evidence records UID 12001 and the result 42.
The test removed the container, and an independent Docker lookup confirmed its
absence. Evidence: `output/hosted-smoke-1790137772829/report.json` and retained
artifact blobs beside it. This test used a synthetic project's supervisor-held
source credential, not production managed enrollment. It is a local Docker test,
not Cloudflare acceptance. No deployment or cloud allocation occurred.

A second real-model acceptance used **managed enrollment**, with no ordinary
project credential delivered to the VM. The `gpt-6-luna` Codex worker again
completed exactly one assignment, submitted evidence, and released its session.
Evidence: `output/hosted-smoke-1790139581122/report.json`. The container was removed
and an independent Docker lookup confirmed its absence. This checks the actual
HTTP enrollment, restricted controls, and assignment execution locally; it does
not exercise the Cloudflare provisioning path.

Fourteen Linux assignment/launcher tests passed, covering UID/group/capability
drop, `no_new_privs`, root-private canary denial, prepared Git handoff and
hardlink/escaping-link/special-file refusal. A separate no-network Linux probe
used the installed Python helper and UID 12001 edits to verify code.v2 checkpoint
and final capture, plus legacy Git capture. Hosted Git regression suites and
TypeScript typecheck passed.

The final combined regression run passed **94 tests**: managed enrollment and
HTTP restrictions, cross-assignment Code denial, Fleet lifecycle/adapter and
composition, existing credentials/remote permissions, Code HTTP transfers,
Sessions and actual Runner child-process recovery. No tests failed or skipped
in that run. These overlap the earlier focused counts above.

The next sandbox checkpoint passed **86 tests** covering native Cloudflare
verification, protected launch, bootstrap boundaries, and the three newer
production fixes merged from `0d64e2f8`. These overlap previous counts. The final
merged image also passed the local Docker smoke for certificate SSH, tunnel
startup, root-owned protected workspace parents, and UID 12001 Git handoff.
A read-only live Cloudflare API check verified the application response and the
terminal pagination shape; it did not verify a running protected instance.

The complete amd64 hosted Codex image was subsequently built and pushed to a
dedicated Cloudflare application, leaving the existing bridge unchanged. Its
registry manifest identifies the exact locally built image. The application is
pinned to digest
`sha256:5e95a293042768d070bb59684179f95703bd06e6e951cd8331dd84c4c04a30d5`.

On 2026-09-23, Merv Sandboxes created `sbx_ngnfd4ak` in the independent
`fleet-cloudflare-canary` account with a one-VM limit, a ten-minute lease and a
$0.10 monthly compute budget. The VM became ready and ran the bounded platform
probe successfully. Root could mount the required private tmpfs with
`nosuid,nodev,noexec`; the ordinary sandbox user had UID 1000 and no effective
capabilities. The native Cloudflare verifier independently matched that exact
running instance, application version and image digest. Merv then confirmed
`stopped`, the provider confirmed `absent`, a separate native inventory was
empty, and the temporary API grant was revoked. No model or Merv runtime
credential was delivered to this VM. Evidence is in
`output/fleet-cloudflare-canary/successful-result.json`,
`native-verification.json` and `native-cleanup.json` beside it.

This ordinary-mode probe establishes platform capability and image provenance.
It does not establish protected startup, assignment UID 12001 isolation, managed
enrollment or real work execution on Cloudflare. Those remain acceptance gates.
The image now fails protected startup if its trusted bootstrap fails or private
tmpfs cannot be established; five local entrypoint tests and the ordinary image
smoke passed, alongside 27 focused provider/launch tests.

## Fleet v1 implementation in progress

- `@merv/fleet` now owns one PostgreSQL allocation table, stable requests, capacity
  reservation, reconciliation and retirement intent. It is disabled by default.
  Trusted owner adapters supply enrollment and completion; the core imports no
  Sessions, workflows or research implementation.
- `@merv/sandboxes` exposes an opt-in server-only runtime capability for protected
  provisioning, fixed-release launch, inspection, renewal and confirmed deletion.
- Sessions exposes `dispatchDemand`, sharing candidate eligibility with real
  leasing inside a read-only snapshot. It does not need an existing runner or
  acquire State's global writer lock.
- Optional Fleet UI/tools entries use the existing collection renderer for a
  sidebar row and drain/halt controls. No public allocation tool exists. A
  composition test verifies installation and withdrawal without Sessions or any
  research plugin.
- Sessions now binds each managed allocation to one successful automatic claim,
  with immutable profile/source, expiring enrollment and control credentials,
  restricted HTTP routes and transactional Code transfer checks. General tools,
  manual assignments and administration are denied. Existing external runners
  continue to use their existing authentication.
- The optional `@merv/fleet/workflow` entry connects shared Sessions demand to
  Fleet with the fixed `hosted-codex` / `gpt-6-luna` profile and code.v2 support.
  It carries enrollment and model credentials only through protected bootstrap,
  and waits for the supervisor's release acknowledgement and workspace capture
  before treating an assignment as finished. It adds no research dependency or
  separate scheduler tables.
- Deployment rendering now opts into Fleet only with explicit fixed-runtime
  settings. Workflow demand is separately enabled; credentials are referenced
  by environment variable name and never included in rendered configuration.

A real-services integration now covers shared demand → Fleet allocation →
protected launch receipt → managed enrollment → heartbeat → one lease → release
acknowledgement → provider-confirmed stop. Only the sandbox provider is a test
double in that run. The workflow adapter currently relies on actual claim/demand
changes and bounded empty-worker retirement; it does not predict external
runners' spare capacity.

The same integration now covers three concurrent managed workers, distinct
claims, one lost launch reply recovered without another create or launch,
provider-confirmed cleanup, and a coexisting external runner. All five workflow
tests passed, as did TypeScript typecheck. The provider remains a test double in
this integration; this is not the three-VM Cloudflare acceptance. Deployment
supports `MERV_FLEET_WORKFLOW_MAX_AGENTS`, defaulting to one, so the pilot can
raise concurrency explicitly after the single-worker gate passes.

Ten Fleet PostgreSQL tests passed, including global/project capacity contention,
lost-reply recovery, source revocation, cancellation during bootstrap, drain and
provider-confirmed release. Stable observations, including revision-only tunnel
heartbeats, perform no State writes. A separate combined consumer/demand/UI and
existing Sandboxes regression run passed 23 tests; the existing Sessions suite
passed 53 tests. These runs overlap and are not an aggregate suite count.

## Remaining work

1. Complete trusted provider image/release wiring;
   verify current-authority checks, provider termination and the Cloudflare
   security gates. Then run three-machine real-work acceptance with external
   runners coexisting. Local tests do not replace that acceptance.
2. Pilot Pi only after Fleet acceptance, within the separate read-only and
   conversational-write gates in the proposal.

The user approved the test credential after the initial automatic approval
rejection, and the platform canary above completed. A separate attempt against
the existing `dev` account was rejected by its spending suspension; that account
and its safeguards were left unchanged. The dedicated Fleet account uses its
own newly created bridge credential and spending controls.

The next deployment needs an operator-owned `cloudflare-fleet` provider and a
dedicated Cloudflare native API credential. The local Wrangler OAuth login can
verify instances but receives HTTP 403 from account-token management endpoints;
the available browser is signed out. Dashboard sign-in has been requested while
deployment and protected acceptance scripts are prepared. No further approval
is pending. The developer OAuth credential will not be installed on the server.
The provided OpenAI key is not the blocker. See
`output/fleet-cloudflare-canary/report.md` for the retained evidence.

Enrollment is deliberately short-lived (15 minutes, bounded by the allocation
deadline). A prolonged uncertain launch can exhaust that window; it must retire
and retry as a new allocation, not extend the old credential indefinitely. Fleet
currently bounds that recovery by the allocation deadline.

Sandbox work is in `output/fleet-sandboxes` on `codex/fleet-runtime-bootstrap`,
cloned from sandbox commit `c7b9582`, now merged with deployed sandbox commit
`0d64e2f8`. The latest checkpoint is `e17907f`, following `4369915`, `07b25e0` and merge
`e14b89d`; the incremental backup is
`output/fleet-runtime-bootstrap.bundle`. The sibling sandbox checkout was left
untouched. The dedicated Cloudflare image and bridge were deployed; the shared
sandbox control services and production Merv deployment have not been changed.
