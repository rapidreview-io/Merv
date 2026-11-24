/** Which of a project's sessions its main thread shows as agents. */
import { ago, type Provider, type Thread } from './rows';

const DAY = 86_400_000;

/** Who stands at the foot of the thread: agents asking for the person, then those at work. What finished is
 *  in the thread itself, where it happened, so nothing here ages out or is cut off. With `finished`, for a
 *  thread that keeps no such record, those done within the day follow, newest first.
 *  The main thread itself is never one of them. */
export function threadAgents(
  threads: Thread[],
  now = Date.now(),
  waiting?: Set<string>,
  finished = false,
): Thread[] {
  const rank = (thread: Thread) =>
    waiting?.has(thread.id) ? 0 : thread.status === 'running' ? 1 : 2;
  return threads
    .filter(
      (thread) =>
        !thread.side_of &&
        !thread.archived &&
        !thread.main &&
        (thread.status === 'running' ||
          !!waiting?.has(thread.id) ||
          (finished &&
            (thread.counts?.turns ?? 0) > 0 &&
            now - Date.parse(thread.updated_at) < DAY)),
    )
    .sort((a, b) => rank(a) - rank(b) || b.updated_at.localeCompare(a.updated_at));
}

/** A few agents show at once and the rest wait behind one line; one that needs the person is never among the rest. */
export function shownAgents<T>(
  agents: T[],
  most?: number,
  all = false,
  needs: (agent: T) => boolean = () => false,
): { shown: T[]; more: number } {
  if (!most || all || agents.length <= most) return { shown: agents, more: 0 };
  const shown = agents.filter((agent, at) => at < most || needs(agent));
  return { shown, more: agents.length - shown.length };
}

/** The project's main thread among its sessions, if it has one. */
export const mainThread = (threads: Thread[]) =>
  threads.find((thread) => thread.main && !thread.archived && !thread.side_of);

/** One line of what is live in a project, as the column beside the chat lists it under "Main thread": an agent at work
 *  or asking, or a job under way. `open` is the session a press opens beside the main thread; `ask` is what a press
 *  brings the person to instead when the line needs them: a session's pending request, or the job's own question. */
export interface LiveLine {
  key: string;
  kind: 'agent' | 'job';
  title: string;
  provider?: Provider;
  needs: boolean;
  /** A job's stage in a quiet word. An agent simply at work has none: its moving mark says it. */
  word?: string;
  open?: string;
  ask?: { thread?: string; job?: string };
  /** Since when it has needed the person, where that is known: said after "needs you". */
  since?: string;
}

/** Since when each session has waited on the person: its oldest open request's time. */
export function waitingSince(
  requests: { thread: string; created_at?: string }[],
): Map<string, string> {
  const since = new Map<string, string>();
  for (const request of requests)
    if (
      request.created_at &&
      (!since.has(request.thread) || request.created_at < since.get(request.thread)!)
    )
      since.set(request.thread, request.created_at);
  return since;
}
/** "needs you · 12m": how long it has needed the person, once that is a minute or more. Nothing is ever added to a line at work. */
export function needsWords(since?: string): string {
  const waited = since ? ago(since) : '';
  return waited && waited !== 'now' ? `needs you · ${waited}` : 'needs you';
}

/** Whether the column beside the chat is listing a project's live work, so its main thread need not: the chat has the
 *  window, the column is showing, and the project it shows (the one the person is in) is this thread's. Anywhere else
 *  (the board-first layout, the column hidden, the web's panel) the thread keeps its own list. */
export function nowInColumn(
  side: boolean,
  here: { folder: string } | undefined,
  home: { cwd: string; folders: string[] } | undefined,
): boolean {
  return (
    side && !!here && !!home && (home.cwd === here.folder || home.folders.includes(here.folder))
  );
}

/** At a main thread's foot a job is one line, so its members are not lines of their own there. */
export const outsideJobs = (threads: Thread[], jobs: { id: string }[]) =>
  threads.filter((thread) => !thread.job || !jobs.some((job) => job.id === thread.job!.job));

/** A job's state in two parts: what is said in the one accent, and the rest. Only "needs you" is ever accented.
 *  An end kept before it was said whose pass it was reads as it is said now. */
export function jobWords(words: string): { accent?: string; rest: string } {
  words = words.replace(/^done · passed in /, 'done · review passed in ');
  return words.startsWith('needs you')
    ? { accent: 'needs you', rest: words.slice('needs you'.length).trimStart() }
    : { rest: words };
}

/** What can be pressed at the end of an opened job, in words. One that only waits for a member's own request offers no Continue: the request is the thing to answer. */
export function jobActions(job: {
  state: string;
  needs?: string;
  more: number;
}): ('continue' | 'stop')[] {
  return job.state === 'running'
    ? ['stop']
    : job.state === 'needs'
      ? job.needs === 'asking'
        ? ['stop']
        : ['continue', 'stop']
      : [];
}
export const continueWords = (job: { needs?: string; more: number }) =>
  job.needs === 'limit'
    ? `Continue for ${job.more} more ${job.more === 1 ? 'round' : 'rounds'}`
    : 'Continue';

