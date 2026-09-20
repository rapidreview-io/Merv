import { check, MervError, plain, type Limits } from '@merv/contracts';
import { canonical } from './definition.js';

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

/** Freeze a detached data tree; keep live service handles outside this traversal. */
export function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
