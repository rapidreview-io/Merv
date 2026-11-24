/** What a job's own page says, without drawing it: the head's words for each state, the one line of where the time went,
 *  the rounds in order, the stream cut into chapters, and which quiet words stand at the foot. The desk sends times;
 *  the words are made here against the page's clock. */
import { modelName } from './model-name';
import { providerName } from '@merv/protocol/runtime';
import { type EventRow } from './desk-calls';
import { continueWords, jobActions } from './agents';
import type { JobLine, JobView, Provider } from './rows';

export interface PageTurn extends JobLine {
  at: string;
  ended?: string;
  ms?: number;
}
export interface Chapter {
  at: string;
  state: string;
  round: number;
  ms: number;
  end?: 'done' | 'stopped';
}
export interface Artifact {
  path: string;
  added: number;
  removed: number;
  round: number;
  role: string;
  provider: Provider;
  group: 'files' | 'tests' | 'renders';
}
export interface JobPage extends JobView {
  kind: string;
  task: string;
  writer?: string;
  ended?: string;
  now: string;
  spent: Record<string, number> & { waiting: number };
  turns: PageTurn[];
  chapters: Chapter[];
  artifacts: Artifact[];
  stream: EventRow[];
  cut?: boolean;
  /** The workflow's shape, from its definition. An older desk sends none: the review loop's is meant. */
  flow?: Flow;
  /** "Done means": what was promised, check by check, and each member's word on it. The engine keeps none yet, so the
   *  page has its place and shows nothing. */
  checks?: { n: number; text: string }[];
  /** From afar, what can be done with an ended job's work, as its Mac read it with the page. */
  work?: import('./agents').Work;
}

/** A length of time in one short word: "40m", "3h", "2d"; under a minute, "<1m", and nothing at all for none. */
export function minutes(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  const s = ms / 1000;
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const rounds = (n: number) => `${n} ${n === 1 ? 'round' : 'rounds'}`;

/** Why a job waits, as the second word after "needs you". */
export const WHY: Record<string, string> = {
  limit: 'limit',
  asking: 'asking',
  'no verdict': 'no verdict',
  failed: 'a member failed',
  stopped: 'a member stopped',
  'changed files': 'the review changed files',
  interrupted: 'interrupted',
  'work changed': 'work changed in review',
  unconfirmed: 'message unconfirmed',
  unheard: 'no result heard',
};

/** A length of time in at most two words: "38m", "4h 38m", "4h", "2d 3h"; under a minute "<1m"; none, nothing. */
export function duration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 60_000) return '<1m';
  const all = Math.round(ms / 60_000);
  if (all < 60) return `${all}m`;
  const hours = Math.floor(all / 60),
    rest = all % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24),
    left = hours % 24;
  return left ? `${days}d ${left}h` : `${days}d`;
}

/** The head's clock: how long the job worked, members at work in it, and how long it stood idle, which is every
 *  other moment from its start to its end (or now): waiting on the person, queued, stopped. "worked 4h 38m · idle 8h".
 *  Between the desk's reads a job under way counts as working, one that waits as idle. */
