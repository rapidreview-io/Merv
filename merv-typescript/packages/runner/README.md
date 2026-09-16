# Local runner process and workspace foundation

`LocalLedger` and `ProcessHost` run on Darwin and Linux. They have no dependency on the server's State plugin. The controller must acquire the ledger's controller lock before scheduling, reserve an immutable launch ID and session ID, and attach that launch ID remotely before calling the process host.

## Durable intent and credentials

The private local SQLite database uses WAL, `synchronous=FULL`, and `fullfsync=ON`. Its directory is mode `0700`; its database and logs are `0600`. Use a local filesystem with SQLite locking and durability semantics. A separate SQLite connection holds an exclusive controller lock: losing the controller process releases the lock without blocking supervisor ledger updates.

The ledger is bound to the server URL, source identity, and project. It retains a random runner ID and a private machine HMAC key. Pending lease requests preserve the exact platform and duration before HTTP; a retry derives the same session secret from its request ID. Clearing a pending request does not prevent deriving that same secret when recovering a retained launch.

Source and session bearers are not stored in the ledger. Reconciliation metadata is bounded JSON and rejects secret fields and recognizable bearer values. Runtime command environment and stdin travel only over authenticated local IPC; profile diagnostic `toJSON` hooks are deliberately bypassed only for that explicit transport. The supervisor receives the session bearer, never the source credential. Child output redacts the session bearer and recognized secret environment values, including values split across output chunks.

The machine key and IPC authentication protect local runner coordination. Private files and Unix sockets do not isolate mutually hostile processes running as the same operating-system user. Workspace or host isolation is a separate boundary.

## Git workspaces

`GitWorkspaceManager` keeps durable local tables beside the launch ledger, independently of server State. It supports scratch directories, detached ephemeral worktrees, and persistent branches with optional per-base lineages. [The Git configuration example](../../config/runner.git.example.json) supplies an existing local repository and initial base ref. Runner clones a private bare copy without hardlinks, alternates, source remotes or network access; it never changes the source checkout.

Workspace mode and named commit references come from the frozen execution policy. `reference:name` requires an available full commit OID with no central fallback. The private `refs/merv/central` is initialized once; it is not a published server project head. Persistent shared/per-base and ephemeral checkouts occupy separate roots, and persistent branch names start with `codex/merv/`.

Preparation reserves the exact checkout before creating it and attaches its snapshot before launch. A persistent checkout remains occupied until confirmed process termination, durable capture, server acknowledgment and cleanup. Uncertain launches and pending reports cannot free it. Restart recovery preserves matching owned files, while unverified partial checkouts are retained for investigation.

After confirmed process-group shutdown, writable capture stages changes and creates a WIP commit when needed. Changed files above 50 MiB are refused; unchanged historical large files do not block small changes. Read-only work refuses a changed HEAD or dirty index/worktree and is never auto-committed. Each launch retains its immutable final snapshot after later persistent reuse. `retain: false` removes an acknowledged checkout while preserving Git history; scratch and retained checkouts currently remain on disk.

The native profile supports sandboxed file editing, fixed commit requests through Code and host-side Runner capture. It does not grant the worker arbitrary writes to private Git metadata, general merges or central ref updates. There is no central publication, reviewed-proposal CAS receipt, remote Git transport or cross-machine object transfer in this slice. Server results are source-authenticated observations, not independently verified Git proofs. See [the full workspace contract](../../docs/WORKSPACES.md) for result identity, report/restart behavior and limits.

## Fixed live commit operations

The server's Code plugin owns `code.commit`, `code.operation`, its durable queue
and immutable receipts. Runner adds no agent tools and consumes that protocol
through source-authenticated HTTP. A live worker's frozen execution policy must
explicitly grant `code.commit`; writable workspace mode alone is insufficient.

`GitWorkspaceManager.checkpointCommit(record, command)` validates the launch,
deadline, attachment, checkout epoch and read-only policy. It journals the exact
server command before Git work. Each attempt uses a private alternate index;
once frozen, the tree, parent, message and timestamp deterministically reproduce
the same commit. The owned HEAD and command receipt ref update atomically while
verifying the current launch/epoch owner ref. Git receives only fixed arguments,
with the existing configuration and 50 MiB changed-file guards.

The controller performs this operation without changing the guardian's one-child
ownership proof. An orphan Git child can write only its private index/objects or
attempt the fenced ref transaction. Capture permanently replaces the owner ref
with a closed marker before final HEAD work, preventing delayed commit or initial
ownership creation from affecting a successor. Normal index synchronization uses
a synchronous copy/rename and preserves later working-file edits.

`pendingCommits`, `commitOutcome` and `acknowledgeCommit` retain the local delivery
state. Unknown outcomes stay pending until a Git receipt proves success or the
closed fence proves no commit applied. Lost command retrieval and completion
replies are reconciled after worker closure and controller restart. Checkout
release waits for command and final-capture acknowledgments. Completed receipts
remain readable after cleanup and do not move HEAD again. See
[Code operations](../../docs/CODE_OPERATIONS.md).

