/** A caller-generated session or agent credential: ms_ followed by 43 base64url characters. */
export const sessionSecretPattern = /^ms_[A-Za-z0-9_-]{43}$/;
/** The most a runner keeps of one session's own output as its transcript. */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** How long Codex may finish its closing turn after its own handoff: the runner waits this long,
 *  and the model relay honours the session's grant as long. */
export const codexHandoffGraceMs = 60_000;
/** The one profile the image-owned hosted runner advertises and Fleet enrols and demands, byte
 *  for byte; Git is transport inside Code v2. */
export const hostedCodexPlatform = Object.freeze({
  name: 'hosted-codex',
  harness: 'codex' as const,
  model: 'gpt-6.1-sol',
  effort: 'low',
  enabled: true,
  parallelism: 1,
});
export const hostedCodexCapabilities = Object.freeze(['code.v2']);
