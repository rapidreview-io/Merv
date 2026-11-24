/**
 * Merv's one thread, as rows to draw. The person reads one conversation across every project: what they said and what
 * Merv said, each worker starting and finishing, each job as one line, each question that waits on them, each stop.
 * All of it is read from the stream, the person's ordered log (`streamEvent`), and nothing here asks anyone anything:
 * the same events always make the same rows.
 *
 * What is folded, and where:
 * - a worker's steps are not lines: the first makes its "started" line, the rest are its progress while it works;
 * - a job's members (their quiet finishes, their steps) are inside the job's one line;
 * - a turn that carries on an earlier one (it paused on work in the background) stands where the first one stood;
 * - an answer and a manager's note stand under what they are about;
 * - which project a line is from is said once, where it changes, never on every line;
 * - a stop is a line only when someone asked for it; the app or desk quitting under its sessions is nothing.
 * What is live (who works, who waits for the person) comes from the projects' cards and stands over the reply box.
 */
import type { DoneCard, ProjectCard, StreamEvent } from '@merv/protocol/link';

export type Provider = 'claude' | 'codex';
export type Outcome = 'finished' | 'failed' | 'stopped';
export interface Who {
  kind: StreamEvent['from']['kind'];
  id: string;
  title: string;
  provider?: Provider;
}
/** A project's card as hosted hands it over: with its Mac's name. */
export type ThreadCard = ProjectCard & { label?: string };
/** A line of Merv's own conversation as this page has it, whole: a `said` event is cut at 400 characters, this is not. */
export interface LocalLine {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Where Merv's conversation keeps it, as a `said` event's ref names it: the turn, and for Merv's words their place in it. */
  command?: string;
  message?: number;
}
export interface ThreadStep {
  seq: number;
  at: string;
  text: string;
}
export interface ThreadNote {
  seq: number;
  at: string;
  text: string;
  /** It changes what the work it is about means. */ matters: boolean;
}
interface ThreadAnswer {
  seq: number;
  at: string;
  text: string;
}
/** A member's turn inside a job: which round, who, and the card its turn left. */
export interface ThreadMember {
  seq: number;
  at: string;
  who: Who;
  round: number;
  role: string;
  outcome: Outcome;
  card: DoneCard;
  device?: string;
}
export type Ask = NonNullable<StreamEvent['ask']>;

interface Base {
  key: string;
  at: string;
  seq?: number;
  project?: string;
  device?: string;
}
type SaidRow = Base & {
  type: 'said';
  role: 'user' | 'assistant';
  text: string;
  cut: boolean;
  /** The turn of Merv's conversation it belongs to, where that is known: its steps stand with it. */
  command?: string;
};
export type StartedRow = Base & {
  type: 'started';
  who: Who;
  steps: ThreadStep[];
  /** Nothing after it says the worker ended. */ live: boolean;
};
export type DoneRow = Base & {
  type: 'done';
  who: Who;
  outcome: Outcome;
  card: DoneCard;
  /** Ended while work it started still runs: it is still at it. */ paused: boolean;
  notes: ThreadNote[];
};
export type JobRow = Base & {
  type: 'job';
  job: string;
  title: string;
  end?: { state: 'done' | 'stopped'; words: string; card: DoneCard };
  members: ThreadMember[];
  notes: ThreadNote[];
  steps: ThreadStep[];
};
export type QuestionRow = Base & {
  type: 'question';
  who: Who;
  text: string;
  ask?: Ask;
  /** Still open on its Mac, as its project's card says. */ waiting: boolean;
  answers: ThreadAnswer[];
  notes: ThreadNote[];
  request?: string;
};
export type StopRow = Base & { type: 'stop'; who: Who; text: string };
type NoteRow = Base & { type: 'note'; who: Who; text: string; matters: boolean };
type AnswerRow = Base & { type: 'answer'; text: string };
type DayRow = Base & { type: 'day' };
/** Which project the rows under it are from: said once where it changes, and only in a thread of more than one. */
export type ProjectRow = Base & { type: 'project'; project: string };
export type ThreadRow =
  | SaidRow
  | StartedRow
  | DoneRow
  | JobRow
  | QuestionRow
  | StopRow
  | NoteRow
  | AnswerRow
  | DayRow
  | ProjectRow;

/** One line of what is live: a worker or a job at work, or one that waits for the person. */
export interface NowLine {
  key: string;
  project: string;
  device: string;
  manager: string;
  kind: 'worker' | 'reviewer' | 'job';
  id: string;
  title: string;
  provider?: Provider;
  needs: boolean;
  since: string;
  /** How it stands, in words: "working", "job · reviewing", "needs you". */ words: string;
  /** A worker: its steps since it started, oldest first, the newest last. */
  steps: ThreadStep[];
  /** A job: its members' turns so far. */
  members: ThreadMember[];
  /** What it asks, when it waits for the person. */
  question?: QuestionRow;
  /** Its Mac has been away: this is how it last stood. */
  stale: boolean;
}

