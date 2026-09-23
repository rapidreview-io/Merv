# Fleet implementation status

The reduced [Fleet/Pi proposal](FLEET_PI_PROPOSAL.md) is approved for staged
implementation. Fleet owns generic VM/runtime lifecycle; a separate workflow
adapter asks it for capacity, and chat uses independent taskless requests.
Neither Fleet nor chat depends on the research workflow. Fleet is deployed for
one disposable project. Local managed Codex acceptance, the Cloudflare platform
canary, and protected single-worker execution with automatic cleanup passed.
The final `gpt-6-luna` producer delivered a verified isolation probe, acknowledged
local release, and Fleet stopped its VM without intervention. Independent native
inventory confirmed zero VMs. Dispatch is off. Three-VM Git acceptance remains
pending; the completed task intentionally had no Git workspace. Pi has not started.

Merv now runs setup release `20260923T080026Z-da77907a-5a96a7bf1b4e`.
The completed pilot's workflow adapter is disabled and its source credential is
revoked, so later expiry cannot break startup. Fleet and its optional sidebar
remain available. The signed-in operator Keys page can issue a finite project
credential using the existing `actor.create` API; five UI tests and UI typecheck
passed, including a late response after a project switch. The deployment also
exposes the existing allocation deadline, configured to 1800 seconds. All limits
remain one. Public/container health and served assets passed after deployment;
public health passed again after putting the pilot into this idle state.

GitHub is connected to the human-created `Fleet Git acceptance 2026-09-23`
project and its isolated `rapidreview-io/merv-github-smoke` repository. Agent
repository access is still off, and no Fleet credential has been issued there.
Read-only repository access and a four-hour test-project operator credential
are awaiting explicit approval. Repository preparation and multi-VM execution
have not started.

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
  all inventory pages, then rechecks for deployment drift. A protected worker
  has activated on the pinned image, completed work, acknowledged local release,
  and been removed automatically.
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

The first complete amd64 hosted Codex image was built and pushed to a dedicated
Cloudflare application, leaving the existing bridge unchanged. That image was
pinned to digest
`sha256:5e95a293042768d070bb59684179f95703bd06e6e951cd8331dd84c4c04a30d5`.
The `/run/sshd` startup fix at sandbox commit `a7334969` was then built into a
replacement complete image without changing the Runner bundle or executable
hash. The tested OCI image descriptor and published registry index both have
digest `sha256:da01a5581ef10fb06cb0665e831dc5dd9889b95c755ce77cd8b39d962768bf93`.
The dedicated Cloudflare application reported version 2 with that exact image,
one-instance cap, and a healthy rollout. Its release is
`rt1_b61fdc64f5f21c5c98ab268d1700aab21e340fca347c701044fbfa33a27f2d16`.
The old catalog entry and image pin were retained for rollback. Build and
publication evidence is in `output/fleet-image-20260923-rundir-fix/`.
The current version 3 adds Runner acknowledgement fix `f103ecd0`, pinned to
`sha256:ebb7c789a29d72d925312ae4bdbb904cd299a9c12af39b858b50431763bcc48d`.
Its fixed release is
`rt1_6027fb1375124384291717b6376198a2e8bc674ae5203aad4de19ffc23c20ab6`.
The complete image passed the fresh-`/run` protected bootstrap smoke before
publication; source, build and publication evidence is in
`output/fleet-image-20260923-release-ack/`. All earlier catalog entries remain
available. The dedicated application is still capped at one instance.

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
enrollment or real work execution on Cloudflare. The later protected acceptance
below supplies that evidence separately.
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

1. Prepare the isolated Git test project through normal human administration,
   then run three-machine real-work acceptance, including workspace capture,
   injected failure and external-runner coexistence. The single-worker
   protected execution/cleanup gate is complete; it did not exercise Git.
2. Pilot Pi only after Fleet acceptance, within the separate read-only and
   conversational-write gates in the proposal.

The user approved the test credential after the initial automatic approval
rejection, and the platform canary above completed. A separate attempt against
the existing `dev` account was rejected by its spending suspension; that account
and its safeguards were left unchanged. The dedicated Fleet account uses its
own newly created bridge credential and spending controls.

