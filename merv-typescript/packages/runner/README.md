# Runner

The runner turns one Sessions lease into exactly one supervised local agent process, in a workspace a named driver prepared. It keeps that process alive while the session is live and settles each ended launch exactly once. It holds no authority beyond its source (or managed control) bearer. `LocalLedger` and `ProcessHost` run on Darwin and Linux and do not depend on the server's State plugin.

## Configuration and drivers

For research that does not use Git, set `"workspaceDrivers": []` and omit `workspace`: the CLI loads no Code modules and runs workspace-free assignments in scratch directories without Git installed. [The server configuration without Code](../../config/no-code.example.json) and [the matching runner configuration](../../config/runner-no-code.example.json) show the pair. Omitting `workspaceDrivers` keeps the Code driver (`code.v2`), as does `["code"]`. A `workspace` repository serves policies that name no driver; `workspace: { github: true }` is still accepted until GitHub mode is retired. `workspace` and `assignmentWorkspaceDirectory` together are refused.

Presence advertises each composed driver as a capability, plus `runner.2`: the runner ignores fields a server adds to lease, settings and session replies (what `runner.1` meant) and names `git.local` exactly when it has a repository of its own. A `oneAssignment` (managed) runner advertises only its drivers, because its capabilities must equal its enrolment.

The `WorkspaceDriver` contract owns preparation, capture and close. A driver that runs Code commands also implements `checkpointCommit`, `pendingCommits`, `commitOutcome` and `acknowledgeCommit`; a lifecycle-only driver never polls Code commands, so a policy granting `code.commit` must name a driver that runs them.

## Durable intent and credentials

The private SQLite ledger uses WAL, `synchronous=FULL` and `fullfsync=ON`; its directory is `0700`, its database and logs `0600`. A separate connection holds an exclusive controller lock, which a dead controller releases without blocking guardian updates. The ledger is bound to the server URL, source identity and project, and keeps a random runner ID and a private machine HMAC key. A pending lease request keeps its exact platform from before the HTTP call, and a retry derives the same session secret from its request ID.

Source and session bearers are not stored in the ledger. A launch keeps a projection of its session (never its assignment) and its profile as configured; a profile names secret environment variables but holds none of their values. The source bearer is refused in configuration, in the controller's metadata patches and, by `ProcessHost`, anywhere in a launch command (executable, arguments, cwd, environment, stdin). Command environment and stdin travel only over authenticated local IPC, and the supervisor receives the session bearer, never the source one. Child output redacts the session bearer and recognised secret environment values, including values split across chunks. The machine key and IPC authentication coordinate the runner; they do not isolate hostile processes running as the same OS user.

## Leasing and cadence

A refusal is `final` when it is a 4xx other than 401, 408 and 429 and its code is not `transaction_conflict`, `invalid_control_response` or (until GitHub mode is retired) `github_push_required`. A final refusal is that call's answer: it is recorded once and never replayed. Everything else is retried on the next tick. A 401 on a session control is retried, which can loop only while presence still authenticates; a presence or lease 401/403 means the source is revoked and every launch is stopped. A GET 404 is final only because a server answers 503, never 404, while a route's owning plugin is unmounted. One lease request's failure is that request's: later requests and profiles still lease in the same tick.

Presence is sent when its body changes, 15 s after the last success, or after a failed cycle (the server keeps it fresh for 45 s). A declined profile is not asked again for 5 s; a kept request whose answer was lost is always replayed. The session heartbeat is sent only when it would move `expiresAt` by over a minute, and the guardian's deadline is pushed only when it grows by over a minute. A managed GET does not reconcile, so a hosted runner learns of any reconcile-driven close (expiry, handoff, a workflow moving on) up to about 60 s later.

An assignment larger than the 800,000-byte command bound (about 0.4–0.7 MB of brief) is released `launch_failed` once and counted; after three a hold forms, until stdin travels by file.

## Launch, restart and proof of death

The ledger records intent before any spawn. A guardian atomically changes `reserved` to `starting` before it creates anything, so duplicate guardians cannot start a second worker, and pins the first command by HMAC; a conflicting replay is refused. One detached guardian owns a private authenticated Unix socket and exactly one child, a group owner that starts the command in its own process group. No process ID is stored. A reservation that no guardian claims within the launch's six-second wait is cancelled by the same SQL predicate.

A guardian that fails before it has an owner (a foreign socket directory, a socket it cannot listen on) ends its claim `stopped` (`socket_failed`), and one whose owner cannot be spawned ends it `exited` (`launch_failed`, 127); a socket file left at its path is removed first. A replacement controller reconnects to a live guardian, which can repair a timeout assessment from its own child's lifecycle. A claimed launch whose guardian cannot be reached stays `uncertain`, keeps its capacity and checkout, and is never respawned, unless it is proven gone:

- **Reboot.** The boot identifier is recorded before the guardian is spawned; a launch claimed in another boot ends `host_rebooted`. An unreadable identifier proves nothing. In a container it is usually the host's, so a container restart with a persisted ledger stays `uncertain` (safe); sandboxes that mint their own (gVisor) prove their own restarts.
- **No pinned command.** A `starting`/`uncertain` launch without one ends `guardian_lost_before_launch` a minute after it was first found unreachable (`lostAt`, since every save rewrites `updated_at`). That is safe because a guardian pins the command before it spawns and cannot pin it on an ended row, and a live guardian with no owner ends the launch itself within 30 s.
- **Anything else** (a guardian killed in the same boot after it pinned its command) needs an operator: confirm that the process group is gone, then end the row by hand.

