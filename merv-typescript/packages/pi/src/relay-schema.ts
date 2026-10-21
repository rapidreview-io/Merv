import { z } from 'zod';
import type { ToolDescription } from '@merv/api/types';
import type { Data } from '@merv/contracts';
import { fetchesContent, reasoningSummary, toolChoice } from '@merv/fleet/model-requests';
import { id } from './schema.js';
import { piModelToolName } from './tool-names.js';
import type { PiWork } from './types.js';

/** A model call's request: the history a turn restores (worker HISTORY_BYTES), its prompt and tool
 * outputs, and whatever the model already wrote within the turn, up to its whole context window. */
export const relayRequestBytes = 8 * 1024 * 1024;
/** Any one text fits if its request does: a long earlier answer is history like any other. */
const text = z.string().max(relayRequestBytes);
const identifier = z.string().min(1).max(128);
const toolName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/);

export const piRelayGrantSchema = z.strictObject({
  // `conversation:command:epoch`, whose command id pi.send takes up to 200 characters.
  id: z.string().min(1).max(256),
  userId: identifier,
  projectId: identifier,
  conversationId: identifier,
  commandId: id,
  runtimeId: identifier,
  epoch: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
  model: identifier,
  toolNames: z
    .array(toolName)
    .max(128)
    .refine((names) => new Set(names).size === names.length),
});

// Built once: a union made in the lazy getter was rebuilt at every node of every tool schema.
const json: z.ZodType<unknown> = z.lazy(() => node);
const scalars = [z.null(), z.boolean(), z.number().finite(), z.string()] as const;
const node = z.union([...scalars, z.array(json), z.record(json)]);

const input = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text }).strict(),
  z.strictObject({
    type: z.literal('input_image'),
    image_url: z
      .string()
      .max(1000000)
      .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  }),
]);
const output = z.strictObject({
  type: z.literal('output_text'),
  text,
  annotations: z.array(z.never()).max(0),
});
const message = z.union([
  z.object({ role: z.enum(['system', 'developer']), content: text }).strict(),
  z.object({ role: z.literal('user'), content: z.array(input).min(1).max(64) }).strict(),
  z.strictObject({
    type: z.literal('message'),
    role: z.literal('assistant'),
    id: identifier.optional(),
    status: z.literal('completed').optional(),
    phase: z.enum(['final_answer', 'commentary']).optional(),
    content: z.array(output).min(1).max(64),
  }),
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
  z.strictObject({
    type: z.literal('function_call'),
    id: identifier.optional(),
    call_id: identifier,
    name: identifier,
    arguments: text,
  }),
  z.strictObject({
    type: z.literal('function_call_output'),
    call_id: identifier,
    output: z.union([text, z.array(input).min(1).max(8)]),
  }),
]);

export const piResponsesSchema = z.strictObject({
  model: identifier,
  input: z.array(message).min(1).max(512),
  store: z.literal(false),
  stream: z.literal(true),
  max_output_tokens: z.number().int().min(16).optional(),
  prompt_cache_key: z.string().min(1).max(64).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoning: z
    .strictObject({
      effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
      summary: reasoningSummary.optional(),
    })
    .optional(),
  include: z.tuple([z.literal('reasoning.encrypted_content')]).optional(),
  tools: z
    .array(
      z.strictObject({
        type: z.literal('function'),
        name: toolName,
        description: text.optional(),
        parameters: z.record(json),
        strict: z.boolean().optional(),
      }),
    )
    .max(128)
    .optional(),
  tool_choice: toolChoice.optional(),
});

export function validPiPayload(
  payload: z.infer<typeof piResponsesSchema>,
  toolNames: string[],
): boolean {
  const allowed = new Set(toolNames);
  if (payload.tools?.some((tool) => !allowed.has(tool.name))) return false;
  if (new Set(payload.tools?.map((tool) => tool.name)).size !== (payload.tools?.length ?? 0))
    return false;
  if (payload.tool_choice === 'required' && !payload.tools?.length) return false;
  if (payload.tools?.some((tool) => tool.parameters.type !== 'object') || fetchesContent(payload))
    return false;
  return !payload.input.some(
    (item) =>
      'type' in item &&
      item.type === 'reasoning' &&
      !item.encrypted_content &&
      !item.summary?.length,
  );
}

/** A native tool as a turn offers it (PiWork.tools), from its public description: the description
 * and input schema, without the project envelope a conversation never chooses; null when the relay
 * would refuse its name or schema (the catalog test keeps that from happening unseen). */
export function piTool(definition: ToolDescription): PiWork['tools'][number] | null {
  const { $schema: _schema, ...schema } = definition.inputSchema as Record<string, unknown>;
  const { projectId: _project, ...properties } = schema.properties as Record<string, unknown>;
  const required = (schema.required as string[] | undefined)?.filter((key) => key !== 'projectId');
  const inputSchema = { ...schema, properties, ...(required && { required }) } as Data;
  const description = definition.description ?? '';
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
