import { z } from 'zod';
import type { ToolDefinition, ToolDescription } from '@merv/api/types';
import type { Data } from '@merv/contracts';
import { piModelToolName } from './tool-names.js';
import type { PiWork } from './types.js';

/** A model call's request: the history a turn restores (worker HISTORY_BYTES), its prompt and tool
 * outputs, and whatever the model already wrote within the turn, up to its whole context window. */
export const relayRequestBytes = 8 * 1024 * 1024;
/** Any one text fits if its request does: a long earlier answer is history like any other. */
const text = z.string().max(relayRequestBytes);
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
      .max(128)
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
      .max(128)
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
  // A key directly under `properties` names an input field (paper.cite's url), not a keyword.
  const safeSchema = (value: unknown, depth = 0, names = false): boolean => {
    if (depth > 24) return false;
    if (typeof value === 'string') return !/\b(?:https?:\/\/|data:|file:|ftp:\/\/)/i.test(value);
    if (Array.isArray(value)) return value.every((entry) => safeSchema(entry, depth + 1));
    if (value !== null && typeof value === 'object')
      return Object.entries(value).every(
        ([key, entry]) =>
          (names ||
            ((key !== '$ref' ||
              (typeof entry === 'string' &&
                /^#\/(?:\$defs|definitions)\/[a-zA-Z0-9_/-]+$/.test(entry))) &&
              !['$dynamicRef', 'contentMediaType', 'contentEncoding', 'url', 'uri'].includes(
                key,
              ))) &&
          safeSchema(entry, depth + 1, !names && key === 'properties'),
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

const described: Record<'propose' | 'secret', string> = {
  propose: ' Proposed from a conversation: the person runs it.',
  secret: ' Proposed from a conversation: the person runs it and alone sees its result.',
};
/** A native tool as a turn offers it (PiWork.tools), from its public description and its
 * registration's conversation use: the description and input schema, without the project envelope
 * a conversation never chooses; null when the relay would refuse its name or schema (the catalog
 * test keeps that from happening unseen). */
export function piTool(
  definition: ToolDescription,
  conversation?: ToolDefinition['conversation'],
): PiWork['tools'][number] | null {
  const { $schema: _schema, ...schema } = definition.inputSchema as Record<string, unknown>;
  const { projectId: _project, ...properties } = schema.properties as Record<string, unknown>;
  const required = (schema.required as string[] | undefined)?.filter((key) => key !== 'projectId');
  const inputSchema = { ...schema, properties, ...(required && { required }) } as Data;
  const use = typeof conversation === 'string' ? conversation : undefined;
  const description =
    (definition.description ?? '') + (use && use !== 'never' ? described[use] : '');
  const name = piModelToolName(definition.name);
  const payload = piResponsesSchema.safeParse({
    model: 'catalog',
    input: [{ role: 'developer', content: description }],
    store: false,
    stream: true,
    tools: [{ type: 'function', name, description, parameters: inputSchema }],
  });
  return payload.success && validPiPayload(payload.data, [name])
    ? {
        name: definition.name,
        description,
        inputSchema,
        readOnly: definition.annotations?.readOnlyHint === true,
      }
    : null;
}
