import type { Sandboxes } from '@merv/sandboxes/types';

/**
 * What a unit reads from Sandboxes, as a spy: native funding for version selection and the
 * capture IDs Sandboxes verified for an instance. Evidence is granted only by that explicit set.
 */
export function nativeWorkFixture() {
  let connected = true;
  const verified = new Map<string, string[]>();
  const service: Pick<Sandboxes, 'captures' | 'nativeWork'> = {
    nativeWork: { connected: async () => connected },
    captures: async (_project, instanceId) => verified.get(instanceId) ?? [],
  };
  return {
    service,
    verified,
    connected: (value: boolean) => {
      connected = value;
    },
  };
}
