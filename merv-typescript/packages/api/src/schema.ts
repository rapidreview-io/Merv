import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';
import { MervError } from '@merv/contracts';

/** JSON snapshots isolate callers and exclude values a JSON transport cannot preserve. */
export function cloneJson<T>(value: T): T {
  const ancestors = new Set<object>();
  function copy(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || ancestors.has(input))
      throw new TypeError('Value must be finite, acyclic JSON');
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new TypeError('Value must be a plain JSON object');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) return input.map(copy);
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, copy(child)]),
      );
    } finally {
      ancestors.delete(input);
    }
  }
  return copy(value) as T;
}

function rejectReferences(schema: unknown): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const node = schema as Record<string, unknown>;
  if ('$async' in node) throw new Error('Async schemas are unsupported');
  for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
    if (keyword in node && (typeof node[keyword] !== 'string' || !node[keyword].startsWith('#')))
      throw new Error('Only local schema references are supported');
  }
  for (const keyword of [
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
    'dependencies',
  ]) {
    const children = node[keyword];
    if (children && typeof children === 'object' && !Array.isArray(children))
      Object.values(children).forEach(rejectReferences);
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
    if (Array.isArray(node[keyword])) node[keyword].forEach(rejectReferences);
  for (const keyword of [
    'items',
    'additionalItems',
    'additionalProperties',
    'unevaluatedProperties',
    'unevaluatedItems',
    'contains',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'contentSchema',
  ]) {
    const child = node[keyword];
    if (Array.isArray(child)) child.forEach(rejectReferences);
    else rejectReferences(child);
  }
}

/** Compilation is synchronous, strict, and never fetches remote references. */
export function compileSchema(schema: unknown): ValidateFunction {
  try {
    const snapshot = cloneJson(schema);
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      !('type' in snapshot) ||
      snapshot.type !== 'object'
    )
      throw new Error('Tool schema must declare object input');
    rejectReferences(snapshot);
    const dialect = '$schema' in snapshot ? snapshot.$schema : undefined;
    const options = {
      strict: true,
      allErrors: true,
      ownProperties: true,
      addUsedSchema: false,
      coerceTypes: false as const,
      useDefaults: false as const,
      removeAdditional: false as const,
    };
    let validator: Ajv | Ajv2020;
    if (
      dialect === undefined ||
      dialect === 'https://json-schema.org/draft/2020-12/schema' ||
      dialect === 'https://json-schema.org/draft/2020-12/schema#'
    )
      validator = new Ajv2020(options);
    else if (
      dialect === 'http://json-schema.org/draft-07/schema#' ||
      dialect === 'http://json-schema.org/draft-07/schema'
    )
      validator = new Ajv(options);
    else throw new Error('Only JSON Schema draft 2020-12 and draft-07 are supported');
    addFormats(validator);
    return validator.compile(snapshot);
  } catch (error) {
    throw new MervError(
      'invalid_schema',
      `Unsupported or invalid tool schema: ${error instanceof Error ? error.message : 'schema compilation failed'}`,
    );
  }
}
