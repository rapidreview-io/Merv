/**
 * Merv's side of the board's session names. merv-desktop reads the person's Macs here; Merv has
 * none, so no device is ever listed and nothing here reaches a Mac. What stays are the words a
 * session and its agent are named by, shared with the panel parts.
 */
import { ago, askTitle, stateOf } from '../panel/rows';
import type { ThreadState } from '@merv/protocol/link';
import type { EventStreamState } from '../event-stream';

export type Device = {
  id: string;
  label: string;
  connected: boolean;
  seenAt?: string | null;
  threads: ThreadState[];
  projects?: { project: string; label: string; main?: boolean }[];
  providers?: ('claude' | 'codex')[];
};
export { providerName as agentName } from '@merv/protocol/runtime';
/** A session's name: what was asked, else its folder's. */
export const sessionTitle = (thread: ThreadState) => askTitle(thread.title) || thread.label;
export { ago };
export const age = (at?: string) => {
  const minutes = at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000)) : 0;
  return minutes < 60
    ? `${minutes}m`
    : minutes < 1440
      ? `${Math.floor(minutes / 60)}h`
      : `${Math.floor(minutes / 1440)}d`;
};

/** Merv pairs no Mac: the list is empty and stays so. */
const none: Device[] = [];
const idle = { state: 'ended' as EventStreamState, retry() {} };
export function useDevices() {
  return { devices: none, stream: idle };
}

export const delivery = (receipt: { delivery?: string; state?: string }) =>
  receipt.delivery ??
  (receipt.state === 'completed'
    ? 'delivered'
    : receipt.state === 'expired'
      ? 'refused'
      : receipt.state === 'outcome_unknown'
        ? 'unknown'
        : receipt.state);
export const threadState = (thread: ThreadState) => stateOf(thread, !!thread.waiting);
