import { type EventRow } from './desk-calls';
import { toolKind, type ToolKind } from './marks';
import { OutputBuffer } from '@merv/protocol/output';
import {
  authFailure,
  contextWindow,
  hiddenItem,
  type Provider,
  type RuntimeEvent,
} from '@merv/protocol/runtime';
import type { DiffReference, SessionSource } from '@merv/protocol/diff';

const bodies = new WeakMap<EventRow, any>();
export const bodyOf = (row: EventRow): any => {
  if (!bodies.has(row)) bodies.set(row, JSON.parse(row.body));
  return bodies.get(row);
};
/** Streamed text stays parsed; serialize only if a wire-format caller asks for it. */
export const withBody = (row: EventRow, body: any): EventRow => {
  const next = {
    ...row,
    get body() {
      return JSON.stringify(body);
    },
  };
  bodies.set(next, body);
  return next;
};

export interface Step {
  item: string;
  kind: ToolKind;
  title: string;
  detail?: string;
  deferred?: boolean;
  exitCode?: number;
  done: boolean;
  failed: boolean;
  /** When it began and ended, in milliseconds, where the events say. */
  at?: number;
  ended?: number;
  agent?: { blocks: Block[] };
}
export interface AttachmentInfo {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
}
export type Block =
  | { type: 'provider_switch'; key: string; text: string }
  | {
      type: 'user';
      key: string;
      text: string;
      by?: string;
      turn?: number;
      source?: SessionSource;
      sources?: SessionSource[];
      requestId?: string;
      attachments?: AttachmentInfo[];
      references?: DiffReference[];
    }
  | { type: 'assistant'; key: string; text: string; message?: string }
  | { type: 'trail'; key: string; steps: Step[] }
  | { type: 'error'; key: string; text: string; auth: boolean }
  /** In a project's main thread: a worker's turn ended here, and speaks here: its own closing words and the files it changed. */
  | ({
      type: 'agent';
      key: string;
      agent: string;
      title: string;
      provider: Provider;
      branch?: string;
      turn?: number;
      through?: number;
      outcome: 'finished' | 'failed' | 'stopped';
      /** The record kept when the turn ended; absent in entries an earlier build wrote, which are read from the session as it is now. */
      completion?: string;
      /** The turn was a reviewer's: whose work it judged, and what it concluded. */
      review?: Review;
      /** How many files the turn changed, where that was measured. */
      files?: number;
      /** The turn ended while work it started in the background still ran: the worker is still at it. */
      paused?: true;
      /** When the entry was written, for the time its line shows under the pointer. */
      at?: string;
    } & Spoken)
  /** In a project's main thread: a job ended here, and its writer speaks here. Its rounds open under it, oldest first. */
  | ({
      type: 'job';
      key: string;
      job: string;
      title: string;
      state: 'done' | 'stopped';
      words: string;
      files?: number;
      /** The job's writer, and its last ended turn in the job. */
      author?: { thread: string; provider: Provider; completion?: string };
      at?: string;
    } & Spoken);

/** A changed file as an entry names it: its text is in the completion. */
export interface EntryFile {
  path: string;
  added: number;
  removed: number;
}
/** What an entry carries of its turn so the thread shows it with nothing more to ask for. `worded`: the entry was written
 *  with the words in it. One without, from an earlier build, is read from its completion when it comes into view. */
export interface Spoken {
  worded?: true;
  said?: string;
  cut?: boolean;
  changes?: EntryFile[];
}
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
const spokenOf = (body: any): Spoken =>
  typeof body.cut !== 'boolean'
    ? {}
    : {
        worded: true,
        ...(typeof body.said === 'string' && body.said && { said: body.said }),
        ...(body.cut && { cut: true }),
        ...(Array.isArray(body.changes) && {
          changes: body.changes
            .filter((file: any) => typeof file?.path === 'string')
            .map((file: any) => ({
              path: file.path,
              added: count(file.added),
              removed: count(file.removed),
            })),
        }),
      };

/** A review as its entry keeps it. `changed`: files in the folder changed while it ran, which a review must not do. */
export interface Review {
  of: string;
  title: string;
  verdict: 'pass' | 'needs changes' | 'none';
  changed?: boolean;
}
const reviewOf = (value: any): Review | undefined =>
  value && typeof value.of === 'string' && typeof value.title === 'string'
    ? {
        of: value.of,
        title: value.title,
        verdict:
          value.verdict === 'pass' || value.verdict === 'needs changes' ? value.verdict : 'none',
        ...(value.changed === true && { changed: true }),
      }
    : undefined;

/** One entry per piece of work. A worker's entry that another of its entries carries on (it took itself up again, as when
 *  a background task it started ended) is shown once: as the newest of them says it now, where the first one stood. */