The operator-owned `cloudflare-fleet` provider and dedicated native verification
credential are installed. Workers Containers **Read** permission was verified
against application and instance GET endpoints, restricted to the control host's
egress IP and expiring on 2026-09-30. The developer Wrangler OAuth credential
remains local. The user explicitly approved transferring the supplied OpenAI key
to root-private host configuration for `gpt-6-luna` tests. Acceptance collectors
execute on the host; project and sandbox bearers remain there.

The first protected test failed before enrollment: four sequential allocations
failed before tunnel readiness; no Runner session or model call occurred. Fleet
confirmed all four stopped and independent Cloudflare inventory showed zero
instances. Dispatch was disabled on detecting the replacement loop. Retained
Cloudflare logs distinguish two protected-bootstrap failures from two subsequent
capacity failures. The ordinary canary's log identified missing `/run/sshd` at
bootstrap validation: Cloudflare does not preserve that build-time directory,
and the previous entrypoint created it only after bootstrap. Protected startup
correctly failed closed at that step. Commit `a7334969` initializes runtime
directories before bootstrap; a fresh-`/run` protected AgentBootstrap regression
passed remotely, and the previous entrypoint failed the same fixture.
Evidence: `output/fleet-cloudflare-canary/protected-startup-failure.json`.
Retained log excerpts: `protected-startup-log-evidence.json` in that directory.
This is a failed acceptance, not a successful protected launch.

Commit `2c867f97` bounds replacement attempts for an unchanged task revision:
at most two created-but-unclaimed allocations, with a 60-second cooldown before
the second. Existing allocation history preserves this across adapter restart;
queued allocations cancelled before creation do not consume the budget. A new
task revision remains eligible. Six focused workflow tests and typecheck passed.
An exhausted revision currently needs a new revision/task; no new retry control
or scheduling table was added. Deployment of this fix was explicitly approved
and completed with healthy public/internal checks.

Enrollment is deliberately short-lived (15 minutes, bounded by the allocation
deadline). A prolonged uncertain launch can exhaust that window; it must retire
and retry as a new allocation, not extend the old credential indefinitely. Fleet
currently bounds that recovery by the allocation deadline.

Sandbox work is in `output/fleet-sandboxes` on `codex/fleet-runtime-bootstrap`,
cloned from sandbox commit `c7b9582`, now merged with deployed sandbox commit
`0d64e2f8`. The startup-fix checkpoint is `a7334969`, following `e28e401`
(documentation), `33109ff`, `e17907f`, `4369915`, `07b25e0` and merge
`e14b89d`; the incremental backup is
`output/fleet-runtime-bootstrap.bundle`. The sibling sandbox checkout was left
untouched. The dedicated Cloudflare image and bridge were deployed. Sandbox
control and pipelines-worker now use the additive deployment; the gateway,
database and Hatchet services were untouched.
The replacement control image `merv-sandboxes-control:33109ff-fleet` was built
on the control host from the clean, checksummed source archive and passed an
import smoke. Its image ID is
`sha256:2d1c085e1a230c38eff3454580397038c901e30a8fda8229ec6b12d8df5728bc`.
The additive Compose helper has four passing tests and preserves the existing
providers and service settings. Its rollout passed health, namespace/grant,
release-catalog and native image checks. Six workload drain counts were zero
before and after replacement. Build evidence is in
`output/fleet-control-build-33109ff.json`.
The control and pipelines services have since loaded the new release into the
operator catalog without removing the previous one. Their image remains
`merv-sandboxes-control:33109ff-fleet`; the gateway, database and Hatchet
services were not recreated.

