/**
 * Work handed from a board, held on this page until the person approves it. In merv-desktop a
 * hand-off went to the Mac, which held it and sent it by itself after 30 seconds. In Merv the work
 * runs on cloud machines, so nothing is ever sent by itself: the card waits (`sendAt: null`) until
 * the person presses Approve, and only then is it asked of the Agent. The desk-call adapter
 * (`heldCalls`) answers the card's Send and Cancel here.
 */
import { useSyncExternalStore } from 'react';
import type { Held } from '../panel/handoff';
import type { DeskCall } from '../panel/desk-calls';

/** What the Agent is asked once the person approves: the person's words and where they point. */
export interface HeldWork {
  held: Held;
  board: string;
  shapes: string[];
}
let all: HeldWork[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((hear) => hear());

/** A selection handed from a board: its picture, the person's words, waiting for Approve. */
export function hold(work: {
  id: string;
  board: string;
  title: string;
  words: string;
  shapes: string[];
  picture?: string;
}) {
  const held: Held = {
    id: work.id,
    kind: 'unit',
    approve: true,
    board: { id: work.board, title: work.title },
    unit: {
      id: work.id,
      title: work.words || 'Execute this',
      request: work.words,
      brief: work.words ? `Execute this: ${work.words}` : 'Execute this.',
      ...(work.picture && { picture: work.picture }),
    },
    providers: [],
    cwd: '',
    label: work.title,
    sendAt: null,
  };
  all = [
    ...all.filter((one) => one.held.id !== work.id),
    { held, board: work.board, shapes: work.shapes },
  ];
  changed();
}
const drop = (id: string) => {
  all = all.filter((one) => one.held.id !== id);
  changed();
};

const subscribe = (hear: () => void) => {
  listeners.add(hear);
  return () => void listeners.delete(hear);
};
export const useHeld = () => useSyncExternalStore(subscribe, () => all);

/**
 * The card's own calls, answered on this page: Approve asks the Agent with the brief as the person
 * left it and the board's selection; Cancel drops it. Anything else is not Merv's to answer.
 */
export function heldCalls(ask: (words: string) => Promise<boolean>): DeskCall {
  return async <T>(path: string, body?: unknown): Promise<T> => {
    const [, id = '', what] = /^(?:held|handoffs)\/([^/]+)\/(send|cancel|hold)$/.exec(path) ?? [];
    const work = all.find((one) => one.held.id === decodeURIComponent(id));
    if (!work || !what) throw new Error('request_closed');
    if (what === 'send') {
      const brief = (body as { brief?: string } | undefined)?.brief?.trim() || work.held.unit.brief;
      const selection = `\n\nBoard: ${work.board}. Selected shapes: ${work.shapes.join(', ')}.`;
      if (!(await ask(brief + (work.shapes.length ? selection : ''))))
        throw new Error('Could not send it.');
    }
    // Merv never counts down, so holding changes nothing; only Approve and Cancel end the card.
    if (what !== 'hold') drop(work.held.id);
    return undefined as T;
  };
}
