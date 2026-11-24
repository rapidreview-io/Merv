/**
 * What a press or a key does to a live line in the column: an agent at work or asking, or a job under way. A line
 * that needs the person brings the main thread to what is asked; any other opens that session beside it. A job is
 * controlled where it shows: S stops it, C continues it, the arrows move between lines.
 */
import { type KeyboardEvent } from 'react';
import type { DeskCall } from './desk-calls';
import { jobActions, type LiveLine } from './agents';
import type { JobView } from './rows';

export interface Ask {
  main: string;
  thread?: string;
  job?: string;
  /** It has been brought into view. */ shown?: boolean;
}
/** What was last asked for and not yet shown: the main thread may still be opening when it is asked. */
let asked: Ask | undefined;
/** The ask meant for this main thread, once. */
export function takeAsk(main: string): Ask | undefined {
  if (asked?.main !== main) return;
  const ask = asked;
  asked = undefined;
  return ask;
}
/** A press on a line. One that needs the person brings the main thread into view at what is asked, above its message
 *  box; any other opens that agent's session (a job's current member's) beside the main thread, which stays in view. */
export function pressLive(main: string, line: Pick<LiveLine, 'open' | 'ask'>) {
  if (line.ask) {
    asked = { main, ...line.ask };
    dispatchEvent(new CustomEvent('merv:answer', { detail: asked }));
  } else if (line.open)
    dispatchEvent(new CustomEvent('merv:open-beside', { detail: { main, id: line.open } }));
}

/** Continue or stop a job, at the person's press. */
export const jobAct = (call: DeskCall, id: string, what: 'continue' | 'stop') =>
  call(`jobs/${encodeURIComponent(id)}/${what}`, {});
/** A job set to start later: cancel it, or start it now whatever it waits for. */
export const laterAct = (call: DeskCall, id: string, what: 'cancel' | 'start') =>
  call(`later/${encodeURIComponent(id)}/${what}`, {});
/** What a key does to a job with the keys on its line: S stops one under way, C carries on one that waits for the person's word. */
export function jobKey(
  job: Pick<JobView, 'state' | 'needs' | 'more'> | undefined,
  key: string,
): 'continue' | 'stop' | undefined {
  const what =
    key.toLowerCase() === 's' ? 'stop' : key.toLowerCase() === 'c' ? 'continue' : undefined;
  return job && what && jobActions(job).includes(what) ? what : undefined;
}
/** The arrows move the keys to the line above or below, within one list and never out of it. */
export function moveLine(
  event: KeyboardEvent<HTMLElement>,
  selector: string,
  within: string,
): boolean {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
  const lines = Array.from(
      event.currentTarget.closest(within)?.querySelectorAll<HTMLElement>(selector) ?? [],
    ),
    at = lines.indexOf(event.currentTarget);
  const next = lines[at + (event.key === 'ArrowDown' ? 1 : -1)];
  if (at < 0 || !next) return false;
  event.preventDefault();
  next.focus();
  return true;
}
