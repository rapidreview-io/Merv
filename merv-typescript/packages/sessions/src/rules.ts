/**
 * What a runner advertises and Sessions accepts, as pure rules: Sessions parses heartbeats,
 * settings, leases and Fleet's enrolments with them, and the runner checks its profiles and
 * the server's replies with the same patterns.
 */
import { z } from 'zod';
import type { RunnerPlatform } from '@merv/contracts/types';
import type { RunningPhrase } from '@merv/contracts/running';
import type { LeaseLiveness, SessionStatus } from './models.js';

/** Keyed by the harness type, so the list below is exactly that type's members. */
const harnesses: Record<RunnerPlatform['harness'], true> = {
  codex: true,
  claude: true,
  gemini: true,
  cursor: true,
  opencode: true,
  copilot: true,
  qwen: true,
  hermes: true,
  command: true,
};
/** Every harness a runner platform may name. */
export const RUNNER_HARNESSES = Object.keys(harnesses) as [
  RunnerPlatform['harness'],
  ...RunnerPlatform['harness'][],
];
/** One line of visible text: trimmed, at most 200 characters, no NUL or line break. */
export const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value));
/** What names a runner platform. */
export const platformName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** What a runner's server-owned settings tune of one of its platforms. */
export const platformTuning = {
  name: z.string().regex(platformName),
  enabled: z.boolean(),
  model: label.optional(),
  effort: label.optional(),
  parallelism: z.number().int().min(1).max(32),
};
/** One platform a runner advertises, and the one Fleet enrols a machine it rents with. */
export const runnerPlatformSchema = z
  .object({ ...platformTuning, harness: z.enum(RUNNER_HARNESSES) })
  .strict();
/** What a machine can do beyond its platforms, as opaque names: at most 16, each once. */
export const capabilitiesSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9.]{0,39}$/))
  .max(16)
  .refine((items) => new Set(items).size === items.length);
/** Every status a session row can hold (`SessionStatus`). */
export const SESSION_STATUSES = ['offered', 'active', 'released', 'expired'] as const;
/** A lease's platform as a person reads it, on the Running sidebar and the Agents page. */
export const platformPhrase = (platform: Pick<RunnerPlatform, 'name' | 'model' | 'effort'>) =>
  [platform.name, platform.model, platform.effort].filter(Boolean).join(' · ');

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
