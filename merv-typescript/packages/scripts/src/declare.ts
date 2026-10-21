/** JSON Schema declarations; unknown constructs stay unknown, native projectId is implicit. */
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

/** Nouns have one overload per action; mounted projectId stays an ordinary argument. */
export function declaration(
  tool: { name: string; description?: string; inputSchema: unknown; outputSchema?: unknown },
  native = true,
  actions?: Record<string, { optional: boolean; output?: unknown }>,
): string {
  const path = tool.name
    .split('.')
    .map((part) => (identifier.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join('');
  const description = (tool.description ?? '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  const comment = description.length > 300 ? `${description.slice(0, 299)}…` : description;
  const schema = isSchema(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const lines = actions
    ? Object.entries(actions).map(([name, { optional, output }]) => {
        const args = `${key(name)}${optional ? '?' : ''}: ${typeOf(properties[name])}`;
        return `tools${path}(input: { action: ${JSON.stringify(name)}; ${args} }): Promise<${output ? typeOf(output) : 'unknown'}>`;
      })
    : [
        `tools${path}(input: ${typeOf(tool.inputSchema, native)}): Promise<${tool.outputSchema ? typeOf(tool.outputSchema) : 'unknown'}>`,
      ];
  const line = lines.join('\n');
  return comment ? `/** ${comment} */\n${line}` : line;
}
