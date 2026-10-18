import {
  plainLine,
  shellLine,
  statusLine,
  toolFailure,
  toolLine,
} from '@merv/sessions/agent-stream';
import type { AgentBlock } from './agent-stream';

/**
 * A record's trajectory: every session that worked it, on every stage of its workflow, read
 * as moments on one time axis. Sessions says what each block is (`@merv/sessions/agent-stream`);
 * this folds the blocks into moments of a few kinds, lays the sessions on an axis that
 * compresses the waits between them, and counts what was done in any part of it. The view
 * draws; nothing here knows React.
 */

/** The few kinds a moment can be, each one colour; errors are a mark on top, not a kind. */
export type Kind = 'say' | 'think' | 'search' | 'read' | 'edit' | 'run' | 'job' | 'merv';
export const KINDS: readonly Kind[] = [
  'say',
  'think',
  'search',
  'read',
  'edit',
  'run',
  'job',
  'merv',
];
const WORDS: Record<Kind, [string, string]> = {
  say: ['message', 'messages'],
  think: ['thought', 'thoughts'],
  search: ['web search', 'web searches'],
  read: ['read', 'reads'],
  edit: ['edit', 'edits'],
  run: ['command', 'commands'],
  job: ['job', 'jobs'],
  merv: ['Merv call', 'Merv calls'],
};

export interface Moment {
  key: string;
  sessionId: string;
  kind: Kind;
  at: number;
  until: number;
  /** `Ran shell`, `experiment · attach`, `Thought`. */
  label: string;
  /** What it was about, short and without ids. */
  summary: string;
  /** Why it failed, where it did. */
  failed?: string;
  /** What it was on, which repeats across moments: a file, a query, a command's name, a tool. */
  topic?: string;
  /** Placed by its order in the visit: its transcript kept no time for it. */
  ordered?: true;
  block: AgentBlock;
}

/** One session's lane: when it ran, for whom, and its moments. */
export interface Lane {
  sessionId: string;
  threadId: string;
  role: string;
  stage: string;
  harness?: string;
  start: number;
  end: number;
  live: boolean;
  /** It ended before its agent ran. */
  failed: boolean;
  moments: Moment[];
}

