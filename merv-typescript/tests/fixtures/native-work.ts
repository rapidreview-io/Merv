import type { Sandboxes } from '@merv/sandboxes/types';

/**
 * What a unit reads from Sandboxes, as a spy: the capture IDs Sandboxes verified for an
 * instance. Evidence is granted only by that explicit set.
 */
export function nativeWorkFixture() {
  const verified = new Map<string, string[]>();
  const service: Pick<Sandboxes, 'captures'> = {
    captures: async (_project, instanceId) => verified.get(instanceId) ?? [],
  };
  return { service, verified };
}
