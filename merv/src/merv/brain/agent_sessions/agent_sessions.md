# Agent Sessions

Agent Sessions lets Merv run experiments in separate, platform-native coding
agent sessions on the user's machine.

## Boundary

- Research Core still owns experiment and reflection state.
- Application chooses an experiment owner, independent reviewer, or
  post-reflection consolidator.
- Agent Sessions owns worker identity, leases, credentials, and exclusivity.
- Surface authenticates and transports runner/session requests.
- The local runner owns processes and platform-specific commands.

There is no campaign object. Reviews dispatch independently; after reflection
approval, consolidation and its code review finish before the next experiment
wave is materialized.

## Dispatch switch

Automatic dispatch is per project and off by default: a runner claims nothing
until the project sets `agent_dispatch`. Turning it off stops new claims only.
Live sessions continue until the project halts them, which closes their rows so
each runner stops its own children on the next reconcile.

## Lifecycle

1. A runner persists a stable claim key before network I/O and derives its
   high-entropy `mas_` secret from a separate owner-only machine key without
   writing the credential itself to disk.
2. Application supplies current experiment or review candidates.
3. `claim` atomically offers the first candidate without a live owner.
4. Only the secret digest is stored; the plaintext stays with the runner.
5. The runner starts a native platform process with the secret in
   `MERV_AGENT_SESSION_KEY`, then attaches the host process and durable branch
   reference.
6. The first ordinary authenticated Merv call activates the session.
7. Later authenticated calls extend its lease.
8. At reflection consolidation, the runner alone compare-and-swaps the reviewed
   proposal into its bare repository's `refs/merv/central`, then settles the
   durable receipt that permits publication.
9. Runner release, lease expiry, hard deadline, terminal experiment, changed
   attempt, or submitted review closes the session.

The database enforces one live experiment owner, one live worker per review
request, and one result per runner/idempotency key. Reviewers use separate
sessions so producers never review their own work.

An ordinary process exit is immediately resumable. Two rapid exits for the same
task without a commit are treated as a crash loop and use the short launch
backoff, preventing a broken local CLI from spawning every poll cycle.

## Security

The session credential is MCP-only, default-deny, and confined to its project,
experiment, kind, and review request. Parent project-key revocation and project
membership remain authoritative. The secret is never put in command arguments,
prompts, logs, or API responses. The runner keeps one persistent branch and
worktree per experiment and reflection consolidation; detached review worktrees
are temporary. It records launch intent before spawning and refuses to launch a
child whose process identity cannot be safely recovered after restart. A crash
in the smaller pre-PID window holds the claim until its lease expires rather
than risking a duplicate worker.

Worktrees prevent agents from colliding in Git; they are not an operating-system
security boundary. Sessions run as the same local user and can read files that
user can read. Use containers, VMs, or separate OS identities when hostile-agent
containment is required. The Merv-owned bare repository has no remotes, so
managed agents cannot push its private central ref into the user's repository.

## Local platforms

Settings and `~/.merv/client.json` select named platforms, models, effort, and
parallelism. Native process adapters cover Codex, Claude Code, Gemini CLI,
Cursor Agent, OpenCode, GitHub Copilot CLI, Qwen Code, and Hermes Agent. A
shell-free stdin command adapter covers custom local agents that emit JSONL on
stdout. Codex and Claude Code receive an isolated, session-scoped MCP
configuration. Other adapters use the shell-safe `merv-client call` bridge; it
reads the session secret from the environment, never argv. Hermes receives an
explicit adapter note to ignore ambient native Merv MCP configuration in
runner-owned sessions. One runner machine owns a project's experiment branches
and central repository; agent platforms share that runner.

Every claimed session writes only to the executor machine under
`~/.merv/agent-traces/<agent-session-id>/`. The immutable `metadata.json`
associates exactly one work item with exactly one sanitized harness/model setup.
Provider events go to `trace.jsonl`, while diagnostics go to `stderr.log` so
they cannot corrupt the structured stream. Hermes creates the same trace file
through its session export after the process stops. Interactive sessions do not
use this path. Aider is not an auto-run adapter because it cannot provide a
complete structured interaction trace.

The server keeps only the immutable human-readable assignment, non-secret agent
setup, and aggregate token/tool/message counters needed by Auto-run. Raw events
never leave the runner. A separate non-secret heartbeat names the runner machine
and marks it live even while it has no job; commands and runner identity stay
private.
