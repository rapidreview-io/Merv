import { z } from 'zod';

export const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
/** What a conversation is called until Pi names it after its first answer. */
export const defaultTitle = 'New conversation';
export const createInput = z
  .object({ requestId: id, title: z.string().trim().min(1).max(200).default(defaultTitle) })
  .strict();
export const sendInput = z
  .object({ commandId: id, text: z.string().trim().min(1).max(32_000) })
  .strict();
export const warmInput = z.object({ requestId: id, conversationId: id.optional() }).strict();
/** A PiMachine key, e.g. 'standard' or 'large'. */
export const machineKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** pi.machine.set */
export const machineInput = z.object({ machine: machineKey }).strict();
/** machine.switch, the agent's switch_machine. */
export const switchMachineInput = z
  .object({ machine: machineKey, reason: z.string().trim().min(10).max(300) })
  .strict();
export const workerInput = z.object({ workerId: id }).strict();
/** /next; the probe is HMAC-SHA256 base64url. */
export const nextInput = workerInput
  .extend({
    probe: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();
/** Per-turn routes name the conversation too: one worker serves many. */
export const commandInput = workerInput.extend({ commandId: id, conversationId: id }).strict();
/** A message's bound, which also holds an answer cut short. */
export const messageChars = 128_000;
export const message = z
  .object({ role: z.enum(['user', 'assistant']), text: z.string().max(messageChars) })
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
    idleTimeoutSeconds: z.number().int().min(5).max(3600).default(600),
    pollIntervalMs: z.number().int().min(100).max(30_000).default(1000),
    /** MERV_PI_RUNTIME_KEY: one host per person per project (the ruling), or per person. */
    runtimeKey: z.enum(['project', 'person']).default('project'),
    /** The operator's Pi host project (MERV_PI_HOST_PROJECT_ID), whose service key rents every
     * host slot; credentialEnv names the variable holding it. Required when enabled (refined
     * below). */
    host: z
      .object({
        projectId: id,
        credentialEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default('MERV_PI_HOST_KEY'),
      })
      .strict()
      .optional(),
    /** From MERV_FLEET_RUNTIMES, keyed like the Sandboxes runtime profiles; the first is the
     * default. `agent` lets the agent move to it. */
    machines: z
      .array(
        z
          .object({
            key: machineKey,
            label: z.string().trim().min(1).max(40),
            slots: z.number().int().min(1).max(8),
            agent: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine((all) => new Set(all.map((m) => m.key)).size === all.length, 'Machine keys repeat')
      .default([{ key: 'standard', label: 'Standard', slots: 3, agent: false }]),
    /** MERV_PI_AGENT_MOVES: offer switch_machine at all. */
    agentMoves: z.boolean().default(false),
  })
  .strict()
  .refine((config) => !config.enabled || config.host, {
    message: 'Enabled Pi needs its host project',
    path: ['host'],
  });
export type PiConfig = z.input<typeof piConfig>;
export type PiMachineConfig = z.output<typeof piConfig>['machines'][number];

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

/** pi@1 is published and immutable. pi@2 moves machines from conversations to hosts: turns begun
 * on a conversation's machine end as a restart ends them, and no conversation keeps a machine. */
export const hostMigration = {
  version: 2,
  sql: `CREATE TABLE pi_hosts (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX pi_one_live_host ON pi_hosts(key) WHERE status = 'live';
  CREATE TABLE pi_people (key TEXT PRIMARY KEY, data_json TEXT NOT NULL);
  ALTER TABLE pi_commands ADD COLUMN host_id TEXT;
  CREATE INDEX pi_host_turns ON pi_commands(host_id, created_at)
    WHERE status IN ('waiting','starting','working','saving');
  UPDATE pi_commands SET status = 'interrupted', data_json = (data_json::jsonb || jsonb_build_object(
    'status', 'interrupted', 'error', 'service_unavailable',
    'completedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))::text
    WHERE status IN ('waiting','starting','working','saving');
  UPDATE pi_conversations SET data_json = ((data_json::jsonb - 'epoch' - 'runtimeId' - 'runtimeEpoch'
    - 'runtimeExpiresAt' - 'idleSince') || '{"activeCommandId":null}'::jsonb)::text;
  DROP INDEX pi_one_runtime_per_user;
  ALTER TABLE pi_conversations DROP COLUMN runtime_id;
  CREATE INDEX pi_conversations_by_user ON pi_conversations(user_id);`,
};
