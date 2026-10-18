import { check, clip, type State } from '@merv/contracts';
import { dailyTokens, ownLimits, RESPONSES_URL } from '@merv/fleet/model-ledger';
import type { ModelRelayConfig, ModelTokens } from '@merv/fleet/types';
import type { PiModelCharge, PiRelayGrant } from './types.js';
import { turnCeilingMs } from './limits.js';
import {
  piRelayGrantSchema,
  piResponsesSchema,
  relayRequestBytes,
  validPiPayload,
} from './relay-schema.js';

export type { PiRelayGrant } from './types.js';
type PiRelay = ModelRelayConfig<PiRelayGrant, 'pi', PiModelCharge>;
export type PiRelayConfig = Omit<
  PiRelay,
  'name' | 'route' | 'token' | 'grant' | 'payload' | 'lane' | 'maxRequestBytes' | 'totalTimeoutMs'
> &
  Partial<Pick<PiRelay, 'maxRequestBytes' | 'totalTimeoutMs'>> & {
    /** MERV_PI_MODELS: a grant names one of these, and the relay alone sets each call's effort. */
    models: readonly { id: string; effort: 'none' | 'low' | 'medium' }[];
  };

const piLedger = dailyTokens('pi_model_usage');
/** People's own daily limits, set by the platform admin: each replaces the ceiling. */
const piLimits = ownLimits('pi_model_limits', 'tokens');
/**
 * A person's Agent tokens today: a call is charged at its most (its request and its output)
 * before it goes out and settled to its usage when that arrives; one cut off keeps its charge.
 * The day's total refuses any call that would pass their own limit, else the ceiling.
 */
export const piTokens = (state: State, now: () => string, ceiling: number) => ({
  async reserve(grant: { userId: string }, body: Record<string, unknown>): Promise<PiModelCharge> {
    const most =
      Math.ceil(JSON.stringify(body).length / 4) + (Number(body.max_output_tokens) || 128_000);
    const day = now().slice(0, 10);
    const charged = await state.transaction(async (tx) => {
      const limit = (await piLimits.of(tx, [grant.userId])).get(grant.userId) ?? ceiling;
      return await piLedger.charge(tx, grant.userId, day, most, limit);
    });
    check(charged, 'pi_model_ceiling', "Today's Agent tokens are used up", 403);
    return { day, tokens: most };
  },
  async settle(
    usage: { inputTokens: number; outputTokens: number },
    grant: { userId: string },
    reserved: PiModelCharge,
  ): Promise<void> {
    // Settles the day the call was charged to, even past midnight.
    const delta = usage.inputTokens + usage.outputTokens - reserved.tokens;
    await state.transaction((tx) => piLedger.settle(tx, grant.userId, reserved.day, delta));
  },
  /** Each of `persons`' tokens over the UTC days [from, to), and the daily limit that holds. */
  used: (persons: readonly string[], from: string, to: string): Promise<ModelTokens[]> =>
    state.read(async (sql) => {
      const used = await piLedger.used(sql, persons, from, to);
      const own = await piLimits.of(sql, persons);
      return persons.map((person, i) => ({
        used: used[i]!,
        limit: own.get(person) ?? ceiling,
        own: own.has(person),
      }));
    }),
  /** Sets `person`'s own daily limit, or clears it (null) so the ceiling holds again. */
  async setLimit(person: string, tokens: number | null): Promise<void> {
    await state.transaction((tx) => piLimits.set(tx, person, tokens));
  },
});

/** Pi's relay: one model call at a time per conversation, as a person's conversations share one
 *  machine, in the Pi-shaped request its worker sends. */
export function piModelRelay({ models, authority, ...config }: PiRelayConfig): PiRelay {
  const efforts = new Map(models?.map(({ id, effort }) => [id, effort]));
  if (!efforts.size) throw new Error('Pi relay requires a model');
  return {
    maxRequestBytes: relayRequestBytes,
    totalTimeoutMs: turnCeilingMs,
    ...config,
    name: 'pi',
    route: '/pi-model/responses',
    token: /^pir_[A-Za-z0-9_-]{43}$/,
    authority: {
      authorize: (token) => authority.authorize(token),
      validate: async (grant) => {
        if (!efforts.has(grant.model)) throw new Error('Pi relay grant names no catalog model');
        await authority.validate(grant);
      },
    },
    grant: (raw) => piRelayGrantSchema.parse(raw),
    payload: (raw, grant) => {
      const parsed = piResponsesSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.model !== grant.model ||
        !validPiPayload(parsed.data, grant.toolNames)
      )
        return null;
      // The catalog's effort, whatever the worker asked: no summary, and encrypted reasoning to
      // replay only where the model reasons.
      const effort = efforts.get(grant.model)!;
      const { reasoning: _reasoning, include: _include, ...rest } = parsed.data;
      return {
        ...rest,
        reasoning: { effort },
        ...(effort !== 'none' && { include: ['reasoning.encrypted_content'] }),
      };
    },
    lane: (grant) => grant.conversationId,
  };
}

type Usage = { inputTokens: number; outputTokens: number };
/**
 * A request sent to the relay's own upstream: its answer's message texts, and `usage` to settle
 * its charge as the relay settles a call's: none where the provider refused it, and null, keeping
 * the charge, where it may have run it. The provider's own words, which name a refused key, are
 * never read.
 */
export async function responses(
  key: string,
  body: object,
  timeoutMs: number,
): Promise<{ texts: string[]; usage: Usage | null }> {
  let response: Response;
  try {
    response = await fetch(RESPONSES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { texts: [], usage: null };
  }
  if (!response.ok) return { texts: [], usage: { inputTokens: 0, outputTokens: 0 } };
  const answer = (await response.json().catch(() => null)) as {
    output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  const count = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : 0);
  return {
    texts: (answer?.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? ''),
    usage: answer?.usage
      ? {
          inputTokens: count(answer.usage.input_tokens),
          outputTokens: count(answer.usage.output_tokens),
        }
      : null,
  };
}

/** The request that names a conversation from its first exchange: small, without reasoning. */
export const titleRequest = (model: string, user: string, reply: string) => ({
  model,
  store: false,
  max_output_tokens: 24,
  reasoning: { effort: 'none' },
  instructions: 'Title this conversation in 2 to 6 words. Reply with the title only.',
  input: `User: ${clip(user, 2000)}\n\nAgent: ${clip(reply, 2000)}`,
});

/** That request, answered: anything short of a usable title is '', so the conversation keeps the
 * name it has. */
export async function piTitle(
  key: string,
  body: ReturnType<typeof titleRequest>,
): Promise<{ title: string; usage: Usage | null }> {
  const { texts, usage } = await responses(key, body, 10_000);
  const said = texts
    .join('')
    .replace(/[*_`"“”«»]/g, '')
    .replace(/[\s\p{Cc}\p{Cf}\p{Cs}]+/gu, ' ')
    .replace(/^[\s#>'‘’-]*(?:title:)?[\s'‘’]*|[\s'‘’.]+$/gi, '');
  // Never half a character, which jsonb refuses where it lists the person's conversations.
  return { title: clip(said, 80).trim(), usage };
}
