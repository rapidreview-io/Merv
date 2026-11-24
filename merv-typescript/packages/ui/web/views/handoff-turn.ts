/**
 * What came of the turn Merv took on a hand-off sent from the board (docs/handoff.md). The Mac
 * shows the selection at once and waits for Merv's unit to bring the task prompt; only a unit does.
 * When the turn ends without one (Merv answered in words, asked a question, or put the words into
 * a session that was already running), the card would wait for nothing. The board reads the turn
 * and tells the Mac why, so the card can say so and offer to ask again.
 */
import type { PiCommand, PiSnapshot } from '@merv/pi/models';

export type PromptFailure = { reason: 'none' | 'routed' | 'interrupted'; detail?: string };

const desk = (outcome: PiCommand['outcomes'][number]) => {
  if (outcome.name !== 'desk.write' && outcome.name !== 'desk_write') return undefined;
  const input = outcome.input as { action?: unknown; unit?: { board?: unknown } } | null;
  return input && typeof input === 'object' ? input : undefined;
};

/** The turn that answers words sent as `commandId`: their own, or the one already running then,
 *  which hears them at its next chance. */
export function answeringTurn(
  snapshot: PiSnapshot,
  commandId: string,
  runningAtSend?: string | null,
) {
  return (
    snapshot.commands.find((command) => command.id === commandId) ??
    (runningAtSend ? snapshot.commands.find((command) => command.id === runningAtSend) : undefined)
  );
}

/**
 * `undefined` while the turn runs; `null` once it sent a unit for this board, so the task prompt is
 * on its way to the Mac; otherwise why no prompt came.
 */
export function promptOutcome(
  turn: PiCommand | undefined,
  board: string,
): PromptFailure | null | undefined {
  if (!turn || (turn.status !== 'completed' && turn.status !== 'interrupted')) return undefined;
  const calls = turn.outcomes.map(desk).filter((input) => !!input);
  if (
    calls.some(
      (input) =>
        input.action === 'unit' && (input.unit?.board === undefined || input.unit.board === board),
    )
  )
    return null;
  if (turn.status === 'interrupted') return { reason: 'interrupted' };
  if (calls.some((input) => input.action === 'message' || input.action === 'start'))
    return { reason: 'routed' };
  const said = [...turn.messages]
    .reverse()
    .find((message) => message.role === 'assistant')
    ?.text.trim();
  return { reason: 'none', ...(said && { detail: said.slice(0, 600) }) };
}
