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

## Build and pin a Cloudflare candidate

From `merv-typescript`, one command creates a fresh minimal sandbox Docker
context from the isolated sandbox checkout, bundles the existing supervisor,
builds both `linux/amd64` images, and records source hashes, image IDs, and the
installed `/opt/merv/runtime/start-runner` SHA-256:

```sh
node scripts/hosted-runner/package.mjs build \
  ../output/fleet-sandboxes ../output/hosted-candidate-1 merv-hosted-codex:candidate-1
```

The output is `../output/hosted-candidate-1/build.json`. Use a new output
directory and tag for each candidate. The staged Docker context contains only
the Cloudflare Dockerfile's explicit COPY inputs and the amd64 agent binary;
unrelated changes in either checkout are not copied. The bundle hash records
the compiled Runner payload, while source revisions and file hashes record the
inputs selected for this build. The image ID identifies the actual result even
when upstream base tags or package downloads change.

After separately pushing and independently checking the immutable registry
reference, pin that externally obtained digest:

```sh
node scripts/hosted-runner/package.mjs finalize \
  ../output/hosted-candidate-1/build.json \
  registry.cloudflare.com/ACCOUNT/IMAGE@sha256:64_LOWERCASE_HEX_DIGITS cloudflare
```

This writes `releases.json` in the strict `RuntimeReleases` catalog format and
`release.json` with its `rt1_…` release ID and registry reference. The service's
operator catalog enables the same release; the trusted sandbox bootstrap writes
`/opt/merv/runtime/releases.json` as a root-owned mode-0600 file before protected
launch. The catalog is finalized after the image digest is known, so it is not
baked into the image it identifies. This helper never pushes, deploys, accesses
Cloudflare credentials, or asserts that the registry digest matches the locally
built image. The operator must verify that link and the live provider image and
runtime gates before enabling Fleet.
