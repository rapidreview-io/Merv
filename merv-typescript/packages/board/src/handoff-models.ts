/** The hand-off's records, as the page reads them too (no Node here). */
export type Harness = 'claude' | 'codex';
export type RunState = 'queued' | 'running' | 'asking' | 'done' | 'stopped' | 'failed';
export interface Ask {
  id: string;
  title: string;
  options: { id: string; name: string; kind: string }[];
}
export interface Command {
  id: string;
  kind: 'say' | 'steer' | 'stop' | 'answer';
  text?: string;
  ask?: string;
  option?: string;
}
export interface Run {
  id: string;
  board: string;
  owner: string;
  harness: Harness;
  repo: string;
  brief: string;
  /** What the handed-off shapes say, for the agent's first prompt. */
  words: string;
  /** The tag drawn beside the shapes. */
  tag: string;
  state: RunState;
  /** The agent's open question: its approval request, until answered. */
  ask?: Ask;
  /** The harness's own session id, so a follow-up finds the same session. */
  session?: string;
  result?: { summary: string; branch: string; dir: string; stat: string };
  error?: string;
  commands: Command[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}
export interface Connector {
  name: string;
  repos: string[];
  claude: boolean;
  codex: boolean;
  started: string;
  seen: string;
}
export interface RunEvent {
  seq: number;
  at: string;
  kind: 'you' | 'agent' | 'tool' | 'ask' | 'note';
  id?: string;
  text: string;
  status?: string;
}

export const NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex' };
