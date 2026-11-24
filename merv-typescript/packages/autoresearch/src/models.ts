/** Autoresearch's records as its tools and pages read them. */

/** Where the manager stands: the state of its `autoresearch` workflow instance. */
export type AutoresearchState = 'managing' | 'waiting' | 'paused' | 'idle' | 'off';
/** Why the loop is paused: the person paused it, the spend cap, or the wake limit. */
export type AutoresearchPause = 'person' | 'cap' | 'wake_limit';

/** What a project's autoresearch may spend, and what it has, in US dollars. */
export interface AutoresearchSpend {
  capUsd: number;
  /** Sandboxes compute this round has cost so far, accrued and reserved; null where unknown. */
  spentUsd: number | null;
  /** The estimate held back for each run of the manager's that has not ended. */
  runEstimateUsd: number;
  openRuns: number;
  /** Spent plus the estimate for every open run. */
  committedUsd: number | null;
  /** Whether one more run fits under the cap. */
  allowsRun: boolean;
  /** Where the spend comes from, or why it is not known. */
  source: 'sandboxes' | 'no_compute' | 'unavailable';
}

/** One line of the manager's log: its decision at a wake, or what the loop itself did. */
export interface AutoresearchLine {
  id: string;
  at: string;
  /** decide: the manager's own line; the rest are the loop's or the person's. */
  kind: 'decide' | 'end' | 'wake' | 'pause' | 'resume' | 'start' | 'configure' | 'cap';
  /** The manager's revision the line was written at. */
  revision: number | null;
  actorId: string;
  text: string;
}

/** A task or experiment the manager started, and how it ended. */
export interface AutoresearchRun {
  id: string;
  workflow: 'task' | 'experiment';
  name: string;
  startedAt: string;
  endedAt: string | null;
  finalState: string | null;
}

/** One project's autoresearch, as `autoresearch.read` (`status`) answers it. */
export interface AutoresearchStatus {
  projectId: string;
  enabled: boolean;
  /** The manager's workflow instance; null before autoresearch was first turned on. */
  managerId: string | null;
  /** Who last set it up: the person a pause at the cap or the wake limit asks. */
  ownerId: string | null;
  state: AutoresearchState | null;
  revision: number | null;
  /** The manager's thread, once it has had a visit. */
  threadId: string | null;
  goal: string | null;
  paused: AutoresearchPause | null;
  roundStartedAt: string | null;
  wakes: { used: number; limit: number; pending: number };
  spend: AutoresearchSpend;
  runs: AutoresearchRun[];
  /** The newest lines, newest first. */
  lines: AutoresearchLine[];
  /** Whether this reader may change the settings and use pause and resume. */
  writable: boolean;
}

/** `autoresearch.write` (`configure`): a project admin's settings. */
export interface AutoresearchConfigure {
  enabled?: boolean;
  /** What the round may spend on Sandboxes compute, in US dollars. */
  capUsd?: number;
  /** What one run is expected to cost, held back against the cap while it runs. */
  runEstimateUsd?: number;
  /** Consecutive automatic wakes before the loop waits for the person. */
  wakeLimit?: number;
  /** What the manager works toward; required to turn it on. */
  goal?: string;
  requestId: string;
}

/** The manager's decision at the end of a visit (`autoresearch.decide`). */
export interface AutoresearchDecide {
  autoresearchId: string;
  expectedRevision: number;
  /** One line for the person: what was decided and what is next, at most 200 characters. */
  note: string;
  /** wait: for the work it started; end: the round is over, with `summary`. */
  next: 'wait' | 'end';
  summary?: string;
  requestId: string;
}
