import type {
  PiHostRecord,
  PiMachine,
  PiPersonRecord,
  PiSwitchMachineError,
  PiWork,
} from './types.js';

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

/** switch_machine for this turn (native name machine.switch, input switchMachineInput), or null
 * when the agent may not move now. C0 stub: never offered; G3 implements the rules. */
export function moveTool(_context: PiMoveContext): PiWork['tools'][number] | null {
  return null;
}

/** Why the rules refuse the agent's switch to `to` now; null lets the service start it (T2).
 * Capacity (fleet.free) is the service's check, answered machine_unavailable. C0 stub. */
export function moveRefusal(_context: PiMoveContext, _to: string): PiSwitchMachineError | null {
  return { code: 'machine_unavailable' };
}

/** The lines a turn's PiWork.notes carry about its machine and the latest move. C0 stub. */
export function moveNotes(_context: PiMoveContext): string[] {
  return [];
}