## Launch and restart

The ledger records intent before any spawn. A guardian atomically changes `reserved` to `starting` before creating its child. This claim is irreversible: duplicate guardians and repeated launch requests cannot create a second worker. The first command is pinned by an HMAC; a conflicting replay is refused.

One detached guardian owns a private authenticated Unix socket and exactly one direct child: a group-owner process. The group owner starts the configured command in its own inherited process group. The guardian retains the actual child handle; the ledger stores no process ID.

A replacement controller reconnects to the existing guardian. A claimed but unstarted guardian can accept the original command once. Authenticated inspection can repair a conservative timeout assessment using that same guardian's observed lifecycle. A claimed launch with no reachable guardian remains `uncertain`, consumes capacity, and is never respawned. A remotely released session is not evidence that a local process has died.

Cancellation of a still-reserved launch competes with the same atomic SQL claim and can safely finish before spawn. Once claimed, stopping requires the supervisor protocol.

## Deadlines and shutdown proof

The group owner independently enforces its current deadline, including when the controller stops polling. A valid extension reaches it through the guardian. Guardian IPC loss also initiates shutdown. Shutdown sends `SIGTERM` to the owner's own group, then escalates after a bounded grace period.

For observed completion, the original guardian checks its own direct child's `exitCode`, `signalCode`, connection, and positive PID, then synchronously signals that owned group with `SIGKILL`. It records a terminal result only after that successful group kill and the corresponding observed child exit. It never signals a saved PID, a PID discovered with `ps`, or a PID supplied over IPC. No replacement guardian reconstructs a child handle from disk.

This narrow live-handle operation relies on the standalone guardian having exactly one direct child and loading only its fixed supervisor code and Node built-ins, with no application plugins, async hooks, or runtime preloads. The checked Node 22.13.1 implementation reaps children and invokes their exit callbacks on the same event loop; Node updates the child's exit fields before emitting user events:

- [libuv's wait and exit callback, lines 101–174](https://github.com/nodejs/node/blob/v22.13.1/deps/uv/src/unix/process.c#L101-L174).
- [Node's native exit callback, lines 327–342](https://github.com/nodejs/node/blob/v22.13.1/src/process_wrap.cc#L327-L342).
- [ChildProcess exit-field updates, lines 269–295](https://github.com/nodejs/node/blob/v22.13.1/lib/internal/child_process.js#L269-L295).

The check and signal contain no asynchronous boundary. A child that dies during that synchronous callback has not yet been reaped and retains its PID; a reaped child has its exit fields set and fails the guard. Keep this ordering and the guardian's isolation when changing the runtime or supervisor.

If the guardian disappears or cannot confirm its own group kill, the group owner still has a bounded self-cleanup fallback. That fallback does **not** establish an observed completion proof: unexpected death or missing supervision leaves the durable launch uncertain. Uncertainty is retained for operator investigation rather than allowing another worker into the same slot or workspace.

This is process-group supervision, not an operating-system sandbox. Descendants that deliberately daemonize into another session or process group are outside its shutdown proof. Filesystem isolation, hostile child containment, remote processes, and recovery of an uncertain launch require separate mechanisms.

## Runtime resource and validation

`src/supervisor.mjs` contains the dependency-free guardian and group-owner entry points. A compiled distribution must copy it beside `process-host.js`, at `dist/packages/runner/src/supervisor.mjs`; TypeScript compilation alone does not copy this resource.

`tests/runner-process.test.ts` exercises exact launch deduplication, private durable requests, controller locking, process-tree stop, independent deadlines, guardian loss, uncertain-slot retention, authenticated recovery, IPC refusal, and diagnostic-redaction transport. These tests launch only synthetic local Node commands. They require permission to create Unix-domain sockets and child process groups.

`tests/runner-workspaces.test.ts` exercises real temporary Git repositories, checkout exclusivity, source isolation, persistent history, strict base pins, restart/capture replay, read-only refusals, file bounds, unsafe configuration and foreign paths. Synthetic HTTP/MCP tests verify the matching server receipts. The historical workspace-capture checkpoint passed 490 tests, typechecks and builds; this count predates Code operations.

The Code foundation passed 20 local Git tests (the 12 workspace tests plus eight
commit tests) and two synthetic HTTP/MCP integrations. These include an actual
controller SIGKILL between commit-object creation and target persistence,
delayed old Git transactions across checkout reuse, live-worker commit receipts,
actual Reviews attribution and lost dispatch/completion replies across restart.

Native Git capture acceptance passed on 2026-09-15 with two fresh Codex agents in a synthetic managed workflow: sandboxed edit, Runner capture, read-only verification of the pinned commit, and confirmed final cleanup. The source was unchanged. The report is `/private/tmp/merv-native-git-live-20260915-02/report.json`. This historical run proves same-machine operation using one private object store; it predates Code operations and does not exercise actual Reviews/consolidation, central publication or cross-machine transport. Native Code acceptance has its own record in [CODE_OPERATIONS.md](../../docs/CODE_OPERATIONS.md).
