import type { ToolDescription, ToolDefinition } from './types.js';

type Schema = Record<string, any>;
export function compactSchema(schema: Schema): Schema {
  // Existing pointers and URI scopes cannot safely be relocated.
  const serialized = JSON.stringify(schema);
  if (
    /"\$(?:id|anchor|dynamic\w+|recursive\w+)"\s*:/.test(serialized) ||
    /"\$ref":"(?!#\/\$defs\/[^/" ]+")/.test(serialized)
  )
    return schema;
  const definitions: Schema = {};
  const uses = new Map<string, Schema[]>();
  function visit(value: Schema, root = false, name?: string): Schema {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out = { ...value };
    if (name && out.title?.toLowerCase().replaceAll(' ', '_') === name.toLowerCase())
      delete out.title;
    for (const container of ['properties', '$defs'])
      if (out[container])
        out[container] = Object.fromEntries(
          Object.entries(out[container]).map(([key, child]) => [
            key,
            visit(child as Schema, false, container === 'properties' ? key : undefined),
          ]),
        );
    for (const key of ['items', 'additionalProperties'])
      if (out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]))
        out[key] = visit(out[key]);
    for (const key of ['anyOf', 'allOf', 'oneOf'])
      if (Array.isArray(out[key])) out[key] = out[key].map((child: Schema) => visit(child));
    if (!root) {
      const key = JSON.stringify(out);
      const copies = uses.get(key) ?? [];
      copies.push(out);
      uses.set(key, copies);
    }
    return out;
  }
  const out = visit(schema, true);
  // Descendants precede parents; costs reflect any sharing already done below them.
  let next = 0;
  for (const copies of uses.values()) {
    const first = copies[0]!;
    while (Object.hasOwn(schema.$defs ?? {}, `s${next}`)) next++;
    const name = `s${next}`;
    const reference = { $ref: `#/$defs/${name}` };
    const size = JSON.stringify(first).length;
    if ((size - JSON.stringify(reference).length) * copies.length <= size + name.length + 4)
      continue;
    definitions[name] = { ...first };
    next++;
    for (const copy of copies) {
      for (const key of Object.keys(copy)) delete copy[key];
      Object.assign(copy, reference);
    }
  }
  if (Object.keys(definitions).length) out.$defs = { ...out.$defs, ...definitions };
  return JSON.stringify(out).length < JSON.stringify(schema).length ? out : schema;
}

/** Only outside-agent discovery uses this copy. Runtime validators and worker metadata stay intact. */
export function compactTool(
  description: ToolDescription,
  definition: ToolDefinition,
): ToolDescription {
  const schema = description.inputSchema as Schema;
  description.description = definition.summary ?? description.description;
  if (definition.actions)
    for (const [name, value] of Object.entries(schema.properties ?? {}) as [string, Schema][])
      if (value && typeof value === 'object' && typeof value.description === 'string') {
        const prefix = `Required when action is "${name}"; omit otherwise. `;
        if (value.description.startsWith(prefix))
          value.description =
            definition.actions[name]?.summary ?? value.description.slice(prefix.length);
      }
  if (schema.properties?.projectId)
    schema.properties.projectId.description =
      'Human sessions/account keys: required. Actor/project keys: defaults to fixed project. Access checked.';
  return { ...description, inputSchema: compactSchema(schema) as ToolDescription['inputSchema'] };
}
