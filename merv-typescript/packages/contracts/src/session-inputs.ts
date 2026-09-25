import type { RunnerPlatform } from './sessions-models.js';

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
/** A caller-generated session or agent credential: ms_ followed by 43 base64url characters. */
export const sessionSecretPattern = /^ms_[A-Za-z0-9_-]{43}$/;
/** How long Codex may finish its closing turn after its own handoff: the runner waits this long,
 *  and the model relay honours the session's grant as long. */
export const codexHandoffGraceMs = 60_000;
