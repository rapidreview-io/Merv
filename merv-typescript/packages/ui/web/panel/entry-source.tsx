/**
 * Where a finished entry reads what it does not carry: a worker's turn in full, whether its work is merged, what can
 * be done with it, a job's rounds. On the Mac the desk answers directly; far from it (runmerv.com, Merv's one thread)
 * the page hands in its own reader, and what only the Mac can do is simply not offered. The entries themselves are the
 * same components either way: only where they read from differs.
 */
import { createContext, useContext, useMemo } from 'react';
import { useMacDesk, type DeskCall } from './desk-calls';
import type { AgentResult } from './agent-cards';
import type { Work } from './agents';
import type { JobView } from './rows';
import { carriedResult, resultOf, type Carried, type FarReport } from './entry-far';
export { carriedResult, resultOf, type Carried, type FarReport } from './entry-far';

interface TurnAt {
  turn?: number;
  through?: number;
  completion?: string;
}
export interface EntrySource {
  /** A worker's turn: its kept record when `at` names one, else as its session has it now. */
  result(agent: string, at?: TurnAt): Promise<AgentResult>;
  /** Whether its ended work is certainly not in the default branch. Absent: never asked, never said. */
  unmerged?(thread: string): Promise<{ unmerged?: boolean }>;
  /** What can be done with ended work on its own branch, and doing it. Absent: nothing is offered. */
  work?(thread: string): Promise<Work>;
  act?(thread: string, what: 'merge' | 'pull-request' | 'discard'): Promise<Work>;
  /** A job and its rounds. Absent: only what the entry carries is shown. */
  job?(id: string): Promise<JobView>;
}

const at = (place?: TurnAt) =>
  place?.completion
    ? `?completion=${encodeURIComponent(place.completion)}`
    : place?.turn
      ? `?turn=${place.turn}`
      : place?.through
        ? `?through=${place.through}`
        : '';
/** This Mac's own desk: everything is here. */
const deskSource = (call: DeskCall): EntrySource => ({
  result: (agent, place) =>
    call<AgentResult>(`threads/${encodeURIComponent(agent)}/result${at(place)}`),
  unmerged: (thread) =>
    call<{ unmerged?: boolean }>(`threads/${encodeURIComponent(thread)}/unmerged`),
  work: (thread) => call<Work>(`threads/${encodeURIComponent(thread)}/work`),
  act: (thread, what) => call<Work>(`threads/${encodeURIComponent(thread)}/work/${what}`, {}),
  job: (id) => call<JobView>(`jobs/${encodeURIComponent(id)}`),
});

const Source = createContext<EntrySource | undefined>(undefined);
export const EntrySourceProvider = Source.Provider;
/** The source given, else this Mac's own desk. */
export function useEntrySource(): EntrySource {
  const given = useContext(Source),
    call = useMacDesk(),
    mac = useMemo(() => deskSource(call), [call]);
  return given ?? mac;
}

/** A source that reads turns from afar, from one Mac: merging and jobs stay with that Mac. When the Mac cannot answer,
 *  a turn the stream carried (`known`, by its completion) is shown as it was carried. */
export const farSource = (
  read: (ask: { device?: string; agent?: string; completion?: string }) => Promise<FarReport>,
  device?: string,
  known?: (completion: string) => Carried | undefined,
): EntrySource => ({
  result: (agent, place) =>
    read({ device, agent, ...(place?.completion && { completion: place.completion }) }).then(
      resultOf,
      (failed) => {
        const card = place?.completion ? known?.(place.completion) : undefined;
        if (card) return carriedResult(card);
        throw failed;
      },
    ),
});
