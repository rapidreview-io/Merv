import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { check, sessionSecretPattern, type Sql, type State } from '@merv/contracts';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';
import type { ModelRelayConfig } from './types.js';

/** Published migration text is immutable after release. */
export const usageMigration = {
  version: 1,
  sql: `CREATE TABLE fleet_model_usage (
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    tokens BIGINT NOT NULL,
    PRIMARY KEY(person, day)
  );`,
};

/** A person's own daily limit, where they set one (founder ruling 2026-09-25). */
export const limitsMigration = {
  version: 2,
  sql: `CREATE TABLE fleet_model_limits (
    person TEXT PRIMARY KEY,
    tokens BIGINT NOT NULL
  );`,
};

/** The latest unaffordable reservation, separate from charged usage and personal limits. */
export const blockerMigration = {
  version: 3,
  sql: `CREATE TABLE fleet_model_blockers (
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    required_tokens BIGINT NOT NULL,
    PRIMARY KEY(person, day)
  );`,
};
/** Operator-authorized retry windows; old rentals remain immutable Fleet history. */
export const workflowRetryMigration = {
  version: 4,
  sql: `CREATE TABLE fleet_workflow_retry_grants (
    id BIGSERIAL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    instance_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    prior_allocations INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(project_id, request_id),
    UNIQUE(project_id, instance_id, expected_revision, prior_allocations)
  );
  CREATE INDEX fleet_workflow_retry_target ON fleet_workflow_retry_grants
    (project_id, instance_id, expected_revision, id DESC);
  CREATE OR REPLACE FUNCTION fleet_workflow_retry_immutable() RETURNS trigger LANGUAGE plpgsql AS $merv$
  BEGIN
    RAISE EXCEPTION 'Fleet workflow retry grants are retained';
  END;
  $merv$;
  CREATE TRIGGER fleet_workflow_retry_no_update BEFORE UPDATE ON fleet_workflow_retry_grants
    FOR EACH ROW EXECUTE FUNCTION fleet_workflow_retry_immutable();
  CREATE TRIGGER fleet_workflow_retry_no_delete BEFORE DELETE ON fleet_workflow_retry_grants
    FOR EACH ROW EXECUTE FUNCTION fleet_workflow_retry_immutable();`,
};
/** Each reservation keeps its identity and first settlement across process restarts. */
export const modelRequestsMigration = {
  version: 5,
  sql: `CREATE TABLE fleet_model_requests (
    id TEXT PRIMARY KEY,
    person TEXT NOT NULL,
    day TEXT NOT NULL,
    reserved_tokens BIGINT NOT NULL CHECK (reserved_tokens >= 0),
    settled_tokens BIGINT CHECK (settled_tokens >= 0),
    FOREIGN KEY (person, day) REFERENCES fleet_model_usage(person, day)
  );`,
};
export const modelMigrations = [
  usageMigration,
  limitsMigration,
  blockerMigration,
  workflowRetryMigration,
  modelRequestsMigration,
];

const maxRequestBytes = 16 * 1024 * 1024;
/** The requested output allowance, reasoning included. Input reservations remain estimates. */
const maxOutputTokens = 65_536;
/** A tool Codex runs on the machine. Hosted tools, which run and bill at the provider where
 *  Merv cannot see them, never pass; neither does a web search. */
const tool = z.object({ type: z.enum(['function', 'custom', 'local_shell']) }).passthrough();
/** Exactly the keys Codex sends through a custom provider (linux-workflow-gate.py records them):
 *  no background, stored or chained response, service tier or output cap of its own. */
const codexRequest = z
  .object({
    model: z.string(),
    instructions: z.string().optional(),
    input: z.array(z.record(z.unknown())),
    tools: z
      .array(
        z.union([
          tool,
          // Codex groups each MCP server's tools under one namespace.
          z
            .object({
              type: z.literal('namespace'),
              name: z.string(),
              description: z.string().optional(),
              tools: z.array(tool),
            })
            .strict(),
        ]),
      )
      .optional(),
    tool_choice: z.enum(['auto', 'none', 'required']).optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z.string().optional(),
        summary: z.enum(['auto', 'concise', 'detailed']).optional(),
      })
      .strict()
      .optional(),
    store: z.literal(false),
    stream: z.literal(true),
    include: z.array(z.literal('reasoning.encrypted_content')).max(1).optional(),
    prompt_cache_key: z.string().max(200).optional(),
    text: z
      .object({
        verbosity: z.enum(['low', 'medium', 'high']).optional(),
        format: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    client_metadata: z.record(z.string()).optional(),
  })
  .strict();

