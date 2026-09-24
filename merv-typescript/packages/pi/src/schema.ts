import { z } from 'zod';

export const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const createInput = z
  .object({ requestId: id, title: z.string().trim().min(1).max(200) })
  .strict();
export const sendInput = z
  .object({ commandId: id, text: z.string().trim().min(1).max(32_000) })
  .strict();
export const workerInput = z.object({ workerId: id }).strict();
export const commandInput = workerInput.extend({ commandId: id }).strict();
export const message = z
  .object({ role: z.enum(['user', 'assistant']), text: z.string().max(128_000) })
  .strict();
export const outcome = z
  .object({
    callId: id,
    name: z.string().min(1).max(128),
    input: z.record(z.unknown()),
    output: z.unknown(),
  })
  .strict();
export const completionInput = commandInput
  .extend({
    messages: z.array(message).min(1).max(128),
    outcomes: z.array(outcome).max(64),
    checkpoint: z.string().min(1).max(2_000_000),
    checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const piConfig = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().optional(),
    model: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,100}$/)
      .default('gpt-6-luna'),
    secretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('MERV_PI_SECRET'),
    modelApiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('MERV_PI_MODEL_API_KEY'),
    turnTimeoutSeconds: z.number().int().min(10).max(900).default(300),
    idleTimeoutSeconds: z.number().int().min(5).max(300).default(30),
    pollIntervalMs: z.number().int().min(100).max(30_000).default(1000),
  })
  .strict();
export type PiConfig = z.input<typeof piConfig>;

export const migration = {
  version: 1,
  sql: `CREATE TABLE pi_conversations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    user_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    runtime_id TEXT,
    data_json TEXT NOT NULL,
    UNIQUE(project_id, user_id, request_id)
  );
  CREATE UNIQUE INDEX pi_one_runtime_per_user ON pi_conversations(user_id) WHERE runtime_id IS NOT NULL;
  CREATE TABLE pi_commands (
    id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES pi_conversations(id),
    status TEXT NOT NULL,
    relay_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id, id)
  );
  CREATE UNIQUE INDEX pi_one_active_turn ON pi_commands(conversation_id)
    WHERE status IN ('waiting','starting','working','saving');`,
};
