# Merv

This extension connects Qwen Code directly to Merv over MCP. Interactive
authentication is handled by browser OAuth; never ask the user to mint or paste
a Merv key.

Start with `agent.hello` (once per context window; pass its `agent_id` in every
Merv call after that), then `project(action="list")`, choose the project the
user means, then call `workflow.status_and_next` with its project id. Follow that response's gate
and next action. Load the matching Merv skill before experiment, task, review,
reflection, consolidation, or sandbox work.

When Merv requests an independent review, delegate the returned handoff prompt
to a fresh subagent with the matching reviewer skill. That reviewer must call
`review.start` with its own session id and submit its verdict through
`review.submit`.
