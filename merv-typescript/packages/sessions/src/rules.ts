/**
 * What a runner advertises and Sessions accepts, as pure rules: Sessions parses heartbeats,
 * settings, leases and Fleet's enrolments with them, and the runner checks its profiles and
 * the server's replies with the same patterns.
 */
import { z } from 'zod';
import type { RunnerPlatform } from '@merv/contracts/types';
import type { Role } from '@merv/contracts/scope-models';

/** Keyed by the harness type, so the list below is exactly that type's members. */
const harnesses: Record<RunnerPlatform['harness'], true> = {
  codex: true,
  claude: true,
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
/**
 * A visit its worker ended by its own hand: its handoff, its question to its owner, or an
 * inquiry visit's reply. Hosted
 * Codex may finish the model call it had started for a minute after either, which Sessions and
 * the runner's grace both read here.
 */
export const ownEnd = (reason: string | null | undefined) =>
  reason === 'handoff' || reason === 'asked_owner' || reason === 'inquiry_answered';
/**
 * What a runner advertises when it runs an inquiry visit as one (`session.inquiry`): read-only,
 * its conversation restored and never kept. Only such a runner is offered one.
 */
export const INQUIRY_CAPABILITY = 'inquiry.1';
/** Every status a session row can hold (`SessionStatus`). */
export const SESSION_STATUSES = ['offered', 'active', 'released', 'expired'] as const;
/** A lease's platform as a person reads it, on the Running sidebar and the Agents page. */
export const platformPhrase = (platform: Pick<RunnerPlatform, 'name' | 'model' | 'effort'>) =>
  [platform.name, platform.model, platform.effort].filter(Boolean).join(' · ');
/** Who reads what agents say (a visit's live stream, a thread's conversation): an operator. */
export const readsAgents = (role: Role): boolean => role === 'operator';
