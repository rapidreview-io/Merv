import { z } from 'zod';

/** Longest string, including one tool output, a relayed request may carry. */
export const maxTextChars = 100_000;
const text = z.string().max(maxTextChars);
const identifier = z.string().min(1).max(128);
const toolName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);

export const piRelayGrantSchema = z
  .object({
    id: identifier,
    userId: identifier,
    projectId: identifier,
    conversationId: identifier,
    commandId: identifier,
    runtimeId: identifier,
    epoch: z.number().int().nonnegative(),
    expiresAt: z.string().datetime({ offset: true }),
    model: identifier,
    toolNames: z
      .array(toolName)
      .max(64)
      .refine((names) => new Set(names).size === names.length),
  })
  .strict();

const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]),
);

const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text }).strict(),
]);
const output = z
  .object({ type: z.literal('output_text'), text, annotations: z.array(z.never()).max(0) })
  .strict();
const message = z.union([
  z.object({ role: z.enum(['system', 'developer']), content: text }).strict(),
  z.object({ role: z.literal('user'), content: z.array(input).min(1).max(64) }).strict(),
  z
    .object({
      type: z.literal('message'),
      role: z.literal('assistant'),
      id: identifier.optional(),
      status: z.literal('completed').optional(),
      phase: z.enum(['final_answer', 'commentary']).optional(),
      content: z.array(output).min(1).max(64),
    })
    .strict(),
  // Replayed verbatim from checkpoints: unknown fields are dropped rather than failing every turn.
  z.object({
    type: z.literal('reasoning'),
    id: identifier.optional(),
    encrypted_content: text.nullable().optional(),
    content: z.array(z.never()).max(0).optional(),
    summary: z
      .array(z.object({ type: z.literal('summary_text'), text }))
      .max(64)
      .optional(),
    status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
  }),
  // A model's call to an undeclared tool is only history: the agent answered it with an error.
  z
    .object({
      type: z.literal('function_call'),
      id: identifier.optional(),
      call_id: identifier,
      name: identifier,
      arguments: text,
    })
    .strict(),
  z.object({ type: z.literal('function_call_output'), call_id: identifier, output: text }).strict(),
]);

export const piResponsesSchema = z
  .object({
    model: identifier,
    input: z.array(message).min(1).max(512),
    store: z.literal(false),
    stream: z.literal(true),
    max_output_tokens: z.number().int().min(16).optional(),
    prompt_cache_key: z.string().min(1).max(64).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning: z
      .object({
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
        summary: z.enum(['auto', 'concise', 'detailed']).optional(),
      })
      .strict()
      .optional(),
    include: z.tuple([z.literal('reasoning.encrypted_content')]).optional(),
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            name: toolName,
            description: text.optional(),
            parameters: z.record(json),
            strict: z.boolean().optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    tool_choice: z.enum(['auto', 'none', 'required']).optional(),
  })
  .strict();

export function validPiPayload(
  payload: z.infer<typeof piResponsesSchema>,
  toolNames: string[],
): boolean {
  const allowed = new Set(toolNames);
  if (payload.tools?.some((tool) => !allowed.has(tool.name))) return false;
  if (new Set(payload.tools?.map((tool) => tool.name)).size !== (payload.tools?.length ?? 0))
    return false;
  if (payload.tool_choice === 'required' && !payload.tools?.length) return false;
  const safeSchema = (value: unknown, depth = 0): boolean => {
    if (depth > 24) return false;
    if (typeof value === 'string') return !/(?:https?:\/\/|data:|file:|ftp:\/\/)/i.test(value);
    if (Array.isArray(value)) return value.every((entry) => safeSchema(entry, depth + 1));
    if (value !== null && typeof value === 'object')
      return Object.entries(value).every(
        ([key, entry]) =>
          (key !== '$ref' ||
            (typeof entry === 'string' &&
              /^#\/(?:\$defs|definitions)\/[a-zA-Z0-9_/-]+$/.test(entry))) &&
          !['$dynamicRef', 'contentMediaType', 'contentEncoding', 'url', 'uri'].includes(key) &&
          safeSchema(entry, depth + 1),
      );
    return true;
  };
  if (
    payload.tools?.some((tool) => tool.parameters.type !== 'object' || !safeSchema(tool.parameters))
  )
    return false;
  return !payload.input.some(
    (item) =>
      'type' in item &&
      item.type === 'reasoning' &&
      !item.encrypted_content &&
      !item.summary?.length,
  );
}