function oneEntryEach(rows: EventRow[]): EventRow[] {
  const next = new Map<string, EventRow>(),
    present = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'agent_done') continue;
    const body = bodyOf(row);
    if (typeof body.completion === 'string') present.add(body.completion);
    if (typeof body.continues === 'string' && body.continues) next.set(body.continues, row);
  }
  if (!next.size) return rows;
  const newest = (row: EventRow) => {
    for (const seen = new Set<EventRow>(); next.has(bodyOf(row).completion) && !seen.has(row);) {
      seen.add(row);
      row = next.get(bodyOf(row).completion)!;
    }
    return row;
  };
  // An entry that carries on one shown here is shown in that one's place; the first of each stands as the newest says it.
  return rows.flatMap((row) =>
    row.type !== 'agent_done' ? [row] : present.has(bodyOf(row).continues) ? [] : [newest(row)],
  );
}

/** One native assistant message, however many times its words were flushed: its item, in its
 *  turn and process, spoken by the main agent or one sub-agent. Without an item it is its own. */
function messageIdentity(body: any): string | undefined {
  if (body?.role !== 'assistant' || typeof body.item !== 'string' || !body.item) return;
  return JSON.stringify([
    body.parent_tool_use_id || '',
    body.item,
    body.turn ?? null,
    body.generation ?? null,
  ]);
}

/** Events in order become blocks: what was said, and runs of tool calls as one trail each.
 *  The store keeps a message as fragments, flushed whenever anything else happened; they are
 *  joined where its first words stand, whatever came between, and never with another message. */
