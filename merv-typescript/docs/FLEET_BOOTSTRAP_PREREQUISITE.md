# Protected runtime launch — milestone 0

Proposed cross-repository prerequisite, not an existing API. Required before hosted Fleet execution ships.

**Owners.** The merv-sandboxes maintainer owns the service endpoint, secret delivery, launcher/image and provider acceptance. The Merv Fleet implementer owns scoped enrollment and consumer tests. Assign named implementers when implementation starts; this document does not imply anybody has accepted that work.

**Observed gaps.** Jobs persist request env. Internal `script_ref` resolves pipeline/snapshot scripts, not general protected launches. The Cloudflare Dockerfile installs sudo; `control/src/merv_sandboxes/access/bootstrap.py` grants the login user `NOPASSWD:ALL`. Different usernames alone do not establish credential isolation.

**Narrow API.** Add one authenticated server-owned operation to launch an allowlisted pinned runtime in an owned sandbox. Input: namespace/sandbox, immutable operation key, configured release ID and explicitly secret bootstrap material. No arbitrary scripts or user-selected URLs.

Persist harmless metadata and an opaque secret reference. Use an existing suitable secret store, otherwise a small encrypted TTL envelope with its key outside job storage. Deliver a private file over the existing authenticated execution transport; exclude it from logs, outputs, workspace capture, snapshots and diagnostics. Delete after exchange/expiry. Ordinary jobs cannot resolve launch references. This is not a general secret-management product.

Merv issues allocation/epoch-bound enrollment. Bind exchange to the launch and a stable worker nonce/public key. A lost response recovers the same encrypted result within a short lifetime, without minting another identity. Reject changed-input operation-key reuse, expiry and revocation. No source, sandbox-consumer, database or cloud key reaches the harness.

**Isolation contract.** Trusted supervisor owns managed-runner credentials. Assignment executes under a separate unprivileged UID with no sudo, privileged groups/capabilities, access to supervisor files/control sockets, process inspection, debugging or signals. Scrub its environment. The administrative login may stay privileged, but its credentials/process access must be inaccessible to the assignment. Test actual runtime behavior; source inspection is not proof.

**Gate A evidence:** attempt credential reads, /proc inspection, ptrace, signals, sudo and control-socket access as the harness user. All relevant escalation paths must fail. Pin tested image/release/provider configuration.

**Gate B evidence:** secret canaries absent from job rows/API output/logs/snapshots/diagnostics; duplicate launch/exchange and lost responses recover one launch/enrollment; restart, expiry and revocation fail safely. Run a fixed worker through readiness, stop and confirmed provider release.

**Fallback:** if either gate fails, hosted execution stays disabled; existing external runners remain available. Fix the dedicated launcher/image before proceeding. No plaintext env, same-user convention or main application VM fallback. Moving supervision outside the sandbox requires a separate design decision.
