import { z } from 'zod';
import { messageChars } from './limits.js';

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
/** A model id as the provider names it, e.g. 'gpt-6-luna'. */
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
/** pi.send; `model` is the one the page shows, which must still be the conversation's. */
export const sendInput = z
  .object({ commandId: id, text: z.string().trim().min(1).max(32_000), model: modelId.optional() })
  .strict();
/** pi.voice: the conversation, and the browser's WebRTC offer. */
export const voiceInput = z.object({ id, sdp: z.string().min(1).max(100_000) }).strict();
/** screen.look: what the agent wants to know about the person's screen. */
export const lookInput = z.object({ question: z.string().max(1_000).default('') }).strict();
/** screen.show: what the agent puts on the person's screen: one record, or one page. */
export const showInput = z
  .object({
    record: z.string().trim().min(1).max(200).optional(),
    page: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
/** pi.screen: the person's page answers what was asked of it: a look with a snapshot of itself,
 * a show with where it went or why it could not. */
export const screenInput = z
  .object({
    id,
    askId: id,
    shot: z
      .object({
        path: z.string().max(2_000),
        html: z.string().min(1).max(2_500_000),
        width: z.number().int().min(200).max(8_000),
        height: z.number().int().min(200).max(8_000),
      })
      .strict()
      .optional(),
    opened: z
      .object({ path: z.string().max(2_000), title: z.string().max(500) })
      .strict()
      .optional(),
    missing: z.string().max(2_000).optional(),
  })
  .strict();
/** pi.model.set */
export const modelInput = z.object({ id, model: modelId }).strict();
export const warmInput = z.object({ requestId: id, conversationId: id.optional() }).strict();
/** pi.run: the conversation, the turn and the proposal whose call the person runs. */
export const runInput = z.object({ id, commandId: id, proposalId: id }).strict();
/** A PiMachine key, e.g. 'standard' or 'large'. */
export const machineKey = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** pi.machine.set */
export const machineInput = z.object({ machine: machineKey }).strict();
/** machine.switch, the agent's switch_machine. */
export const switchMachineInput = z
  .object({ machine: machineKey, reason: z.string().trim().min(10).max(300) })
  .strict();
const workerInput = z.object({ workerId: id }).strict();
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
    /** Ignored: loading Pi is the switch. Configurations rendered before still carry it. */
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    /** MERV_PI_MODELS: what a person may pick per conversation; the first is the default. Reasoning
     * models only (every GPT-5 and GPT-6): the relay sets each call's effort, and the worker asks
     * for reasoning on any model. The picker shows labels only. */
    models: z
      .array(
        z
          .object({
            id: modelId,
            label: z.string().trim().min(1).max(24),
            effort: z.enum(['none', 'low']),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .refine((all) => new Set(all.map((m) => m.id)).size === all.length, 'Model ids repeat')
      .default([
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', effort: 'low' },
        { id: 'gpt-6-luna', label: 'GPT-6 Luna', effort: 'none' },
      ]),
    secretEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('MERV_PI_SECRET'),
    modelApiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .default('MERV_PI_MODEL_API_KEY'),
    /** A person's Agent model tokens in a UTC day (founder ruling 2026-09-25: 100M, fixed). */
    dailyTokensPerPerson: z.number().int().min(1).default(100_000_000),
    /** How long a turn may go without progress: to reach its machine, then between any two signs
     * of work (its claim, a streamed word, a tool call). Its one ceiling is turnCeilingMs. */
    turnTimeoutSeconds: z.number().int().min(10).max(900).default(300),
    idleTimeoutSeconds: z.number().int().min(5).max(3600).default(600),
    pollIntervalMs: z.number().int().min(100).max(30_000).default(1000),
    /** The operator's Pi host project (MERV_PI_HOST_PROJECT_ID), whose service key rents every
     * host slot; credentialEnv names the variable holding it. */
    host: z
      .object({
        projectId: id,
        credentialEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default('MERV_PI_HOST_KEY'),
      })
      .strict(),
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
    /** Voice: the GPT-Live session Main opens for a person's browser, on the model key. */
    voice: z
      .object({
        url: z.string().url().default('https://api.openai.com/v1/live/sessions'),
        model: z.string().min(1).default('gpt-live-1'),
        voice: z.string().min(1).default('marin'),
      })
      .strict()
      .default({}),
    /** Seeing the screen: Cloudflare's headless browser draws the person's page snapshot. */
    screen: z
      .object({
        url: z
          .string()
          .url()
          .default(
            'https://api.cloudflare.com/client/v4/accounts/{account}/browser-run/screenshot',
          ),
        tokenEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default('MERV_BROWSER_RENDER_TOKEN'),
        accountEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default('MERV_BROWSER_RENDER_ACCOUNT'),
        /** How long the person's page has to answer a look. */
        waitMs: z.number().int().min(1_000).max(60_000).default(12_000),
      })
      .strict()
      .default({}),
  })
  .strict();
export type PiConfig = z.input<typeof piConfig>;
export type PiModelConfig = z.output<typeof piConfig>['models'][number];

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
/** Published migration text is immutable after release. A person's Agent tokens for each UTC day. */
export const usageMigration = {
  version: 3,
  sql: `CREATE TABLE pi_model_usage (
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    tokens BIGINT NOT NULL,
    PRIMARY KEY(person, day)
  );`,
};
/**
 * pi@4 keeps what Run told the agent (`ran.told`, and `said`, the part that says how the call
 * came out) on each call that ran before Pi kept it, so the page reads it as it reads any other.
 * Run then wrote it only as the person's next message, the first of a later turn answering the
 * latest calls: `Ran <tool>: <result>` (a tool's receipt ends `. Re-read … for current details.`,
 * which `said` leaves out), `Ran <tool>; its result is shown only to me.`, or
 * `<tool> was refused: <why>`. Calls alike are told in the order they ran; words sent with the
 * person's own after them are theirs. Pi kept `told` from 2026-10-06, and Run had existed since
 * 2026-09-25, so only proposals run in those eleven days change: the read-only count is
 * `SELECT count(*) FROM pi_commands, jsonb_array_elements(data_json::jsonb->'proposals') call
 *  WHERE call->'ran' IS NOT NULL AND call->'ran'->'told' IS NULL`.
 * Only turns that propose calls or may tell one are read: text first, as jsonb refuses some JSON
 * (`\u0000`, half a character), and a turn it refuses is left as it is.
 */
export const toldMigration = {
  version: 4,
  sql: `WITH turns AS MATERIALIZED (
    SELECT conversation_id, id, data_json::jsonb AS data,
      row_number() OVER (PARTITION BY conversation_id ORDER BY created_at, id) AS n
    FROM pi_commands
    WHERE (strpos(data_json, '"proposals"') > 0 OR strpos(data_json, 'Ran ') > 0
        OR strpos(data_json, ' was refused: ') > 0)
      AND pg_input_is_valid(data_json, 'jsonb')
  ), proposing AS (
    SELECT * FROM turns
    WHERE jsonb_typeof(data->'proposals') = 'array' AND jsonb_array_length(data->'proposals') > 0
  ), calls AS (
    SELECT p.conversation_id, p.n, c.at, c.call->>'name' AS tool,
      row_number() OVER (PARTITION BY p.conversation_id, p.n, c.call->>'name'
        ORDER BY c.call->'ran'->>'at', c.at) AS k
    FROM proposing p, jsonb_array_elements(p.data->'proposals') WITH ORDINALITY AS c(call, at)
    WHERE c.call->'ran' IS NOT NULL AND c.call->'ran'->'told' IS NULL
  ), sentences AS (
    SELECT t.conversation_id, t.n, t.data->'messages'->0->>'text' AS text,
      (SELECT max(p.n) FROM proposing p
        WHERE p.conversation_id = t.conversation_id AND p.n < t.n) AS answers,
      regexp_match(t.data->'messages'->0->>'text', '^Ran (\\S+); its result is shown only to me\\.$') AS secret,
      regexp_match(t.data->'messages'->0->>'text', '^Ran (\\S+): (.*)$') AS ran,
      regexp_match(t.data->'messages'->0->>'text', '^(\\S+) was refused: (.*)$') AS refused
    FROM turns t
    WHERE t.data->'messages'->0->>'role' = 'user'
      AND strpos(t.data->'messages'->0->>'text', E'\\n\\n') = 0
  ), receipts AS (
    SELECT conversation_id, answers, text, tool, said,
      row_number() OVER (PARTITION BY conversation_id, answers, tool ORDER BY n) AS k
    FROM (
      SELECT *,
        coalesce(secret[1], ran[1], refused[1]) AS tool,
        CASE WHEN secret IS NOT NULL THEN NULL
          WHEN ran IS NOT NULL
            THEN regexp_replace(ran[2], '\\. Re-read [[:alnum:]_. ]+ for current details\\.$', '')
          ELSE refused[2] END AS said
      FROM sentences
    ) parsed
    WHERE tool IS NOT NULL AND answers IS NOT NULL
  ), told AS (
    SELECT c.conversation_id, c.n, c.at, r.text, r.said
    FROM calls c JOIN receipts r
      ON r.conversation_id = c.conversation_id AND r.answers = c.n AND r.tool = c.tool AND r.k = c.k
  ), kept AS (
    SELECT p.conversation_id, p.id, jsonb_agg(
      CASE WHEN t.text IS NULL THEN c.call
        ELSE jsonb_set(c.call, '{ran}', c.call->'ran'
          || jsonb_strip_nulls(jsonb_build_object('told', t.text, 'said', t.said))) END
      ORDER BY c.at) AS proposals
    FROM proposing p
    CROSS JOIN jsonb_array_elements(p.data->'proposals') WITH ORDINALITY AS c(call, at)
    LEFT JOIN told t ON t.conversation_id = p.conversation_id AND t.n = p.n AND t.at = c.at
    WHERE EXISTS (SELECT 1 FROM told WHERE told.conversation_id = p.conversation_id AND told.n = p.n)
    GROUP BY p.conversation_id, p.id
  )
  UPDATE pi_commands SET data_json = jsonb_set(data_json::jsonb, '{proposals}', kept.proposals)::text
  FROM kept WHERE pi_commands.conversation_id = kept.conversation_id AND pi_commands.id = kept.id;`,
};

/** Pi's tables, in order: what its service migrates when it starts. */
export const piMigrations = [migration, hostMigration, usageMigration, toldMigration];
