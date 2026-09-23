# Fleet implementation status

The reduced [Fleet/Pi proposal](FLEET_PI_PROPOSAL.md) is approved for staged
implementation. Fleet owns generic VM/runtime lifecycle; a separate workflow
adapter asks it for capacity, and chat uses independent taskless requests.
Neither Fleet nor chat depends on the research workflow. Hosted execution is
disabled; no release milestone or provider acceptance gate has passed.

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
  A production provider image, release manifest and trusted supervisor are not
  wired together or attested yet.
- The TypeScript Runner has an isolated Codex scratch adapter, including a
  dedicated assignment launcher, scoped process environment and repository
  skill controls. Its local `oneAssignment` setting fences the runner to one
  durable assignment across completion and restart. This is not managed Fleet
  enrollment or server-side allocation.

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

Ten Fleet PostgreSQL tests passed, including global/project capacity contention,
lost-reply recovery, source revocation, cancellation during bootstrap, drain and
provider-confirmed release. Stable observations, including revision-only tunnel
heartbeats, perform no State writes. A separate combined consumer/demand/UI and
existing Sandboxes regression run passed 23 tests; the existing Sessions suite
passed 53 tests. These runs overlap and are not an aggregate suite count.

## Remaining work

1. Complete the managed-runner identity/enrollment and one-successful-assignment
   transaction, then connect the workflow owner adapter to the allocator and
   shared Sessions demand. The allocator's lifecycle callback contract alone is
   not production authentication.
2. Complete the hosted Git checkout and trusted provider image/release wiring;
   verify current-authority checks, provider termination and the Cloudflare
   security gates. Then run three-machine real-work acceptance with external
   runners coexisting. Local tests do not replace that acceptance.
3. Pilot Pi only after Fleet acceptance, within the separate read-only and
   conversational-write gates in the proposal.

Sandbox work is in `output/fleet-sandboxes` on `codex/fleet-runtime-bootstrap`,
cloned from sandbox commit `c7b9582`. The integrated runtime launch checkpoint is
`7b66e70`, following the earlier foundation and transport commits; the incremental backup is
`output/fleet-runtime-bootstrap.bundle`. The sibling sandbox checkout was left
untouched, and nothing was pushed or deployed.
