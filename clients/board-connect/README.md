# Board connector

Hands what is on a board to your own Claude Code and Codex, on your machine, over ACP
(`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`). You read and steer
each session beside the board.

```sh
cd clients/board-connect && npm install
node connect.mjs --server https://your-board --project <id> --key <key> --repo ~/some/repo [--repo ~/another]
```

Options: `--name` (what the board calls this machine), `--claude-config DIR` (Claude's config
folder; by default what your shell's `claude` alias sets, else the default login), `--claude-mode`
(`default`: Claude asks before changes), `--codex-mode` (`workspace-write`: Codex edits the worktree
and asks for anything else). `MERV_URL`, `MERV_PROJECT`, `MERV_KEY` work in place of the flags.

Locally (`npm run board` with `MERV_BOARD_HANDOFF=all`), the server prints the whole command with
your key. On a hosted board, the key is a Merv key for your project.

## What it does

- Polls the board every 2 s, outbound only.
- Each session gets a git worktree of the repo at `.board-worktrees/<id>` on branch `board/<id>`,
  made from HEAD. Your checkout is never edited. After every turn the worktree is committed on that
  branch; the session's card says the branch and the folder.
- Runs the harnesses under the logins they already have here; never reads or sends credentials.
- Their own permission prompts stay on: an approval waits on the board until you answer it, and is
  never allowed by itself. Codex's JS "code mode" is turned off for these sessions, since it runs
  commands with no approval at all.

## What leaves your machine

The folder names you offer (never paths), which harnesses answer `--version`, the agent's
messages, one line per tool call (its title, which for a shell command is the command), each
approval question and your answer, the final diffstat and branch name. The server runs its secret
redaction over the text and stores it per session. Not sent: file contents, diffs, tool output,
paths or any credential.
