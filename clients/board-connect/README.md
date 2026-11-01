# Board connector (experiment)

Lets a board hand tasks to your own Claude Code and Codex. It runs on your machine and dials out.

```sh
node connect.mjs --server https://your-merv --key "$MERV_KEY" --workspace ~/some/repo --name "Mac"
```

To try the whole loop locally, from `merv-typescript/`:

```sh
npm run demo:command-center
```

That makes a throwaway git repository in your temp directory, starts the seeded server and dials the
connector out to it. Agents only ever run in worktrees of that directory.

## What it does

- Polls the board every 2 s over outbound HTTPS. No port is opened and no tunnel is used.
- Runs the unmodified `claude` and `codex` binaries, under the logins they already have here. It
  never reads, holds or sends their credentials.
- Gives each task and harness its own git worktree and branch, `.board-worktrees/<task>-<harness>`.
- After a run, decides each check:
  - **A check with a command in backticks** is run by this process and decided by its exit code.
    The first time it sees a command, it asks at the terminal (`--trust-checks` skips this, for a
    throwaway workspace only). On macOS the command runs in `sandbox-exec` with no network, writes
    only to its worktree and temp, and cannot read `~/.ssh`, `~/.aws`, `~/.codex`, `~/.claude*`,
    `~/.merv`, `~/.config` or `~/.gnupg`.
  - **Any other check** gets one reading from the other harness, if it is installed. A no fails the
    check; a yes leaves it "for your eyes" and never counts as a pass by itself. Without the other
    harness, a fresh run of the same one reads it.

## What leaves your machine

Sent: the machine name, the workspace folder's name, which harnesses are signed in, each step's one
line (a command's first 50 characters or a file's name), the agent's closing summary, the diffstat,
and each verdict's reason. A command check's reason includes the last line of its output.

Not sent: file contents, the diff itself, the transcript, or any token.

These are stored on the board as ordinary shapes, so a board's share link shows them.

## What it does not do yet

- Agents run with no way to ask you anything: Claude in `acceptEdits` with an allowlist, Codex in
  `workspace-write`. A denied tool is a refused step, not a question on the board.
- No steering during a run, only Stop. Send back resumes the same session with the failures.
- Sessions you started yourself in a terminal are not seen. That is what the `board` plugin
  (`clients/board`, on `claude/board-attach`) is for.
- The sandbox is macOS only. Elsewhere a command check runs with a reduced environment and nothing
  else.
- No install, pairing or key scoping: `--key` is your own full Merv key.