export interface OneThread {
  rows: ThreadRow[];
  now: NowLine[];
  /** Every project named here: with more than one, each line says which. */ projects: string[];
}

const who = (event: StreamEvent): Who => ({
  kind: event.from.kind,
  id: event.from.id,
  title: event.from.title ?? '',
  ...(event.from.provider && { provider: event.from.provider }),
});
const base = (event: StreamEvent): Base & { seq: number } => ({
  key: `s${event.seq}`,
  at: event.at,
  seq: event.seq,
  project: event.project,
  ...(event.device && { device: event.device }),
});
const outcomeOf = (event: StreamEvent): Outcome =>
  event.outcome ?? event.card?.outcome ?? 'finished';
const flat = (text: string) => text.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** A `said` event and a line this page has are the same words when one begins as the other does, about when it was said. */
const SAME_WITHIN = 15 * 60_000;
const alike = (one: string, other: string) => {
  const a = flat(one).slice(0, 80),
    b = flat(other).slice(0, 80);
  return !!a && !!b && (a.startsWith(b) || b.startsWith(a));
};
const sameWords = (line: LocalLine, role: SaidRow['role'], event: StreamEvent) => {
  if (line.role !== role) return false;
  // Named by the event itself: the same turn, and the same place in it or the same words.
  const ref = event.ref as { command?: string; message?: number } | undefined;
  if (ref?.command && line.command)
    return (
      ref.command === line.command &&
      (ref.message === undefined ||
        line.message === undefined ||
        ref.message === line.message ||
        alike(line.text, event.text))
    );
  return (
    Math.abs(Date.parse(line.at) - Date.parse(event.at)) <= SAME_WITHIN &&
    alike(line.text, event.text)
  );
};
const dayOf = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** The stream's events, the projects' cards and this page's own lines with Merv, as the one thread. */
export function oneThread(
  events: StreamEvent[],
  cards: ThreadCard[] = [],
  local: LocalLine[] = [],
): OneThread {
  const ordered = [...new Map(events.map((event) => [event.seq, event])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
  // Who is a member of which job: said by the members' own finishes.
  const jobOf = new Map<string, string>();
  for (const event of ordered)
    if (event.type === 'done' && event.card?.job?.id && event.card.agent)
      jobOf.set(event.card.agent, event.card.job.id);
  const flying = new Map(
    cards.flatMap((card) => card.inFlight.map((item) => [item.id, { card, item }] as const)),
  );
  const open = new Set(
    cards.flatMap((card) =>
      card.waitingOnYou.flatMap((item) => [
        item.id,
        ...(item.seq !== undefined ? [`seq:${item.seq}`] : []),
        ...(item.local ? [item.local] : []),
      ]),
    ),
  );

  const rows: ThreadRow[] = [];
  const bySeq = new Map<number, DoneRow | JobRow | QuestionRow>();
  const runs = new Map<string, StartedRow>(),
    jobs = new Map<string, JobRow>(),
    completions = new Map<string, DoneRow>();
  const lines = [...local],
    used = new Set<string>();
  const job = (id: string, event: StreamEvent) => {
    let row = jobs.get(id);
    if (!row) {
      row = {
        ...base(event),
        key: `j${id}`,
        type: 'job',
        job: id,
        title: '',
        members: [],
        notes: [],
        steps: [],
      };
      jobs.set(id, row);
      rows.push(row);
    }
    return row;
  };
  const noted = (event: StreamEvent) =>
    typeof event.about === 'number' ? bySeq.get(event.about) : undefined;

  for (const event of ordered) {
    const from = who(event),
      session = event.ref?.session ?? event.ref?.agent ?? from.id;
    if (event.type === 'said') {
      const role = from.kind === 'person' ? ('user' as const) : ('assistant' as const);
      const whole = lines.find((line) => !used.has(line.key) && sameWords(line, role, event));
      if (whole) used.add(whole.key);
      const command = whole?.command ?? (event.ref as { command?: string } | undefined)?.command;
      rows.push({
        ...base(event),
        type: 'said',
        role,
        text: whole?.text ?? event.text,
        cut: !whole && /…$/.test(event.text),
        ...(command && { command }),
      });
    } else if (event.type === 'step') {
      const step = { seq: event.seq, at: event.at, text: event.text };
      const inJob = jobOf.get(from.id);
      if (inJob) {
        job(inJob, event).steps.push(step);
        continue;
      }
      let run = runs.get(from.id);
      if (!run) {
        run = { ...base(event), type: 'started', who: from, steps: [], live: true };
        runs.set(from.id, run);
        rows.push(run);
      }
      run.steps.push(step);
      if (from.title) run.who = from;
    } else if (event.type === 'done') {
      const card = event.card ?? { title: from.title };
      if (from.kind === 'job' || typeof card.jobEnded === 'string') {
        // A job's end: its one line stands here, where it ended.
        const row = job(card.jobEnded ?? from.id, event);
        rows.splice(rows.indexOf(row), 1);
        rows.push(row);
        Object.assign(row, {
          at: event.at,
          seq: event.seq,
          title: card.title || from.title,
          end: {
            state:
              card.state === 'stopped' || outcomeOf(event) === 'stopped'
                ? ('stopped' as const)
                : ('done' as const),
            words: card.words ?? '',
            card,
          },
        });
        bySeq.set(event.seq, row);
      } else if (card.job?.id) {
        const row = job(card.job.id, event);
        row.members.push({
          seq: event.seq,
          at: event.at,
          who: from,
          round: card.job.round,
          role: card.job.role,
          outcome: outcomeOf(event),
          card,
          ...(event.device && { device: event.device }),
        });
        if (!row.end) Object.assign(row, { at: event.at, seq: event.seq });
        // A job is named for its writer's task: a reviewer's title is "Review of …".
        if (!row.title && card.job.role !== 'reviewer') row.title = card.title;
        bySeq.set(event.seq, row);
      } else if (outcomeOf(event) === 'stopped') {
        // A stop is a line only when the person asked for it, saying who stopped what. Merv's own stop is its `stop`
        // event; one nobody asked for (the app or desk quit or restarted, a session lost) is nothing, however many.
        const run = runs.get(session) ?? runs.get(from.id);
        if (run) {
          run.live = false;
          runs.delete(run.who.id);
        }
        if (card.stoppedBy === 'person')
          rows.push({
            ...base(event),
            type: 'stop',
            who: from,
            text: `You stopped ${from.title || card.title || 'a session'}`,
          });
      } else {
        const paused = card.paused === true && outcomeOf(event) === 'finished';
        const before = card.continues ? completions.get(card.continues) : undefined;
        // It carries on a turn shown here: it is shown in that one's place, as it stands now.
        const row: DoneRow = before ?? {
          ...base(event),
          type: 'done',
          who: from,
          outcome: 'finished',
          card,
          paused,
          notes: [],
        };
        if (before) Object.assign(row, { at: event.at, seq: event.seq });
        else rows.push(row);
        Object.assign(row, { who: from, outcome: outcomeOf(event), card, paused });
        if (card.completion) completions.set(card.completion, row);
        bySeq.set(event.seq, row);
        const run = runs.get(session) ?? runs.get(from.id);
        if (run && !paused) {
          run.live = false;
          runs.delete(run.who.id);
        }
      }
    } else if (event.type === 'question') {
      const request = event.ref?.request;
      const row: QuestionRow = {
        ...base(event),
        type: 'question',
        who: from,
        text: event.text,
        ...(event.ask && { ask: event.ask }),
        waiting:
          open.has(`seq:${event.seq}`) || open.has(event.local) || (!!request && open.has(request)),
        answers: [],
        notes: [],
        ...(request && { request }),
      };
      rows.push(row);
      bySeq.set(event.seq, row);
    } else if (event.type === 'answer') {
      const about = noted(event);
      if (about?.type === 'question') {
        about.answers.push({ seq: event.seq, at: event.at, text: event.text });
        about.waiting = false;
      } else rows.push({ ...base(event), type: 'answer', text: event.text });
    } else if (event.type === 'note') {
      const about = noted(event),
        matters = event.changesStory === true;
      if (about) about.notes.push({ seq: event.seq, at: event.at, text: event.text, matters });
      else rows.push({ ...base(event), type: 'note', who: from, text: event.text, matters });
    } else if (event.type === 'stop') {
      rows.push({ ...base(event), type: 'stop', who: from, text: event.text });
      const run = runs.get(session) ?? runs.get(from.id);
      if (run) {
        run.live = false;
        runs.delete(run.who.id);
      }
    }
  }

  // A job still under way stands with what is live, not in the conversation; one whose members are all that is known of it stays where its newest turn is.
  const liveJobs = new Set(
    [...jobs.values()].filter((row) => !row.end && flying.has(row.job)).map((row) => row.job),
  );
  for (const row of jobs.values()) {
    if (row.end || liveJobs.has(row.job)) continue;
    rows.splice(rows.indexOf(row), 1);
    const after = rows.findIndex((other) => other.seq !== undefined && other.seq > row.seq!);
    rows.splice(after < 0 ? rows.length : after, 0, row);
  }
  let shown = rows.filter((row) => row.type !== 'job' || !liveJobs.has(row.job));

  // This page's own lines with Merv that the stream has not said: each where its time puts it.
  for (const line of lines) {
    if (used.has(line.key)) continue;
    const row: SaidRow = {
      key: `l:${line.key}`,
      at: line.at,
      type: 'said',
      role: line.role,
      text: line.text,
      cut: false,
      ...(line.command && { command: line.command }),
    };
    const time = Date.parse(line.at);
    let at = shown.length;
    while (at > 0 && Date.parse(shown[at - 1]!.at) > time) at--;
    shown.splice(at, 0, row);
  }

  const projects = [
    ...new Set(
      [...ordered.map((event) => event.project), ...cards.map((card) => card.project)].filter(
        (project) => project && project !== 'unknown',
      ),
    ),
  ];
  // A quiet word where the day changes, and, in a thread of several projects, where the project does.
  const dated: ThreadRow[] = [];
  let day = '',
    project = '';
  for (const row of shown) {
    const next = dayOf(row.at);
    if (next && next !== day) {
      day = next;
      dated.push({ key: `d${next}`, at: row.at, type: 'day' });
    }
    if (
      projects.length > 1 &&
      row.project &&
      row.project !== 'unknown' &&
      row.project !== project
    ) {
      project = row.project;
      dated.push({ key: `p${row.key}`, at: row.at, type: 'project', project });
    }
    dated.push(row);
  }

  // What is live, by the cards: what waits for the person leads, then who works, newest first as each card has them.
  const questions = shown.filter(
    (row): row is QuestionRow => row.type === 'question' && row.waiting,
  );
  const now: NowLine[] = cards.flatMap((card) =>
    card.inFlight.map((item): NowLine => {
      const needs = item.state === 'needs you';
      const run = [...runs.values()].find((row) => row.who.id === item.id);
      const waits = card.waitingOnYou.filter((asked) => asked.from === item.id);
      return {
        key: `${card.device}:${item.id}`,
        project: card.project,
        device: card.device,
        manager: card.manager.thread,
        kind: item.kind,
        id: item.id,
        title: item.title,
        ...(item.provider && { provider: item.provider }),
        needs,
        since: item.since,
        words:
          item.kind === 'job'
            ? `job · ${item.words ?? item.state}`
            : needs
              ? 'needs you'
              : 'working',
        steps: [
          ...(run?.steps ?? []),
          ...(item.lastStep && run?.steps.at(-1)?.text !== item.lastStep
            ? [{ seq: 0, at: card.updatedAt, text: item.lastStep }]
            : []),
        ],
        members: jobs.get(item.id)?.members ?? [],
        ...(needs && {
          question:
            questions.findLast((row) =>
              waits.some((asked) => asked.id === row.request || asked.seq === row.seq),
            ) ?? questions.findLast((row) => row.who.id === item.id),
        }),
        stale: card.stale === true,
      };
    }),
  );
  // A project with something waiting for the person leads; within a project, what waits leads.
  const waitsIn = (name: string) => now.some((line) => line.project === name && line.needs);
  const order = [...new Set(now.map((line) => line.project))].sort(
    (a, b) => Number(waitsIn(b)) - Number(waitsIn(a)),
  );
  now.sort(
    (a, b) =>
      order.indexOf(a.project) - order.indexOf(b.project) || Number(b.needs) - Number(a.needs),
  );
  return { rows: dated, now, projects };
}

/** A day as the thread names it: today, yesterday, else the date. */
export function dayWords(at: string, now = Date.now()): string {
  const date = new Date(at),
    today = new Date(now);
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== today.getFullYear() && { year: 'numeric' }),
  });
}

/** A member's turn in a job as one line says it: "Round 2 · Codex reviewed · needs changes". */
export function memberWords(member: ThreadMember): string {
  const name =
    member.who.provider === 'codex'
      ? 'Codex'
      : member.who.provider === 'claude'
        ? 'Claude'
        : 'An agent';
  const review = member.card.review;
  if (member.role === 'reviewer' || review)
    return `${name} reviewed · ${member.outcome !== 'finished' ? member.outcome : review?.changed ? 'changed files' : review?.verdict === 'pass' ? 'passed' : review?.verdict === 'needs changes' ? 'needs changes' : 'no verdict'}`;
  const files = member.card.files ?? member.card.changes?.length ?? 0;
  return `${name} wrote · ${member.outcome !== 'finished' ? member.outcome : files ? `${files} ${files === 1 ? 'file' : 'files'}` : 'no files'}`;
}

/** The events handed to Merv.app with the conversation: the newest, as many as fit in what the app takes at once. */
export function fitEvents<T>(events: T[], most = 80, budget = 240_000): T[] {
  let kept = events.slice(-most);
  while (kept.length > 1 && JSON.stringify(kept).length > budget)
    kept = kept.slice(Math.ceil(kept.length / 8));
  return kept;
}
