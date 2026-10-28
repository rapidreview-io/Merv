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

/** Anthropic's prompt-cache marker, which pi-ai puts on the system prompt, the last tool and the
 * newest message. */
const cacheControl = z
  .strictObject({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() })
  .optional();
const anthropicText = z.strictObject({
  type: z.literal('text'),
  text,
  cache_control: cacheControl,
});
// Only pictures the request carries: a URL or file source would have Anthropic fetch it.
const anthropicImage = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
    data: z
      .string()
      .max(1_400_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
  cache_control: cacheControl,
});
const anthropicBlock = z.discriminatedUnion('type', [
  anthropicText,
  anthropicImage,
  z.strictObject({
    type: z.literal('tool_use'),
    id: identifier,
    name: identifier,
    input: z.record(json),
    cache_control: cacheControl,
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    tool_use_id: identifier,
    content: z.union([text, z.array(z.union([anthropicText, anthropicImage])).max(16)]),
    is_error: z.boolean().optional(),
    cache_control: cacheControl,
  }),
  // Replayed verbatim from checkpoints, as Anthropic signed them.
  z.strictObject({ type: z.literal('thinking'), thinking: text, signature: text }),
  z.strictObject({ type: z.literal('redacted_thinking'), data: text }),
]);

/** A Claude call as the worker's pi-ai sends it: custom tools only, and nothing the relay does not
 * set itself (thinking, effort, betas). */
export const piAnthropicSchema = z.strictObject({
  model: identifier,
  max_tokens: z.number().int().min(16).max(128_000),
  stream: z.literal(true),
  system: z.array(anthropicText).max(8).optional(),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        content: z.union([text, z.array(anthropicBlock).min(1).max(256)]),
      }),
    )
    .min(1)
    .max(512),
  tools: z
    .array(
      z.strictObject({
        name: toolName,
        description: text.optional(),
        input_schema: z.record(json),
        // Tool inputs stream as Claude writes them.
        eager_input_streaming: z.boolean().optional(),
        cache_control: cacheControl,
      }),
    )
    .max(128)
    .optional(),
  // Claude Opus 5.5 refuses forced tool use.
  tool_choice: z.strictObject({ type: z.enum(['auto', 'none']) }).optional(),
  thinking: z.record(json).optional(),
  output_config: z.record(json).optional(),
});

export function validPiAnthropicPayload(
  payload: z.infer<typeof piAnthropicSchema>,
  toolNames: string[],
): boolean {
  const allowed = new Set(toolNames);
  const tools = payload.tools ?? [];
  return (
    tools.every((tool) => allowed.has(tool.name) && tool.input_schema.type === 'object') &&
    new Set(tools.map((tool) => tool.name)).size === tools.length &&
    !fetchesContent(payload)
  );
}
