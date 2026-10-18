import { canonical, check, MervError, plain, type Limits } from '@merv/contracts';

/** Bounds on caller-supplied data: nesting depth, JSON values, and canonical encoded length. */
export const DATA_LIMITS = { depth: 32, nodes: 16_000, limit: 256_000 } as const;

/** Reject accessors, cycles and values JSON would silently erase at this provider boundary. */
export function workflowJson<T>(
  value: T,
  code = 'invalid_workflow_policy',
  status = 500,
  {
    depth = Infinity,
    nodes = Infinity,
    limit = Infinity,
    undefined: undefinedFields = 'reject' as Limits['undefined'],
  } = {},
): T {
  try {
    const detached = plain<T>(value, code, {
      depth,
      nodes,
      keys: 'any',
      strings: 'json',
      undefined: undefinedFields,
      nullPrototype: false,
    });
    const encoded = canonical(detached);
    check(encoded.length <= limit, code, 'Input is too large', status);
    return JSON.parse(encoded) as T;
  } catch (error) {
    throw new MervError(
      code,
      error instanceof MervError ? error.message : 'Input must contain only finite JSON values',
      status,
    );
  }
}
