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

The last successful run is recorded in
`output/hosted-smoke-1790137772829/report.json` at the repository root. Its session
completed, evidence was submitted for review, and container deletion was checked.
The test preserves the report, artifact blobs and disposable database schema for
inspection. It does not assert that an independent review passed.

This bypasses provider provisioning and the SSH transport by invoking the actual
receiver inside local Docker. The root supervisor holds a synthetic project's
source credential; the assignment receives only its scoped session credential.
Production Fleet still requires managed enrollment, Cloudflare isolation and
cleanup acceptance, and hosted Git support. This script is not a production
Fleet owner or a substitute for those gates.
