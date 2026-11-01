# Board for Claude Code

Attach the session you already run to a board. Nothing about your login, your CLAUDE.md, your
permissions or your terminal changes, and no Anthropic token ever leaves your machine.

```sh
claude plugin install board --marketplace rapidreview-io/merv-plugins
```

On a board, choose **Attach Claude Code** in the ⋯ menu, then in your session run the line it shows:
`/board:pair ABC234`. Only that session attaches, and only to that board.

## What is sent

To the board's server, only while this session is attached, over an outbound connection:

- your folder's name, as the session's pen name;
- the first 200 characters of each prompt and of Claude's closing message each turn;
- each tool's name, its start and end, whether it failed, and the first 200 characters of its
  command, path, pattern, URL or description;
- what Claude draws.

Never sent: tool output, file contents, edits, or the transcript. Text goes through the same secret
patterns as board transcripts before it leaves your machine; a pattern can miss a secret, so a secret
typed in a prompt or command could still pass.

The server relays session events to pages open on that board and keeps them in memory only. What
Claude draws is stored, as all board marks are. **Pin** on the session's strip is the one way its
activity is stored, as marks on the board, and only when you press it.

Marks on the board reach Claude as notes before its next model request. Anyone who can edit the
board can therefore steer this session, within the permissions you already gave it.

If the board cannot be reached, hooks give up within 600 ms, then stay quiet for 30 seconds.
