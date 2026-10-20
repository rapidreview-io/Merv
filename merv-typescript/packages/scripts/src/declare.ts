/** A JSON Schema as a TypeScript type, for the line a script author reads; what it cannot say is
 *  `unknown`. At a native tool's root, projectId is the script's own, so it is left out. */
type Schema = Record<string, unknown>;

const identifier = /^[A-Za-z_$][\w$]*$/;
const key = (name: string) => (identifier.test(name) ? name : JSON.stringify(name));
const isSchema = (value: unknown): value is Schema =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const union = (types: string[]) => [...new Set(types)].join(' | ') || 'never';

export function typeOf(schema: unknown, root = false): string {
  if (!isSchema(schema)) return 'unknown';
  if ('const' in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value)));
  const options = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(options)) return union(options.map((option) => typeOf(option)));
  if (Array.isArray(schema.type))
    return union(schema.type.map((type) => typeOf({ ...schema, type })));
  switch (schema.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'null':
      return schema.type;
    case 'integer':
      return 'number';
    case 'array': {
      const item = typeOf(schema.items);
      return /[ |]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case 'object': {
      const properties = isSchema(schema.properties) ? schema.properties : {};
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const fields = Object.entries(properties)
        .filter(([name]) => !(root && name === 'projectId'))
        .map(([name, value]) => `${key(name)}${required.has(name) ? '' : '?'}: ${typeOf(value)}`);
      if (!fields.length && isSchema(schema.additionalProperties))
        return `Record<string, ${typeOf(schema.additionalProperties)}>`;
      return fields.length ? `{ ${fields.join('; ')} }` : '{}';
    }
    default:
      return 'unknown';
  }
}

/** `tools.a.b(input: …): Promise<…>` under its description, cut at 300 characters. A mounted
 *  (not native) tool's projectId is its own argument, so it stays. */
export function declaration(
  tool: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown },
  native = true,
): string {
  const path = tool.name
    .split('.')
    .map((part) => (identifier.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join('');
  const description = (tool.description ?? '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  const comment = description.length > 300 ? `${description.slice(0, 299)}…` : description;
  const output = tool.outputSchema ? typeOf(tool.outputSchema) : 'unknown';
  const line = `tools${path}(input: ${typeOf(tool.inputSchema, native)}): Promise<${output}>`;
  return comment ? `/** ${comment} */\n${line}` : line;
}
