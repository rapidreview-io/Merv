/**
 * How a panel part asks its desk without knowing where the desk is. A part reads one of two adapters and never a
 * transport of its own; outside a provider there is no desk, and a call fails.
 *
 * - `useDeskCall()`: the desk the part is drawn for. Merv.app's panel provides this Mac's (`api.ts`, in `App`);
 *   runmerv.com provides the Mac reached through the person's account.
 * - `useMacDesk()`: what only a panel beside the Mac asks: its drafts and queues, its git, its agents' sign-in, its
 *   settings. Merv.app provides it; runmerv.com does not, so there these calls fail, as they always have.
 */
import { createContext, useContext } from 'react';

/** One request to the desk: GET without a body, POST with one; the answer as JSON, or an error with its message. */
export type DeskCall = <T>(path: string, body?: unknown) => Promise<T>;

/** One row of a desk's event stream, as Merv.app's desk and runmerv.com's relay both send it. */
export interface EventRow {
  seq: number;
  thread: string | null;
  type: string;
  body: string;
  at: string;
}

const noDesk: DeskCall = () => Promise.reject(new Error('No desk to ask'));
export const DeskCalls = createContext<DeskCall>(noDesk);
export const useDeskCall = () => useContext(DeskCalls);
export const MacDesk = createContext<DeskCall>(noDesk);
export const useMacDesk = () => useContext(MacDesk);

export async function whileBusy(
  set: (busy: boolean) => void,
  onError: (message: string) => void,
  run: () => Promise<unknown>,
) {
  set(true);
  try {
    await run();
  } catch (error) {
    onError((error as Error).message);
  } finally {
    set(false);
  }
}
