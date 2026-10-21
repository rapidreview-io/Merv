import assert from 'node:assert/strict';

/** Expand discovery references for assertions; annotations have no validation effect. */
export function expanded(schema: Record<string, any>, root = schema): Record<string, any> {
  const result = structuredClone(schema);
  if (typeof result.$ref === 'string') {
    assert.match(result.$ref, /^#\/\$defs\/[^/]+$/);
    const target = root.$defs[result.$ref.split('/').at(-1)!];
    assert.ok(target, result.$ref);
    delete result.$ref;
    Object.assign(result, expanded(target, root));
  }
  if (result.allOf?.length === 1 && Object.keys(result.allOf[0]).join() === '$ref') {
    Object.assign(result, expanded(result.allOf[0], root));
    delete result.allOf;
  }
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
    if (result[key])
      for (const name of Object.keys(result[key]))
        if (typeof result[key][name] === 'object')
          result[key][name] = expanded(result[key][name], root);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
    if (result[key]) result[key] = result[key].map((item: any) => expanded(item, root));
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else'])
    if (result[key] && typeof result[key] === 'object') result[key] = expanded(result[key], root);
  return result;
}

/** Canonical validation constraints, independently ignoring annotations. */
export function constraints(schema: Record<string, any>): Record<string, any> {
  const out = structuredClone(schema);
  for (const key of ['$defs', '$schema', 'title', 'description']) delete out[key];
  for (const key of ['properties', 'patternProperties', 'definitions', 'dependentSchemas'])
    if (out[key])
      out[key] = Object.fromEntries(
        Object.entries(out[key]).map(([name, value]) => [
          name,
          typeof value === 'object' ? constraints(value as any) : value,
        ]),
      );
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
    if (out[key]) out[key] = out[key].map(constraints);
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else'])
    if (out[key] && typeof out[key] === 'object') out[key] = constraints(out[key]);
  return out;
}