export function blocksOf(
  rows: EventRow[],
  outputs: Map<string, OutputBuffer> = new Map(),
): Block[] {
  rows = oneEntryEach(rows);
  const blocks: Block[] = [];
  const steps = new Map<string, Step>();
  const children = new Map<string, Block[]>();
  const child = (id: string) => {
    if (!children.has(id)) children.set(id, []);
    return children.get(id)!;
  };
  const said = new Map<string, Extract<Block, { type: 'assistant' }>>();
  const hidden = new Set(
    rows
      .filter((row) => row.type === 'item')
      .map((row) => bodyOf(row))
      .filter((body) => body.hidden ?? hiddenItem(body))
      .map((body) => body.item),
  );
  for (const row of rows) {
    const body = bodyOf(row);
    const target = body.parent_tool_use_id ? child(body.parent_tool_use_id) : blocks;
    if (
      row.type === 'message' &&
      (body.text ||
        body.images ||
        body.attachments?.length ||
        body.references?.length ||
        body.sources?.length)
    ) {
      if (!body.text)
        body.text =
          !body.attachments?.length && body.images
            ? `${body.images} ${body.images === 1 ? 'image' : 'images'}`
            : '';
      if (body.role === 'user') {
        target.push({
          type: 'user',
          key: `m${row.seq || body.item}`,
          text: body.text,
          by: body.by,
          ...(body.source && { source: body.source }),
          ...(body.sources?.length && { sources: body.sources }),
          ...(body.requestId && { requestId: body.requestId }),
          ...(body.rewindTurn && { turn: body.rewindTurn }),
          ...(body.attachments?.length && { attachments: body.attachments }),
          ...(body.references?.length && { references: body.references }),
        });
        continue;
      }
      const message = messageIdentity(body);
      const known = message && said.get(message);
      if (known) {
        known.text += body.text;
        continue;
      }
      const block: Extract<Block, { type: 'assistant' }> = {
        type: 'assistant',
        key: `m${row.seq || body.item}`,
        text: body.text,
        ...(message && { message }),
      };
      if (message) said.set(message, block);
      target.push(block);
    } else if (row.type === 'manager_notice') {
      blocks.push({ type: 'provider_switch', key: `notice${row.seq}`, text: String(body.text) });
    } else if (row.type === 'provider_switch') {
      blocks.push({
        type: 'provider_switch',
        key: `switch${row.seq}`,
        text: `Switched to ${body.to === 'claude' ? 'Claude Code' : 'Codex'} · context carried over${body.fresh ? ' · fresh session' : ''}`,
      });
    } else if (row.type === 'agent_done') {
      // Older threads hold a line for each request the person allowed or denied. They are no longer written, and are not shown.
      if ('decided' in body) continue;
      // A job's end is one line; a member's turn is shown inside its job, never beside it.
      const at = typeof row.at === 'string' && row.at ? { at: row.at } : {};
      if (typeof body.jobEnded === 'string')
        blocks.push({
          type: 'job',
          key: `j${row.seq}`,
          ...at,
          job: body.jobEnded,
          title: String(body.title ?? ''),
          state: body.state === 'done' ? 'done' : 'stopped',
          words: String(body.words ?? body.state ?? ''),
          ...(Number.isSafeInteger(body.files) && { files: body.files }),
          ...(typeof body.author?.thread === 'string' && {
            author: {
              thread: body.author.thread,
              provider: body.author.provider === 'codex' ? ('codex' as const) : ('claude' as const),
              ...(typeof body.author.completion === 'string' && {
                completion: body.author.completion,
              }),
            },
          }),
          ...spokenOf(body),
        });
      else if (typeof body.job?.id === 'string') continue;
      else if (
        typeof body.agent === 'string' &&
        ['finished', 'failed', 'stopped'].includes(body.outcome)
      )
        blocks.push({
          type: 'agent',
          key: `a${row.seq}`,
          ...at,
          agent: body.agent,
          title: String(body.title ?? ''),
          provider: body.provider === 'codex' ? 'codex' : 'claude',
          ...(typeof body.branch === 'string' && { branch: body.branch }),
          ...(Number.isSafeInteger(body.turn) && { turn: body.turn }),
          ...(Number.isSafeInteger(body.through) && { through: body.through }),
          outcome: body.outcome,
          ...(typeof body.completion === 'string' &&
            body.completion && { completion: body.completion }),
          ...(reviewOf(body.review) && { review: reviewOf(body.review)! }),
          ...(Number.isSafeInteger(body.files) && { files: body.files }),
          ...(body.paused === true && { paused: true as const }),
          ...spokenOf(body),
        });
    } else if (row.type === 'item') {
      if (hidden.has(body.item)) continue;
      const known = steps.get(body.item);
      if (known) {
        // A finish keeps what the start said it was; only its result and outcome are new.
        known.done = body.phase === 'completed';
        if (known.done) known.ended = Date.parse(row.at) || undefined;
        known.failed = body.title === 'failed';
        if (body.detail !== undefined) known.detail = body.detail;
        known.deferred = body.deferred;
        if (body.exitCode !== undefined) known.exitCode = body.exitCode;
        continue;
      }
      const step: Step = {
        item: body.item,
        kind: toolKind(body.kind, body.title),
        title: body.startTitle ?? body.title,
        deferred: body.deferred,
        detail: body.detail ?? outputs.get(body.item)?.text,
        exitCode: body.exitCode,
        done: body.phase === 'completed',
        failed: body.title === 'failed',
        at: Date.parse(row.at) || undefined,
      };
      if (body.kind === 'Task' || body.kind === 'Agent') {
        step.kind = 'tool';
        step.agent = { blocks: child(body.item) };
      }
      steps.set(body.item, step);
      const last = target.at(-1);
      if (last?.type === 'trail') last.steps.push(step);
      else target.push({ type: 'trail', key: `t${row.seq}`, steps: [step] });
    } else if (row.type === 'status' && body.status === 'failed') {
      blocks.push({
        type: 'error',
        key: `e${row.seq}`,
        text: body.error ?? 'It stopped with an error.',
        auth: body.auth ?? authFailure(body.error),
      });
    }
  }
  // A pause its worker moved on from without carrying it on, to other work, is not still at work.
  for (const [at, block] of blocks.entries())
    if (
      block.type === 'agent' &&
      block.paused &&
      blocks.slice(at + 1).some((later) => later.type === 'agent' && later.agent === block.agent)
    )
      delete block.paused;
  // A step still running shows what it has printed so far.
  for (const [item, step] of steps)
    if (!step.done && outputs.has(item)) step.detail = outputs.get(item)!.text;
  for (const [id, blocks] of children) {
    const step = steps.get(id);
    if (step) step.agent = { blocks };
  }
  return blocks;
}

/** Words still arriving after a flush belong to the message whose stored words came first;
 *  any other live block follows what is stored. */
export function joinStreaming(stored: Block[], live: Block[]): Block[] {
  const blocks = [...stored];
  for (const block of live) {
    const at =
      block.type === 'assistant' && block.message
        ? blocks.findIndex((known) => known.type === 'assistant' && known.message === block.message)
        : -1;
    if (at < 0) {
      blocks.push(block);
      continue;
    }
    const known = blocks[at] as Extract<Block, { type: 'assistant' }>;
    blocks[at] = {
      ...known,
      text: known.text + (block as Extract<Block, { type: 'assistant' }>).text,
    };
  }
  return blocks;
}