export function clock(
  job: Pick<JobPage, 'state' | 'spent' | 'at' | 'ended' | 'now'>,
  now: number,
): { worked: number; idle: number; words: string } {
  const read = Date.parse(job.now);
  let worked = Object.entries(job.spent ?? {}).reduce(
    (sum, [state, ms]) => (state === 'waiting' ? sum : sum + (ms || 0)),
    0,
  );
  if (job.state === 'running' && !job.ended && Number.isFinite(read))
    worked += Math.max(0, now - read);
  const end = job.ended ? Date.parse(job.ended) : now;
  const total = job.at
    ? Math.max(0, end - Date.parse(job.at)) || 0
    : worked + (job.spent?.waiting ?? 0);
  const idle = Math.max(0, total - worked);
  return {
    worked,
    idle,
    words: [
      duration(worked) && `worked ${duration(worked)}`,
      duration(idle) && `idle ${duration(idle)}`,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/** Why a job needs the person, said after the amber "needs you" on the head's type line: " · limit". Nothing for a job
 *  that does not need them. */
export function needsWhy(job: Pick<JobPage, 'state' | 'needs'>): string | undefined {
  if (job.state !== 'needs') return;
  return job.needs ? ` · ${WHY[job.needs] ?? job.needs}` : '';
}

/** A turn's line among the rounds: "Round 2 · Claude Code wrote · 3 files · 12m". */
export const turnWords = (turn: Pick<PageTurn, 'round' | 'words' | 'ms' | 'provider' | 'model'>) =>
  `Round ${turn.round} · ${(turn.model ? turn.words.replace(providerName(turn.provider), `${providerName(turn.provider)} · ${modelName(turn.model)}`) : turn.words).replace(/…$/, '')}${minutes(turn.ms) ? ` · ${minutes(turn.ms)}` : ''}`;

/** A chapter's heading in the stream: "Round 2 · reviewing · 4m", and the end: "passed in 2 rounds". */
export function chapterWords(chapter: Chapter, job?: Pick<JobPage, 'round'>): string {
  if (chapter.state === 'shipped') return 'shipped';
  if (chapter.end === 'done') return `passed in ${rounds(job?.round ?? chapter.round)}`;
  if (chapter.end === 'stopped') return `stopped in round ${chapter.round}`;
  return `Round ${chapter.round} · ${chapter.state}${minutes(chapter.ms) ? ` · ${minutes(chapter.ms)}` : ''}`;
}

/** The task's first line, and whether there is more of it behind "brief ›". A first line the title already says is not
 *  said again: the goal is then the brief's next line, or only the word that opens the brief. */
export function goalOf(task: string, title = ''): { first: string; more: boolean } {
  const lines = task
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const same = !!title && lines[0]?.replace(/[.\s]+$/, '') === title.replace(/[.\s]+$/, '');
  const first = same ? (lines[1] ?? '') : (lines[0] ?? '');
  return { first, more: lines.length > (same && lines[1] ? 2 : 1) };
}
/** The brief stays open until round 1 hands its work in; then it folds. */
export const briefOpen = (job: Pick<JobPage, 'turns'>) =>
  !job.turns.some((turn) => turn.role !== 'reviewer' && turn.state !== 'working');

/** The stream as the page reads it: a chapter heading at each move, then runs of one member's events, each run under
 *  who it is. A run never spans a chapter. */
export type Piece =
  | { kind: 'chapter'; key: string; chapter: Chapter; index: number }
  | {
      kind: 'member';
      key: string;
      thread: string;
      provider: Provider;
      model?: string;
      role: string;
      rows: EventRow[];
    };
export function pieces(job: Pick<JobPage, 'stream' | 'chapters' | 'turns'>): Piece[] {
  const who = new Map(job.turns.map((turn) => [turn.thread, turn]));
  const out: Piece[] = [];
  const chapters = [...job.chapters].sort((a, b) => a.at.localeCompare(b.at));
  let next = 0;
  const heading = () => {
    const chapter = chapters[next]!;
    out.push({ kind: 'chapter', key: `c${next}`, chapter, index: next });
    next++;
  };
  // The job's start leads: its writer was given the task a moment before the job was written down. A later move is
  // made by the turn that ended just before it, so its heading comes after that turn's closing words, even at the same time.
  if (chapters.length) heading();
  for (const row of job.stream) {
    while (next < chapters.length && Date.parse(chapters[next]!.at) < Date.parse(row.at)) heading();
    const last = out.at(-1),
      member = who.get(row.thread ?? '');
    if (last?.kind === 'member' && last.thread === row.thread) {
      last.rows.push(row);
      continue;
    }
    out.push({
      kind: 'member',
      key: `m${row.seq}`,
      thread: row.thread ?? '',
      provider: member?.provider ?? 'claude',
      ...(member?.model && { model: member.model }),
      role: member?.role ?? 'member',
      rows: [row],
    });
  }
  while (next < chapters.length) heading();
  return out;
}
/** Who speaks in a run: "Claude Code · writer", the role as the flow says its work. */
export const memberWords = (
  piece: { provider: Provider; model?: string; role: string },
  flow?: Flow,
) =>
  `${providerName(piece.provider)}${piece.model ? ` · ${modelName(piece.model)}` : ''} · ${roleWord(piece.role, flow)}`;

/** The quiet words at the foot, by state: Stop while it runs; Continue (and Stop) when it needs the person; once it
 *  ended, what can be done with its work, which the work's own read says. */
export function footActs(
  job: Pick<JobPage, 'state' | 'needs' | 'more'>,
): { what: 'continue' | 'stop'; words: string }[] {
  return jobActions(job).map((what) => ({
    what,
    words: what === 'continue' ? continueWords(job) : 'Stop',
  }));
}

/** What a destructive press loses, said once before it is done. */
export function stopLoses(job: Pick<JobPage, 'turns' | 'branch'>): string {
  const now = job.turns.find((turn) => turn.state === 'working');
  const who = now
    ? `${providerName(now.provider)}'s ${now.role === 'reviewer' ? 'review' : 'turn'} in progress is cut off`
    : 'The job ends here';
  return `${who}, and the job cannot be continued.${job.branch ? ` What was written stays on ${job.branch}.` : ''}`;
}
export function discardLoses(branch: string | undefined, files: number): string {
  return `Deletes ${branch ? `branch ${branch}` : 'its branch'}${files ? ` and its ${files} changed ${files === 1 ? 'file' : 'files'}` : ''}.`;
}

/** The workflow the job runs, as its definition says it: where it starts, its states, which of them end it, and its
 *  roles in the order they are cast. The rounds and the rail read their shape from here, never from one recipe. */
export interface Flow {
  initial: string;
  states: string[];
  terminal: string[];
  roles: string[];
  /** What each role does: "writing". The rounds' columns are named from it. */
  doing?: Record<string, string>;
}

/** The review loop's shape, for a desk that sends no flow of its own. */
const REVIEW_FLOW: Flow = {
  initial: 'writing',
  states: ['writing', 'reviewing', 'done', 'abandoned'],
  terminal: ['done', 'abandoned'],
  roles: ['author', 'reviewer'],
  doing: { author: 'writing', reviewer: 'reviewing' },
};

/** A state's name as one short verb: "writing" → "Write", "reviewing" → "Review", "planning" → "Plan", "testing" →
 *  "Test". A name that is not "-ing", or whose stem cannot be told for sure, is said as it is: "Deciding", "Qa". */
export function stateWord(state: string): string {
  const cap = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : word);
  const name = state.replace(/[_-]+/g, ' ').trim();
  if (!/^[a-z]+ing$/i.test(name) || name.length < 6) return cap(name);
  const stem = name.slice(0, -3).toLowerCase();
  // Planning, running, shipping: the doubled last letter was added for "-ing".
  if (/([b-df-hj-np-tv-z])\1$/.test(stem) && !/(ll|ss|ff|zz)$/.test(stem))
    return cap(stem.slice(0, -1));
  // Approving, merging, triaging, forcing: an English verb does not end so; its "e" was dropped for "-ing".
  if (/v$|[a-z][gc]$/.test(stem) && !/ng$/.test(stem)) return cap(`${stem}e`);
  // Writing, coding, making: one short syllable, a single vowel between consonants, had a silent "e".
  if (/^[^aeiou]+[aeiou][^aeiouwxy]$/.test(stem) && stem.length <= 4) return cap(`${stem}e`);
  // Reviewing, testing, building, reading, editing: the stem stands as it is, where it ends as verbs commonly do.
  if (/([aeiou]{2}[^aeiou]|[^aeiou]{2}|ew|ow|ay|ey)$/.test(stem) || /^[aeiou]/.test(stem))
    return cap(stem);
  return cap(name);
}

/** A role as the one who does its work: "writing" → "writer", "reviewing" → "reviewer", "planning" → "planner". Read
 *  from what the flow says the role does; a role whose work cannot be said so is named as it is. */
export function roleWord(role: string, flow: Flow = REVIEW_FLOW): string {
  const doing = flow.doing?.[role];
  const verb = doing ? stateWord(doing).toLowerCase() : '';
  if (!verb || / /.test(verb) || /ing$/.test(verb)) return role.replace(/[_-]+/g, ' ');
  if (verb.endsWith('e')) return `${verb}r`;
  if (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(verb)) return `${verb}${verb.at(-1)}er`;
  return `${verb}er`;
}

export interface RoundMark {
  at: number;
  label: string;
  short: string;
}
/** The rail's marks: one per round, where that round begins, "Round 1" … "Round 13". `at` is the chapter it stands
 *  on. A round is what the job's history counts as one, from the flow's own start; the end is no round. */
export function roundStarts(chapters: Chapter[]): RoundMark[] {
  const out: RoundMark[] = [];
  chapters.forEach((chapter, at) => {
    if (chapter.end || out.some((mark) => mark.label === `Round ${chapter.round}`)) return;
    out.push({ at, label: `Round ${chapter.round}`, short: String(chapter.round) });
  });
  return out;
}

/** The rounds at a glance: one line per round, round 1 first, and in it each member's turn in the column of its role,
 *  in the order the flow casts its roles. A role met that the flow does not name takes the next column. */
interface RoundRow {
  round: number;
  cells: (PageTurn | undefined)[];
}
export function roundRows(
  turns: PageTurn[],
  flow: Flow = REVIEW_FLOW,
): { columns: string[]; rows: RoundRow[] } {
  const column = (turn: PageTurn) => (turn.step === 'shipping' ? 'shipping' : turn.role);
  const columns = [...flow.roles];
  for (const turn of [...turns].sort((a, b) => a.n - b.n))
    if (!columns.includes(column(turn))) columns.push(column(turn));
  const used = columns.filter((role) => turns.some((turn) => column(turn) === role));
  const by = new Map<number, RoundRow>();
  for (const turn of [...turns].sort((a, b) => a.n - b.n)) {
    const row = by.get(turn.round) ?? { round: turn.round, cells: used.map(() => undefined) };
    // A member given the same round again (its turn was cut off and restarted) shows its newest attempt.
    row.cells[used.indexOf(column(turn))] = turn;
    by.set(turn.round, row);
  }
  return { columns: used, rows: [...by.values()].sort((a, b) => a.round - b.round) };
}
/** A turn's words in its round's line, without the agent's name, which its mark says: "wrote · 6 files",
 *  "reviewed · needs changes", "reviewing". `did` is the verb, which a narrow page leaves out when more follows. */
export function cellWords(turn: Pick<PageTurn, 'words' | 'provider' | 'ms'>): {
  did: string;
  rest: string;
  took: string;
} {
  const name = providerName(turn.provider);
  const words = turn.words
    .replace(/…$/, '')
    .replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '');
  const [did = '', ...rest] = words.split(' · ');
  return { did, rest: rest.join(' · '), took: minutes(turn.ms) };
}

/** What the job made, in one line before its files are shown: "38 files · +1,240 −310 · by 2 members"; one member
 *  is named: "by Claude Code". */
export function madeLine(files: Artifact[]): {
  files: string;
  added: string;
  removed: string;
  by: string;
} {
  const count = (n: number) => n.toLocaleString('en-US');
  const added = files.reduce((sum, file) => sum + file.added, 0),
    removed = files.reduce((sum, file) => sum + file.removed, 0);
  const who = new Map(files.map((file) => [`${file.role}:${file.provider}`, file]));
  const by =
    who.size === 1
      ? `by ${providerName([...who.values()][0]!.provider)}`
      : `by ${who.size} members`;
  return {
    files: `${count(files.length)} ${files.length === 1 ? 'file' : 'files'}`,
    added: `+${count(added)}`,
    removed: `−${count(removed)}`,
    by,
  };
}

/** A member's run in the thread, read for its final message: the last thing it said, which is what it handed on (the
 *  writer's report to the reviewer, the reviewer's verdict back). Everything before it is its work, folded under
 *  "show work". A run that has said nothing final yet has only work. */
export function finalOf<B extends { type: string }>(blocks: B[]): { final?: B; work: B[] } {
  const at = blocks.findLastIndex((block) => block.type === 'assistant');
  if (at < 0) return { work: blocks };
  return { final: blocks[at], work: blocks.filter((_, index) => index !== at) };
}
