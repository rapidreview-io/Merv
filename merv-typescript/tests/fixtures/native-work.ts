import type { CaptureEvidence, Sandboxes } from '@merv/sandboxes/types';

/**
 * What a unit reads from Sandboxes, as a spy: the capture IDs Sandboxes verified for an
 * instance, and the attempt any of them was captured under. Evidence is granted only by that
 * explicit set.
 */
export function nativeWorkFixture() {
  const verified = new Map<string, string[]>();
  const attempts = new Map<string, string>();
  /** Captures refused, by instance, under any attempt. */
  const refused = new Map<string, CaptureEvidence['refused']>();
  const captures: Sandboxes['captures'] = async (_project, instanceId, _tx, only) =>
    (verified.get(instanceId) ?? []).filter(
      (id) => !only || !attempts.has(id) || only.includes(attempts.get(id)!),
    );
  const service: Pick<Sandboxes, 'captures' | 'evidence'> = {
    captures,
    evidence: async (project, works, tx) =>
      new Map(
        await Promise.all(
          works.map(
            async ({ instanceId, attempts: only }) =>
              [
                instanceId,
                {
                  artifactIds: await captures(project, instanceId, tx, only),
                  refused: refused.get(instanceId) ?? [],
                },
              ] as const,
          ),
        ),
      ),
  };
  return { service, verified, attempts, refused };
}