/** Whether anything in the request would have the provider fetch or look up content of its own:
 *  a file by id or URL, a remote image, a stored item, or a schema reference outside the tool. */
const fetches = (value: unknown, depth = 0): boolean => {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((entry) => fetches(entry, depth + 1));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      ['file_id', 'file_url'].includes(key) ||
      (key === 'image_url' && !(typeof entry === 'string' && entry.startsWith('data:'))) ||
      (key === 'type' && ['input_file', 'item_reference'].includes(entry as string)) ||
      (['$ref', '$dynamicRef'].includes(key) && !String(entry).startsWith('#')) ||
      fetches(entry, depth + 1),
  );
};

/** The upstream body for a hosted Codex call, or null: the binding's model and the relay's own
 *  output cap. When the worker sends `reasoning`, its effort becomes the binding's, or none (the
 *  provider's default) when the binding sets none; a call without `reasoning` is sent without
 *  one, whatever the binding sets. */
export function codexPayload(raw: unknown, grant: ManagedModelGrant) {
  const parsed = codexRequest.safeParse(raw);
  if (!parsed.success || parsed.data.model !== grant.model || fetches(raw)) return null;
  const { reasoning, ...rest } = parsed.data;
  return {
    ...rest,
    ...(reasoning && { reasoning: { ...reasoning, effort: grant.effort } }),
    max_output_tokens: maxOutputTokens,
  };
}

const day = () => new Date().toISOString().slice(0, 10);

/** A person's daily Fleet model tokens: their own limit, else the deployment's. */
async function ceiling(sql: Sql, person: string, fallback: number) {
  const own = await sql.get<{ tokens: number | string }>(
    'SELECT tokens FROM fleet_model_limits WHERE person=?',
    person,
  );
  return Number(own?.tokens ?? fallback);
}
/** A refusal stops new Fleet rent while today's remaining tokens cannot fund that last request. */
export async function modelBudgetStatus(state: State, person: string, fallback: number) {
  const today = day();
  return await state.read(async (sql) => {
    const tokens = await ceiling(sql, person, fallback);
    const used = await sql.get<{ tokens: number | string }>(
      'SELECT tokens FROM fleet_model_usage WHERE person=? AND day=?',
      person,
      today,
    );
    const refusal = await sql.get<{ required_tokens: number | string }>(
      'SELECT required_tokens FROM fleet_model_blockers WHERE person=? AND day=?',
      person,
      today,
    );
    const usedToday = Number(used?.tokens ?? 0);
    const lastRefusedTokens = refusal ? Number(refusal.required_tokens) : null;
    const remaining = Math.max(0, tokens - usedToday);
    const blockReason =
      remaining <= maxOutputTokens
        ? 'minimum_reservation_unaffordable'
        : lastRefusedTokens !== null && remaining < lastRefusedTokens
          ? 'last_refused_reservation_unaffordable'
          : null;
    return {
      tokens,
      usedToday,
      remaining,
      lastRefusedTokens,
      blocked: blockReason !== null,
      blockReason,
      resetsAt: new Date(new Date(`${today}T00:00:00.000Z`).getTime() + 86_400_000).toISOString(),
    };
  });
}
export async function setDailyTokens(state: State, person: string, tokens: number) {
  await state.transaction((tx) =>
    tx.run(
      'INSERT INTO fleet_model_limits(person,tokens) VALUES(?,?) ON CONFLICT(person) DO UPDATE SET tokens=excluded.tokens',
      person,
      tokens,
    ),
  );
}
const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);

/**
 * Hosted Codex calls the model through Main with its session bearer, so the machine holds no
 * provider key. Each session has one call in flight. A call is charged to its person's day before
 * it goes out, using an input estimate plus the output cap, and settled to valid reported usage
 * when it finishes; one refused before it is sent, or answered with an error status, is refunded,
 * and one cut off or lacking usable usage keeps its charge. The durable daily total refuses a
 * reservation that would pass the ceiling; actual input use can exceed its estimate, so this
 * is not a hard bound on provider billing. Its tables are made by `modelMigrations`, which
 * the workflow adapter runs when it starts.
 */
