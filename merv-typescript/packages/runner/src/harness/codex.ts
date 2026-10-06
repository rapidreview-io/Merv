import { lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { codexEvents } from '@merv/contracts';
import { assignmentCodexHome, type RunnerProfile } from '../profiles.js';
import { entries, firstId, type Harness, spent } from './shared.js';

/** The isolated assignment's own home; a local launch has one in its run directory. */
const home = (profile: RunnerProfile, runDirectory: string) =>
  profile.harness === 'codex' && profile.isolatedLauncher
    ? assignmentCodexHome
    : join(runDirectory, 'codex-home');

/**
 * Codex. `codex exec --json` runs one thread and ends each turn with `turn.completed`, whose
 * usage is the thread's running total (`input_tokens` includes cached input), so the last one
 * counts; a stream cut off before any turn completed reports nothing. It keeps each thread in its
 * home's databases too and resumes a thread only where it was recorded, so a local launch has a
 * home of its own, taken away whole when it ends; a conversation is a dated
 * `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` there.
 */
export const codex: Harness = {
  lines: codexEvents,
  usage: (output, model) => spent(output, 'turn.completed', model),
  conversationId: (output) =>
    firstId(
      output,
      '"thread.started"',
      (event) => event.type === 'thread.started' && event.thread_id,
    ),
  resumeRefused: /no rollout found/i,
  line: () => undefined,
  home,
  locate(root, id) {
    const walk = (directory: string, depth: number): string | undefined => {
      for (const entry of entries(directory)) {
        const path = join(directory, entry.name);
        if (depth < 3 && entry.isDirectory()) {
          const found = walk(path, depth + 1);
          if (found) return found;
        } else if (
          depth === 3 &&
          entry.name.startsWith('rollout-') &&
          entry.name.endsWith(`-${id}.jsonl`)
        )
          return path;
      }
      return undefined;
    };
    return walk(join(root, 'sessions'), 0);
  },
  restorePath(root, _cwd, id) {
    const now = new Date().toISOString();
    return [
      join(root, 'sessions', now.slice(0, 4), now.slice(5, 7), now.slice(8, 10)),
      `rollout-${now.slice(0, 19).replaceAll(':', '-')}-${id}.jsonl`,
    ];
  },
  forget: (root) => rmSync(root, { recursive: true, force: true }),
};

/** Before a local Codex launch: its own `CODEX_HOME`, holding a link to the machine's login. */
export function launchCodexHome(
  profile: RunnerProfile,
  runDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (profile.harness !== 'codex' || profile.isolatedLauncher) return undefined;
  const path = home(profile, runDirectory);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const login = join(path, 'auth.json');
  if (!lstatSync(login, { throwIfNoEntry: false }))
    symlinkSync(
      join(environment.CODEX_HOME ?? join(environment.HOME ?? homedir(), '.codex'), 'auth.json'),
      login,
    );
  return path;
}
