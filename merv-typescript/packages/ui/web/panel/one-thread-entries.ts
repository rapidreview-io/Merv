/**
 * Merv's one thread as the entries a project's main thread is drawn from. The person's words and Merv's become the same
 * `user` and `assistant` blocks; Merv's own tool calls in a turn become one `trail`, the quiet gray line that opens to its
 * steps; a worker's finish is the main thread's `agent` entry; a job's end is its `job` entry, with its rounds as the
 * job's own lines. What only a thread across projects has (a worker starting, a question that waits on the person, a
 * stop, a manager's note on its own, the day and the project where they change) passes through as it is, as `one`.
 * Pure: the same rows always make the same entries.
 */
import type { Block, Step } from './chat-events';
import type { AgentEntryBlock, JobEntryBlock } from './agent-cards';
import { MERV_STEP, mervKind } from './tool-words';
import {
  memberWords,
  type DoneRow,
  type JobRow,
  type OneThread,
  type ThreadNote,
  type ThreadRow,
} from './one-thread';
import type { JobView } from './rows';

/** One of Merv's turns and the tools it used, in order: what a page of Merv's conversation knows of it. */
export interface MervTurn {
  command: string;
  /** Each call: its tool (dots said as underscores), the action it took, whether it failed, and
   *  what it answered, which its step opens to. */
  steps: { id: string; tool: string; action?: string; failed?: boolean; output?: string }[];
}

type Placed = { device?: string; notes: ThreadNote[] };
export type ThreadEntry =
  | Extract<Block, { type: 'user' }>
  | Extract<Block, { type: 'assistant' }>
  | Extract<Block, { type: 'trail' }>
  | ({ type: 'agent'; key: string } & AgentEntryBlock & Placed)
  | ({ type: 'job'; key: string } & JobEntryBlock & Placed & { view: JobView })
  | { type: 'one'; key: string; row: Exclude<ThreadRow, { type: 'said' | 'done' | 'job' }> };

/** A tool call of Merv's as a step of the main thread's trail. */
function mervStep(step: MervTurn['steps'][number]): Step {
  return {
    item: step.id,
    kind: mervKind(step.tool),
    ...(step.output && { detail: step.output }),
    title: `${MERV_STEP}${step.tool}${step.action ? `.${step.action}` : ''}`,
    done: true,
    failed: !!step.failed,
  };
}

function agentEntry(row: DoneRow): Extract<ThreadEntry, { type: 'agent' }> {
  const { card } = row,
    review = card.review;
  return {
    type: 'agent',
    key: row.key,
    ...(row.seq !== undefined && { seq: row.seq }),
    agent: card.agent ?? row.who.id,
    title: card.title || row.who.title,
    provider: row.who.provider ?? card.provider ?? 'claude',
    ...(card.turn !== undefined && { turn: card.turn }),
    ...(card.through !== undefined && { through: card.through }),
    outcome: row.outcome,
    ...(card.completion && { completion: card.completion }),
    ...(card.branch && { branch: card.branch }),
    ...(review && {
      review: {
        of: review.of,
        title: review.title,
        verdict:
          review.verdict === 'pass' || review.verdict === 'needs changes' ? review.verdict : 'none',
        ...(review.changed && { changed: true }),
      },
    }),
    ...(card.files !== undefined && { files: card.files }),
    ...(row.paused && { paused: true as const }),
    at: row.at,
    // Everything the stream says of the turn is carried here: nothing is read for an entry to be drawn.
    worded: true,
    ...(card.said && { said: card.said }),
    ...(card.cut && { cut: true }),
    ...(card.changes && { changes: card.changes }),
    ...(row.device && { device: row.device }),
    notes: row.notes,
  };
}

function jobEntry(row: JobRow): Extract<ThreadEntry, { type: 'job' }> {
  const card = row.end?.card,
    round = Math.max(0, ...row.members.map((member) => member.round));
  const words = row.end ? row.end.words || row.end.state : round ? `round ${round}` : 'job';
  const view: JobView = {
    id: row.job,
    recipe: '',
    title: row.title,
    state: row.end?.state ?? 'running',
    words,
    more: 0,
    lines: row.members.map((member, n) => ({
      n: n + 1,
      thread: member.card.agent ?? member.who.id,
      provider: member.who.provider ?? 'claude',
      role: member.role,
      round: member.round,
      state: member.outcome,
      words: memberWords(member),
      ...(member.card.completion && { completion: member.card.completion }),
      ...(member.card.files !== undefined && { files: member.card.files }),
    })),
  };
  return {
    type: 'job',
    key: row.key,
    ...(row.seq !== undefined && { seq: row.seq }),
    job: row.job,
    title: row.title,
    state: row.end?.state === 'stopped' ? 'stopped' : 'done',
    words,
    at: row.at,
    ...(card?.files !== undefined && { files: card.files }),
    ...(card?.author && {
      author: {
        thread: card.author.thread,
        provider: card.author.provider === 'codex' ? ('codex' as const) : ('claude' as const),
        ...(card.author.completion && { completion: card.author.completion }),
      },
    }),
    worded: true,
    ...(card?.said && { said: card.said }),
    ...(card?.cut && { cut: true }),
    ...(card?.changes && { changes: card.changes }),
    ...(row.device && { device: row.device }),
    notes: row.notes,
    view,
  };
}

/** The thread's rows as entries, oldest first. Merv's steps in a turn stand before its first words in that turn, or,
 *  while it has said nothing yet, under what the person said to begin it. */
export function threadEntries(
  thread: Pick<OneThread, 'rows'>,
  turns: MervTurn[] = [],
): ThreadEntry[] {
  const steps = new Map(
    turns.filter((turn) => turn.steps.length).map((turn) => [turn.command, turn]),
  );
  const answered = new Set(
    thread.rows.flatMap((row) =>
      row.type === 'said' && row.role === 'assistant' && row.command ? [row.command] : [],
    ),
  );
  const placed = new Set<string>();
  const entries: ThreadEntry[] = [];
  const trail = (command: string | undefined) => {
    const turn = command ? steps.get(command) : undefined;
    if (!turn || placed.has(turn.command)) return;
    placed.add(turn.command);
    entries.push({ type: 'trail', key: `t:${turn.command}`, steps: turn.steps.map(mervStep) });
  };
  for (const row of thread.rows) {
    if (row.type === 'said') {
      if (row.role === 'assistant') trail(row.command);
      entries.push(
        row.role === 'user'
          ? { type: 'user', key: row.key, text: row.text, by: 'person' }
          : { type: 'assistant', key: row.key, text: row.text },
      );
      if (row.role === 'user' && row.command && !answered.has(row.command)) trail(row.command);
    } else if (row.type === 'done') entries.push(agentEntry(row));
    else if (row.type === 'job') entries.push(jobEntry(row));
    else entries.push({ type: 'one', key: row.key, row });
  }
  return entries;
}
