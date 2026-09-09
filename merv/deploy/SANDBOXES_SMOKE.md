# Cutover smoke verification

The storage verifier runs **inside the new Merv image** after migration and service health succeed. It uses the image's native JWT signer, PostgreSQL URL, and explicit `MERV_BLOB_*` credentials for Merv's own artifact R2 bucket. It does not create research projects or post research events.

Copy `verify_sandboxes_cutover.py` into the new container, then run:

```sh
python /tmp/verify_sandboxes_cutover.py
python /tmp/verify_sandboxes_cutover.py --write-storage
```

The first invocation reads only. The second repeats the reads, then writes unique smoke objects, verifies them, and deletes those exact objects. Defaults verify old and recent artifact hashes, heavy content across up to five projects, and all 26 recovered objects in `proj_d0b83f01b61a` (4,057,894 bytes total). Defaults also add the largest available heavy object so its 1 MiB range read exercises migrated large-object access. Historical transfers are capped at 256 MiB; objects larger than 32 MiB receive a 1 MiB range read with exact total-size verification. The new multipart payload is 65 MiB, so the normal 64 MiB part size yields two parts. Its first part is uploaded before obtaining fresh resume targets; only the missing part is then uploaded. The complete file is read and hashed afterward.

New evidence exercises Merv's `R2BlobStore` under a unique `smoke_<time>_<random>` namespace. Its content key is known before the upload, so cleanup removes and verifies that exact key even if an accepted upload's response is lost. The heavy adapter uses a unique `merv-project-smoke_<time>_<random>` namespace without a Merv project row. Artifact reads verify namespace isolation; native heavy reads additionally check foreign metadata and transfer-target denial. Heavy cleanup waits up to 90 seconds for worker-confirmed deletion; any pending exact IDs are printed for operator recovery. Reports contain hashes and IDs, never signed URLs, secret keys, or file contents. A failed check exits nonzero.

Before switching production Merv, pass `--pre-cutover` to permit schema57 or schema58. Every research query runs under PostgreSQL `default_transaction_read_only=on`; `remote_sandbox_links` is checked when schema58 or newer is present. Omit this flag after the artifact redesign so the final check requires schema59. Artifact history must already be copied into the configured Merv R2 bucket before running its read checks.

`verify_merv_composition.py` separately validates the release image without using production research data. It clears both database URL variables before importing Merv, builds hosted composition against temporary SQLite, verifies schema59, creates a synthetic project and key solely in that temporary database, and checks owner-scoped HTTP/MCP authentication plus configured native health and delegated authentication. Run it in a disposable `--rm --read-only` container with `/tmp` on tmpfs and no published ports. Reuse the existing deployment environment through Compose parsing or an in-memory dotenv parser; Docker `--env-file` does not remove Compose's single quotes. Never create a new credential file or database clone for this check.

After the final upload mapping and production switch, run `verify_migrated_uploads.py --report -` inside the new control container beside `verify_sandboxes_cutover.py`, passing the successful final import report on stdin. It requires schema58 and checks only the120 research receipts identified in that reviewed report with database-enforced read-only queries: every handle must uniquely contain its own row ID and project, and every referenced native object's namespace, digest, and size must match. Receipts that have since completed remain verifiable; unrelated new uploads are excluded. Native metadata reads are cached by object. It refreshes targets for only one available receipt and the smallest still-uploading receipt, verifies that their exact completion handles survive, and transfers no bytes. Existing migration sessions are never completed or deleted by this check; reports exclude handles and signed URLs.

## Bounded compute check

Run only after the coordinator reviews the live offer and authorizes its exact cost and lease. Use native service namespace `merv-project-smoke-<random>` so the explicitly scoped shared providers are visible. No Merv project, feed post, task, or experiment is needed.

1. Read `GET /v1/auth/me`, `GET /v1/providers` and `GET /v1/options?provider=<shared-thunder-name>&sort=price&all_options=true`. Select the cheapest **available, USD-priced CPU offer** from the configured Thunder provider. Record provider, plugin, offer ID, hourly amount and minimum billable interval. If none is offered, inspect shared Lambda options and ask the coordinator to choose the smallest suitable offer within the same explicit spend bound. Never substitute a GPU or more expensive provider silently.
2. Generate an ephemeral Ed25519 caller key on the Docker host using `ssh-keygen`. Keep its directory mode0700, private key mode0600. The Merv production image intentionally contains no SSH client. Only the public key goes to the service.
3. Before creating compute, require hourly price ×300/3600 plus any known minimum charge to fit the coordinator's bound. POST `/v1/sandboxes` with the selected provider/offer ID, `lease_seconds:300`, a unique smoke name, and stable idempotency key. Sign a `merv_budget` claim with unique smoke payer, that provider, `billing_mode:"platform"`, current UTC source day, zero legacy spends, and an explicit project/provider daily limit equal to the approved smoke bound. Never put the budget claim in request JSON. Record the returned sandbox ID immediately and use it for cleanup even if later assertions fail.
4. Poll only that sandbox using `GET /v1/sandboxes/{id}?wait=20`. Budget at most180 seconds for readiness. On failed/unknown provisioning or timeout, issue DELETE and continue checking until stopped; do not create a replacement automatically.
5. Request a60-second caller certificate via POST `/v1/access/certificates` with that sandbox ID and public key. Save the certificate and returned gateway host key; build a dedicated known_hosts entry (`[host]:port` for nonstandard ports). Run host SSH with BatchMode, ConnectTimeout10, StrictHostKeyChecking=yes, IdentitiesOnly=yes, explicit private key/certificate/known_hosts paths and returned sandbox ID as user. Require `printf merv-ssh-smoke` to return exactly that marker. Never disable host-key checking.
6. Start one durable job with POST `/v1/sandboxes/{id}/jobs`, a stable retry key, timeout30, working directory `/workspace`, and output directory `/workspace/merv-smoke-output`:

   ```sh
   mkdir -p /workspace/merv-smoke-output
   printf 'merv-job-smoke\n' > /workspace/merv-smoke-output/result.txt
   printf 'merv-job-smoke\n'
   printf 'merv-job-stderr\n' >&2
   ```

   Poll the returned job ID using its cursor and wait20 until succeeded. Require exit_code0, bounded stdout/stderr matching both markers, and a retained artifact/snapshot ID. Request the same sandbox/job/output from a second smoke namespace and require404. Read the retained snapshot manifest and verify the result file's small SHA-256 if the snapshot exposes storage object references.
7. Once ready and the job succeeds, renew exactly once with `lease_seconds:300` and the same signed smoke budget. Verify the returned lease deadline advanced relative to the old deadline; total actual lifetime remains bounded by immediate release afterward. Do not renew on failures. The maximum authorized extension is one additional300-second reservation; enforce the coordinator's cap against the total reservation before requesting it.
8. In a `finally` cleanup, DELETE the exact sandbox ID. Poll until `state:"stopped"`; a DELETE acknowledgment or deleting state is insufficient. Then confirm the durable job remains readable after release, delete the smoke output snapshot and any exact associated storage objects, and remove the ephemeral host key directory. Retain only sanitized IDs, timestamps, measured cost, and assertions in the smoke report. A deletion timeout is a failed smoke with an explicit cleanup obligation, never a passing result.

The machine's300-second lease is an independent expiry backstop. The service must confirm provider deletion before the coordinator declares this check complete.