/** What a press on a closed line reveals, named in the line's last word: never a bare "show". These are the lines of
 *  what is live, and of a job's rounds; a turn that ended in the thread is not folded, so it has no such word. */
export type Reveals = 'progress' | 'changes' | 'answer' | 'review' | 'rounds' | 'diff';
/** An agent's line: at work or asking, how far it has come; a review that ended, the review; a turn that ended, its
 *  changes when it is known to have changed files, else its answer. */
export function reveals(line: { state: CardState; review?: boolean; files?: number }): Reveals {
  if (line.state === 'working' || line.state === 'waiting') return 'progress';
  // What changed is opened on its own line: a line that opens an agent promises what it said.
  return line.review ? 'review' : 'answer';
}
export const toggleWords = (open: boolean, what: Reveals) => (open ? 'hide' : `show ${what}`);

/** A finished agent's message stands whole in the thread up to about this many lines of text; a longer one shows its
 *  first part and one word at the cut. Not folded for the sake of a few lines more. */
const FOLD_LINES = 24,
  FOLD_SLACK = 8;
/** The first part of a long message, cut between lines of its source so what shows is still whole Markdown: a code
 *  block open at the cut is closed. Nothing when the message is short enough to stand whole. Lines are counted as they
 *  will roughly be drawn: a long paragraph is several, a blank line half of one, a table's rule none. */
