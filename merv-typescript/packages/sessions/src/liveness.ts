import type { RunningPhrase } from '@merv/contracts/running';
import type { LeaseLiveness, SessionStatus } from './models.js';

// A lease's liveness: the one place Sessions words a lease's behaviour, for its Running board
// and for every lease the Agents page reads.

/** What a lease's liveness reads of it. */
export interface LeaseFacts {
  status: SessionStatus;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string;
  hardDeadline?: string;
  closedAt?: string | null;
  closeReason?: string | null;
  outcome?: string | null;
}
/** An active lease a read saw run out; the sweep closes it within the second. */
export const lapsed = (lease: LeaseFacts, now: number) =>
  lease.status === 'active' &&
  (Date.parse(lease.expiresAt) <= now ||
    (!!lease.hardDeadline && Date.parse(lease.hardDeadline) <= now));
/**
 * A lease's behaviour, the one place it is worded: offered and not taken up, active, lapsed,
 * released or expired, and then how it ended and when. Behaviour, not lifecycle: no read can
 * tell a lease that is working from one that is idle, so nothing here says which.
 */
export function leaseLiveness(lease: LeaseFacts, now: number): LeaseLiveness {
  if (lease.status === 'offered')
    return {
      verdict: 'offered',
      tone: 'warn',
      rest: ['not taken up · ', { since: lease.createdAt }],
    };
  if (lapsed(lease, now))
    return {
      verdict: 'lapsed',
      tone: 'bad',
      rest: ['lease ran out · ', { since: lease.expiresAt }],
    };
  if (lease.status === 'active')
    return {
      verdict: 'active',
      tone: 'ok',
      rest: [{ since: lease.activatedAt ?? lease.createdAt }],
    };
  // How it ended is a clause only where it says more than the state word already does.
  const end = lease.outcome || lease.closeReason;
  const rest: RunningPhrase = end && end !== lease.status ? [{ state: end }] : [];
  if (lease.closedAt) rest.push(...(rest.length ? [' · '] : []), { ago: lease.closedAt });
  return { verdict: lease.status, tone: lease.status === 'released' ? 'dim' : 'warn', rest };
}
/** Liveness as one line led by its verdict: `Offered · not taken up · 2m`. */
export function livenessLine({ verdict, rest }: LeaseLiveness): RunningPhrase {
  const head = `${verdict[0]!.toUpperCase()}${verdict.slice(1)}${rest.length ? ' · ' : ''}`;
  const [first, ...more] = rest;
  return typeof first === 'string' ? [head + first, ...more] : [head, ...rest];
}
