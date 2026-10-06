import type { RunnerProfile } from '../profiles.js';
import { claude } from './claude.js';
import { codex } from './codex.js';
import type { Harness } from './shared.js';

export type { Harness } from './shared.js';
export const harnesses = { claude, codex };
export type HarnessName = keyof typeof harnesses;
/** The profile's agent harness; a plain command has none. */
export const harnessOf = (profile: RunnerProfile): Harness | undefined =>
  harnesses[profile.harness as HarnessName];
