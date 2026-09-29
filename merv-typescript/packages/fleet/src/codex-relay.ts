import { z } from 'zod';
import { check, sessionSecretPattern, type State } from '@merv/contracts';
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
export const modelMigrations = [
  usageMigration,
  limitsMigration,
  blockerMigration,
  workflowRetryMigration,
];

const maxRequestBytes = 16 * 1024 * 1024;
/** One call's output, reasoning included: well above a step's longest answer, and a bound on a
 *  single call's spend. */
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

/** The upstream body for a hosted Codex call, or null: the binding's model, its effort whatever
 *  the worker asked, and the relay's own output cap. */
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

/** A person's daily Fleet model tokens: their own limit, else the deployment's; and today's use. */
export async function dailyTokens(state: State, person: string, fallback: number) {
  return await state.read(async (sql) => {
    const own = await sql.get<{ tokens: number | string }>(
      'SELECT tokens FROM fleet_model_limits WHERE person=?',
      person,
    );
    const used = await sql.get<{ tokens: number | string }>(
      'SELECT tokens FROM fleet_model_usage WHERE person=? AND day=?',
      person,
      day(),
    );
    return { tokens: Number(own?.tokens ?? fallback), usedToday: Number(used?.tokens ?? 0) };
  });
}
/** A refusal stops new Fleet rent while today's remaining tokens cannot fund that last request. */
export async function modelBudgetStatus(state: State, person: string, fallback: number) {
  const today = day();
  return await state.read(async (sql) => {
    const own = await sql.get<{ tokens: number | string }>(
      'SELECT tokens FROM fleet_model_limits WHERE person=?',
      person,
    );
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
    const tokens = Number(own?.tokens ?? fallback);
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
 * it goes out, at its most (its request's tokens and the output cap), and settled to what it used
 * when it finishes; one that never finishes keeps its charge. The day's total, kept in the
 * database across restarts, refuses any call that would pass the ceiling. Its tables are made by
 * `modelMigrations`, which the workflow adapter runs when it starts.
 */
export function codexModelRelay(
  sessions: Sessions,
  state: State,
  options: { providerKey: () => string; dailyTokensPerPerson: number },
): ModelRelayConfig<ManagedModelGrant, 'codex', { day: string; tokens: number }> {
  return {
    name: 'codex',
    route: '/codex-model/responses',
    token: sessionSecretPattern,
    enabled: true,
    providerKey: options.providerKey,
    authority: {
      authorize: (token) => sessions.managedModelGrant(token),
      validate: async (grant) => void (await sessions.managedModelGrant(grant.id)),
    },
    reserve: async (grant, body) => {
      const most = Math.ceil(JSON.stringify(body).length / 4) + maxOutputTokens;
      const today = day();
      const charged = await state.transaction(async (tx) => {
        const own = await tx.get<{ tokens: number | string }>(
          'SELECT tokens FROM fleet_model_limits WHERE person=?',
          grant.person,
        );
        const ceiling = Number(own?.tokens ?? options.dailyTokensPerPerson);
        const admitted =
          most <= ceiling &&
          (await tx.get(
            'INSERT INTO fleet_model_usage(person,day,tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET tokens=fleet_model_usage.tokens+excluded.tokens WHERE fleet_model_usage.tokens+excluded.tokens <= ? RETURNING tokens',
            grant.person,
            today,
            most,
            ceiling,
          ));
        if (admitted)
          await tx.run(
            'DELETE FROM fleet_model_blockers WHERE person=? AND day=?',
            grant.person,
            today,
          );
        else
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
      return { day: today, tokens: most };
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
    // Settles the day the call was charged to, even past midnight.
    onUsage: async (record, grant, reserved) => {
      log(record);
      await state.transaction((tx) =>
        tx.run(
          'UPDATE fleet_model_usage SET tokens=tokens+? WHERE person=? AND day=?',
          record.inputTokens + record.outputTokens - reserved.tokens,
          grant.person,
          reserved.day,
        ),
      );
    },
  };
}
