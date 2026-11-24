import { type Provider, type SessionOptions } from '@merv/protocol/runtime';
import { type State } from './marks';
import type { ProjectCard } from '@merv/protocol/link';

export type { Provider } from '@merv/protocol/runtime';
export interface Thread {
  side_of?: { thread: string; at: number };
  handed?: boolean;
  followup?: { at: number } | { on: 'done' | 'pr' };
  wake?: number;
  wakeReview?: boolean;
  setup?: 'running' | 'done' | 'failed';
  worktreeLeft?: boolean;
  renameable?: boolean;
  choices?: SessionOptions;
  worktree?: { folder: string; branch?: string };
  id: string;
  provider: Provider;
  cwd: string;
  title: string;
  status: string;
  turn: string | null;
  generation: number;
  updated_at: string;
  archived?: boolean;
  pinned?: boolean;
  draft?: boolean;
  counts?: { turns: number };
  inTerminal?: boolean;
  /** The project's main thread: the one the person talks to, which knows the project's other sessions. */
  main?: boolean;
  /** A reviewer: the worker whose work it judges, read-only in that worker's folder, and that worker's title. */
  review?: { worker: string; title: string };
  /** A member of a job: which job, and in what role. */
  job?: { job: string; role: string };
  /** On a main thread: the jobs it has under way. */
  jobs?: JobView[];
  /** On a main thread: its jobs that ended, the newest few first. */
  jobsEnded?: JobView[];
  /** On a main thread: its project's card as the desk last built it, which the column's one list is drawn from. */
  card?: ProjectCard;
}
/** One turn a member took in a job, in words: "Codex reviewed · needs changes". */
export interface JobLine {
  n: number;
  thread: string;
  provider: Provider;
  model?: string;
  role: string;
  step?: string;
  round: number;
  state: 'working' | 'finished' | 'failed' | 'stopped';
  words: string;
  completion?: string;
  files?: number;
  late?: true;
}
/** A job: several agents on one piece of work, moved by the desk. `words` is its state as every reader says it. */
export interface JobView {
  id: string;
  recipe: string;
  title: string;
  summary?: string;
  state: 'running' | 'needs' | 'done' | 'stopped';
  words: string;
  needs?: string;
  more: number;
  lines: JobLine[];
  branch?: string;
  /** The main thread it belongs to, the workflow's own state ("reviewing"), and since when it has needed the person. */
  main?: string;
  step?: string;
  since?: string;
  /** The round it is in, the rounds it may take, when it came to its current step (for one that ended, when it ended), and when it began. */
  round?: number;
  rounds?: { used: number; max: number };
  stageSince?: string;
  at?: string;
}
export interface Past {
  provider: Provider;
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  /** `joinable`: in a terminal on the shared Codex server, so it can be joined as it runs. */
  owner: 'running elsewhere' | 'unknown' | 'joinable';
}
export interface Request {
  id: string;
  thread: string;
  kind: string;
  title: string;
  /** When it was asked. */
  created_at?: string;
  detail: string | null;
  options: string | null;
  questions: string | null;
}
export interface Link {
  paired: boolean;
  connected: boolean;
  consent: 'yes' | 'no' | null;
  /** False until the person has opened You here or answered about their chats. */
  seenYou?: boolean;
  /** The first-run list is still showing: someone new who has not finished it or put it away. */
  welcome?: boolean;
  browser: boolean;
  /** Sessions may use other apps on the Mac without asking. Absent from an older desk. */
  apps?: boolean;
  /** The folder new sessions start in when none is named. */
  main?: string | null;
  /** Folders added as projects, kept before their first session. */
  picked?: string[];
  /** Projects put away from the list, each with when. Absent from an older desk. */
  archivedFolders?: Record<string, string>;
}

/** Merv's conversation on the board beside, as the board tells it: one per board. */
export interface MervChat {
  board: string;
  conversation?: string;
  boardId?: string;
  working: boolean;
  lines: { role: 'user' | 'assistant'; text: string }[];
}

export const folderName = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? cwd;
/** A system note stands in for no title at all: the row is then its folder's. */
const SYSTEM_NOTE =
  /^(?:The command below was run|RESUMING:|Reply with the single word|Start by looking at where this comes)/;
/** The person's ask as a title: no markdown, no paths, no wrapper, and no worktree aside. */
export const askTitle = (title: string) =>
  SYSTEM_NOTE.test(title)
    ? ''
    : title
        .replace(/^Execute this[:.]?\s*/, '')
        .replace(/https?:\/\/([^\s/]+)\S*/g, '$1')
        .replace(/(^|\s)(?:~?\/|[A-Za-z]:\\)\S+/g, '$1')
        .replace(/[*`#]+|(^|\s)_+|_+(?=\s|$)/g, '$1')
        .split(/\n/)[0]!
        .replace(/^\s*Repo:\s*/i, '')
        .replace(/[,(]?\s*(?:\(?this checkout is a |in the |on branch )?git worktree.*$/, '')
        .trim();
/** A session's name: what was asked, else its folder's. */
export const sessionTitle = (title: string, cwd: string) =>
  askTitle(title) || folderName(cwd) || 'Chat';
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
export const stateOf = (thread: Pick<Thread, 'status'>, waiting: boolean): State =>
  waiting
    ? 'waiting'
    : thread.status === 'running'
      ? 'running'
      : thread.status === 'failed'
        ? 'failed'
        : thread.status === 'stopped'
          ? 'stopped'
          : 'idle';

/** Sessions handed out from here that are at work, while no thread tells of them. Never how one ended: a desk that quit or
 *  restarted leaves every session it had running "stopped", and that is nobody's news. */
export const handedLive = (threads: Thread[]) =>
  threads.filter(
    (thread) => thread.handed && (thread.status === 'running' || thread.status === 'starting'),
  );
