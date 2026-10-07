import type { RunnerProfile } from '../profiles.js';
import type { Launcher } from './shared.js';

/**
 * A plain command: no agent harness, so no filesystem sandbox, MCP connections, conversation or
 * printed usage. It runs its configured arguments in the runner's runtime environment.
 */
export const commandLauncher: Launcher<Extract<RunnerProfile, { harness: 'command' }>> = {
  tuned: false,
  skills: false,
  handoffGraceMs: 0,
  valid: () => true,
  isolated: () => false,
  networked: () => false,
  huggingface: () => false,
  prepare: () => undefined,
  launch: (profile, { runtime }) => ({
    executable: profile.executable,
    args: [...(profile.args ?? [])],
    env: runtime,
  }),
};
