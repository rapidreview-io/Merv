import {
  lineKind,
  plainLine,
  statusLine,
  toolFailure,
  toolLine,
} from '@merv/sessions/agent-stream';
import type { AgentBlock } from './agent-stream';

/**
 * A thread's conversation as the page lays it out, from what Sessions says each event is
 * (`lineKind` and its neighbours in `@merv/sessions/agent-stream`): the agent's messages as
 * prose, the steps between two of them as one group, each step one short line, an error a line
 * of its own that stays in sight, the people over the thread where they spoke, and the visits
 * and milestones as dividers. Nothing here decides what an event is; it only orders and groups.
 */

/** One step the agent took between two things it said: a thought, a tool call, an error. */
export interface Step {
  key: string;
  kind: 'thinking' | 'tool' | 'error';
  /** `Ran shell`, `Read file`, `sandboxes · workflow_get`, `Thought`. */
  label: string;
  /** What it was about, or for an error what went wrong; short and without ids. */
  summary: string;
  block: AgentBlock;
  /** Its call is in flight on the live visit. */
  running: boolean;
}

/** A person's line: a message to the thread, its agent's question, or an answer. */
export interface PersonLine {
  key: string;
  at: string;
  /** `You`, the person's name, or `Agent asked`. */
  who: string;
  body: string;
  /** Where it stands: Sent, Read, or where a question to the agent is. */
  note?: string;
  reply?: string;
  /** The agent asked it; `open` while it still waits on an answer. */
  asked?: { open: boolean };
}

/** One visit, as the timeline is handed it: its divider, then its blocks. */
export interface VisitBlocks {
  key: string;
  at: string;
  divider: string;
  tone?: 'error';
  blocks: readonly AgentBlock[];
  live?: boolean;
}

export type Entry =
  | { type: 'divider'; key: string; text: string; tone?: 'error' }
  | { type: 'message'; key: string; block: Extract<AgentBlock, { kind: 'text' }> }
  | { type: 'person'; key: string; line: PersonLine }
  | { type: 'steps'; key: string; steps: Step[]; live: boolean };

/** A block as a step, or what else it is: a message, a divider, or nothing to draw. */
function read(
  block: AgentBlock,
  live: boolean,
):
  | { step: Step }
  | { message: Extract<AgentBlock, { kind: 'text' }> }
  | { divider: string }
  | undefined {
  const kind = lineKind(block);
  if (block.kind === 'text') return block.text.trim() ? { message: block } : undefined;
  if (block.kind === 'status') {
    const said = statusLine(block.text);
    if (said.kind === 'system') return { divider: said.text };
    if (said.kind === 'quiet') return undefined;
    return {
      step: {
        key: block.key,
        kind: 'error',
        label: said.text.split(' · ')[0]!,
        summary: said.text.split(' · ').slice(1).join(' · '),
        block,
        running: false,
      },
    };
  }
  if (block.kind === 'thinking') {
    const first = block.text.trim().split('\n', 1)[0] ?? '';
    return {
      step: {
        key: block.key,
        kind: 'thinking',
        label: block.done || !live ? 'Thought' : 'Thinking',
        summary: plainLine(first.replace(/[*_#`]+/g, '')),
        block,
        running: false,
      },
    };
  }
  const { label, summary } = toolLine(block.name, block.input);
  return {
    step: {
      key: block.key,
      kind: kind === 'error' ? 'error' : 'tool',
      label: kind === 'error' ? `${label} failed` : label,
      summary: kind === 'error' ? toolFailure(block.result!)! : summary,
      block,
      running: live && !block.result,
    },
  };
}

/** Whether these blocks draw anything: a quiet milestone (`Started`) alone draws nothing. */
export const says = (blocks: readonly AgentBlock[], live: boolean): boolean =>
  blocks.some((block) => read(block, live) !== undefined);

/**
 * The timeline: each visit's divider, then what its agent said and did, the people's lines
 * placed among them by when they were said, and every run of steps between two lines that are
 * not steps folded into one group.
 */
export function timeline(visits: readonly VisitBlocks[], people: readonly PersonLine[]): Entry[] {
  const said = [...people].sort((a, b) => a.at.localeCompare(b.at));
  const entries: Entry[] = [];
  let group: Extract<Entry, { type: 'steps' }> | undefined;
  const put = (entry: Entry) => {
    group = undefined;
    entries.push(entry);
  };
  /** The people's lines said before `at`. */
  const before = (at: string) => {
    while (said.length && said[0]!.at <= at) {
      const line = said.shift()!;
      put({ type: 'person', key: `person:${line.key}`, line });
    }
  };
  for (const visit of visits) {
    before(visit.at);
    put({ type: 'divider', key: visit.key, text: visit.divider, tone: visit.tone });
    for (const block of visit.blocks) {
      before(block.at);
      const line = read(block, !!visit.live);
      if (!line) continue;
      if ('message' in line)
        put({ type: 'message', key: `${visit.key}:${block.key}`, block: line.message });
      else if ('divider' in line)
        put({ type: 'divider', key: `${visit.key}:${block.key}`, text: line.divider });
      else if (group) group.steps.push(line.step);
      else {
        group = {
          type: 'steps',
          key: `${visit.key}:${block.key}`,
          steps: [line.step],
          live: !!visit.live,
        };
        entries.push(group);
      }
    }
    group = undefined;
  }
  before('￿');
  return entries;
}

/** One line of a card: what its agent last said or did, as the thread draws it. */
export interface TailLine {
  key: string;
  kind: 'message' | Step['kind'];
  text: string;
}

/**
 * The last `count` lines a card shows of its live agent: each message's last line, each step's
 * label and summary, its thinking left out. No raw ids: every line is Sessions' own reading.
 */
export function tailLines(blocks: readonly AgentBlock[], count = 3): TailLine[] {
  const lines: TailLine[] = [];
  for (const entry of timeline([{ key: 'tail', at: '', divider: '', blocks, live: true }], []))
    if (entry.type === 'message') {
      const last = entry.block.text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (last)
        lines.push({
          key: entry.key,
          kind: 'message',
          text: plainLine(last.replace(/[*_#`>]+/g, ''), 160),
        });
    } else if (entry.type === 'steps')
      for (const step of entry.steps)
        if (step.kind !== 'thinking')
          lines.push({
            key: step.key,
            kind: step.kind,
            text: [step.label, step.summary].filter(Boolean).join(' · '),
          });
  return lines.slice(-count);
}
