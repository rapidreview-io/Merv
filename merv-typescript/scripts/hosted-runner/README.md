# Local hosted Codex acceptance

This explicit acceptance harness runs the isolated Runner and pinned Codex CLI
inside a local Docker container. It creates a synthetic project in a disposable
PostgreSQL schema, asks `gpt-6-luna` to submit evidence for one task, verifies one
session and a review handoff, and removes its container in `finally`.

Build the sandbox image from the isolated Sandboxes checkout, then build the
payload and overlay from the `merv-typescript` directory:

```sh
node scripts/hosted-runner/build.mjs ../output/hosted-runner-bundle
docker build -f scripts/hosted-runner/Dockerfile \
  -t merv-hosted-codex:acceptance ../output/hosted-runner-bundle
node --import tsx scripts/hosted-runner/local-smoke.ts
```

Set `MERV_DB_URL` to a disposable local PostgreSQL service. Supply the model key
through private process environment `MERV_RUNNER_API_KEY`; the test removes that
variable before creating the server or Docker subprocesses. Without it, the test
tries the dedicated Runner account in macOS Keychain. Never put the key in source,
an image build argument, or a committed configuration file.

The managed-enrollment acceptance is recorded in
`output/hosted-smoke-1790139581122/report.json` at the repository root. Its
session completed, evidence was submitted for review, and container deletion was
checked. The test preserves the report, artifact blobs and disposable database
schema for inspection. It does not assert that an independent review passed.

This bypasses provider provisioning and the SSH transport by invoking the actual
receiver inside local Docker. Managed enrollment gives the supervisor a scoped
control credential; the assignment receives only its session credential. Hosted
Git is implemented and locally tested. Cloudflare isolation, cleanup, and
provider acceptance remain pending. This script is not a production Fleet owner
or a substitute for those gates.

## Releasing to production

`node deploy/hosted-release.mjs` releases changes to these files: it layers the compiled hosted
files on the pinned base image, runs the Linux probes below against that exact image, and moves
the Cloudflare app, the Sandboxes catalog and Main together, with a live canary turn and automatic
rollback. `deploy/release.mjs` runs it after every production release.

It never rebuilds the base image, which holds `Dockerfile` and `packages/pi/worker-runtime`. To
change those, build a new base from `merv-typescript` with the isolated sandbox checkout:

```sh
node scripts/hosted-runner/package.mjs build \
  ../output/fleet-sandboxes ../output/hosted-candidate-1 merv-hosted-codex:candidate-1
```

The output is `../output/hosted-candidate-1/build.json`, with source hashes, image IDs and the
installed `/opt/merv/runtime/start-runner` SHA-256. Use a new output directory and tag each time.
The staged Docker context holds only the Cloudflare Dockerfile's explicit COPY inputs and the
amd64 agent binary. Push it, then pin it as `base` in `deploy/hosted-release.json`.

## Combined Pi and workflow Linux probes

The candidate now includes a fixed dispatcher for the workflow supervisor and
the isolated Pi SDK worker. Pi receives allocation-bound authority on private
stdin, not a provider key. Its pinned dependencies and lockfile come from
`packages/pi/worker-runtime`. The image entrypoint `boot` starts one worker at
container boot through the same identity drop; it loads Pi and waits on its
private stdin. A root-only socket hands its pipes to the first Pi supervisor,
which writes the bootstrap as before, and a workflow launch kills it. Without
that worker the supervisor starts one itself. The worker's module compile cache
is filled at image build under its UID and sealed root-owned; V8 ignores it
where the CPU features differ from the build host's.

Run these probes on a Linux Docker host against the built combined image:

```sh
docker run --rm --network none --cap-add SYS_PTRACE \
  --tmpfs /run/merv-runtime:mode=0700 --entrypoint /usr/bin/python3.11 \
  -v "$PWD/scripts/hosted-runner/linux-pi-gate.py:/opt/merv/runtime/probe.py:ro" \
  merv-hosted-pi:candidate-20260923 /opt/merv/runtime/probe.py
docker run --rm --network none \
  --tmpfs /run/merv-runtime:mode=0700 --entrypoint /usr/bin/python3.11 \
  -v "$PWD/scripts/hosted-runner/linux-workflow-gate.py:/opt/merv/runtime/probe.py:ro" \
  merv-hosted-pi:candidate-20260923 /opt/merv/runtime/probe.py
```

`SYS_PTRACE` is for the root test inspector only; the Pi worker and assignment
probe must have zero effective, permitted, inheritable, bounding and ambient
capabilities. The Pi probe checks identity, bootstrap removal, private parent
files/descriptors, ptrace, signal permission, sudo and a synthetic root-only
control socket, for a fresh worker and for one loaded at boot (and its holder).
The workflow probe uses synthetic credentials and a loopback enrollment
endpoint to verify the real Codex login and fixed supervisor path.
Neither probe calls a model or contacts Merv production. Neither replaces the
actual Cloudflare security, task execution, retention or cleanup gates. Current
candidate and deployment evidence is in `docs/PI_IMPLEMENTATION_STATUS.md`.

## Pre-harness isolation evidence

The next candidate uses `assignment-probed.py` around the existing fixed
assignment launcher. Only validated Codex `exec`, not login or Git, invokes
`isolation_probe.py` before the final identity handoff. It pins the actual root
supervisor, guardian and group ancestry by executable, arguments, PID and start
time, and verifies the guardian owns its listening control socket. A bounded
child uses the same UID/GID/capability drop, attempts all required denials, and
exits before the assignment begins. Missing targets and unexpected error codes
refuse launch; they never count as denials.

After rechecking target identities, the launcher writes an exclusive root-owned
0444 report under `/run/merv-isolation/<workspace-hash>.json`. Only safe identity,
namespace, inode and denial results enter that report. The fixed v2 Cloudflare
shell probe compares its own namespace/visibility with this pre-harness evidence
instead of guessing a supervisor from the process name `node`.

`linux-isolation-probe-gate.mjs` is a synthetic-ancestry Linux integration fixture,
not a release payload or actual-provider acceptance. It requires neither network
nor added capabilities. Its success does not prove the actual Cloudflare
supervisor is hidden by a namespace: that comparison still requires a new pinned
release and live evidence.

The supervisor now sends one random 32-byte hex `workerNonce` across enrollment
retries. This requires the coordinated Sessions v8 server migration/protocol;
old empty-body enrollment is intentionally rejected. The trusted Fleet owner
acknowledges a verified running exchange through the protected runtime service,
which purges its encrypted bootstrap without waiting for runtime stop. Deploy
the server, Sandboxes service and hosted image as a coordinated release, with
all admission drained and a migration-compatible rollback plan.
