/** Hosted Codex, which Fleet rents and grants the model to. Pure rules: no service and no
 *  imports, so the runner and the hosted image run them too. */

/** How long Codex may finish its closing turn after its own handoff: the runner waits this long,
 *  and Fleet's model relay honours the session's grant as long. */
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
/** Opt-in profile for paid service experiments. A host is pinned to one of these profiles. */
export const hostedAstraPlatform = Object.freeze({
  ...hostedCodexPlatform,
  model: 'gpt-6-astra',
  effort: 'medium',
});
export type HostedCodexPlatform = typeof hostedCodexPlatform | typeof hostedAstraPlatform;
export const hostedCodexCapabilities = Object.freeze(['code.git.1']);
