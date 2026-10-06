/**
 * What a worker agent is doing, as the runner reads it from the agent's own output and Sessions
 * keeps and relays it: its thinking, what it says, the tools it calls and what they answer. One
 * shape for every harness (Claude Code's stream-json, Codex's --json), so the page that draws it
 * never learns which agent wrote it.
 *
 * A block that is still being written arrives in pieces under one `id`: each piece's `delta` is
 * appended to the ones before it, and `done` closes the block. A block sent whole is one event with
 * `done`. Every text is scrubbed of credentials before it leaves the machine. Thinking and text
 * longer than AGENT_EVENT_TEXT characters are split into more pieces, nothing dropped; a tool's
 * input or output is cut to AGENT_EVENT_TEXT characters, and `cut` counts what was dropped.
 */
export const AGENT_EVENT_TEXT = 16_000;

export type AgentEvent =
  | { kind: 'thinking'; id: string; delta: string; done?: boolean; cut?: number }
  | { kind: 'text'; id: string; delta: string; done?: boolean; cut?: number }
  /** `input` is the call's arguments as JSON text. */
  | { kind: 'tool_call'; id: string; name: string; input: string; cut?: number }
  /** Answers the call with the same `id`. */
  | { kind: 'tool_result'; id: string; output: string; error?: boolean; cut?: number }
  /** The session's own milestones: started, resumed a conversation, finished, its usage. */
  | { kind: 'status'; id: string; text: string };

/** One event as Sessions keeps it: numbered from 1 within its session, in the order it arrived. */
export interface AgentStreamEvent {
  seq: number;
  at: string;
  event: AgentEvent;
}
