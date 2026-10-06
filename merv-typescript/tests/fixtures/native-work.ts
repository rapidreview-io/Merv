import type { Sandboxes } from '@merv/sandboxes/types';

/**
 * What a unit reads from Sandboxes, as a spy: the capture IDs Sandboxes verified for an
 * instance, and the attempt any of them was captured under. Evidence is granted only by that
 * explicit set.
 */
export function nativeWorkFixture() {
  const verified = new Map<string, string[]>();
  const attempts = new Map<string, string>();
  const service: Pick<Sandboxes, 'captures'> = {
    captures: async (_project, instanceId, _tx, only) =>
      (verified.get(instanceId) ?? []).filter(
        (id) => !only || !attempts.has(id) || only.includes(attempts.get(id)!),
      ),
  };
  return { service, verified, attempts };
}
