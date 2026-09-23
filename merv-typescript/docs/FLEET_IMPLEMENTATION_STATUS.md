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

A real-model local acceptance harness exists. Its latest attempt timed out while
reading the saved macOS Keychain key, before creating the synthetic task or
container. It has not demonstrated a real Codex assignment. No deployment or
cloud allocation occurred.

## Remaining work

1. Complete the trusted provider image, release installation, managed enrollment,
   current-authority checks at exchange, provider termination evidence and the
   Cloudflare security/acceptance gates.
2. Implement the actual Fleet allocator/package: PostgreSQL admission and
   lifecycle, shared Sessions selection, managed principal and Runner, status UI,
   hosted Git checkout, and three-machine real-work acceptance with external
   runners coexisting.
3. Pilot Pi only after Fleet acceptance, within the separate read-only and
   conversational-write gates in the proposal.

Sandbox work is in `output/fleet-sandboxes` on `codex/fleet-runtime-bootstrap`,
cloned from sandbox commit `c7b9582`. Earlier foundation commits are `2eaab0e`,
`4bb4771` and `7e4142a`; the incremental backup is
`output/fleet-runtime-bootstrap.bundle`. The sibling sandbox checkout was left
untouched, and nothing was pushed or deployed.