The protected tests ran on committed `2c867f97`, release
`20260923T064442Z-2c867f97-714a965267ff`, configured for one disposable Fleet project,
fixed Cloudflare provider/release, 600-second lease, and all caps one. Dispatch
is currently off. Its compiled CLI, container health, all 57 configured
plugins, public UI/assets, anonymous denial and origin restrictions passed the
existing release checks. Only committed source was packaged; unrelated local
workflow/Lean changes were excluded. The deployment record and rollback image
are retained in `deploy/RELEASES.md` and the remote release directory.
The same immutable Merv image was recreated with only its private Fleet release
ID changed first to `rt1_b61fdc64f5f21c5c98ab268d1700aab21e340fca347c701044fbfa33a27f2d16`
and then to current release
`rt1_6027fb1375124384291717b6376198a2e8bc674ae5203aad4de19ffc23c20ab6`.
The candidate rendered with the expected provider, offer, 600-second lease,
one-worker limits and disposable project; the app and public health checks passed.
The earlier canary environment and pre-Fleet baseline remain in root-private
backups. In the earlier protected run, task
`wf_566f694393fb49f9a69ab4cc25af2da0` reached an activated managed session
`session_7210fbde21614a129d3443d2bfa27013` on native application version 2.
Dispatch was fenced off after activation. The task delivered artifact
`art_47f738c13097441387fcbc7b979af241` and reached review
`review_eed2e930af1b44d6a068f2a385a923b2`; Sessions reached `released` with
outcome `completed`. Its literal probe independently passed UID/GID 12001,
zero effective/bounding capabilities, no-new-privileges, the four private-path
access checks and arithmetic 42. There was intentionally no Git workspace.

`runner_released_at` nevertheless remained null: a remotely completed Runner
without a usage file skipped the release acknowledgement. Fleet correctly
waited for that acknowledgement. The operator requested `fleet.halt` at
07:18:23Z; Cloudflare independently confirmed zero active instances and no active
deployment for native `cfc-op_c9wbwfn0jjr8opm3` at 07:18:36Z. This is a failed
automatic-cleanup gate, despite successful protected task execution. Sanitized
evidence is in `output/fleet-cloudflare-canary/protected-second-result.json`,
`protected-second-probe.txt` and `protected-native-second-summary-20260923.json`.
The collector's `localChecksPassed` covers only its listed linkage/probe checks;
`acceptancePassed` is explicitly false.

Runner fix `f103ecd0` always acknowledges managed remote closure, including when
there is no usage report, and keeps release pending through transient network
failure. Its real managed handoff regression injects the first failed
acknowledgement, verifies pending state, then verifies retry and server receipt;
ordinary Runner behavior stays unchanged. All 13 Runner integration tests and
typecheck passed. The replacement hosted overlay is deployed; the running
control-server image does not need this Runner-only fix.

The repeat producer task `wf_c7e253751027433bac7923ac71ddc631` passed on version 3.
Its first attempt was released before enrollment after Cloudflare reported no
available container capacity. Resuming the same task preserved its existing
two-attempt budget and cooldown. The second attempt bootstrapped successfully;
native inventory initially reported `stopped` before reporting `running` at
07:48:50Z. Protected delivery waited for native verification to succeed.
Allocation `flt_0265bcb6824c43fc9a4c174eb09566b0` activated managed session
`session_8b549f079bd04823acc204f48ffbd6d0` at 07:49:01Z. The task delivered the
literal isolation probe, reached `in_review`, and completed its producer session
at 07:49:22Z. A read-only database check confirmed `runner_released_at` at
07:49:23.401Z. Fleet released the allocation at 07:49:33Z; native inventory
confirmed no active deployment for `cfc-op_x5n2jdj0afd7vapm` and zero VMs at
07:49:39Z, independently reconfirmed at 07:53:51Z. No manual stop was needed.

The probe independently verified UID/GID 12001, zero effective and bounding
capabilities, no-new-privileges, seccomp mode 2, denial of all four private paths,
and arithmetic 42. Dispatch was fenced immediately after activation. An earlier
reviewer on the same image also acknowledged release and was removed
automatically. Evidence: `output/fleet-cloudflare-canary/protected-third-result.json`,
`protected-third-probe.txt`, `protected-native-producer-summary-20260923.json`
and `protected-native-producer-independent-audit-20260923.json`.
This establishes protected execution and automatic cleanup, not an approved
Git delivery: the task remains in review and had no workspace. The 600-second
sandbox lease is renewable; the separate allocation deadline in that test was
one hour. Cleanup occurred well before both limits. The later setup release
exposes the deadline setting and the idle deployment now sets it to 1800 seconds.
