# Agent Sessions

Agent Sessions lets Merv run experiments in separate, platform-native coding
agent sessions on the user's machine.

## Boundary

- Research Core still owns experiment and reflection state.
- Application chooses an owner, independent reviewer, or consolidator.
- Agent Sessions owns worker identity, leases, credentials, and exclusivity.
- Surface authenticates and transports runner/session requests.
- The local runner owns processes and platform-specific commands.
- No campaign object: reviews dispatch independently, and after reflection
  approval, consolidation and its code review finish before the next wave.

## Dispatch switch

Automatic dispatch is per project and off by default: a runner claims nothing
until the project sets `agent_dispatch`. Turning it off stops new claims only;
halting a project or one session closes rows so each runner stops its own
children on the next reconcile.

## Lifecycle

1. A runner persists a stable claim key before network I/O and derives its
   `mas_` secret from an owner-only machine key without writing it to disk.
2. Application supplies current experiment or review candidates.
3. `claim` atomically offers the first candidate without a live owner.
4. Only the secret digest is stored; the plaintext stays with the runner.
5. The runner starts a native platform process with the secret in
   `MERV_AGENT_SESSION_KEY`, then attaches the host process and durable branch
   reference.
6. The first ordinary authenticated Merv call activates the session.
7. Later authenticated calls extend its lease.
8. At consolidation the runner alone compare-and-swaps the reviewed proposal
   into its bare repository's `refs/merv/central` and settles the receipt.
9. Runner release, lease expiry, hard deadline, terminal experiment, changed
   attempt, or submitted review closes the session.

The database enforces one live experiment owner, one live worker per review
request, and one result per runner/idempotency key; reviewers use separate
sessions so producers never review their own work. An ordinary exit is
immediately resumable; two rapid exits without a commit are a crash loop and
use the short launch backoff so a broken CLI cannot spawn every poll cycle.

## Security

The session credential is MCP-only, default-deny, and confined to its project,
experiment, kind, and review request; parent project-key revocation and project
membership remain authoritative. The secret is never put in argv, prompts,
logs, or API responses. The runner keeps one persistent branch and worktree per
experiment and consolidation; detached review worktrees are temporary. It
records launch intent before spawning, refuses a child whose process identity
cannot be recovered after restart, and holds a pre-PID-crash claim until its
lease expires rather than risking a duplicate worker.

Worktrees prevent Git collisions, not filesystem access: sessions run as the
same local user, so use containers, VMs, or separate OS identities for
hostile-agent containment. The Merv-owned bare repository has no remotes, so
managed agents cannot push its private central ref into the user's repository.

## Pairing and settings

A runner pairs with one project by device code: it generates its own `mk_`
key, presents only the digest, prints an 8-character code, and an owner's
approval in Settings registers the digest as a labelled project key (Surface's
`RunnerPairings` with `ProjectKeys.register_digest`, one transaction). Per
`(project_id, runner_id)` this module then holds the owner's desired tuning and
the machine's inventory: the heartbeat carries inventory and applied version up
and the caller's own row plus `desired_settings` down. The schema is closed
(`merv.shared.runner_settings`): enabled/model/effort/parallelism per native
platform and workspace paths, never argv. Browsers address a runner by an
opaque `runner_ref`; runner identity stays private.

## Local platforms

`~/.merv/client.json` holds platforms, tuning, and executable commands; the
runner merges brain-held tuning into it per entry. Native process adapters
cover Codex, Claude Code, Gemini CLI, Cursor Agent, OpenCode, GitHub Copilot
CLI, Qwen Code, and Hermes Agent; a shell-free stdin command adapter covers
custom agents that emit JSONL on stdout. Codex and Claude Code receive an
isolated, session-scoped MCP configuration; other adapters use the shell-safe
`merv-client call` bridge (session secret from the environment); Hermes is told
to ignore ambient Merv MCP configuration. One runner machine owns a project's
experiment branches and central repository; agent platforms share that runner.

Every claimed session writes only to the executor under
`~/.merv/agent-traces/<agent-session-id>/`: immutable `metadata.json` (one work
item, one sanitized harness/model setup), `trace.jsonl` (provider events), and
`stderr.log` (diagnostics). Hermes produces the same trace through its session
export after the process stops. Aider is not an auto-run adapter because it
cannot provide a complete structured trace.

The server keeps the assignment, non-secret agent setup, aggregate counters,
and one bounded, redacted excerpt per session (`agent_session_traces`: last ≤60
events + ≤8 KiB stderr, secret-shaped keys/values masked on both ends, owner
runner only, overwritten in place) for the job card. The raw trace never leaves
the runner. The heartbeat marks a machine live even with no job or platforms;
commands and runner identity stay private.
