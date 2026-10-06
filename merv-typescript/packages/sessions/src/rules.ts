/**
 * What a runner advertises and Sessions accepts, as pure rules: Sessions parses heartbeats,
 * settings, leases and Fleet's enrolments with them, and the runner checks its profiles and
 * the server's replies with the same patterns.
 */
import { z } from 'zod';
import type { RunnerPlatform } from '@merv/contracts';

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