export function foldAt(text: string, most = FOLD_LINES, width = 100): string | undefined {
  const lines = text.replace(/\s+$/, '').split('\n');
  let used = 0,
    fence = '',
    at = -1,
    open = '';
  for (const [index, line] of lines.entries()) {
    const before = fence,
      mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark)
      fence = fence
        ? mark.startsWith(fence[0]!) && mark.length >= fence.length
          ? ''
          : fence
        : mark;
    used += !line.trim()
      ? fence
        ? 1
        : 0.5
      : !fence && /^\s*\|?[\s|:-]+\|[\s|:-]*$/.test(line)
        ? 0
        : Math.ceil(line.length / width);
    // The last line that still fits is the last one shown; a first line too long to fit is shown all the same.
    if (used > most && at < 0) {
      at = Math.max(0, index - 1);
      open = index ? before : fence;
    }
  }
  if (at < 0 || used <= most + FOLD_SLACK) return;
  const head = lines.slice(0, at + 1);
  const blanks = () => {
    while (head.length && !head.at(-1)!.trim()) head.pop();
  };
  blanks();
  // A code block that would only begin at the cut is left for the rest.
  if (open && /^\s*(`{3,}|~{3,})/.test(head.at(-1) ?? '')) {
    head.pop();
    open = '';
    blanks();
  }
  return head.length ? `${head.join('\n')}${open ? `\n${open}` : ''}` : undefined;
}

/** How a job ended, as the line under its writer's words says it: an end kept in older words reads the same. */
export const jobEndWords = (words: string) =>
  words.replace(/^done · (?:review )?passed in /, 'passed in ');

/** The files line under a message: the first few by name, and how many more there are behind one word. */
export const FILES_NAMED = 3;

/** Where the work is, in words. A worker's branch is its own; a reviewer sits on the branch of the work it judges.
 *  `unmerged`: read as the entry was opened, the work is certainly not in the default branch (uncommitted changes in
 *  its folder, or commits the default branch lacks), and that is said. Nothing else is ever said about merging: not
 *  that it is merged, and nothing at all where it could not be read. */
export const whereWords = (branch: string, own = true, unmerged = false) =>
  `${own ? 'on its own branch' : 'on branch'} ${branch}${unmerged ? ' · not merged' : ''}`;

/** What the desk says can be done with ended work on its own branch (`threads/:id/work`). */
export interface Work {
  state: 'none' | 'unmerged' | 'merged' | 'discarded';
  branch?: string;
  into?: string;
  busy?: boolean;
  pr?: boolean;
}
/** The end of a finished message, in words: what can be pressed, or the fact once it was. Merge names the branch it
 *  goes into and is offered only where there is one; a pull request only where the desk can open one; nothing while
 *  its agent is at work again, and nothing where there is no work on a branch of its own. */
export function workWords(work: Partial<Work> | undefined): {
  fact?: string;
  acts: { what: 'merge' | 'pull-request' | 'discard'; words: string; into?: string }[];
} {
  if (work?.state === 'merged')
    return { fact: `merged into ${work.into ?? 'its base branch'}`, acts: [] };
  if (work?.state === 'discarded') return { fact: 'branch discarded', acts: [] };
  if (work?.state !== 'unmerged' || work.busy) return { acts: [] };
  return {
    acts: [
      ...(work.into ? [{ what: 'merge' as const, words: 'merge into', into: work.into }] : []),
      ...(work.pr ? [{ what: 'pull-request' as const, words: 'pull request' }] : []),
      { what: 'discard' as const, words: 'discard' },
    ],
  };
}

/** A reviewer's words as they are shown under a line that already states its verdict: a line that is nothing but that
 *  same verdict is left out, with the blank line it stood after. Anything more on the line, a different verdict, or a
 *  line inside a code block stays. The stored words are never changed. */
export function withoutVerdict(said: string, stated: ReviewEnd | undefined): string {
  const same =
    stated === 'passed'
      ? /^pass(?:ed|es)?$/i
      : stated === 'needs changes'
        ? /^needs?[\s-]+changes?$/i
        : undefined;
  if (!same) return said;
  const kept: string[] = [];
  let fenced = false;
  for (const line of said.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) fenced = !fenced;
    const verdict = fenced
      ? undefined
      : /^[\s*_#>-]*verdict[*_]*\s*[:：-]\s*[*_]*\s*(.*?)[\s*_.]*$/i.exec(line);
    if (verdict && same.test(verdict[1]!)) {
      while (kept.length && !kept.at(-1)!.trim()) kept.pop();
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/^\n+/, '');
}

/** How often an opened card of an agent at work is read again. */
export const LIVE_EVERY = 3000;
/** Whether a card is read again on that beat: only one that is open on an agent at work, in a window the person can see, with no read still on its way. */
export const readsAgain = (
  card: { open: boolean; state: CardState; live: boolean },
  hidden: boolean,
  reading: boolean,
) => card.open && card.live && card.state === 'working' && !hidden && !reading;

/** A name short enough for a reply box. */
export const shortName = (title: string, most = 32) => {
  const line = title.replace(/\s+/g, ' ').trim();
  return line.length > most ? `${line.slice(0, most - 1).trimEnd()}…` : line;
};

/** What a card says of a turn: how it stands, or that it cannot be read. */
export type CardState = 'working' | 'waiting' | 'finished' | 'failed' | 'stopped' | 'unreadable';
export const STATE_WORDS: Record<CardState, string> = {
  working: 'working',
  waiting: 'needs you',
  finished: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  unreadable: 'cannot be read',
};

/** How a review ended, in a word or two: its verdict when it finished, else how it stopped. One that changed files failed as a review, whatever it concluded. */
export type ReviewEnd =
  'passed' | 'needs changes' | 'no verdict' | 'changed files' | 'failed' | 'stopped';
export function reviewEnd(
  review: { verdict: 'pass' | 'needs changes' | 'none'; changed?: boolean },
  outcome: 'finished' | 'failed' | 'stopped',
): ReviewEnd {
  if (review.changed) return 'changed files';
  if (outcome !== 'finished') return outcome;
  return review.verdict === 'pass'
    ? 'passed'
    : review.verdict === 'needs changes'
      ? 'needs changes'
      : 'no verdict';
}

/** One id for one unsent draft, however many times its send is tried: after a failure, a timeout or a reload the same
 *  words go with the same id, so the desk takes them once. Changed words are another draft and get another id. */
export function sendId(
  key: string,
  content: unknown,
  make: () => string = () => crypto.randomUUID(),
): string {
  const of = JSON.stringify(content, (name, value) =>
      name === 'data' || name === 'url' ? undefined : value,
    ),
    at = `merv:send-id:${key}`;
  try {
    const kept = JSON.parse(localStorage.getItem(at) ?? 'null') as {
      of: string;
      id: string;
    } | null;
    if (kept?.of === of && typeof kept.id === 'string') return kept.id;
  } catch {
    /* Unreadable: a new id. */
  }
  const id = make();
  try {
    localStorage.setItem(at, JSON.stringify({ of, id }));
  } catch {
    /* Kept for this try only. */
  }
  return id;
}
/** The draft was taken: the next words typed there are a new send. */
export function sendDone(key: string) {
  try {
    localStorage.removeItem(`merv:send-id:${key}`);
  } catch {
    /* Nothing kept. */
  }
}

/** The project already has a main thread, started a moment ago from here or elsewhere: what the person just
 *  typed is delivered to it, once, and its id returned so the panel can open it. While the winner is still
 *  starting it has no id yet, so it is asked for again. Nothing typed is dropped: with no winner, nothing is sent. */
export async function deliverToMain(
  send: <T>(path: string, body?: unknown) => Promise<T>,
  cwd: string,
  message: Record<string, unknown>,
  id: string,
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((done) => setTimeout(done, ms)),
  tries = 20,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const found = await send<{ thread: string | null }>(
      `project/thread?cwd=${encodeURIComponent(cwd)}`,
    ).catch(() => ({ thread: null }));
    if (found.thread) {
      // The id makes a repeat of this same send a no-op on the desk.
      await send(`threads/${found.thread}/messages`, { ...message, id });
      return found.thread;
    }
    await wait(250);
  }
}
