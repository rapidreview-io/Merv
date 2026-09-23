# Fleet implementation status

The user authorized staged implementation after approving the reduced
[Fleet/Pi proposal](FLEET_PI_PROPOSAL.md). Earlier design-only statements describe
the proposal-writing phase, not the current authorization. The full goal remains
active; none of the release milestones is complete yet.

## Current stage: milestone 0, security foundations

Sandbox source checkout: `output/fleet-sandboxes`, branch
`codex/fleet-runtime-bootstrap`, based on sandbox commit `c7b9582`.
Implementation commits: `2eaab0e` (foundations), `4bb4771` (protected access and
local transport/sudo acceptance).
An incremental backup bundle is at `output/fleet-runtime-bootstrap.bundle`.
The original sibling sandbox checkout has unrelated edits and was not modified.
This isolated clone's origin points to that sibling; nothing was pushed/deployed.

Implemented:

- Encrypted expiring bootstrap envelopes using existing AES-GCM vault primitives.
  Immutable operation/launch/job bindings, replay, revoke/consume/purge, safe
  metadata and retained idempotency tombstones; migration 0025.
- Linux enrollment-file and assignment-identity primitives. Private tmpfs files,
  UID/GID/group/capability reduction, no privilege gain, cleared environment/FDs.
- Cloudflare entrypoint writes private bootstrap files and removes bootstrap
  variables before spawning child commands/services.
- Immutable protected-runtime creation mode denies generic SSH certificates,
  namespace-certificate connections, jobs, workflow attachment/provisioning,
  snapshots/restores and terminals. The infrastructure reverse tunnel remains
  available; this is not a public runtime-launch bypass.
- Container initializes the encrypted store and sweeps expired ciphertext.

Verification:

- 20 bootstrap-store PostgreSQL tests passed.
- Combined store, entrypoint, existing vault and bootstrap run: 27 passed.
- Five real Linux launcher tests passed independently in local Docker.
- Ruff and whitespace checks passed.
- Latest protected-boundary/access/jobs/store run: 68 passed. Registry/snapshot/
  workflow regression run: 59 passed. Following independent review, fixes for
  legacy workflow replay, immutable mode and terminal denial passed a 41-test
  focused run; protected reverse-tunnel registration passed separately.
  These suites overlap; their counts are not a distinct-test total.
- Real gateway certificate/SFTP test: exact synthetic payload delivered, no
  canary in raw/decoded asciicast recordings or gateway/sshd logs, positive
  shell-recording control. Five e2e subtests passed with networking disabled.
- Actual sudo-capable Cloudflare-image fixture: seven Linux tests passed.
  Positive controls proved unrestricted sudo, setuid and file-capability
  escalation works, then proved the launcher blocks those same attacks.

PostgreSQL tests used an isolated local container, `merv-fleet-bootstrap-postgres`,
at `127.0.0.1:51529`; no production database was accessed. Docker Desktop was
started for tests. These tests do not prove the real Cloudflare provider gate.
The later sudo fixture uses cached Cloudflare image
`sha256:5b9fde5b4a58be30712cf747dabe23baed5749ae6df4a44cb4ee69a9f9121939`.
Live provider acceptance and final-image ACL/cgroup guarantees remain open.
No cloud resources or model credentials were used for this work.

The local sibling Python environment crashes importing readline through pytest's
capture plugin. Tests ran with `-p no:capture`; this is a local test-tool issue.

## Next implementation work, in order

1. Protected transport and fixed-release launch coordinator. Do not reuse ordinary
   job scripts or their retained command/env fields. SFTP recording exclusion
   and generic privileged-surface denial now have local evidence. Implement
   actual private-file delivery with receipt/retry behavior and no diagnostic
   secret leakage, preserving the protected-runtime boundary.
2. API authorization, immutable release allowlist, durable launch receipts,
   enrollment retry/revocation fencing. Envelope expiry cleanup is now wired.
   The store/launcher are intentionally not public routes or job resolvers.
3. Dedicated image and Runner assignment adapter, including scoped environment
   and output channels. Prove actual UID/GID/sudo/process protections, provider
   termination and both milestone-0 go/no-go gates on the configured provider.
4. Workflow Fleet v1: optional package, PostgreSQL admission/lifecycle, shared
   Sessions selection helper, one-assignment managed principal/Runner, status UI.
   Three-machine real-work acceptance with failure and external-runner coexistence.
5. Pi read-only pilot after Fleet acceptance: independent conversations, same
   capacity channel, bounded transient streaming, durable canonical outcomes and
   checkpoint/restore. Conversational writes stay behind the separate gate in
   the Pi proposal; do not silently replace that scope with broad credentials.

Keep hosted execution disabled until milestone 0 passes. In particular, the
store's resolved plaintext can race a later revoke: enrollment must revalidate
current authority. Process-group cleanup does not prove descendant termination;
cgroup/provider shutdown owns that fact. The primitives document these limits.

## Reproduction

From `output/fleet-sandboxes`, using the sibling control virtualenv:

```sh
SANDBOXES_TEST_DATABASE_URL=postgresql://sandboxes:sandboxes@127.0.0.1:51529/postgres \
SANDBOXES_TEST_DOCKER=1 PYTHONPATH=control/src \
../../../merv-sandboxes/control/.venv/bin/python -m pytest -p no:capture \
  control/tests/test_runtime_bootstraps.py control/tests/test_runtime_entrypoint.py \
  control/tests/test_vault.py control/tests/test_bootstrap.py -q
```

The local test DB uses disposable fixture credentials only. For Linux tests,
mount this clone's `control` read-only at `/control`, the sibling virtualenv's
pure-Python pytest dependencies at `/testdeps`, and run `python:3.11-slim` with
network disabled, `PYTHONPATH=/control/src:/testdeps`,
`PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`, and private tmpfs
`/run/merv-runtime:rw,nosuid,nodev,noexec,mode=0700`.
Copy `test_runtime_launcher.py` to `/tmp` before running pytest there to avoid
loading macOS-compiled dependencies through the repository conftest.
