# Promote one reviewed Main build without rebuilding

Ordinary `release.mjs` bounds build cache with `docker builder prune` and then builds again.
A same-source rebuild is not promised to have the same Docker image ID: generated assets,
package/runtime installation and layer metadata can differ. `--expected-image` must refuse
that difference before candidate execution, live UI copying or Main stop. Do not weaken it,
substitute the new image, or rewrite an admission intent to fit a rebuild.

`--resume` observes the frozen release job. `--retry-prestart` reuses that release's retained
manifest only after Main has stopped; it is not a build-only promotion path. Neither can
adopt a build-only directory or modify an active release.

## Explicit promotion

Use the reviewed deployment driver containing this option, with a separately reviewed source
revision. This mode does not package the driver's checkout or require a new application image.
It creates a new release ID and copies the pinned build archive into that new release. It does
not overwrite the active/failed release, original build directory or admission journal.

The operator must independently approve all five bindings before invoking it:

- Build-only directory ID beneath `/opt/merv-typescript/cutover-builds/`.
- Full committed source revision and SHA-256 of its exact allowlisted source archive.
- Exact immutable Docker image ID produced by that reviewed build.
- SHA-256 of the exact build receipt bytes that attest the revision/archive/image/predecessor.

The receipt hash is a trusted operator-supplied attestation. A manifest's self-declared
`buildPassed: true` is insufficient. Review the build procedure/logs and receipt association
before pinning its hash; do not blindly compute a fresh hash of arbitrary host input and call
that approval. Existing images lack embedded source-provenance labels, so the driver cannot
independently derive compiled image provenance from source bytes. It verifies the approved
attestation and actual immutable image, then reruns real CLI/runtime checks. If independent
provenance approval is unavailable, refuse promotion rather than infer it from a mutable tag.

```sh
node deploy/release.mjs --host ResearchSuite_Control \
  --prebuilt-build REVIEWED_BUILD_ID \
  --prebuilt-revision FULL_REVIEWED_REVISION \
  --prebuilt-archive REVIEWED_ARCHIVE_SHA256 \
  --prebuilt-receipt REVIEWED_BUILD_MANIFEST_SHA256 \
  --expected-image sha256:REVIEWED_IMAGE_ID \
  --skip-hosted --no-rollback
```

Add `--dry-run` to validate arguments and show the proposed release ID without contacting a host.
All promotion arguments are required together. Unsafe/duplicate values and resume/retry
combinations are rejected before external work. Observe a launched promotion using its new
release ID with ordinary `--resume ... --skip-hosted --no-rollback`, without promotion flags.
The saved job freezes the verifier and all expected values, so resume cannot replace them.

Under the existing maintenance lock and recovery/hosted-owner gates, promotion verifies:

1. The separately pinned receipt bytes, receipt/source-manifest revision and archive hashes,
   and SHA-256 of the exact archive copied into the new release.
2. Receipt image ID equals explicitly expected ID equals actual Docker image inspection ID.
   No image tag is resolved. The image must be linux/amd64, declare native Git protocol 1,
   and embed the current immutable Sandboxes image pin.
3. The current Main is healthy/running and its immutable image is the build's exact predecessor.
4. The immutable image actually passes compiled CLI and runtime checks without network.

Then the same UI staging, exact-image Git preflight, Main stop, post-stop preflight, candidate
startup, local acceptance and public HTTPS acceptance run. No build, pull or cache prune occurs
on promotion. The existing default build path is unchanged. Pi admission fencing/drain and
restoration remain owned by the parent operation and its exact expected-image journal. Retain
that fence until the promoted expected image passes public acceptance. Hosted rollout is a
separate explicit step; automatic rollback stays disabled.

## Failed rebuild: owned abort/reopen assessment (not an implemented command)

The old guard has no supported abort/reopen action. Its restore assertion correctly requires
the expected candidate and must not be bypassed to reopen the predecessor. A supported abort
would need a separately reviewed durable journal, preserving the original intent byte-for-byte.
It would bind the failed release ID/job hash, original intent hash/owner, expected candidate,
exact original running container/image and database/schema, public predecessor acceptance,
and explicit parent decision to abandon that attempt.

Before any such restoration, prove under the maintenance lock that the old job and its child
build processes are terminal and cannot continue. Lock availability alone is not enough if an
unstarted queued job could still acquire it. Require the pinned job's expected-image-mismatch
failure evidence (which precedes UI mutation), no candidate-started/deploy log/status artifacts,
and unchanged healthy predecessor identity. Merely lacking candidate-started is insufficient:
ordinary UI copying precedes that marker. Inspect live UI acceptance too. Refuse pending
recovery, hosted ownership, mismatched journals or nonzero Pi commands/hosts/allocations.

Record abort intent durably before an atomic zero-census barrier removal, then record completion.
Recovery after a committed removal but lost response requires that pre-existing durable abort
intent; never infer ownership from an absent barrier. Replay must not remove a subsequently
recreated barrier. Do not stop/restart Main, cancel work, overwrite original expectations or use
an old DB snapshot to accomplish an abort. This document authorizes no execution and this change
implements no abort command. The parent may instead keep its fence and promote the originally
approved exact candidate once the failed rebuild is conclusively terminal.