/** Only an acknowledged turn in an explicit multi-hop request names the other session. */
export function replyingTo(
  rows: EventRow[],
  thread: {
    id: string;
    provider: Provider;
    status: string;
    turn: string | null;
    generation: number;
  },
): string | undefined {
  if (thread.status !== 'running' || !thread.turn) return;
  const events = rows
    .filter((row) => row.thread === thread.id)
    .sort((a, b) => a.seq - b.seq)
    .map((row) => ({ ...row, body: bodyOf(row) }));
  const message = events.findLast((row) => row.type === 'message' && row.body.role === 'user');
  const asked = message?.body;
  if (
    asked?.by !== 'merv' ||
    typeof asked.source?.thread !== 'string' ||
    asked.source.thread === thread.id ||
    asked.nativeTurn !== thread.turn ||
    asked.generation !== thread.generation
  )
    return;
  const argue = /^argue:[^:]+:r[1-4]:(codex|claude)$/.exec(asked.requestId ?? '');
  if (!(argue?.[1] === thread.provider || /^(?:plan|api):[^:]+:[12]$/.test(asked.requestId ?? '')))
    return;
  const began =
    events.findLast(
      (row) =>
        row.type === 'status' &&
        row.body.status === 'running' &&
        row.body.turn === thread.turn &&
        row.body.generation === thread.generation,
    )?.seq ?? message!.seq;
  // Completion may arrive before the panel refreshes the thread or before the dispatch ack.
  if (
    events.some(
      (row) =>
        row.body.generation === thread.generation &&
        ((row.seq > began && (row.type === 'ended' || (row.type === 'status' && row.body.ended))) ||
          (row.type === 'status' &&
            row.body.turn === thread.turn &&
            row.body.status !== 'running')),
    )
  )
    return;
  return asked.source.thread;
}

/** Runtime windows win; older agents fall back to their provider's usual window. */
export function contextShare(
  usage: Pick<
    Extract<RuntimeEvent, { type: 'usage' }>,
    'input' | 'output' | 'contextUsed' | 'contextWindow' | 'model'
  >,
  provider: Provider,
): number {
  const window =
    usage.contextWindow && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? usage.contextWindow
      : contextWindow(provider, usage.model);
  const used = usage.contextUsed ?? usage.input + usage.output;
  return Number.isFinite(used) ? Math.max(0, Math.min(1, used / window)) : 0;
}

/** Fold old branches without losing their messages or tool results. */
export function sectionsOf(rows: EventRow[], outputs: Map<string, OutputBuffer> = new Map()) {
  const ranges = rows
    .filter((row) => row.type === 'rewind')
    .map((row) => bodyOf(row) as { after: number; through: number; files?: boolean });
  const sections: {
    key: number;
    undone: boolean;
    filesKept?: boolean;
    turn?: number;
    rows: EventRow[];
  }[] = [];
  for (const row of oneEntryEach(
    [...rows].sort((a, b) => (a.seq || Infinity) - (b.seq || Infinity)),
  )) {
    const range = row.seq
      ? ranges.findLast((range) => row.seq > range.after && row.seq <= range.through)
      : undefined;
    // What a worker finished happened, whatever the main thread's own conversation went back over.
    const undone = !!range && row.type !== 'agent_done';
    const body = row.type === 'message' ? bodyOf(row) : undefined;
    const turn = body?.role === 'user' ? (body.rewindTurn as number | undefined) : undefined;
    const last = sections.at(-1);
    if (last?.undone === undone && (undone || !turn)) last.rows.push(row);
    else
      sections.push({ key: row.seq, undone, filesKept: range?.files === false, turn, rows: [row] });
  }
  return sections
    .map(({ rows, ...section }) => ({ ...section, blocks: blocksOf(rows, outputs) }))
    .filter((section) => section.blocks.length);
}

/**
 * Words still arriving, as far as they can be drawn without being drawn twice. A last line that so far
 * is only the start of a list item, a heading or a code fence ("3", "-", "``"), or a table's first row
 * with its rule not yet under it, would show as a paragraph and then jump into its real shape a moment
 * later. It waits that moment instead.
 */
export function settled(text: string): string {
  const lines = text.split('\n');
  if (/^\s*(?:\d{1,3}\.?|[-*+]|#{1,3}|`{1,2}|~{1,2})?$/.test(lines.at(-1)!)) lines.pop();
  const row = (line?: string) => /^\s*\|/.test(line ?? ''),
    bars = (line: string) => line.split('|').length;
  if (row(lines.at(-1)) && !row(lines.at(-2))) lines.pop();
  else if (
    row(lines.at(-1)) &&
    !row(lines.at(-3)) &&
    /^[\s|:-]*$/.test(lines.at(-1)!) &&
    bars(lines.at(-1)!) < bars(lines.at(-2)!)
  )
    lines.splice(-2);
  return lines.join('\n');
}
