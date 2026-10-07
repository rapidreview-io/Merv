import { z } from 'zod';
import { check, sessionSecretPattern, type Sql, type State } from '@merv/contracts';
import { dailyTokens } from './model-ledger.js';
import { fetchesContent, reasoningSummary, toolChoice } from './model-requests.js';
import type { ManagedBoundSession } from '@merv/sessions/types';
import { codexHandoffGraceMs, hostedCodexPlatform } from './hosted-codex.js';
import type { ManagedModelGrant, ModelRelayConfig, ModelRelayFailure } from './types.js';

/** Hosted Codex's grant of the model for a session its runner holds: while the session is live,
 *  or within Codex's grace after its own handoff, charged to `person`. Sessions held the machine
 *  to the hosted profile, so the model is that profile's. */
export function hostedGrant(
  bound: ManagedBoundSession,
  person: string | undefined,
  now: number,
): ManagedModelGrant {
  check(
    person && (!bound.handedOffAt || now - Date.parse(bound.handedOffAt) < codexHandoffGraceMs),
    'unauthorized',
    'No live managed session holds this credential',
    401,
  );
  const { model, effort } = hostedCodexPlatform;
  const { sessionId: id, projectId, allocationId, expiresAt, tokenBudget } = bound;
  return {
    id,
    projectId,
    allocationId,
    person,
    model,
    effort,
    expiresAt,
    ...(tokenBudget !== undefined && { tokenBudget }),
  };
}

const maxRequestBytes = 16 * 1024 * 1024;
/** One call's output, reasoning included: well above a step's longest answer, and a bound on a
 *  single call's spend. */
const maxOutputTokens = 65_536;
/** A tool Codex runs on the machine. Hosted tools, which run and bill at the provider where
 *  Merv cannot see them, never pass; neither does a web search. */
const tool = z.object({ type: z.enum(['function', 'custom', 'local_shell']) }).passthrough();
const tools = z.array(
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
);
/** Responses Lite, which Codex uses for a model its catalog marks so (gpt-6.1-sol from 0.160):
 *  the tools travel as the first input item instead of top-level `tools`, and are held to the
 *  same rule. */
const additionalTools = z
  .object({
    type: z.literal('additional_tools'),
    id: z.string().optional(),
    role: z.literal('developer'),
    tools,
  })
  .strict();
/** Exactly the keys Codex sends through a custom provider (linux-workflow-gate.py records them):
 *  no background, stored or chained response, service tier or output cap of its own. */
