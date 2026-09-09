# Agent Sessions

Agent Sessions runs workflow nodes in separate, platform-native coding-agent
sessions on the user's machine.

## Boundary

- Workflows owns node evaluation, agent briefs, transitions, and composition.
- Application connects that authority to scheduling and support capabilities.
- Agent Sessions owns worker identity, leases, credentials, and exclusivity.
- Surface authenticates and transports runner/session requests.
- The local runner owns processes and platform-specific commands.

## Dispatch and lifecycle

Automatic dispatch is per project and off by default. The project must set
`agent_dispatch` before runners receive work. Turning it off stops new claims;
halting a project/session closes leases so runners stop their children.

`Application._dispatch_plan` enumerates dispatchable nodes from the workflow
registry, prioritizing independent reviews. The queue subtracts current live
instance/revision leases. New workflow names require no scheduler branch.
Dependencies and review prerequisites use the same evaluation as status/tools.

1. A runner persists its claim key before network I/O and derives its `mas_`
   secret from an owner-only machine key without writing the secret to disk.
2. Application supplies current workflow instance/revision candidates.
3. `claim` locks and rechecks the revision and prerequisites, rebuilds the node
   brief, and freezes exact references in the same transaction as its lease.
4. Only the secret digest is stored. The child receives the secret through
   `MERV_AGENT_SESSION_KEY`, then attaches its process and branch references.
5. The first authorized MCP authentication activates the lease. Workflows
   records actual work start once per node revision, including resumed workers.
6. Authenticated calls and confirmed child heartbeats renew the bounded lease.
7. Release, expiry, hard deadline, changed workflow revision/prerequisites, or a
   superseded review closes the lease and causes the runner to stop its child.

The database enforces one live lease per workflow instance/revision and one
result per runner/idempotency key. Reviewers use independent credentials and
workspaces; graph completion fences the previous node. Ordinary exits can
resume. Repeated fast exits without a commit use a launch-failure backoff.
Schema 60 binds existing leases to workflow instances while retaining their
secret, deadline, and frozen legacy packet. Legacy claim support remains for
existing callers; newly scheduled work always uses workflow authority.

## Security and workspaces

Session credentials are MCP-only, default-deny, and scoped to their project,
workflow instance/revision, read-only policy, and review request. Project
knowledge/content reads stay project-scoped; mutations target the assigned
record. Capability-backed reviewers can start/submit their assigned verdict
but cannot change evidence or take other workflow exits. Parent key revocation
and project membership remain authoritative. Secrets never appear in argv,
prompts, logs, or responses.

The runner records launch intent before spawning, verifies process identity on
restart, and holds uncertain pre-PID claims until expiry to avoid duplicates.
It retains a branch/worktree per workflow, temporary detached review worktrees,
and proposal branches for consolidation. A node can request a scratch directory
without Git. Source heads from completed sessions support continuation.

The runner alone compare-and-swaps reviewed proposals into `refs/merv/central`.
Its bare repository has no remotes. Existing experiment branch paths are kept;
other plugins share the generic workflow namespace keyed by instance ID.
Worktrees prevent Git collisions; same-user processes share filesystem access.

## Pairing and observability

A runner pairs by a device code and receives a project `mk_` key. Per runner,
Agent Sessions stores desired model/effort/parallelism/workspace settings and
reported machine/platform inventory. Only closed-schema settings cross this
boundary, never argv. Browsers address runners by opaque references.
Provider sign-in belongs to each harness; the brain stores only bounded status,
quota, and smoke-test evidence. A failed fast launch enters the normal backoff.

Native adapters cover Codex, Claude Code, Gemini CLI, Cursor Agent, OpenCode,
GitHub Copilot CLI, Qwen Code and Hermes; custom commands use shell-free stdin.
Native MCP or the `merv-client call` bridge carries the session credential.
One runner machine owns a project's durable Git repository.

Each session writes immutable metadata, provider trace, and stderr under
`~/.merv/agent-traces/<session-id>/`. The server stores the frozen assignment,
sanitized setup, aggregate counters and a bounded/redacted trace excerpt:
at most 60 events and 8 KiB stderr. The owning runner may update the excerpt
briefly after close; raw traces stay local. Heartbeats report idle machines too.