const READS = new Set(['Read file', 'Searched code', 'Found files', 'Listed files']);
const EDITS = new Set(['Wrote file', 'Edited file', 'Edited files', 'Edited notebook']);
/** A run submitted to a sandbox is a job; polling or reading one is a Merv call. */
const JOB = /(^|[._-])(runs?|submit|launch|start|exec|command)(?![a-z])/;
/** A tool's kind from the words Sessions gives it, and a Merv tool's from its name. */
export function kindOf(name: string | undefined, label: string): Kind {
  if (label === 'Searched web' || label === 'Fetched page') return 'search';
  // Merv's own web tools (`web.search`, `web.fetch`) are searches, not Merv calls.
  if (/^web\.(search|fetch)$/.test(name ?? '')) return 'search';
  if (READS.has(label)) return 'read';
  if (EDITS.has(label)) return 'edit';
  if (label === 'Ran shell' || label === 'Ran subagent') return 'run';
  if (label === 'Updated plan') return 'think';
  const tool = name ?? '';
  // A command on a sandbox is a command; a run submitted to one is a job.
  if (tool === 'sandbox.terminal') return 'run';
  return /^sandbox(es)?\./.test(tool) && JOB.test(tool.slice(tool.indexOf('.'))) ? 'job' : 'merv';
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const fieldsOf = (input: string | undefined): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(input ?? '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
/** The program a shell line runs: past `sudo`, `env` and assignments, by its base name. */
export function programOf(command: string): string {
  const words = shellLine(command).split(/\s+/);
  const program = words.find(
    (word) =>
      word && !/^[A-Z_][A-Z0-9_]*=/i.test(word) && !/^(sudo|env|time|nohup|exec)$/.test(word),
  );
  return basename(program ?? '').replace(/^\.\//, '');
}
function topicOf(
  kind: Kind,
  name: string | undefined,
  input: string | undefined,
): string | undefined {
  const fields = fieldsOf(input);
  if (kind === 'search') return str(fields.query ?? fields.url ?? fields.q) || undefined;
  if (kind === 'read' || kind === 'edit')
    return (
      basename(str(fields.file_path ?? fields.path ?? fields.pattern ?? fields.url)) || undefined
    );
  if (kind === 'run') {
    const command = fields.command ?? fields.cmd;
    const script = Array.isArray(command) ? command.map(String).join(' ') : str(command ?? input);
    return programOf(script) || undefined;
  }
  return name;
}

/**
 * A session's blocks as its moments; a call still open on a live visit runs to `now`. A stored
 * transcript carries no times of its own, so its events all bear one stamp: given the visit's
 * span, such moments are placed along it by their order instead, and say so (`ordered`).
 */
export function momentsOf(
  sessionId: string,
  blocks: readonly AgentBlock[],
  now: number,
  span?: { start: number; end: number },
): Moment[] {
  const moments: Moment[] = [];
  for (const block of blocks) {
    const at = Date.parse(block.at);
    const until = block.kind === 'status' ? at : Math.max(at, Date.parse(block.until) || at);
    const key = `${sessionId}:${block.key}`;
    if (block.kind === 'text') {
      if (!block.text.trim()) continue;
      moments.push({
        key,
        sessionId,
        kind: 'say',
        at,
        until,
        label: 'Said',
        summary: plainLine(block.text.replace(/[*_#`>]+/g, '')),
        block,
      });
    } else if (block.kind === 'thinking')
      moments.push({
        key,
        sessionId,
        kind: 'think',
        at,
        until,
        label: 'Thought',
        summary: plainLine(block.text.replace(/[*_#`]+/g, '')),
        block,
      });
    else if (block.kind === 'status') {
      // The harness's notices ('Error · model metadata not found') are not the agent's doing;
      // a turn that failed is a message it could not make.
      const said = statusLine(block.text);
      const [head = '', ...rest] = said.text.split(' · ');
      if (said.kind !== 'error' || !/^(Turn failed|Failed)$/.test(head)) continue;
      const why = rest.join(' · ') || head;
      moments.push({
        key,
        sessionId,
        kind: 'say',
        at,
        until,
        label: head,
        summary: why,
        failed: why,
        block,
      });
    } else {
      const { label, summary } = toolLine(block.name, block.input);
      const kind = kindOf(block.name, label);
      const failed = block.result ? toolFailure(block.result) : undefined;
      moments.push({
        key,
        sessionId,
        kind,
        at,
        until: block.result ? until : now,
        label,
        summary,
        ...(failed !== undefined && { failed }),
        ...(topicOf(kind, block.name, block.input) && {
          topic: topicOf(kind, block.name, block.input),
        }),
        block,
      });
    }
  }
  if (span && moments.length > 1 && new Set(moments.map((moment) => moment.at)).size === 1) {
    const step = Math.max(0, span.end - span.start) / (moments.length + 1);
    moments.forEach((moment, index) => {
      moment.at = moment.until = span.start + step * (index + 1);
      moment.ordered = true;
    });
  }
  return moments;
}

// ─── The axis ──────────────────────────────────────────────────────────────────────────────

/** A wait longer than this between sessions is folded to one break. */
export const GAP_MS = 2 * 60_000;
export const BREAK_PX = 22;
interface Segment {
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}
export interface Axis {
  width: number;
  segments: Segment[];
  /** Each fold: where it stands and how long the wait it hides was. */
  breaks: { x: number; ms: number }[];
  ticks: { x: number; label: string }[];
  x(t: number): number;
  /** The moment under a pixel; one in a fold is the fold's nearer edge. */
  t(x: number): number;
}
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440].map((minutes) => minutes * 60_000);
const clockOf = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Time across `width` pixels: the spans when a session ran share the width by their length,
 * and a wait between them longer than GAP_MS is one BREAK_PX fold. Ticks fall on round clock
 * times at least 64 px apart.
 */
export function axisOf(spans: readonly { start: number; end: number }[], width: number): Axis {
  const sorted = spans
    .map(({ start, end }) => ({ t0: start, t1: Math.max(end, start + 1000) }))
    .sort((a, b) => a.t0 - b.t0);
  const merged: { t0: number; t1: number }[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.t0 - last.t1 <= GAP_MS) last.t1 = Math.max(last.t1, span.t1);
    else merged.push({ ...span });
  }
  const folds = Math.max(0, merged.length - 1);
  const active = merged.reduce((sum, span) => sum + (span.t1 - span.t0), 0) || 1;
  const scale = Math.max(0, width - folds * BREAK_PX) / active;
  const segments: Segment[] = [];
  const breaks: Axis['breaks'] = [];
  let x = 0;
  for (const [index, span] of merged.entries()) {
    if (index) {
      breaks.push({ x: x + BREAK_PX / 2, ms: span.t0 - merged[index - 1]!.t1 });
      x += BREAK_PX;
    }
    const x1 = x + (span.t1 - span.t0) * scale;
    segments.push({ t0: span.t0, t1: span.t1, x0: x, x1 });
    x = x1;
  }
  const at = (t: number) => {
    for (const [index, segment] of segments.entries()) {
      if (t <= segment.t1 || index === segments.length - 1)
        return segment.x0 + (Math.min(Math.max(t, segment.t0), segment.t1) - segment.t0) * scale;
      const next = segments[index + 1]!;
      if (t < next.t0) return segment.x1 + BREAK_PX / 2;
    }
    return 0;
  };
  const t = (px: number) => {
    const segment = segments.find((item) => px <= item.x1) ??
      segments.at(-1) ?? { t0: 0, x0: 0, x1: 0 };
    return (
      segment.t0 + (Math.min(Math.max(px, segment.x0), segment.x1) - segment.x0) / (scale || 1)
    );
  };
  const ticks: Axis['ticks'] = [];
  for (const segment of segments) {
    const step = STEPS.find((candidate) => candidate * scale >= 64) ?? STEPS.at(-1)!;
    for (let time = Math.ceil(segment.t0 / step) * step; time <= segment.t1; time += step)
      if ((time - segment.t0) * scale >= 24 && (segment.t1 - time) * scale >= 24)
        ticks.push({ x: at(time), label: clockOf(time) });
  }
  return { width, segments, breaks, ticks, x: at, t };
}

// ─── Stages and lanes ──────────────────────────────────────────────────────────────────────

/** One stretch of a stage: the sessions that ran on it before the record moved on. */
export interface StageSpan {
  state: string;
  start: number;
  end: number;
  lanes: Lane[];
}
/** Lanes in time order, each run of one stage its own span, so a loop shows as a return. */
export function stageSpans(lanes: readonly Lane[]): StageSpan[] {
  const spans: StageSpan[] = [];
  for (const lane of [...lanes].sort((a, b) => a.start - b.start)) {
    const last = spans.at(-1);
    if (last && last.state === lane.stage) {
      last.lanes.push(lane);
      last.end = Math.max(last.end, lane.end);
    } else spans.push({ state: lane.stage, start: lane.start, end: lane.end, lanes: [lane] });
  }
  return spans;
}

// ─── What was done ─────────────────────────────────────────────────────────────────────────

export interface Tally {
  kind: Kind;
  count: number;
  failed: number;
  /** The topics most returned to, most first, with how often. */
  topics: [string, number][];
  /** For reads and edits, how many distinct files. */
  files?: number;
}
const STOP = new Set(
  'the a an of in on for to and or with from by at is are was were be how what why which does do vs versus into over under between about using use used via paper papers results effect effects'.split(
    ' ',
  ),
);
/** The words a run of searches kept coming back to. */
export function keywords(queries: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const query of queries)
    for (const word of new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9+#-]+/)
        .filter((word) => word.length >= 3 && !STOP.has(word) && !/^\d+$/.test(word)),
    ))
      counts.set(word, (counts.get(word) ?? 0) + 1);
  return top(counts);
}
const top = (counts: Map<string, number>, n = 3): [string, number][] =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

/** What these moments come to, one tally a kind, in KINDS order, kinds with nothing left out. */
export function tally(moments: readonly Moment[]): Tally[] {
  const tallies: Tally[] = [];
  for (const kind of KINDS) {
    const here = moments.filter((moment) => moment.kind === kind);
    if (!here.length) continue;
    const topics = here.map((moment) => moment.topic).filter((topic): topic is string => !!topic);
    const counts = new Map<string, number>();
    // A Merv tool counts under its family: `experiment.attach` is one more on `experiment`.
    for (const topic of topics) {
      const name = kind === 'merv' ? topic.split(/[.·]/)[0]!.trim() : topic;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    tallies.push({
      kind,
      count: here.length,
      failed: here.filter((moment) => moment.failed !== undefined).length,
      topics: kind === 'search' ? keywords(topics) : top(counts),
      ...((kind === 'read' || kind === 'edit') && { files: new Set(topics).size }),
    });
  }
  return tallies;
}

/** A tally as its chip reads: `14 web searches · grokking, decay`, `6 jobs · 1 failed`. */
export function chipText(item: Tally): string {
  const [one, many] = WORDS[item.kind];
  const parts = [`${item.count} ${item.count === 1 ? one : many}`];
  if (item.files !== undefined && item.files > 1 && item.files < item.count)
    parts.push(`${item.files} files`);
  else if (item.topics.length && item.kind !== 'say' && item.kind !== 'think')
    parts.push(item.topics.map(([topic]) => topic).join(', '));
  if (item.failed) parts.push(`${item.failed} failed`);
  return parts.join(' · ');
}

/** The part of the trajectory in hand: everything, a brushed stretch of time, a session or a stage. */
export type Selection =
  { range: [number, number] } | { session: string } | { stage: number } | undefined;
export function selected(
  moment: Moment,
  selection: Selection,
  spans: readonly StageSpan[],
): boolean {
  if (!selection) return true;
  if ('range' in selection)
    return moment.at <= selection.range[1] && moment.until >= selection.range[0];
  if ('session' in selection) return moment.sessionId === selection.session;
  return !!spans[selection.stage]?.lanes.some((lane) => lane.sessionId === moment.sessionId);
}