const codexRequest = z
  .object({
    model: z.string(),
    instructions: z.string().optional(),
    input: z.array(
      z.union([
        additionalTools,
        // No other item carries tools, however it names itself.
        z
          .record(z.unknown())
          .refine((item) => item.type !== 'additional_tools' && !Object.hasOwn(item, 'tools')),
      ]),
    ),
    tools: tools.optional(),
    tool_choice: toolChoice.optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z.string().optional(),
        summary: reasoningSummary.optional(),
        context: z.literal('all_turns').optional(),
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

/** The upstream body for a hosted Codex call, or null: the binding's model and the relay's own
 *  output cap. When the worker sends `reasoning`, its effort becomes the binding's, or none (the
 *  provider's default) when the binding sets none; a call without `reasoning` is sent without
 *  one, whatever the binding sets. */
export function codexPayload(raw: unknown, grant: ManagedModelGrant) {
  const parsed = codexRequest.safeParse(raw);
  if (!parsed.success || parsed.data.model !== grant.model || fetchesContent(raw)) return null;
  const { reasoning, ...rest } = parsed.data;
  return {
    ...rest,
    ...(reasoning && { reasoning: { ...reasoning, effort: grant.effort } }),
    max_output_tokens: maxOutputTokens,
  };
}

const day = () => new Date().toISOString().slice(0, 10);
const ledger = dailyTokens('fleet_model_usage');
/** A grant's own budget: `charge` adds a call's most unless that passes `budget` (false then). */
const grantLedger = {
  charge: async (sql: Sql, grant: string, tokens: number, budget: number) =>
    tokens <= budget &&
    !!(await sql.get(
      'INSERT INTO fleet_grant_tokens(grant_id,tokens) VALUES(?,?) ON CONFLICT(grant_id) DO UPDATE SET tokens=fleet_grant_tokens.tokens+excluded.tokens WHERE fleet_grant_tokens.tokens+excluded.tokens <= ? RETURNING tokens',
      grant,
      tokens,
      budget,
    )),
  settle: (sql: Sql, grant: string, delta: number) =>
    sql.run(
      'UPDATE fleet_grant_tokens SET tokens=GREATEST(0,tokens+?) WHERE grant_id=?',
      delta,
      grant,
    ),
};

/** A person's daily Fleet model tokens: their own limit, else the deployment's. */
async function ceiling(sql: Sql, person: string, fallback: number) {
  const own = await sql.get<{ tokens: number | string }>(
    'SELECT tokens FROM fleet_model_limits WHERE person=?',
    person,
  );
  return Number(own?.tokens ?? fallback);
}
/** A refusal stops new Fleet rent, and new work on a machine already rented, while today's
 *  remaining tokens cannot fund that last request. */
export async function modelBudgetStatus(state: State, person: string, fallback: number) {
  return await state.read((sql) => budgetIn(sql, person, fallback));
}
/** `modelBudgetStatus` read in the caller's own transaction. */
export async function budgetIn(sql: Sql, person: string, fallback: number) {
  const today = day();
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

/** How long after a relay fault a visit's failed close is put down to it. Codex gives up on a
 *  call after about 6 s of retries, and its runner releases the visit once Main answers. */
const relayFaultMs = 15 * 60_000;
/** A call's end that is the relay's or its provider's, not the visit's: an outage or a stream
 *  cut short, the relay unable to judge or busy, or Main shutting down. A provider's refusal of
 *  the request itself (any other 4xx) is the visit's. */
const relayFault = (record: ModelRelayFailure) =>
  ['upstream_failed', 'relay_unavailable', 'relay_timeout', 'relay_busy'].includes(record.code) &&
  !(
    record.upstreamHttpStatus !== undefined &&
    record.upstreamHttpStatus >= 400 &&
    record.upstreamHttpStatus < 500 &&
    ![408, 429].includes(record.upstreamHttpStatus)
  );
const fault = (sql: Sql, subject: string, code: string, at: string) =>
  sql.run(
    'INSERT INTO fleet_relay_faults(subject,code,at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET code=excluded.code,at=excluded.at',
    subject,
    code,
    at,
  );
/** Main (and its relay) started: every visit live before now lost its calls in flight. Faults
 *  past their window are let go here. */
export async function markRelayStart(state: State): Promise<void> {
  const at = new Date().toISOString();
  await state.transaction(async (tx) => {
    await tx.run(
      'DELETE FROM fleet_relay_faults WHERE at<?',
      new Date(Date.now() - relayFaultMs).toISOString(),
    );
    await fault(tx, '*', 'main_restarted', at);
  });
}
/** Whether the relay failed a visit that started at `since` lately: one of its calls, or Main
 *  restarting while it was live. */
export async function relayFaulted(sql: Sql, sessionId: string, since: string, now = Date.now()) {
  return !!(await sql.get(
    "SELECT 1 FROM fleet_relay_faults WHERE subject IN (?,'*') AND at>=? AND at>?",
    sessionId,
    since,
    new Date(now - relayFaultMs).toISOString(),
  ));
}

/**
 * Hosted Codex calls the model through Main with its session bearer, so the machine holds no
 * provider key. Each session has one call in flight. A call is charged to its person's day before
 * it goes out, at its most (its request's tokens and the output cap), and settled to what it used
 * when it finishes; one refused before it is sent, answered with an error status, or failed with
 * no usage, is refunded, and one cut off keeps its charge. The day's total, kept in the database
 * across restarts, refuses any call that would pass the ceiling; a session with a budget of its
 * own (`tokenBudget`) is charged and refused the same way, in the same transaction. Its tables are
 * made by `modelMigrations`, which the workflow adapter runs when it starts.
 */
export function codexModelRelay(
  state: State,
  options: {
    providerKey: () => string;
    dailyTokensPerPerson: number;
    /** The grant of a bearer or, when the relay checks again, of its session id: the one grant
     *  authority, the workflow adapter's in Main. */
    authorize: (tokenOrSessionId: string) => Promise<ManagedModelGrant>;
  },
): ModelRelayConfig<ManagedModelGrant, 'codex', { day: string; tokens: number }> {
  return {
    name: 'codex',
    route: '/codex-model/responses',
    token: sessionSecretPattern,
    providerKey: options.providerKey,
    authority: {
      authorize: options.authorize,
      validate: async (grant) => void (await options.authorize(grant.id)),
    },
    reserve: async (grant, body) => {
      const most = Math.ceil(JSON.stringify(body).length / 4) + maxOutputTokens;
      const today = day();
      const refused = await state.transaction(async (tx) => {
        const limit = await ceiling(tx, grant.person, options.dailyTokensPerPerson);
        if (!(await ledger.charge(tx, grant.person, today, most, limit))) {
          // The day's largest refusal stands until the reset or a raised limit funds it: a
          // smaller call that still passes leaves the refused visit waiting.
          await tx.run(
            'INSERT INTO fleet_model_blockers(person,day,required_tokens) VALUES(?,?,?) ON CONFLICT(person,day) DO UPDATE SET required_tokens=GREATEST(fleet_model_blockers.required_tokens,excluded.required_tokens)',
            grant.person,
            today,
            most,
          );
          return 'ceiling';
        }
        if (
          grant.tokenBudget !== undefined &&
          !(await grantLedger.charge(tx, grant.id, most, grant.tokenBudget))
        ) {
          await ledger.settle(tx, grant.person, today, -most);
          return 'budget';
        }
        return null;
      });
      if (refused) log({ event: `codex_relay_${refused}`, model: grant.model, charge: most });
      check(
        refused !== 'budget',
        'token_budget_spent',
        "This session's model tokens are spent",
        403,
      );
      check(
        refused !== 'ceiling',
        'fleet_model_ceiling',
        'The daily model token ceiling is reached',
        403,
      );
      return { day: today, tokens: most };
    },
    grant: (raw) => raw as ManagedModelGrant,
    payload: codexPayload,
    // What Codex itself sends with a Responses Lite body.
    headers: (body): Record<string, string> =>
      (body.input as { type?: unknown }[]).some((item) => item.type === 'additional_tools')
        ? { 'x-openai-internal-codex-responses-lite': 'true' }
        : {},
    lane: (grant) => grant.id,
    maxRequestBytes,
    totalTimeoutMs: 15 * 60_000,
    // A second, in-memory bound: a step's calls, far beyond what one takes.
    maxRequestsPerGrant: 1000,
    // The relay's own fault is said of the visit, so Sessions does not count its close.
    onFailure: async (record, grant) => {
      log(record);
      if (relayFault(record))
        await state.transaction((tx) => fault(tx, grant.id, record.code, new Date().toISOString()));
    },
    onTerminal: log,
    // Settles the day the call was charged to, even past midnight.
    onUsage: async (record, grant, reserved) => {
      log(record);
      const delta = record.inputTokens + record.outputTokens - reserved.tokens;
      await state.transaction(async (tx) => {
        await ledger.settle(tx, grant.person, reserved.day, delta);
        if (grant.tokenBudget !== undefined) await grantLedger.settle(tx, grant.id, delta);
      });
    },
  };
}