The group owner enforces its current deadline itself, including when the controller stops polling, and guardian loss also shuts it down: `SIGTERM` to its own group, then `SIGKILL`. Once an owner exists, the guardian records the launch ended only after it has itself group-killed that live, unreaped direct child and observed its exit, checked synchronously with no async boundary ([libuv](https://github.com/nodejs/node/blob/v22.13.1/deps/uv/src/unix/process.c#L101-L174), [process_wrap](https://github.com/nodejs/node/blob/v22.13.1/src/process_wrap.cc#L327-L342), [child_process](https://github.com/nodejs/node/blob/v22.13.1/lib/internal/child_process.js#L269-L295), Node 22.13.1). Keep the guardian free of plugins, async hooks and preloads. The owner's self-cleanup fallback is not a proof, and descendants that leave the process group are outside it; this is supervision, not a sandbox.

## Settling an ended launch

An ended launch owes, in order: one release (its outcome and usage), the capture, owed Code receipts, the workspace result for an attached launch, and the closed checkout. A refused step is recorded and not replayed; a failed one is retried next tick. A launch whose driver is no longer composed is released but not settled, does not occupy capacity, and settles once the driver is back.

Usage is read from `usage.json` or from the last 1 MiB of the agent's output: Codex's last `turn.completed`, Claude's `result` event. A launch that ends within 10 s is counted `crash_loop`, otherwise `host_failed`, unless its halt named an outcome: a deadline halt is `host_failed`, a failed preparation `workspace_failed` (before attach) or `launch_failed` (after), and a deferred one (`checkout_busy`, `driver_absent`, a driver's own cause) `preparation_deferred`, which nothing counts.

The stop rule: a user-machine runner's `stop()` (Ctrl-C, systemd, an upgrade) releases the launches it ended with no outcome, which closes the session `released` and counts nothing. It flags every unreleased launch before it waits for the current tick, so a launch whose guardian got the same group SIGTERM first is uncounted too, and so is one the user killed by hand whose release was still pending. Hosted (`oneAssignment`) stops, presence or lease 401/403 halts, deadlines, and an agent's own group SIGTERM outside a stop stay counted: `released` has no backoff, so a repeated eviction or a poison 401 would re-offer the same work at once. A hosted Code-driver close that keeps failing holds the machine until Fleet retires it.

## Git workspaces

`GitWorkspaceManager` keeps its tables beside the ledger. It clones the configured source ([example](../../config/runner.git.example.json)) once into a private bare repository without hardlinks, alternates, remotes or network access, and never changes the source. The source and `baseRef` are read only to bootstrap or add a checkout, so a changed `repository`/`baseRef` refuses new checkouts only. Policies, lineages and bases are in [the workspace contract](../../docs/WORKSPACES.md). A persistent checkout is occupied until confirmed termination, durable capture, server acknowledgment and cleanup; a successor behind a live or settling owner is deferred `checkout_busy`, behind an `uncertain` one refused and counted.

Capture runs only after the process group has provably stopped:

- Whatever merge, rebase, cherry-pick, revert or bisect the agent left half-done is cleared first.
- A writer's lineage continues from wherever the agent left HEAD, keeping its commits and uncommitted work. Work on a side branch becomes the lineage, and an older commit checked out rewinds it, dropping checkpoint commits from the branch.
- A changed file above 50 MiB (or a symlinked directory over tracked paths) is never committed: it is moved to `<path>.refused-<launch>/` at its relative path, a tracked path is restored from HEAD, and the rest of the work is captured. The launch's metadata (`workspaceNotes.workspace_capture_refused_file`), a stderr line and `lastError` name the moved paths.
- Read-only work is reported as attached, and its checkout is put back on that head with ignored files kept.
- A capture or close that still fails after 10 minutes and three attempts (in-memory clock) is abandoned: the checkout moves to `<path>.abandoned-<launch>` with its `.git` pointer removed, the slot is freed and no result is reported. Abandoned checkouts, scratch directories and logs are not cleaned up.

The private repository's configuration is reset to the runner's allow-list at every runner Git call, since an agent's `git config` or `git remote add` in a checkout writes it; an agent in another slot can still write a key between that reset and a Git command, and every call pins its safety settings with `-c`. With `workspace: { github: true }`, until it is retired, the repository is fetched from and checkpoints and captures pushed to GitHub through short-lived Code transport grants; otherwise there is no central publication or cross-machine transfer, and results are source-authenticated observations, not verified Git proofs.

Code's `code.commit` reaches a live worker only through its frozen policy grant. The runner journals the exact command before Git work, builds a deterministic commit in a private index, and moves HEAD and the receipt ref in one transaction fenced by the launch's owner ref, which capture replaces with a closed marker before final HEAD work. Unknown outcomes stay pending until a receipt or the closed fence proves them; see [Code operations](../../docs/CODE_OPERATIONS.md).

## Runtime resource and tests

`src/supervisor.mjs` holds the dependency-free guardian and group owner; a compiled distribution must copy it beside `process-host.js` (TypeScript does not). `tests/runner-process.test.ts` covers launch deduplication, controller locking, process-tree stop, deadlines, guardian loss and proof of death, and needs permission for Unix sockets and process groups. `tests/runner-lease-path.test.ts`, `runner-settle.test.ts` and `runner-cadence.test.ts` drive the controller against a stand-in server; `tests/runner-workspaces.test.ts` uses real temporary Git repositories.
