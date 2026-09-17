/**
 * Liveness for the Agents pages, and the one place an enum becomes words.
 *
 * Liveness is behavioural, not lifecycle: one verdict and one phrase per record,
 * composed in a fixed order — the state word, a middle clause, then a clock — so
 * that phrases line up down a column and no view writes a status sentence of its
 * own. Colour reaches the verdict word alone; `rest` is what stays quiet.
 *
 * What this module cannot say: Cordis reports no utilisation, no idle_since and
 * no per-record command feed, so a verdict distinguishes taken-up from waiting,
 * present from quiet, and open from closed. It must never pretend to distinguish
 * a lease that is working from one that is idle. When the server did not say
 * which state a record is in, the answer is `null` and the view renders no
 * liveness line at all rather than asserting that nothing has happened.
 */

/** Every enum becomes words in one place: an unknown value reads, never renders raw. */
export const words = (value: string) => value.replaceAll('_', ' ');
/** The reader's form of an enum or id: its words, or the em dash the server left. */
export const term = (value: string | null | undefined) => (value ? words(value) : '—');

/** A countdown, counting to 0s rather than to a euphemism: 0s, 41s, 6m 21s, 3h 5m. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [days, hours, minutes] = [total / 86400, (total / 3600) % 24, (total / 60) % 60].map(
    Math.floor,
  );
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
/** How long something has been true, at the coarseness a person reads it: 41s, 9m, 3h, 2d. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m`;
  if (total < 172_800) return `${Math.floor(total / 3600)}h`;
  return `${Math.floor(total / 86400)}d`;
}

/**
 * The clock a page reads its payload by. `at` is now in the server's own terms —
 * the payload's `observedAt` plus the time since it arrived — so every duration is
 * one server stamp minus another and browser skew never reaches it. `since` is how
 * long ago that payload arrived, and it is the age no verdict may outrun: a fact
 * the read did not see cannot be asserted from a browser timer.
 */
export interface Clock {
  at: number;
  since: number;
  /** True once the payload is older than the cadence it was read at. */
  stale: boolean;
}
export type Now = number | Clock;
/** A bare millisecond reading is a payload of its own moment, and never stale. */
export const clockOf = (now: Now): Clock =>
  typeof now === 'number' ? { at: now, since: 0, stale: false } : now;
export function clock(
  observedAt: string | null | undefined,
  loadedAt: string | null | undefined,
  now: number,
  freshFor: number,
): Clock {
  const arrived = loadedAt ? Date.parse(loadedAt) : Number.NaN;
  const since = Number.isFinite(arrived) ? Math.max(0, now - arrived) : 0;
  const observed = observedAt ? Date.parse(observedAt) : Number.NaN;
  return { at: Number.isFinite(observed) ? observed + since : now, since, stale: since > freshFor };
}

export type Tone = 'ok' | 'warn' | 'bad' | 'dim';
export interface Liveness {
  /** The behavioural state word; the only word on the line that takes colour. */
  verdict: string;
  tone: Tone;
  /** The middle clause and the clock, which stay quiet. */
  rest: string;
  /** The whole line, for any surface that states liveness as one string. */
  phrase: string;
}
export const say = (verdict: string, tone: Tone, ...clauses: (string | null)[]): Liveness => {
  const rest = clauses.filter(Boolean).join(' · ');
  return { verdict, tone, rest, phrase: [words(verdict), rest].filter(Boolean).join(' · ') };
};
/** Milliseconds since a stamp, or null when the server sent nothing parseable. */
const since = (at: string | null | undefined, now: number): number | null => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? now - parsed : null;
};
const held = (at: string | null | undefined, now: number) => {
  const delta = since(at, now);
  return delta === null ? null : `for ${elapsed(delta)}`;
};
const ago = (at: string | null | undefined, now: number, what = '') => {
  const delta = since(at, now);
  return delta === null ? null : `${what}${elapsed(delta)} ago`;
};

/** The lease fields `sessions.projectStatus` sends, all of them optional here. */
export interface LeaseFacts {
  status?: string | null;
  createdAt?: string | null;
  activatedAt?: string | null;
  expiresAt?: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  outcome?: string | null;
}
/** A lease's behaviour: taken up or not, still inside its window or past it, how it ended. */
export function leaseLiveness(lease: LeaseFacts, now: Now): Liveness | null {
  const { at, since: age } = clockOf(now);
  // How it ended is a clause only where it says more than the state word already does.
  const end = lease.outcome || lease.closeReason;
  const ending = end && end !== lease.status ? words(end) : null;
  switch (lease.status) {
    case 'offered':
      return say('offered', 'warn', 'not taken up', held(lease.createdAt, at));
    case 'active':
      // A heartbeat extends an active lease server-side, so only a read that itself
      // saw the window close may call it lapsed; `at - age` is that read's moment.
      return (since(lease.expiresAt, at - age) ?? -1) >= 0
        ? say('lapsed', 'bad', 'lease ran out', held(lease.expiresAt, at))
        : say('active', 'ok', held(lease.activatedAt ?? lease.createdAt, at));
    case 'released':
      return say('released', 'dim', ending, ago(lease.closedAt, at));
    case 'expired':
      return say('expired', 'warn', ending, ago(lease.closedAt, at));
    default:
      return null;
  }
}

/** The runner fields the same read sends. `live` is the server's own freshness call. */
export interface RunnerFacts {
  live?: boolean | null;
  lastSeenAt?: string | null;
  lastDecision?: string | null;
  lastDecisionAt?: string | null;
}
/** A runner's behaviour: present, or quiet since its last heartbeat. */
export function runnerLiveness(runner: RunnerFacts, now: Now): Liveness | null {
  if (typeof runner.live !== 'boolean') return null;
  const { at } = clockOf(now);
  return runner.live
    ? say('live', 'ok', ago(runner.lastSeenAt, at, 'seen '))
    : say('quiet', 'warn', ago(runner.lastSeenAt, at, 'last seen '));
}
/** Leases the runner took, and a closed reason where the last cycle gave it none. */
const TAKEN = new Set(['offered', 'replayed']);
export function decisionLiveness(runner: RunnerFacts, now: Now): Liveness | null {
  if (!runner.lastDecision) return null;
  const { at } = clockOf(now);
  return TAKEN.has(runner.lastDecision)
    ? say('dispatched', 'ok', ago(runner.lastDecisionAt, at))
    : say('declined', 'warn', words(runner.lastDecision), ago(runner.lastDecisionAt, at));
}
