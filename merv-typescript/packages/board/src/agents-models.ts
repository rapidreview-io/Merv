/** The experiment of handing a board's tasks to a person's own agents (agents.ts). */
export type AgentHarness = 'claude' | 'codex';

export interface AgentTask {
  id: string;
  board: string;
  /** The frame the task is: its title the goal, the notes in it the checks. */
  frame: string;
  /** The shape that says how the task stands; the machinery's, never a check. */
  status: string;
  goal?: string;
  title: string;
  /** Shapes that give the last run's reasons; the machinery's too. */
  verdicts: string[];
  /** The latest run. */
  run?: string;
  createdBy: string;
  createdAt: string;
}

export interface CheckVerdict {
  /** The shape of the check. */
  check: string;
  pass: boolean;
  how: 'command' | 'judge';
  /** Who judged it, when no exit code did: a harness other than the one that did the work. */
  by: string;
  reason: string;
}

export interface AgentRun {
  id: string;
  task: string;
  board: string;
  owner: string;
  harness: AgentHarness;
  state: 'queued' | 'running' | 'judging' | 'stopping' | 'passed' | 'failed' | 'stopped' | 'error';
  spec: {
    title: string;
    goal?: string;
    checks: { id: string; text: string; command?: string }[];
    context: string;
    previous?: { summary: string; failures: CheckVerdict[]; session?: string };
  };
  picture?: { data: string; mimeType?: string };
  step?: string;
  session?: string;
  verdicts?: CheckVerdict[];
  result?: { summary: string; files: string[]; stat: string };
  error?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface AgentConnector {
  actor: string;
  name: string;
  workspace: string;
  harnesses: Record<string, { ok: boolean; detail: string }>;
  seen: string;
  online?: boolean;
}

export interface AgentsState {
  tasks: (AgentTask & {
    latest?: AgentRun;
    /** How it stands, as its status shape says. */
    said: string;
    /** The frame no longer says what the latest run was handed. */
    changed?: boolean;
    /** The checks as they stand on the board, with the last run's verdict where it had one. */
    checks: { id: string; text: string; verdict?: CheckVerdict }[];
  })[];
  connector: AgentConnector | null;
  waiting: number;
}
