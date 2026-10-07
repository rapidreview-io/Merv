import type { RunnerProfile } from '../profiles.js';
import { claudeLauncher } from './claude.js';
import { codexLauncher } from './codex.js';
import { commandLauncher } from './command.js';
import type { Harness, Launcher } from './shared.js';

export type { Harness, Launcher } from './shared.js';
const launchers = { claude: claudeLauncher, codex: codexLauncher, command: commandLauncher };
/** How the profile is launched: everything the runner core does differently for a harness. */
export const launcherOf = (profile: RunnerProfile): Launcher =>
  launchers[profile.harness] as Launcher;
/** The profile's agent harness; a plain command has none. */
export const harnessOf = (profile: RunnerProfile): Harness | undefined =>
  launchers[profile.harness]?.agent;
