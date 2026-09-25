import type {
  PiHostRecord,
  PiMachine,
  PiMove,
  PiPersonRecord,
  PiSwitchMachineError,
  PiWork,
} from './types.js';

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

/** What the agent-move rules read; the service gathers it inside the turn's transaction. */
export interface PiMoveContext {
  /** Clock, in milliseconds. */
  now: number;
  /** config.agentMoves. */
  enabled: boolean;
  host: PiHostRecord;
  person: PiPersonRecord;
  conversationId: string;
  /** The machine serving the host now (C). */
  current: PiMachine;
  /** Machines the agent could move to: config agent: true, described by Sandboxes, and allowed
   * for this person here (PiService.machineChoice). Empty means switch_machine is never offered. */
  targets: PiMachine[];
}

const spec = (machine: PiMachine) =>
  `${machine.vcpu === 0.5 ? '½' : machine.vcpu} vCPU, ${machine.memoryGiB} GiB, ${machine.diskGB} GB disk`;
/** Upgrades only: at least as much of everything, and more of something. */
const bigger = (to: PiMachine, from: PiMachine) =>
  to.vcpu >= from.vcpu &&
  to.memoryGiB >= from.memoryGiB &&
  to.diskGB >= from.diskGB &&
  to.vcpu + to.memoryGiB + to.diskGB > from.vcpu + from.memoryGiB + from.diskGB;
/** A move that changed the machine; a deadline's rollover to a fresh one of the same kind is not. */
const changed = (move: PiMove) => move.outcome === 'moved' && move.from !== move.to;

/** When the agent's rate rules next let it move to `to`; not after `now` means now. Moves are
 * oldest first, and the person record is keyed like the host, so "a day" counts per host key. */
function allowedAt({ now, person, conversationId }: PiMoveContext, to: string): number {
  const after = (move: PiMove | undefined, ms: number) => (move ? Date.parse(move.at) + ms : 0);
  const within = (ms: number) => person.moves.filter((move) => Date.parse(move.at) > now - ms);
  const agent = within(day).filter((move) => move.by === 'agent');
  const failed = within(hour).filter((move) => move.outcome === 'failed');
  return Math.max(
    // At most 3 agent moves a day, and 1 an hour per conversation.
    agent.length >= 3 ? after(agent.at(-3), day) : 0,
    after(
      agent.findLast((move) => move.conversationId === conversationId),
      hour,
    ),
    // At least 10 minutes on a machine between moves.
    after(person.moves.findLast(changed), 10 * minute),
    // Hidden for an hour after the person picks another machine, or after 2 failed moves.
    person.choseAt && person.preferred !== to ? Date.parse(person.choseAt) + hour : 0,
    failed.length >= 2 ? after(failed.at(-2), hour) : 0,
  );
}

/** Why the rules refuse the agent's switch to `to` now; null lets the service start it (T2). The
 * service answers `already` before asking, when `to` is C's machine, and checks capacity
 * (fleet.free) after, answering machine_unavailable. No approval step: the targets are already
 * what the person may choose here. */
export function moveRefusal(context: PiMoveContext, to: string): PiSwitchMachineError | null {
  const target = context.targets.find((machine) => machine.key === to);
  if (!context.enabled || !target || !bigger(target, context.current))
    return { code: 'machine_unavailable' };
  if (context.host.next || context.host.draining) return { code: 'move_in_progress' };
  const wait = allowedAt(context, to) - context.now;
  return wait > 0 ? { code: 'move_limit', retryAfterSeconds: Math.ceil(wait / 1000) } : null;
}

/** switch_machine for this turn (native name machine.switch, input switchMachineInput), offered
 * only while the rules would let it move somewhere; null otherwise. */
export function moveTool(context: PiMoveContext): PiWork['tools'][number] | null {
  const { current } = context;
  const targets = context.targets.filter((machine) => !moveRefusal(context, machine.key));
  if (!targets.length) return null;
  return {
    name: 'machine.switch',
    description: [
      'Move to a bigger machine.',
      `You run on ${current.label} (${spec(current)}), shared with this person's other conversations.`,
      ...targets.map(
        (machine) =>
          `${machine.label} has ${spec(machine)} and costs about ${Math.round(machine.maxHourlyUsd / current.maxHourlyUsd)}× as much.`,
      ),
      'Use it only when the machine limits the work (out of memory or disk, far too slow); the model is the same.',
      `This answer finishes here; later turns run on ${targets.map((machine) => machine.label).join(' or ')} once ready.`,
      'Files do not carry over; the conversation does. Say what failed in `reason`.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', enum: targets.map((machine) => machine.key) },
        reason: { type: 'string', minLength: 10, maxLength: 300 },
      },
      required: ['machine', 'reason'],
      additionalProperties: false,
    },
  };
}

/** The lines a turn's PiWork.notes carry: its machine, a move under way, and a move that did not
 * happen within the hour. A failed move's reason is the service's phrase, never the agent's. */
export function moveNotes({ now, host, person, current, targets }: PiMoveContext): string[] {
  const label = (key: string) =>
    [current, ...targets].find((machine) => machine.key === key)?.label ?? key;
  const moved = person.moves.findLast(changed);
  const last = person.moves.at(-1);
  const since =
    moved?.to === current.key ? ` since ${new Date(moved.at).toISOString().slice(11, 16)} UTC` : '';
  const notes = [`Machine: ${current.label} (${spec(current)})${since}.`];
  if (host.next)
    notes.push(`A move to ${label(host.next.machine)} is starting; this answer stays here.`);
  if (last && last.outcome !== 'moved' && Date.parse(last.at) > now - hour)
    notes.push(
      `The move to ${label(last.to)} ${last.outcome === 'failed' ? `failed${last.reason ? ` (${last.reason})` : ''}` : 'was cancelled'}; still on ${current.label}.`,
    );
  return notes.map((note) => note.slice(0, 300));
}
