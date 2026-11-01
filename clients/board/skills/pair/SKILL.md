---
description: Attach this session to a board, with the code the board shows you.
argument-hint: <code>
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/board.mjs" pair "$ARGUMENTS" "${CLAUDE_SESSION_ID}" "${CLAUDE_PLUGIN_DATA}"`

Tell the person the line above in one sentence. If it says attached, that is all: carry on with what they were doing. The board's tools are board_read and board_write; draw on it when they ask.