export function codexModelRelay(
  sessions: Sessions,
  state: State,
  options: {
    providerKey: () => string;
    dailyTokensPerPerson: number;
    /** Reads a bearer's grant; Sessions' by default, the workflow adapter's in Main. */
    authorize?: (token: string) => Promise<ManagedModelGrant>;
  },
): ModelRelayConfig<
  ManagedModelGrant,
  'codex',
  { requestId: string; day: string; tokens: number }
> {
  return {
    name: 'codex',
    route: '/codex-model/responses',
    token: sessionSecretPattern,
    enabled: true,
    providerKey: options.providerKey,
    authority: {
      authorize: options.authorize ?? ((token) => sessions.managedModelGrant(token)),
      validate: async (grant) => void (await sessions.managedModelGrant(grant.id)),
    },
    reserve: async (grant, body) => {
      const most = Math.ceil(JSON.stringify(body).length / 4) + maxOutputTokens;
      const today = day();
      const requestId = randomUUID();
      const charged = await state.transaction(async (tx) => {
        const limit = await ceiling(tx, grant.person, options.dailyTokensPerPerson);
        const admitted =
          most <= limit &&
          (await tx.get(
            'INSERT INTO fleet_model_usage(person,day,tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET tokens=fleet_model_usage.tokens+excluded.tokens WHERE fleet_model_usage.tokens+excluded.tokens <= ? RETURNING tokens',
            grant.person,
            today,
            most,
            limit,
          ));
        if (admitted) {
          await tx.run(
            'INSERT INTO fleet_model_requests(id,person,day,reserved_tokens) VALUES(?,?,?,?)',
            requestId,
            grant.person,
            today,
            most,
          );
          await tx.run(
            'DELETE FROM fleet_model_blockers WHERE person=? AND day=?',
            grant.person,
            today,
          );
        } else
          await tx.run(
            'INSERT INTO fleet_model_blockers(person,day,required_tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET required_tokens=excluded.required_tokens',
            grant.person,
            today,
            most,
          );
        return admitted;
      });
      if (!charged) log({ event: 'codex_relay_ceiling', model: grant.model, charge: most });
      check(charged, 'fleet_model_ceiling', 'The daily model token ceiling is reached', 403);
      return { requestId, day: today, tokens: most };
    },
    grant: (raw) => raw as ManagedModelGrant,
    payload: codexPayload,
    lane: (grant) => grant.id,
    maxRequestBytes,
    totalTimeoutMs: 15 * 60_000,
    // A second, in-memory bound: a step's calls, far beyond what one takes.
    maxRequestsPerGrant: 1000,
    onFailure: log,
    onTerminal: log,
    // The receipt and delta commit together. A retry after a lost commit reply is a no-op.
    onUsage: async (record, grant, reserved) => {
      const total = record.inputTokens + record.outputTokens;
      check(
        Number.isSafeInteger(record.inputTokens) &&
          record.inputTokens >= 0 &&
          Number.isSafeInteger(record.outputTokens) &&
          record.outputTokens >= 0 &&
          Number.isSafeInteger(total),
        'fleet_model_usage_invalid',
        'Invalid model usage',
      );
      await state.transaction(async (tx) => {
        const request = await tx.get<{
          day: string;
          reserved_tokens: string;
          settled_tokens: string | null;
        }>(
          'SELECT day,reserved_tokens,settled_tokens FROM fleet_model_requests WHERE id=? AND person=? FOR UPDATE',
          reserved.requestId,
          grant.person,
        );
        check(request, 'fleet_model_request_missing', 'Unknown model reservation');
        if (request.settled_tokens !== null) {
          check(
            Number(request.settled_tokens) === total,
            'fleet_model_usage_conflict',
            'Model usage already settled',
          );
          return;
        }
        await tx.run(
          'UPDATE fleet_model_usage SET tokens=tokens+? WHERE person=? AND day=?',
          total - Number(request.reserved_tokens),
          grant.person,
          request.day,
        );
        await tx.run(
          'UPDATE fleet_model_requests SET settled_tokens=? WHERE id=?',
          total,
          reserved.requestId,
        );
      });
      log(record);
    },
  };
}
