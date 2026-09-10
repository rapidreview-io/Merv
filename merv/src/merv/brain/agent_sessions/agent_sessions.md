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
registry, prioritizing read-only nodes. The queue subtracts current live
instance/revision leases. New workflow names require no scheduler branch.
Dependencies and review prerequisites use the same evaluation as status/tools.

1. A runner persists its claim key before network I/O and derives its `mas_`
   secret from an owner-only machine key without writing the secret to disk.
2. Application supplies current workflow instance/revision candidates.
3. `lease` locks and rechecks the revision and prerequisites, rebuilds the node
   brief, and freezes the packet in the same transaction as its lease.
4. Only the secret digest is stored. The child receives the secret through
   `MERV_AGENT_SESSION_KEY`, then attaches its process and branch references.
5. The first authorized MCP authentication activates the lease. Workflows
   records actual work start once per node revision, including resumed workers.
6. Authenticated calls and confirmed child heartbeats renew the bounded lease.
7. Release, expiry, hard deadline, a changed instance revision, or a finished
   instance closes the lease and causes the runner to stop its child.

A lease stores, verbatim from the packet: the workflow name and instance id
(opaque `target_type`/`target_id` for UI links), revision and node, `role`,
`label`, the node's `execution` policy and its `references` as JSON. This
module names no workflow, record type, or id field. It learns whether an
instance still stands through the `InstanceFacts` port (instance id, revision,
terminal, label), which the Workflows runtime implements and Surface injects.
Application derives the job kind the UI shows from `execution`.

The database enforces one live lease per workflow instance/revision and one
result per runner/idempotency key. Reviewers use independent credentials and
workspaces; graph completion fences the previous node. Ordinary exits can
resume. Repeated fast exits without a commit use a launch-failure backoff.
`persistence.py` declares the six tables this module owns and their ladder
steps. Schema 60 bound existing leases to workflow instances; 61 added the
policy columns and keyed branch facts (`agent_workspaces`) by instance; 63
retired `kind`, `review_request_id` and `source_sha`, which the packet's
`execution` and `references` already say. A lease without a stored policy is
read-only with no node tools.

## Security and workspaces

Session credentials are MCP-only and default-deny. The gateway allows the
support baseline for the policy's read/write mode plus the node's declared
tools, binds `workflow.transition` to the leased instance and revision, permits
`sandbox.*` only with declared sandbox authority, and applies every `Scope`
rule: a present argument must equal the value resolved from the lease (instance
id, workflow name, or a reference by kind), and mutating or contract-declared
fields are supplied to the handler from the lease. Parent key revocation and
project membership remain authoritative. Secrets never appear in argv,
prompts, logs, or responses.

The runner records launch intent before spawning, verifies process identity on
restart, and holds uncertain pre-PID claims until expiry to avoid duplicates.
`execution.workspace` alone drives its layout: `none` is a scratch directory,
`ephemeral` a detached worktree at the referenced base, `persistent` a branch
per instance (per base sha when `per_base`) under the declared namespace, so
experiment and consolidation branch names are unchanged. Only persistent
workspaces record branch facts, keyed by instance, for later sessions and the
UI. The runner alone compare-and-swaps accepted work into `refs/merv/central`
through the generic `agent-advances` prepare/pending/settle routes, whose
`sources[].id` are opaque lineage ids; the `consolidation/*` paths are
deprecated aliases of the same Protocol. Its bare repository has no remotes.

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
