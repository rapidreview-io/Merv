import { z } from 'zod';
import { check, sessionSecretPattern, type State } from '@merv/contracts';
import type { ModelRelayConfig } from '@merv/api/types';
import type { ManagedModelGrant, Sessions } from '@merv/sessions/types';

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
const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);

/**
 * Hosted Codex calls the model through Main with its session bearer, so the machine holds no
 * provider key. Each session has one call in flight. A call is charged to its person's day before
 * it goes out, at its most (its request's tokens and the output cap), and settled to what it used
 * when it finishes; one that never finishes keeps its charge. The day's total, kept in the
 * database across restarts, refuses any call that would pass the ceiling.
 */
export async function codexModelRelay(
  sessions: Sessions,
  state: State,
  options: { providerKey: () => string; dailyTokensPerPerson: number },
): Promise<ModelRelayConfig<ManagedModelGrant, 'codex'>> {
  await state.migrate('fleet_workflow', [usageMigration]);
  // The day each session's one call in flight was charged to.
  const days = new Map<string, string>();
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
      const charged =
        most <= options.dailyTokensPerPerson &&
        (await state.transaction((tx) =>
          tx.get(
            'INSERT INTO fleet_model_usage(person,day,tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET tokens=fleet_model_usage.tokens+excluded.tokens WHERE fleet_model_usage.tokens+excluded.tokens <= ? RETURNING tokens',
            grant.person,
            today,
            most,
            options.dailyTokensPerPerson,
          ),
        ));
      if (!charged) log({ event: 'codex_relay_ceiling', model: grant.model, charge: most });
      check(charged, 'fleet_model_ceiling', 'The daily model token ceiling is reached', 403);
      days.set(grant.id, today);
      return most;
    },
    grant: (raw) => raw as ManagedModelGrant,
    payload: codexPayload,
    lane: (grant) => grant.id,
    maxRequestBytes,
    totalTimeoutMs: 15 * 60_000,
    // A second, in-memory bound: a step's calls, far beyond what one takes.
    maxRequestsPerGrant: 1000,
    onFailure: log,
    // Settles the day the call was charged to, even past midnight.
    onUsage: async (record, grant, reserved) => {
      log(record);
      await state.transaction((tx) =>
        tx.run(
          'UPDATE fleet_model_usage SET tokens=tokens+? WHERE person=? AND day=?',
          record.inputTokens + record.outputTokens - reserved,
          grant.person,
          days.get(grant.id) ?? day(),
        ),
      );
    },
  };
}
